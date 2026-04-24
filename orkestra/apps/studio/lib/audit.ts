import { db } from "@/lib/db";
import { createHash } from "crypto";

export function hashAuditEntry(prevHash: string, payload: unknown, timestamp: Date): string {
  const h = createHash("sha256");
  h.update(prevHash);
  h.update("\n");
  h.update(timestamp.toISOString());
  h.update("\n");
  h.update(JSON.stringify(payload));
  return h.digest("hex");
}

export async function appendAudit(params: {
  actor: string;
  action: string;
  subject?: string;
  payload?: Record<string, unknown>;
  workflowRunId?: string;
}): Promise<void> {
  const last = await db.auditLog.findFirst({ orderBy: { id: "desc" } });
  const prevHash = last?.thisHash ?? "GENESIS";
  const ts = new Date();
  const payload = params.payload ?? {};
  const thisHash = hashAuditEntry(prevHash, { ...params, payload }, ts);
  await db.auditLog.create({
    data: {
      actor: params.actor,
      action: params.action,
      subject: params.subject,
      payload: payload as object,
      prevHash,
      thisHash,
      timestamp: ts,
      workflowRunId: params.workflowRunId,
    },
  });
}

export async function verifyAuditChain(): Promise<{
  ok: boolean;
  total: number;
  brokenAt?: string;
}> {
  const entries = await db.auditLog.findMany({ orderBy: { id: "asc" } });
  let prev = "GENESIS";
  for (const e of entries) {
    if (e.prevHash !== prev) {
      return { ok: false, total: entries.length, brokenAt: e.id.toString() };
    }
    const expected = hashAuditEntry(
      prev,
      {
        actor: e.actor,
        action: e.action,
        subject: e.subject ?? undefined,
        payload: e.payload,
      },
      e.timestamp,
    );
    if (expected !== e.thisHash) {
      return { ok: false, total: entries.length, brokenAt: e.id.toString() };
    }
    prev = e.thisHash;
  }
  return { ok: true, total: entries.length };
}
