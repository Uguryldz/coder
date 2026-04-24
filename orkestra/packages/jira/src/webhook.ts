import { createLogger, loadConfig } from "@orkestra/config";
import { JiraTicket, JiraUser } from "@orkestra/contracts";
import crypto from "node:crypto";
import { z } from "zod";

const log = createLogger("jira.webhook");

// ---------------------------------------------------------------------------
// Webhook payload shapes (Jira sends a lot; we keep this tolerant)
// ---------------------------------------------------------------------------

const WebhookUser = z
  .object({
    accountId: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    emailAddress: z.string().optional(),
  })
  .passthrough();

const WebhookComment = z
  .object({
    id: z.string(),
    body: z.unknown(),
    author: WebhookUser.optional(),
    updateAuthor: WebhookUser.optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  })
  .passthrough();

const WebhookIssueFields = z
  .object({
    summary: z.string().default(""),
    description: z.unknown().optional(),
    project: z.object({ key: z.string() }),
    issuetype: z.object({ name: z.string() }).optional(),
    status: z.object({ name: z.string() }).optional(),
    priority: z.object({ name: z.string() }).optional().nullable(),
    labels: z.array(z.string()).default([]),
    components: z.array(z.object({ name: z.string() })).default([]),
    reporter: WebhookUser.nullable().optional(),
    assignee: WebhookUser.nullable().optional(),
    duedate: z.string().nullable().optional(),
  })
  .passthrough();

const WebhookIssue = z.object({
  id: z.string(),
  key: z.string(),
  fields: WebhookIssueFields,
});

const WebhookBody = z
  .object({
    webhookEvent: z.string().optional(),
    issue_event_type_name: z.string().optional(),
    timestamp: z.number().optional(),
    user: WebhookUser.optional(),
    issue: WebhookIssue.optional(),
    comment: WebhookComment.optional(),
    changelog: z.unknown().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Normalized event shapes
// ---------------------------------------------------------------------------

export interface JiraWebhookIssueEvent {
  kind: "issue";
  eventType: string;
  ticket: JiraTicket;
  actor?: JiraUser;
  at: string;
  raw: unknown;
}

export interface JiraWebhookCommentEvent {
  kind: "comment";
  eventType: string;
  ticket: JiraTicket;
  commentId: string;
  body: string;
  author?: JiraUser;
  at: string;
  raw: unknown;
}

export type JiraWebhookEvent = JiraWebhookIssueEvent | JiraWebhookCommentEvent;

// ---------------------------------------------------------------------------
// HMAC signature verification
// ---------------------------------------------------------------------------

export interface VerifiableRequest {
  rawBody: string | Buffer;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Verify an incoming Jira webhook HMAC signature.
 * Jira DC / Atlassian Connect send the signature in `x-hub-signature` or
 * `x-atlassian-webhook-identifier` depending on configuration; we accept
 * the raw signature as an explicit argument for flexibility.
 *
 * Expected signature format: `sha256=<hex>` or plain hex.
 */
export function verifyJiraWebhook(
  req: VerifiableRequest,
  signature: string | undefined,
  secret?: string,
): boolean {
  if (!signature) return false;
  const cfg = loadConfig();
  const key = secret ?? cfg.JIRA_WEBHOOK_SECRET;
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
// Parsing
// ---------------------------------------------------------------------------

export function parseJiraWebhook(body: unknown): JiraWebhookEvent | null {
  const parsed = WebhookBody.safeParse(body);
  if (!parsed.success) {
    log.debug({ err: parsed.error.flatten() }, "unparseable jira webhook body");
    return null;
  }
  const b = parsed.data;
  if (!b.issue) return null;

  const at = b.timestamp ? new Date(b.timestamp).toISOString() : new Date().toISOString();
  const eventType = b.webhookEvent ?? b.issue_event_type_name ?? "unknown";
  const ticket = issueToTicket(b.issue);
  const actor = userToContract(b.user);

  if (b.comment) {
    return {
      kind: "comment",
      eventType,
      ticket,
      commentId: b.comment.id,
      body: flattenBody(b.comment.body),
      author: userToContract(b.comment.author) ?? actor,
      at,
      raw: body,
    };
  }

  return {
    kind: "issue",
    eventType,
    ticket,
    actor,
    at,
    raw: body,
  };
}

function issueToTicket(issue: z.infer<typeof WebhookIssue>): JiraTicket {
  const f = issue.fields;
  const description =
    typeof f.description === "string" ? f.description : flattenBody(f.description);

  return JiraTicket.parse({
    id: issue.id,
    key: issue.key,
    projectKey: f.project.key,
    summary: f.summary,
    description,
    issueType: f.issuetype?.name ?? "Task",
    status: f.status?.name ?? "Open",
    priority: f.priority?.name,
    labels: f.labels,
    components: f.components.map((c) => c.name),
    reporter: userToContract(f.reporter ?? undefined),
    assignee: userToContract(f.assignee ?? undefined),
    dueDate: f.duedate ?? undefined,
    customFields: extractCustomFields(f),
    rawContent: issue,
  });
}

function userToContract(u: z.infer<typeof WebhookUser> | undefined): JiraUser | undefined {
  if (!u) return undefined;
  const accountId = u.accountId ?? u.key ?? u.name;
  if (!accountId) return undefined;
  return JiraUser.parse({
    accountId,
    name: u.displayName ?? u.name,
    email: u.emailAddress,
  });
}

function extractCustomFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith("customfield_")) out[k] = v;
  }
  return out;
}

function flattenBody(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flattenBody).join("");
  if (typeof v === "object") {
    const n = v as { text?: string; content?: unknown; type?: string };
    if (typeof n.text === "string") return n.text;
    const inner = flattenBody(n.content ?? []);
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") {
      return inner + "\n";
    }
    return inner;
  }
  return "";
}
