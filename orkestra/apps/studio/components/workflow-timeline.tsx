"use client";

import { Badge } from "@/components/ui/badge";
import { cn, formatDate } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Circle, Clock, XCircle } from "lucide-react";

export interface TimelineStep {
  id: string;
  stepName: string;
  agentRole?: string | null;
  status: string;
  attempt: number;
  startedAt: Date | string;
  endedAt?: Date | string | null;
  errorMessage?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  cacheHits?: number;
  costUsdCents?: number;
}

export interface WorkflowTimelineProps {
  steps: TimelineStep[];
  selectedStepId?: string | null;
  onSelectStep?: (id: string) => void;
}

export function WorkflowTimeline({ steps, selectedStepId, onSelectStep }: WorkflowTimelineProps) {
  if (steps.length === 0) {
    return <p className="text-sm text-muted-foreground">Henüz adım kaydı yok.</p>;
  }

  return (
    <ol className="relative flex flex-col gap-0">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const active = selectedStepId === s.id;
        return (
          <li
            key={s.id}
            className={cn(
              "relative flex gap-3 pb-4 cursor-pointer",
              active && "bg-primary/5 rounded-md -mx-2 px-2",
            )}
            onClick={() => onSelectStep?.(s.id)}
          >
            {!last && (
              <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
            )}
            <div className="relative z-10 mt-0.5">
              <StatusIcon status={s.status} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{s.stepName}</span>
                {s.agentRole && (
                  <Badge variant="outline" className="text-[10px]">
                    {s.agentRole}
                  </Badge>
                )}
                <StatusBadge status={s.status} />
                {s.attempt > 1 && (
                  <Badge variant="warning" className="text-[10px]">
                    {s.attempt}. deneme
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatDate(s.startedAt)}
                {s.endedAt ? ` • ${formatDate(s.endedAt)}` : ""}
              </div>
              {s.tokensIn || s.tokensOut ? (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  tokens: {s.tokensIn ?? 0}↓ / {s.tokensOut ?? 0}↑
                  {typeof s.costUsdCents === "number" && s.costUsdCents > 0
                    ? ` • $${(s.costUsdCents / 100).toFixed(3)}`
                    : ""}
                </div>
              ) : null}
              {s.errorMessage && <p className="mt-1 text-xs text-destructive">{s.errorMessage}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle2 className="h-6 w-6 text-success" />;
  if (status === "failed") return <XCircle className="h-6 w-6 text-destructive" />;
  if (status === "retrying") return <AlertTriangle className="h-6 w-6 text-warning" />;
  if (status === "running") return <Clock className="h-6 w-6 text-primary animate-pulse" />;
  return <Circle className="h-6 w-6 text-muted-foreground" />;
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "success"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "retrying"
          ? "warning"
          : "secondary";
  return (
    <Badge
      variant={variant as "success" | "destructive" | "warning" | "secondary"}
      className="text-[10px]"
    >
      {status}
    </Badge>
  );
}
