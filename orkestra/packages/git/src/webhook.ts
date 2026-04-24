import { createLogger, loadConfig } from "@orkestra/config";
import crypto from "node:crypto";
import { z } from "zod";

const log = createLogger("git.bitbucket.webhook");

// ---------------------------------------------------------------------------
// Incoming payload schemas (Bitbucket DC)
// ---------------------------------------------------------------------------

const BbActor = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    emailAddress: z.string().optional(),
  })
  .passthrough();

const BbRepoLite = z
  .object({
    slug: z.string(),
    project: z.object({ key: z.string() }),
  })
  .passthrough();

const BbChange = z
  .object({
    ref: z.object({ id: z.string(), displayId: z.string(), type: z.string().optional() }),
    refId: z.string().optional(),
    fromHash: z.string().optional(),
    toHash: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const BbPushPayload = z
  .object({
    eventKey: z.string(),
    date: z.string().optional(),
    actor: BbActor.optional(),
    repository: BbRepoLite,
    changes: z.array(BbChange).default([]),
  })
  .passthrough();

const BbPRLite = z
  .object({
    id: z.number(),
    title: z.string(),
    state: z.string().optional(),
    fromRef: z.object({ displayId: z.string(), latestCommit: z.string().optional() }),
    toRef: z.object({ displayId: z.string() }),
  })
  .passthrough();

const BbPRPayload = z
  .object({
    eventKey: z.string(),
    date: z.string().optional(),
    actor: BbActor.optional(),
    pullRequest: BbPRLite.extend({
      toRef: z.object({
        displayId: z.string(),
        repository: BbRepoLite,
      }),
    }),
  })
  .passthrough();

const BbPRCommentPayload = z
  .object({
    eventKey: z.string(),
    date: z.string().optional(),
    actor: BbActor.optional(),
    pullRequest: BbPRLite.extend({
      toRef: z.object({ displayId: z.string(), repository: BbRepoLite }),
    }),
    comment: z.object({ id: z.number(), text: z.string() }),
  })
  .passthrough();

// Minimal pipeline-complete payload. Bitbucket Pipelines (Cloud) posts a different
// shape than DC Bamboo integrations; we accept a loose normalized envelope.
const BbPipelinePayload = z
  .object({
    eventKey: z.string(),
    date: z.string().optional(),
    repository: BbRepoLite.optional(),
    pipeline: z
      .object({
        uuid: z.string().optional(),
        state: z
          .object({
            name: z.string().optional(),
            result: z.object({ name: z.string() }).optional(),
          })
          .optional(),
        target: z
          .object({ commit: z.object({ hash: z.string().optional() }).optional() })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Normalized event shapes
// ---------------------------------------------------------------------------

export interface BitbucketPushEvent {
  kind: "push";
  eventKey: string;
  repo: { projectKey: string; repoSlug: string };
  branches: Array<{ name: string; fromHash?: string; toHash?: string; type?: string }>;
  actor?: { name?: string; email?: string };
  at: string;
  raw: unknown;
}

export interface BitbucketPREvent {
  kind: "pr";
  eventKey: string; // pr:opened | pr:merged | pr:declined | pr:modified | pr:reviewer:approved | ...
  repo: { projectKey: string; repoSlug: string };
  prId: number;
  title: string;
  state?: string;
  source: string;
  target: string;
  actor?: { name?: string; email?: string };
  at: string;
  raw: unknown;
}

export interface BitbucketPRCommentEvent {
  kind: "pr-comment";
  eventKey: string;
  repo: { projectKey: string; repoSlug: string };
  prId: number;
  commentId: number;
  text: string;
  actor?: { name?: string; email?: string };
  at: string;
  raw: unknown;
}

export interface BitbucketPipelineEvent {
  kind: "pipeline";
  eventKey: string;
  repo?: { projectKey: string; repoSlug: string };
  pipelineId?: string;
  result?: string;
  commitSha?: string;
  at: string;
  raw: unknown;
}

export type BitbucketWebhookEvent =
  | BitbucketPushEvent
  | BitbucketPREvent
  | BitbucketPRCommentEvent
  | BitbucketPipelineEvent;

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

export interface VerifiableRequest {
  rawBody: string | Buffer;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Verify Bitbucket webhook HMAC (`X-Hub-Signature`). Accepts `sha256=<hex>`
 * or plain hex. Returns false on any mismatch or malformed input.
 */
export function verifyBitbucketWebhook(
  req: VerifiableRequest,
  signature: string | undefined,
  secret?: string,
): boolean {
  if (!signature) return false;
  const cfg = loadConfig();
  const key = secret ?? cfg.BITBUCKET_WEBHOOK_SECRET;
  if (!key) return false;

  const payload = typeof req.rawBody === "string" ? Buffer.from(req.rawBody, "utf8") : req.rawBody;
  const computed = crypto.createHmac("sha256", key).update(payload).digest("hex");
  const provided = signature
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseBitbucketPullRequestEvent(body: unknown): BitbucketWebhookEvent | null {
  if (!body || typeof body !== "object") return null;
  const eventKey =
    typeof (body as { eventKey?: unknown }).eventKey === "string"
      ? ((body as { eventKey: string }).eventKey as string)
      : "";

  const at = nowIso(body);

  // Push
  if (eventKey.startsWith("repo:refs_changed") || eventKey === "repo:push") {
    const parsed = BbPushPayload.safeParse(body);
    if (!parsed.success) {
      log.debug({ err: parsed.error.flatten() }, "bb push parse failed");
      return null;
    }
    const p = parsed.data;
    return {
      kind: "push",
      eventKey,
      repo: { projectKey: p.repository.project.key, repoSlug: p.repository.slug },
      branches: p.changes.map((c) => ({
        name: c.ref.displayId,
        fromHash: c.fromHash,
        toHash: c.toHash,
        type: c.type,
      })),
      actor: actor(p.actor),
      at,
      raw: body,
    };
  }

  // PR comment (explicit event keys)
  if (
    eventKey === "pr:comment:added" ||
    eventKey === "pr:comment:edited" ||
    eventKey === "pr:comment:deleted"
  ) {
    const parsed = BbPRCommentPayload.safeParse(body);
    if (!parsed.success) {
      log.debug({ err: parsed.error.flatten() }, "bb pr-comment parse failed");
      return null;
    }
    const p = parsed.data;
    return {
      kind: "pr-comment",
      eventKey,
      repo: {
        projectKey: p.pullRequest.toRef.repository.project.key,
        repoSlug: p.pullRequest.toRef.repository.slug,
      },
      prId: p.pullRequest.id,
      commentId: p.comment.id,
      text: p.comment.text,
      actor: actor(p.actor),
      at,
      raw: body,
    };
  }

  // PR lifecycle (opened, modified, merged, declined, approved, etc.)
  if (eventKey.startsWith("pr:")) {
    const parsed = BbPRPayload.safeParse(body);
    if (!parsed.success) {
      log.debug({ err: parsed.error.flatten() }, "bb pr parse failed");
      return null;
    }
    const p = parsed.data;
    return {
      kind: "pr",
      eventKey,
      repo: {
        projectKey: p.pullRequest.toRef.repository.project.key,
        repoSlug: p.pullRequest.toRef.repository.slug,
      },
      prId: p.pullRequest.id,
      title: p.pullRequest.title,
      state: p.pullRequest.state,
      source: p.pullRequest.fromRef.displayId,
      target: p.pullRequest.toRef.displayId,
      actor: actor(p.actor),
      at,
      raw: body,
    };
  }

  // Pipeline / build completion
  if (eventKey.includes("pipeline") || eventKey.includes("build")) {
    const parsed = BbPipelinePayload.safeParse(body);
    if (!parsed.success) return null;
    const p = parsed.data;
    return {
      kind: "pipeline",
      eventKey,
      repo: p.repository
        ? { projectKey: p.repository.project.key, repoSlug: p.repository.slug }
        : undefined,
      pipelineId: p.pipeline?.uuid,
      result: p.pipeline?.state?.result?.name ?? p.pipeline?.state?.name,
      commitSha: p.pipeline?.target?.commit?.hash,
      at,
      raw: body,
    };
  }

  log.debug({ eventKey }, "unknown bitbucket webhook event");
  return null;
}

function actor(a: z.infer<typeof BbActor> | undefined) {
  if (!a) return undefined;
  return { name: a.displayName ?? a.name, email: a.emailAddress };
}

function nowIso(body: unknown): string {
  const d = (body as { date?: unknown }).date;
  if (typeof d === "string") {
    const t = Date.parse(d);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}
