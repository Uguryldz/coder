import { createLogger, loadConfig } from "@orkestra/config";
import { getDb } from "@orkestra/db";
import { ciResultSignal, prApprovedSignal, prReviewChangesSignal } from "@orkestra/workflows";
import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { getTemporalClient } from "../temporal.js";

const log = createLogger("bitbucket-webhook");

function verify(body: string, signature: string | undefined): boolean {
  const cfg = loadConfig();
  if (!signature) return process.env.NODE_ENV !== "production";
  const expected = crypto
    .createHmac("sha256", cfg.BITBUCKET_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function bitbucketWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/bitbucket", async (req: FastifyRequest, reply) => {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const sig = req.headers["x-hub-signature"] as string | undefined;
    if (!verify(raw, sig)) {
      log.warn({ ip: req.ip }, "bitbucket webhook signature mismatch");
      return reply.status(401).send({ error: "bad signature" });
    }

    const eventKey = (req.headers["x-event-key"] as string) ?? "";
    const payload = req.body as Record<string, unknown> | undefined;
    if (!payload) return reply.status(400).send({ error: "empty body" });

    log.info({ eventKey }, "bitbucket webhook");
    try {
      if (eventKey.startsWith("pr:")) {
        await handlePullRequestEvent(eventKey, payload);
      } else if (eventKey.startsWith("pipeline:") || eventKey === "build:updated") {
        await handleCIEvent(payload);
      }
    } catch (e) {
      log.error({ err: String(e) }, "bitbucket webhook handler error");
      return reply.status(500).send({ error: "handler failed" });
    }
    return reply.send({ ok: true });
  });
}

function extractTicketKeyFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const m = branch.match(/([A-Z]+-\d+)/);
  return m?.[1];
}

async function handlePullRequestEvent(
  eventKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const pr = (payload as { pullRequest?: { id?: number; fromRef?: { displayId?: string } } })
    .pullRequest;
  if (!pr) return;
  const sourceBranch = pr.fromRef?.displayId;
  const ticketKey = extractTicketKeyFromBranch(sourceBranch);
  if (!ticketKey) return;

  const db = getDb();
  const run = await db.workflowRun.findFirst({
    where: { jiraTicketId: { contains: ticketKey } },
    orderBy: { startedAt: "desc" },
  });
  if (!run?.temporalWorkflowId) return;

  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(run.temporalWorkflowId);

  if (eventKey === "pr:comment:added") {
    const comment = (payload as { comment?: { text?: string; author?: { name?: string } } })
      .comment;
    if (!comment?.text) return;
    if (/changes.?requested|request.?changes|needs.?work/i.test(comment.text)) {
      await handle.signal(prReviewChangesSignal, {
        prId: String(pr.id),
        commentBody: comment.text,
        author: comment.author?.name ?? "unknown",
      });
      log.info({ ticketKey }, "pr-review-changes signal sent");
    }
  } else if (eventKey === "pr:reviewer:approved") {
    await handle.signal(prApprovedSignal, {
      prId: String(pr.id),
      author: "reviewer",
    });
  }

  // Persist PR id on first opening
  if (eventKey === "pr:opened" && !run.prId) {
    await db.workflowRun.update({ where: { id: run.id }, data: { prId: String(pr.id) } });
  }
}

async function handleCIEvent(payload: Record<string, unknown>): Promise<void> {
  const build = (
    payload as { build?: { buildNumber?: string; status?: string; url?: string; branch?: string } }
  ).build;
  if (!build) return;
  const ticketKey = extractTicketKeyFromBranch(build.branch);
  if (!ticketKey) return;
  const db = getDb();
  const run = await db.workflowRun.findFirst({
    where: { jiraTicketId: { contains: ticketKey } },
    orderBy: { startedAt: "desc" },
  });
  if (!run?.temporalWorkflowId) return;
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(run.temporalWorkflowId);
  const success = build.status === "SUCCESSFUL" || build.status === "passed";
  await handle.signal(ciResultSignal, {
    success,
    url: build.url ?? "",
    reason: build.status,
  });
  log.info({ ticketKey, success, status: build.status }, "ci-result signal sent");
}
