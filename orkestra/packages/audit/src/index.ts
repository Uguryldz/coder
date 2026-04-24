import { createLogger } from "@orkestra/config";
import { getDb } from "@orkestra/db";
import crypto from "node:crypto";

const log = createLogger("audit");

const GENESIS = "0".repeat(64);

/**
 * Append an audit entry with hash chain.
 * `thisHash = sha256(prevHash || action || actor || subject || payloadJson || ts)`
 * Any later tampering breaks the chain.
 */
export async function audit(params: {
  workflowRunId?: string | null;
  actor: string;
  action: string;
  subject?: string;
  payload?: unknown;
}): Promise<void> {
  const db = getDb();
  const last = await db.auditLog.findFirst({
    where: params.workflowRunId ? { workflowRunId: params.workflowRunId } : {},
    orderBy: { id: "desc" },
  });
  const prevHash = last?.thisHash ?? GENESIS;
  const timestamp = new Date().toISOString();
  const payload = params.payload ?? {};
  const h = crypto.createHash("sha256");
  h.update(prevHash);
  h.update("\x1f");
  h.update(params.action);
  h.update("\x1f");
  h.update(params.actor);
  h.update("\x1f");
  h.update(params.subject ?? "");
  h.update("\x1f");
  h.update(JSON.stringify(payload));
  h.update("\x1f");
  h.update(timestamp);
  const thisHash = h.digest("hex");

  await db.auditLog.create({
    data: {
      workflowRunId: params.workflowRunId ?? null,
      actor: params.actor,
      action: params.action,
      subject: params.subject,
      payload: payload as object,
      prevHash,
      thisHash,
    },
  });

  log.debug(
    { action: params.action, actor: params.actor, workflowRunId: params.workflowRunId },
    "audit",
  );
}

/**
 * Verify entire audit chain for a workflow (or global).
 * Returns the id of the first tampered entry, or null if clean.
 */
export async function verifyChain(workflowRunId?: string): Promise<bigint | null> {
  const db = getDb();
  const entries = await db.auditLog.findMany({
    where: workflowRunId ? { workflowRunId } : {},
    orderBy: { id: "asc" },
  });
  let expectedPrev = GENESIS;
  for (const e of entries) {
    if (e.prevHash !== expectedPrev) return e.id;
    const h = crypto.createHash("sha256");
    h.update(e.prevHash);
    h.update("\x1f");
    h.update(e.action);
    h.update("\x1f");
    h.update(e.actor);
    h.update("\x1f");
    h.update(e.subject ?? "");
    h.update("\x1f");
    h.update(JSON.stringify(e.payload));
    h.update("\x1f");
    h.update(e.timestamp.toISOString());
    if (h.digest("hex") !== e.thisHash) return e.id;
    expectedPrev = e.thisHash;
  }
  return null;
}
