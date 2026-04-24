import { createLogger, loadConfig } from "@orkestra/config";
import type { JiraCommand, JiraCommentSignal } from "@orkestra/contracts";
import { getDb } from "@orkestra/db";
import {
  aiAnalyzeSignal,
  aiExplainSignal,
  aiHandoffSignal,
  aiTakeoverSignal,
  aiWriteTestSignal,
  approveSignal,
  cancelSignal,
  clarificationAnsweredSignal,
  modeChangeSignal,
  rejectSignal,
  retrySignal,
} from "@orkestra/workflows";
import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { getTemporalClient } from "../temporal.js";

const log = createLogger("jira-webhook");

function verifySignature(body: string, signature: string | undefined): boolean {
  const cfg = loadConfig();
  if (!signature) return process.env.NODE_ENV !== "production";
  const expected = crypto.createHmac("sha256", cfg.JIRA_WEBHOOK_SECRET).update(body).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const COMMAND_REGEX = /^\/([a-z][a-z0-9-]*)\s*(.*)$/im;

function parseCommand(body: string): { command: JiraCommand; args: string } | null {
  const trimmed = body.trim();
  const match = trimmed.match(COMMAND_REGEX);
  if (!match) return null;
  const cmd = match[1]!.toLowerCase();
  const valid = [
    "approve",
    "reject",
    "cancel",
    "ai-analyze",
    "ai-write-test",
    "ai-explain",
    "ai-takeover",
    "ai-handoff",
    "mode-change",
    "retry",
    "status",
  ];
  if (!valid.includes(cmd)) return null;
  return { command: cmd as JiraCommand, args: (match[2] ?? "").trim() };
}

const SIGNAL_MAP = {
  approve: approveSignal,
  reject: rejectSignal,
  cancel: cancelSignal,
  retry: retrySignal,
  "ai-analyze": aiAnalyzeSignal,
  "ai-write-test": aiWriteTestSignal,
  "ai-explain": aiExplainSignal,
  "ai-takeover": aiTakeoverSignal,
  "ai-handoff": aiHandoffSignal,
  "mode-change": modeChangeSignal,
  status: null,
} as const;

export async function jiraWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/jira", async (req: FastifyRequest, reply) => {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const sig = req.headers["x-hub-signature"] as string | undefined;
    if (!verifySignature(raw, sig)) {
      log.warn({ ip: req.ip }, "jira webhook signature mismatch");
      return reply.status(401).send({ error: "bad signature" });
    }

    const payload = req.body as Record<string, unknown> | undefined;
    if (!payload) return reply.status(400).send({ error: "empty body" });

    const eventType = (payload.webhookEvent as string | undefined) ?? "";
    const correlationId = (req.headers["x-correlation-id"] as string) ?? crypto.randomUUID();
    log.info({ eventType, correlationId }, "jira webhook");

    try {
      if (eventType === "jira:issue_created") {
        await handleIssueCreated(payload, correlationId);
      } else if (eventType === "comment_created" || eventType.startsWith("comment_")) {
        await handleCommentCreated(payload, correlationId);
      } else if (eventType === "jira:issue_updated") {
        // future: handle updates (priority change, reassign)
      }
    } catch (e) {
      log.error({ err: String(e) }, "jira webhook handler error");
      return reply.status(500).send({ error: "handler failed" });
    }
    return reply.send({ ok: true });
  });
}

async function handleIssueCreated(
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<void> {
  const issue = payload.issue as
    | { id: string; key: string; fields: { project?: { key?: string } } }
    | undefined;
  if (!issue) return;
  const client = await getTemporalClient();
  const workflowId = `ticket-${issue.key}`;
  try {
    await client.workflow.start("ticketLifecycleWorkflow", {
      workflowId,
      taskQueue: "orkestra-default",
      args: [
        {
          ticketId: issue.id,
          ticketKey: issue.key,
          projectKey: issue.fields?.project?.key ?? "UNKNOWN",
          correlationId,
        },
      ],
    });
    log.info({ workflowId }, "workflow started");
  } catch (e) {
    const msg = String(e);
    if (/already started|WorkflowExecutionAlreadyStarted/i.test(msg)) {
      log.debug({ workflowId }, "workflow already started, ignoring");
    } else {
      throw e;
    }
  }
}

async function handleCommentCreated(
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<void> {
  const comment = payload.comment as
    | { id: string; body: string; author: { accountId: string; displayName?: string } }
    | undefined;
  const issue = payload.issue as { id: string; key: string } | undefined;
  if (!comment || !issue) return;

  // Parse commands (plain text). ADF body may arrive too; handle string form.
  const bodyText = typeof comment.body === "string" ? comment.body : JSON.stringify(comment.body);
  const parsed = parseCommand(bodyText);

  // Clarification-answered: any comment from reporter while workflow is waiting
  const db = getDb();
  const run = await db.workflowRun.findFirst({
    where: { jiraTicketId: issue.id },
    orderBy: { startedAt: "desc" },
  });

  const client = await getTemporalClient();
  const workflowId = `ticket-${issue.key}`;
  const handle = client.workflow.getHandle(workflowId);

  if (run?.currentStep === "2b-clarification") {
    await handle.signal(clarificationAnsweredSignal, {
      commentBody: bodyText,
      user: { accountId: comment.author.accountId, name: comment.author.displayName },
    });
    log.info({ ticketKey: issue.key }, "clarification-answered signal sent");
  }

  if (!parsed) return;

  const signal = (SIGNAL_MAP as Record<string, unknown>)[parsed.command];
  if (!signal) return;

  const sig: JiraCommentSignal = {
    workflowRunId: run?.id ?? "",
    ticketKey: issue.key,
    command: parsed.command,
    args: parsed.args,
    user: {
      accountId: comment.author.accountId,
      name: comment.author.displayName,
    },
    commentId: comment.id,
    at: new Date().toISOString(),
  };

  // Validate: is user authorized for this command?
  if (!(await isAuthorized(parsed.command, sig, run?.currentStep))) {
    log.warn(
      { ticket: issue.key, user: comment.author.accountId, cmd: parsed.command },
      "unauthorized command",
    );
    return;
  }

  await handle.signal(signal as Parameters<typeof handle.signal>[0], sig);
  log.info(
    { ticketKey: issue.key, cmd: parsed.command, userId: comment.author.accountId },
    "signal dispatched",
  );
}

async function isAuthorized(
  cmd: string,
  _sig: JiraCommentSignal,
  _currentStep?: string,
): Promise<boolean> {
  // Simple policy for MVP:
  // - /cancel, /ai-takeover, /ai-handoff, /mode-change, /retry require admin-level (checked via Jira custom field — future)
  // - /approve, /reject — authorization enforced by workflow (wrong state → ignored)
  // - /ai-analyze, /ai-write-test, /ai-explain — any authenticated commenter
  // Real policy lookup would hit Jira user groups; for now trust all and let workflow filter by state.
  void cmd;
  return true;
}
