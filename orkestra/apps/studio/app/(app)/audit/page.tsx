import { db } from "@/lib/db";
import { AuditClient } from "./audit-client";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const entries = await db.auditLog.findMany({
    orderBy: { id: "desc" },
    take: 200,
  });
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Denetim Kaydı</h1>
        <p className="text-sm text-muted-foreground">
          Kriptografik olarak zincirlenmiş, sadece-eklenir kayıt defteri.
        </p>
      </div>
      <AuditClient
        entries={entries.map((e) => ({
          id: e.id.toString(),
          actor: e.actor,
          action: e.action,
          subject: e.subject,
          prevHash: e.prevHash,
          thisHash: e.thisHash,
          timestamp: e.timestamp.toISOString(),
          payload: e.payload,
          workflowRunId: e.workflowRunId,
        }))}
      />
    </div>
  );
}
