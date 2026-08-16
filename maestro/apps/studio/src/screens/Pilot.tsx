import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import "./shared/screens.css";

/**
 * Screen: pilot — the pilot's REAL-Jira flow, driven from Studio (Dalga D).
 *
 * The pilot (apps/pilot, :7020) is the flow engine: it discovers a `maestro`
 * OPS ticket on the live Jira site, runs the analysis/code/scan/test/PR flow,
 * and opens two human gates the operator answers with `/approve` in the REAL
 * ticket. This screen is its FACE — the operator never leaves Studio. Every
 * call goes through the BFF proxy (`/studio/pilot/*`), which forwards to the
 * pilot; the pilot's own page keeps working, this is an additional door.
 *
 * WHY POLL, NOT EventSource. The pilot streams state over SSE and the BFF
 * passes it through (`/studio/pilot/events`), but the browser's `EventSource`
 * cannot attach the Studio bearer, and the proxy authenticates every request.
 * So this screen POLLS `/studio/pilot/state` on a short interval — the same
 * live picture, over a channel that carries the session token. The SSE
 * passthrough stays available for a future auth-carrying client.
 *
 * WATCH-ONLY, ON PURPOSE. This screen used to carry a "Başlat" button per
 * discovered ticket. It is gone, and its absence is the feature: "Canlı akış"
 * is a WINDOW onto what Maestro is already doing — the record of work happening
 * in Jira — not a console for launching it. Work enters the platform where the
 * work actually lives: somebody labels or comments on a real ticket and the
 * listening rules pick it up. A start button here offered a second, contrary
 * way in, and one that quietly invited an operator to re-run a job the engine
 * had already taken.
 *
 * `POST /studio/pilot/start` still EXISTS at the BFF and is still admin/
 * tech-lead gated; nothing here removes a capability from the platform. What is
 * removed is this screen's claim to be the place you use it. So there is no
 * roles gate on this screen at all any more: every session may read state and
 * events, and there is nothing left to refuse.
 */

/** Poll while the tab is open; a run at a gate is the one worth watching live. */
export const PILOT_REFRESH_MS = 4_000;

type StepState = "bekliyor" | "calisiyor" | "onay" | "tamam" | "hata";

interface DiscoveredTicket {
  readonly key: string;
  readonly summary: string;
  readonly status: string | null;
  readonly createdAt: string | null;
}

interface PilotStep {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly state: StepState;
  readonly notes: readonly string[];
}

/** Mirrors apps/pilot/src/state.ts `PilotState` — only the fields this screen reads. */
interface PilotStateWire {
  readonly runId: string | null;
  readonly ticketKey: string | null;
  readonly browseUrl: string | null;
  readonly jiraSite: string;
  readonly approverGroup: string;
  readonly running: boolean;
  readonly finished: boolean;
  readonly failure: string | null;
  readonly awaitingGate: string | null;
  readonly docsReady: boolean;
  readonly discovered: readonly DiscoveredTicket[];
  readonly steps: readonly PilotStep[];
}

/** Mirrors apps/pilot/src/state.ts `RunHistoryEntry` — a finished past run. */
interface RunHistoryWire {
  readonly runId: string;
  readonly ticketKey: string;
  readonly browseUrl: string | null;
  readonly flowType: string | null;
  readonly outcome: "tamamlandı" | "durduruldu" | "hata";
  readonly detail: string | null;
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly finishedAt: string;
}

const OUTCOME_TONE: Readonly<Record<RunHistoryWire["outcome"], BadgeTone>> = {
  "tamamlandı": "green",
  "durduruldu": "amber",
  "hata": "red",
};

const STEP_TONE: Readonly<Record<StepState, BadgeTone>> = {
  bekliyor: "gray",
  calisiyor: "blue",
  onay: "amber",
  tamam: "green",
  hata: "red",
};

