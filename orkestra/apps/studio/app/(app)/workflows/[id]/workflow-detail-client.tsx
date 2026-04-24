"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { WorkflowTimeline, type TimelineStep } from "@/components/workflow-timeline";
import { WORK_MODE_LABELS, WORKFLOW_STATUS_LABELS } from "@/lib/role-meta";
import { canWrite } from "@/lib/roles";
import { formatDate } from "@/lib/utils";
import { Ban, RotateCcw, Sliders } from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import * as React from "react";
import ReactMarkdown from "react-markdown";

const FINISHED = new Set(["done", "cancelled", "failed"]);
const WORK_MODES = ["full_auto", "ai_assist", "human_lead", "human_only"] as const;

type StepView = TimelineStep & {
  outputKey: string | null;
  model: string | null;
};

type Decision = {
  id: string;
  stepName: string;
  jiraUsername: string | null;
  decision: string;
  reason: string | null;
  command: string | null;
  decidedAt: string;
};

type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  timestamp: string;
  payload: unknown;
};

export function WorkflowDetailClient({
  workflowId,
  status,
  currentMode,
  steps,
  decisions,
  audits,
}: {
  workflowId: string;
  status: string;
  currentMode: string;
  steps: StepView[];
  decisions: Decision[];
  audits: AuditEntry[];
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const { push } = useToast();

  const [selectedStepId, setSelectedStepId] = React.useState<string | null>(
    steps.length > 0 ? steps[steps.length - 1].id : null,
  );
  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null;

  const writable = canWrite(session?.user?.role);
  const finished = FINISHED.has(status);

  async function cancel(reason: string) {
    const res = await fetch(`/api/workflows/${workflowId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      push({ title: "İş akışı iptal edildi", variant: "success" });
      router.refresh();
    } else {
      push({ title: "İptal başarısız", variant: "destructive" });
    }
  }

  async function retry() {
    const res = await fetch(`/api/workflows/${workflowId}/retry`, { method: "POST" });
    if (res.ok) {
      push({ title: "Tekrar başlatıldı", variant: "success" });
      router.refresh();
    } else {
      push({ title: "Hata", variant: "destructive" });
    }
  }

  async function changeMode(mode: string) {
    const res = await fetch(`/api/workflows/${workflowId}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workMode: mode }),
    });
    if (res.ok) {
      push({ title: "Mod değiştirildi", variant: "success" });
      router.refresh();
    } else {
      push({ title: "Hata", variant: "destructive" });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div
        className={`rounded-md border px-4 py-3 text-sm ${
          status === "done"
            ? "border-success/30 bg-success/5 text-success"
            : status === "failed" || status === "blocked" || status === "cancelled"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/30 bg-primary/5 text-primary"
        }`}
      >
        <span className="font-medium">Durum: </span>
        {WORKFLOW_STATUS_LABELS[status] ?? status}
      </div>

      {writable && (
        <div className="flex flex-wrap items-center gap-2">
          <CancelDialog disabled={finished} onConfirm={cancel} />
          <Button
            variant="outline"
            size="sm"
            onClick={retry}
            disabled={status !== "failed" && status !== "blocked"}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Tekrar Dene
          </Button>
          <ModeChangeControl currentMode={currentMode} onChange={changeMode} disabled={finished} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Adımlar</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkflowTimeline
              steps={steps}
              selectedStepId={selectedStepId}
              onSelectStep={setSelectedStepId}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {selectedStep ? selectedStep.stepName : "Adım Çıktısı"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedStep ? (
              <StepOutputPanel step={selectedStep} />
            ) : (
              <p className="text-sm text-muted-foreground">Bir adım seçin.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">İnsan Kararları</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {decisions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Karar yok.</p>
          ) : (
            <ul className="divide-y divide-border">
              {decisions.map((d) => (
                <li key={d.id} className="flex flex-col gap-1 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={decisionVariant(d.decision)}>{d.decision}</Badge>
                    <span className="font-mono">{d.stepName}</span>
                    <span className="text-muted-foreground">{d.jiraUsername ?? "bilinmiyor"}</span>
                    <span className="text-muted-foreground">{formatDate(d.decidedAt)}</span>
                  </div>
                  {d.reason && <p className="text-xs text-muted-foreground">{d.reason}</p>}
                  {d.command && (
                    <code className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">
                      {d.command}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Denetim Kayıtları</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {audits.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Kayıt yok.</p>
          ) : (
            <ul className="divide-y divide-border text-xs">
              {audits.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2">
                  <span className="font-mono">{a.action}</span>
                  <span className="text-muted-foreground">{a.actor}</span>
                  <span className="text-muted-foreground">{formatDate(a.timestamp)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function decisionVariant(d: string): "success" | "destructive" | "warning" | "secondary" {
  if (d === "approve") return "success";
  if (d === "reject" || d === "cancel") return "destructive";
  return "secondary";
}

function StepOutputPanel({ step }: { step: StepView }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<"smart" | "raw">("smart");

  React.useEffect(() => {
    if (!step.outputKey) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/workflows/artifact?key=${encodeURIComponent(step.outputKey)}`)
      .then((r) => {
        if (!r.ok) throw new Error("Çıktı alınamadı");
        return r.text();
      })
      .then((t) => {
        if (!cancelled) setContent(t);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step.outputKey]);

  const parsed = React.useMemo(() => {
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        <Info label="Model" value={step.model ?? "-"} />
        <Info label="Deneme" value={String(step.attempt)} />
        <Info label="Durum" value={step.status ?? "-"} />
        <Info label="Başlama" value={formatDate(step.startedAt)} />
        <Info label="Bitiş" value={step.endedAt ? formatDate(step.endedAt) : "-"} />
        <Info label="Tokens" value={`${step.tokensIn ?? 0}↓ / ${step.tokensOut ?? 0}↑`} />
        <Info label="Cache" value={String(step.cacheHits ?? 0)} />
        <Info label="Maliyet" value={`$${((step.costUsdCents ?? 0) / 100).toFixed(4)}`} />
        <Info label="Agent" value={step.agentRole ?? "-"} />
      </div>

      {step.errorMessage && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <strong>Hata:</strong> {step.errorMessage}
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Çıktı
          </span>
          {parsed && (
            <div className="flex gap-1 rounded border border-border bg-secondary/30 p-0.5 text-[10px]">
              <button
                className={`rounded px-1.5 py-0.5 ${view === "smart" ? "bg-background" : ""}`}
                onClick={() => setView("smart")}
              >
                📋 Detay
              </button>
              <button
                className={`rounded px-1.5 py-0.5 ${view === "raw" ? "bg-background" : ""}`}
                onClick={() => setView("raw")}
              >
                🧾 JSON
              </button>
            </div>
          )}
        </div>
        {!step.outputKey ? (
          <p className="text-xs text-muted-foreground">Bu adım için çıktı yok.</p>
        ) : loading ? (
          <p className="text-xs text-muted-foreground">Yükleniyor...</p>
        ) : error ? (
          <p className="text-xs text-destructive/70">
            Çıktı yüklenemedi. Anahtar: <code className="text-[10px]">{step.outputKey}</code>
          </p>
        ) : content ? (
          <div className="max-h-[520px] overflow-y-auto rounded-md border border-border bg-background p-3">
            {parsed && view === "smart" ? (
              <SmartOutputRenderer stepName={step.stepName} role={step.agentRole ?? null} data={parsed} />
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[11px]">
                {parsed ? JSON.stringify(parsed, null, 2) : content}
              </pre>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── SMART OUTPUT RENDERER ───
// AI ajanı çıktılarını okunabilir, kart/blok halinde göster
function SmartOutputRenderer({
  stepName,
  role,
  data,
}: {
  stepName: string;
  role: string | null;
  data: any;
}) {
  // INTAKE
  if (stepName.includes("intake") || role === "intake") {
    return (
      <div className="flex flex-col gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 font-medium ${data.complete ? "bg-green-500/10 text-green-700" : "bg-amber-500/10 text-amber-700"}`}>
            {data.complete ? "✓ Ticket tam" : "⚠ Eksik"}
          </span>
          {data.workMode && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-700">mode: {data.workMode}</span>}
        </div>
        {data.reasoning && <p className="text-muted-foreground">{data.reasoning}</p>}
        {data.missingFields?.length > 0 && (
          <div>
            <div className="font-medium text-amber-700">Eksik alanlar:</div>
            <ul className="list-inside list-disc">
              {data.missingFields.map((f: string) => <li key={f}>{f}</li>)}
            </ul>
          </div>
        )}
        {data.questions?.length > 0 && (
          <div>
            <div className="font-medium">Sorular (reporter'a):</div>
            <ul className="list-inside list-disc">
              {data.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // ANALYST
  if (stepName.includes("analyst") || role === "analyst") {
    return (
      <div className="flex flex-col gap-4 text-xs">
        {data.analysisDoc && (
          <Section title="📋 Analiz Dokümanı">
            <article className="prose prose-sm max-w-none">
              <ReactMarkdown>{data.analysisDoc}</ReactMarkdown>
            </article>
          </Section>
        )}
        {data.technicalDesign && (
          <Section title="🛠️ Teknik Tasarım">
            {data.technicalDesign.approach && <p className="mb-2"><strong>Yaklaşım:</strong> {data.technicalDesign.approach}</p>}
            {data.technicalDesign.filesToChange?.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 font-medium">Dosya değişiklikleri:</div>
                <ul className="space-y-1">
                  {data.technicalDesign.filesToChange.map((f: any, i: number) => (
                    <li key={i} className="rounded bg-secondary/40 px-2 py-1">
                      <span className={`mr-1 text-[10px] font-bold ${f.action === "create" ? "text-green-600" : f.action === "delete" ? "text-red-600" : "text-blue-600"}`}>[{f.action}]</span>
                      <code>{f.path}</code>
                      {f.rationale && <div className="mt-0.5 text-[10px] text-muted-foreground">{f.rationale}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.technicalDesign.alternatives?.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 font-medium">Alternatifler:</div>
                <ul className="list-inside list-disc text-muted-foreground">
                  {data.technicalDesign.alternatives.map((a: string, i: number) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
          </Section>
        )}
        {data.acceptanceCriteria?.length > 0 && (
          <Section title="✅ Kabul Kriterleri">
            <ul className="space-y-1">
              {data.acceptanceCriteria.map((ac: string, i: number) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 text-green-600">✓</span>
                  <span>{ac}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {data.risks?.length > 0 && (
          <Section title="⚠️ Riskler">
            <ul className="space-y-1">
              {data.risks.map((r: any, i: number) => (
                <li key={i} className="rounded border-l-2 border-amber-500 bg-amber-500/5 px-2 py-1">
                  <span className={`mr-2 rounded px-1 text-[10px] ${r.severity === "high" ? "bg-red-500/20 text-red-700" : r.severity === "medium" ? "bg-amber-500/20 text-amber-700" : "bg-secondary"}`}>{r.severity}</span>
                  {r.description}
                  {r.mitigation && <div className="mt-0.5 text-[10px] text-muted-foreground">Mitigation: {r.mitigation}</div>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {data.estimationHours !== undefined && (
          <div className="text-muted-foreground">⏱️ Tahmini: <strong>{data.estimationHours} saat</strong></div>
        )}
      </div>
    );
  }

  // DEVELOPER
  if (stepName.includes("developer") || role === "developer") {
    return (
      <div className="flex flex-col gap-3 text-xs">
        {data.filesChanged?.length > 0 && (
          <Section title={`📂 Değişen Dosyalar (${data.filesChanged.length})`}>
            <ul className="space-y-0.5">
              {data.filesChanged.map((f: string, i: number) => (
                <li key={i}><code className="rounded bg-secondary/40 px-1.5 py-0.5">{f}</code></li>
              ))}
            </ul>
          </Section>
        )}
        {data.explanation && (
          <Section title="💡 Açıklama">
            <p>{data.explanation}</p>
          </Section>
        )}
        {data.patch && (
          <Section title="🔨 Patch (unified diff)">
            <pre className="max-h-80 overflow-auto whitespace-pre rounded bg-secondary/20 p-2 font-mono text-[10px] leading-relaxed">
              {data.patch.split("\n").map((line: string, i: number) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "bg-green-500/10 text-green-800"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "bg-red-500/10 text-red-800"
                        : line.startsWith("@@")
                          ? "bg-blue-500/10 text-blue-700 font-bold"
                          : line.startsWith("diff ")
                            ? "font-bold text-purple-700"
                            : ""
                  }
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          </Section>
        )}
        {data.prDescription && (
          <Section title="📝 PR Açıklaması">
            <article className="prose prose-sm max-w-none">
              <ReactMarkdown>{data.prDescription}</ReactMarkdown>
            </article>
          </Section>
        )}
        {data.newDependencies?.length > 0 && (
          <Section title="📦 Yeni Bağımlılıklar">
            <ul className="list-inside list-disc">
              {data.newDependencies.map((d: string, i: number) => <li key={i}><code>{d}</code></li>)}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // DEV-REVIEWER
  if (stepName.includes("reviewer") || role === "dev_reviewer") {
    const verdictColor =
      data.verdict === "approve"
        ? "bg-green-500/10 text-green-700"
        : "bg-amber-500/10 text-amber-800";
    return (
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 font-medium ${verdictColor}`}>
            {data.verdict === "approve" ? "✓ APPROVE" : "⚠ CHANGES REQUESTED"}
          </span>
          {data.breaking && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-700">🚨 breaking</span>}
          {data.severity && <span className="rounded bg-secondary/50 px-1.5 py-0.5">severity: {data.severity}</span>}
        </div>
        {data.summary && (
          <Section title="📋 Özet">
            <p>{data.summary}</p>
          </Section>
        )}
        {data.comments?.length > 0 && (
          <Section title={`💬 Yorumlar (${data.comments.length})`}>
            <ul className="space-y-2">
              {data.comments.map((c: any, i: number) => (
                <li
                  key={i}
                  className={`rounded border-l-4 px-3 py-2 ${
                    c.severity === "blocking"
                      ? "border-red-500 bg-red-500/5"
                      : c.severity === "major"
                        ? "border-amber-500 bg-amber-500/5"
                        : c.severity === "minor"
                          ? "border-blue-500 bg-blue-500/5"
                          : "border-gray-300 bg-secondary/30"
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2 text-[10px]">
                    <span className="rounded bg-secondary/60 px-1 py-0.5 font-bold uppercase">{c.severity}</span>
                    {c.file && (
                      <code className="rounded bg-secondary/40 px-1 py-0.5">
                        {c.file}{c.line && `:${c.line}`}
                      </code>
                    )}
                  </div>
                  <div className="text-sm">{c.message}</div>
                  {c.suggestion && (
                    <div className="mt-1 rounded bg-secondary/40 px-2 py-1 font-mono text-[10px]">
                      💡 {c.suggestion}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // TEST-DESIGNER
  if (stepName.includes("test-designer") || role === "test_designer") {
    return (
      <div className="flex flex-col gap-2 text-xs">
        {data.scenarios && (
          <Section title={`🧪 Test Senaryoları (${data.scenarios.length})`}>
            <ul className="space-y-2">
              {data.scenarios.map((s: any, i: number) => (
                <li key={i} className="rounded border border-border bg-secondary/20 p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <strong>{s.title}</strong>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      s.type === "unit" ? "bg-blue-500/10 text-blue-700"
                        : s.type === "integration" ? "bg-purple-500/10 text-purple-700"
                          : "bg-orange-500/10 text-orange-700"
                    }`}>{s.type}</span>
                    {s.negative && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-700">negative</span>}
                    {s.framework && <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-[10px]">{s.framework}</span>}
                  </div>
                  {s.gherkin && (
                    <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-1.5 font-mono text-[10px]">{s.gherkin}</pre>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // TEST-REVIEWER
  if (stepName.includes("test-reviewer") || role === "test_reviewer") {
    return (
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 font-medium ${data.verdict === "approve" ? "bg-green-500/10 text-green-700" : "bg-amber-500/10 text-amber-700"}`}>
            {data.verdict}
          </span>
        </div>
        {data.coverage && (
          <Section title="📊 Coverage">
            <div className="grid grid-cols-2 gap-1 text-[11px]">
              {Object.entries(data.coverage).filter(([k]) => k !== "gaps").map(([k, v]) => (
                <div key={k} className="flex items-center gap-1">
                  <span>{v === true ? "✓" : v === false ? "✗" : "•"}</span>
                  <span className="text-muted-foreground">{k}:</span>
                  <span>{String(v)}</span>
                </div>
              ))}
            </div>
            {data.coverage.gaps?.length > 0 && (
              <div className="mt-2 rounded bg-amber-500/5 p-1.5">
                <div className="font-medium text-amber-700">Eksikler:</div>
                <ul className="list-inside list-disc">
                  {data.coverage.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}
                </ul>
              </div>
            )}
          </Section>
        )}
        {data.comments?.length > 0 && (
          <Section title="Yorumlar">
            <ul className="list-inside list-disc">
              {data.comments.map((c: string, i: number) => <li key={i}>{c}</li>)}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // TEST-RUNNER
  if (stepName.includes("test-runner") || role === "test_runner") {
    return (
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 font-medium ${data.overallPassed ? "bg-green-500/10 text-green-700" : "bg-red-500/10 text-red-700"}`}>
            {data.overallPassed ? "✓ PASS" : "✗ FAIL"}
          </span>
          {data.coveragePct !== undefined && (
            <span className="rounded bg-secondary/50 px-1.5 py-0.5">Coverage: {data.coveragePct}%</span>
          )}
          {data.flaky?.length > 0 && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700">🌀 {data.flaky.length} flaky</span>
          )}
        </div>
        {data.results?.length > 0 && (
          <Section title={`Sonuçlar (${data.results.length})`}>
            <ul className="space-y-1">
              {data.results.map((r: any, i: number) => (
                <li key={i} className="flex items-center gap-2 rounded bg-secondary/20 px-2 py-1">
                  <span>{r.passed ? "✓" : "✗"}</span>
                  <span className="flex-1 truncate">{r.scenarioTitle}</span>
                  <span className="text-[10px] text-muted-foreground">{r.durationMs}ms</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // GENERIC JSON FALLBACK
  return (
    <pre className="whitespace-pre-wrap font-mono text-[11px]">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

function CancelDialog({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={disabled}>
          <Ban className="h-3.5 w-3.5" /> İptal Et
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>İş Akışını İptal Et</DialogTitle>
        </DialogHeader>
        <Textarea
          placeholder="Gerekçe (isteğe bağlı)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Vazgeç
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              setBusy(true);
              await onConfirm(reason);
              setBusy(false);
              setOpen(false);
            }}
            disabled={busy}
          >
            {busy ? "İptal ediliyor..." : "İptal Et"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeChangeControl({
  currentMode,
  onChange,
  disabled,
}: {
  currentMode: string;
  onChange: (mode: string) => Promise<void>;
  disabled: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <Sliders className="h-3.5 w-3.5 text-muted-foreground" />
      <Select
        value={currentMode}
        onValueChange={async (v) => {
          if (v === currentMode) return;
          setBusy(true);
          await onChange(v);
          setBusy(false);
        }}
        disabled={disabled || busy}
      >
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORK_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {WORK_MODE_LABELS[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
