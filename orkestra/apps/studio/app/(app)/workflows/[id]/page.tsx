import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/lib/db";
import { WORKFLOW_STATUS_LABELS, WORK_MODE_LABELS } from "@/lib/role-meta";
import { formatDate } from "@/lib/utils";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WorkflowDetailClient } from "./workflow-detail-client";

export const dynamic = "force-dynamic";

export default async function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await db.workflowRun.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { startedAt: "asc" } },
      decisions: { orderBy: { decidedAt: "desc" } },
    },
  });
  if (!run) notFound();

  const audits = await db.auditLog.findMany({
    where: { workflowRunId: id },
    orderBy: { id: "desc" },
    take: 50,
  });

  const statusVariant: "success" | "destructive" | "warning" | "secondary" =
    run.status === "done"
      ? "success"
      : run.status === "failed" || run.status === "blocked" || run.status === "cancelled"
        ? "destructive"
        : run.status.startsWith("waiting")
          ? "warning"
          : "secondary";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href="/workflows"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> İş Akışları
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{run.jiraTicketId}</h1>
          <Badge variant="secondary">{run.jiraProjectKey}</Badge>
          <Badge variant={statusVariant}>{WORKFLOW_STATUS_LABELS[run.status] ?? run.status}</Badge>
          <Badge variant="outline">{WORK_MODE_LABELS[run.workMode] ?? run.workMode}</Badge>
        </div>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 p-4 text-xs md:grid-cols-4">
          <Info label="Adım" value={run.currentStep} />
          <Info label="Başlama" value={formatDate(run.startedAt)} />
          <Info label="Bitiş" value={run.completedAt ? formatDate(run.completedAt) : "-"} />
          <Info label="Maliyet" value={`$${(run.tokenCostUsdCents / 100).toFixed(2)}`} />
          <Info label="Tokens" value={`${run.tokensIn}↓ / ${run.tokensOut}↑`} />
          <Info label="Önbellek Hit" value={String(run.cacheHits)} />
          <Info label="Hata Sayısı" value={String(run.errorCount)} />
          <Info label="Yeniden Deneme" value={String(run.retryCount)} />
        </CardContent>
      </Card>

      <WorkflowDetailClient
        workflowId={run.id}
        status={run.status}
        currentMode={run.workMode}
        steps={run.steps.map((s) => ({
          id: s.id,
          stepName: s.stepName,
          agentRole: s.agentRole,
          status: s.status,
          attempt: s.attempt,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt ? s.endedAt.toISOString() : null,
          errorMessage: s.errorMessage,
          tokensIn: s.tokensIn,
          tokensOut: s.tokensOut,
          costUsdCents: s.costUsdCents,
          outputKey: s.outputKey,
          model: s.model,
        }))}
        decisions={run.decisions.map((d) => ({
          id: d.id,
          stepName: d.stepName,
          jiraUsername: d.jiraUsername,
          decision: d.decision,
          reason: d.reason,
          command: d.command,
          decidedAt: d.decidedAt.toISOString(),
        }))}
        audits={audits.map((a) => ({
          id: a.id.toString(),
          actor: a.actor,
          action: a.action,
          timestamp: a.timestamp.toISOString(),
          payload: a.payload,
        }))}
      />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}