export function PilotScreen(): ReactNode {
  const t = useT();
  const api = useApi();

  const query = useQuery({
    queryKey: ["pilot-state"],
    queryFn: ({ signal }) => api.get<PilotStateWire>("/studio/pilot/state", { signal }),
    refetchInterval: PILOT_REFRESH_MS,
    retry: false,
  });

  // The finished runs — the "geçmiş işler" list, so past work is visible and
  // not overwritten by the current run. Refreshed on the same beat as the state.
  const historyQuery = useQuery({
    queryKey: ["pilot-runs"],
    queryFn: ({ signal }) => api.get<{ runs: readonly RunHistoryWire[] }>("/studio/pilot/runs", { signal }),
    refetchInterval: PILOT_REFRESH_MS,
    retry: false,
  });
  const history = historyQuery.data?.runs ?? [];

  const state = query.data;
  const running = state?.running ?? false;
  const gateStep = state?.awaitingGate ?? null;

  const discoveredColumns: readonly Column<DiscoveredTicket>[] = [
    {
      key: "key",
      header: t("col.ticket"),
      cell: (ticket) => (
        <>
          <b className="screen-mono">{ticket.key}</b>
          <div className="screen-note">{ticket.summary}</div>
        </>
      ),
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (ticket) => ticket.status ?? "—",
    },
    {
      // What replaced the start button. A row that ends in blank space reads as
      // a control that failed to render; saying which ticket the engine is
      // actually on turns the same column into information — and it is the one
      // thing a watcher wants from this list.
      key: "live",
      header: "",
      align: "right",
      cell: (ticket) =>
        ticket.key === state?.ticketKey ? (
          <Badge tone={running ? "blue" : "gray"}>
            {running ? t("pilot.badge.running") : t("pilot.badge.idle")}
          </Badge>
        ) : (
          // `pilot.step.bekliyor` ("bekliyor" / "waiting") rather than a key of
          // this column's own: `packages/config/locales` is owned by another
          // agent this cycle and `t` THROWS on a key it does not have, so a new
          // one would take the screen down until both files landed. The word is
          // the right word; a dedicated `pilot.discovered.waiting` can replace
          // this once the catalog can be edited.
          <span className="screen-note">{t("pilot.step.bekliyor")}</span>
        ),
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("pilot.intro.title")} subtitle={t("pilot.intro.subtitle")}>
        <p className="screen-note">{t("pilot.intro.body")}</p>
        {state !== undefined ? (
          <p className="screen-note">
            {t("pilot.intro.site", { site: state.jiraSite, group: state.approverGroup })}
          </p>
        ) : null}
      </Card>

      <Card
        title={t("pilot.discovered.title")}
        subtitle={t("pilot.discovered.subtitle")}
        padded={false}
      >
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          <Table
            columns={discoveredColumns}
            rows={state?.discovered ?? []}
            rowKey={(ticket) => ticket.key}
            emptyLabel={t("pilot.discovered.empty")}
            caption={t("pilot.discovered.caption")}
          />
        </QueryState>
      </Card>

      {state !== undefined && state.ticketKey !== null ? (
        <Card
          title={t("pilot.run.title")}
          subtitle={t("pilot.run.subtitle")}
          actions={
            state.browseUrl !== null ? (
              <a
                className="ui-btn ui-btn--sm"
                href={state.browseUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t("pilot.run.open_jira")}
              </a>
            ) : undefined
          }
        >
          <p className="scr-row" style={{ gap: 8, alignItems: "center" }}>
            <b className="screen-mono">{state.ticketKey}</b>
            {running ? (
              <Badge tone="blue">{t("pilot.badge.running")}</Badge>
            ) : state.finished ? (
              <Badge tone="green">{t("pilot.badge.finished")}</Badge>
            ) : (
              <Badge tone="gray">{t("pilot.badge.idle")}</Badge>
            )}
            {state.failure !== null ? <Badge tone="red">{t("pilot.badge.failed")}</Badge> : null}
          </p>

          {gateStep !== null ? (
            <p className="screen-note" role="status">
              <Badge tone="amber">{t("pilot.gate.badge")}</Badge>{" "}
              {t("pilot.gate.instruction", { step: gateStep })}
            </p>
          ) : null}

          <div className="screen-steps" style={{ marginTop: 10 }}>
            {(state.steps ?? []).map((step) => (
              <div className="screen-step" key={step.id}>
                <span className="screen-step__num">{step.id}</span>
                <span className="screen-step__title">
                  {step.title}
                  <span className="screen-note"> {step.hint}</span>
                </span>
                <span className="screen-step__state">
                  <Badge tone={STEP_TONE[step.state]}>{t(`pilot.step.${step.state}`)}</Badge>
                </span>
              </div>
            ))}
          </div>

          {state.docsReady ? (
            <p className="scr-row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
              <span className="screen-note">{t("pilot.docs.ready")}</span>
              <DocLink kind="pdf" label={t("pilot.docs.pdf")} />
              <DocLink kind="docx" label={t("pilot.docs.docx")} />
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* Past work — the history of finished runs, so a completed job is not lost
          the moment the next one starts. Newest first. */}
      <Card title={t("pilot.history.title")} subtitle={t("pilot.history.subtitle")}>
        {history.length === 0 ? (
          <p className="screen-note">{t("pilot.history.empty")}</p>
        ) : (
          <div className="screen-steps">
            {history.map((run) => (
              <div className="screen-step" key={run.runId}>
                <span className="screen-step__title">
                  {run.browseUrl !== null ? (
                    <a href={run.browseUrl} target="_blank" rel="noreferrer noopener" className="screen-mono">
                      {run.ticketKey}
                    </a>
                  ) : (
                    <b className="screen-mono">{run.ticketKey}</b>
                  )}
                  <span className="screen-note">
                    {" "}
                    {run.flowType !== null ? `${run.flowType} · ` : ""}
                    {t("pilot.history.steps", { done: String(run.stepsDone), total: String(run.stepsTotal) })}
                    {run.detail !== null ? ` · ${run.detail}` : ""}
                  </span>
                </span>
                <span className="screen-step__state">
                  <Badge tone={OUTCOME_TONE[run.outcome]}>{run.outcome}</Badge>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * A download button for the generated analysis document. The bytes come through
 * the same authenticated proxy (`/studio/pilot/doc/:kind`) as everything else —
 * `getBlob` carries the session token, which is why this is not a plain `<a>`.
 */
function DocLink({ kind, label }: { readonly kind: "pdf" | "docx"; readonly label: string }): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();

  const download = async (): Promise<void> => {
    try {
      const blob = await api.getBlob(`/studio/pilot/doc/${kind}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `analiz.${kind}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show("error", t(messageKeyOf(error)));
    }
  };

  return (
    <Button size="sm" onClick={() => void download()}>
      {label}
    </Button>
  );
}
