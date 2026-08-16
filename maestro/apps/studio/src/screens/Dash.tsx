import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Kpi, riskTone } from "../ui/index.ts";
import type { BadgeTone } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunRow } from "./shared/runs.ts";
import { RunStatusCell, TicketsList } from "./Tickets.tsx";
import { StartGuide } from "./dash/StartGuide.tsx";
import {
  GUIDE_DISMISSED_KEY,
  readFlag,
  useSetupState,
  webhookAcked,
  writeFlag,
} from "./dash/setup-state.ts";
import "./shared/screens.css";

/**
 * Screen: dash — the operator's landing page.
 *
 * Every number on it is counted from `GET /studio/runs`, which joins the
 * platform catalog to the live workflow state. That is what makes the KPIs
 * mean what their labels say: "kapıda" counts runs whose workflow status IS
 * `gate`, not runs Temporal happens to call `running`. The mock also shows
 * runner pool capacity and a 24-hour activity feed; both need endpoints that do
 * not exist (`/runners`, `/activity`), so they are requested in the report
 * rather than filled with plausible-looking constants. A dashboard that invents
 * its own figures is worse than one that admits it has none.
 */

const ATTENTION_LIMIT = 5;

/** Statuses that mean a human has to look: a failure, or a handover (M96). */
function needsHuman(run: RunRow): boolean {
  return run.status === "fail" || run.status === "handover";
}

/** Mirrors apps/pilot/src/state.ts `RunHistoryEntry` — same wire type Pilot.tsx reads. */
interface PilotRunWire {
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

const PILOT_OUTCOME_TONE: Readonly<Record<PilotRunWire["outcome"], BadgeTone>> = {
  "tamamlandı": "green",
  "durduruldu": "amber",
  "hata": "red",
};

export function DashScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const navigate = useNavigate();
  /**
   * The four KPI tiles are counted from THIS response, and `TicketsList` below
   * fetches the same endpoint with the same default scope — so both see the
   * same set and the tiles cannot claim a number the list does not show.
   *
   * That agreement is the whole reason the archive filter lives on the server
   * (0019). Hiding archived runs by filtering in `TicketsList` alone would have
   * left these tiles counting twelve failures over a list showing none, which
   * is a worse dashboard than the one that started this: a wrong number an
   * operator cannot reconcile against anything.
   *
   * No `archived` argument, deliberately: the BFF's default IS "active", and
   * spelling it out here would create a second place to keep that decision.
   */
  const { data, isPending, error, refetch } = useRuns(200);

  // Is the flow engine (pilot) alive? If its state cannot be read, no job can
  // run and the operator would otherwise not know — the dashboard shows work,
  // not the absence of a worker. A short poll drives a plain alert when it is
  // unreachable, so "nobody is processing tickets" is visible, not silent.
  const pilot = useQuery({
    queryKey: ["pilot-health"],
    queryFn: ({ signal }) =>
      api.get<{ running: boolean; ticketKey: string | null }>("/studio/pilot/state", { signal }),
    refetchInterval: 15_000,
    retry: false,
  });
  const pilotDown = pilot.isError;

  // The engine's REAL jobs — the pilot's own run history, not the DB catalog.
  // Same endpoint and shape the Pilot screen reads (`/studio/pilot/runs`).
  const pilotRuns = useQuery({
    queryKey: ["pilot-runs"],
    queryFn: ({ signal }) =>
      api.get<{ runs: readonly PilotRunWire[] }>("/studio/pilot/runs", { signal }),
    refetchInterval: 15_000,
    retry: false,
  });
  const engineJobs = pilotRuns.data?.runs ?? [];
  const runningTicket = pilot.data?.running === true ? pilot.data.ticketKey : null;

  const runs = useMemo(() => data?.runs ?? [], [data]);

  const stats = useMemo(() => {
    const open = runs.filter((run) => run.status === "running");
    const gate = runs.filter((run) => run.status === "gate");
    const done = runs.filter((run) => run.status === "done");
    const broken = runs.filter(needsHuman);
    return { open, gate, done, broken };
  }, [runs]);

  /**
   * "Needs attention" is derived, not guessed. The order is the order a human
   * should work the queue in: broken first (a failure blocks everything behind
   * it), then runs parked at a gate (a decision only a person can make), each
   * group oldest-first. Gates are visible here for the first time — the old
   * `/runs` could not tell a gate from any other running execution, so this
   * list could only ever offer "oldest running".
   */
  const attention = useMemo(() => {
    const byAgeAsc = (a: RunRow, b: RunRow) => Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return [...stats.broken.sort(byAgeAsc), ...stats.gate.sort(byAgeAsc)].slice(0, ATTENTION_LIMIT);
  }, [stats]);

  /**
   * Whether to show the "where do I start" checklist.
   *
   * This used to be "there are no runs yet", which was wrong in the one case
   * that matters: a deployment with tickets already flowing but the setup only
   * half done (no webhook, most connections unwired) hid the very card that
   * would have explained the gap. The trigger is now the SETUP's own state —
   * any open step shows the guide, however much work has been through it.
   *
   * "Hide" is honoured as a display preference, but it is not a completion
   * claim: `setupIncomplete` below stays true and the Panel keeps a one-line
   * reminder with a way back, so the gap can be silenced but not lost.
   */
  const [webhookAck, setWebhookAck] = useState(() => webhookAcked());
  const [dismissed, setDismissed] = useState(() => readFlag(GUIDE_DISMISSED_KEY));
  const setup = useSetupState(webhookAck);
  const setupIncomplete = !setup.loading && !setup.complete;
  const showGuide = setupIncomplete && !dismissed;

  return (
    <div className="screen-stack">
      {pilotDown && (
        <div className="dash-alert" role="alert">
          <span className="dash-alert__icon">⚠</span>
          <div>
            <b>{t("dash.pilot_down.title")}</b>
            <div className="screen-note">{t("dash.pilot_down.body")}</div>
          </div>
        </div>
      )}

      {/* The engine's real jobs, on top: what the pilot is running NOW and what
          it actually finished. Hidden while the pilot is unreachable — the
          alert above already says so, and an empty card would double the news. */}
      {!pilotDown && !pilotRuns.isError && (
        <Card title={t("dash.live.title")} subtitle={t("dash.live.subtitle")}>
          {runningTicket === null && engineJobs.length === 0 ? (
            <p className="screen-note">{t("dash.live.empty")}</p>
          ) : (
            <div className="screen-steps">
              {runningTicket !== null && (
                <button
                  type="button"
                  className="screen-step"
                  style={{ cursor: "pointer", width: "100%", textAlign: "left" }}
                  onClick={() => void navigate("/pilot")}
                >
                  <span className="screen-step__title">
                    <b className="screen-mono">{runningTicket}</b>
                  </span>
                  <span className="screen-step__state">
                    <Badge tone="blue">{t("dash.live.now")}</Badge>
                  </span>
                </button>
              )}
              {engineJobs.map((job) => {
                const age = ageLabel(job.finishedAt);
                return (
                  <button
                    key={job.runId}
                    type="button"
                    className="screen-step"
                    style={{ cursor: "pointer", width: "100%", textAlign: "left" }}
                    onClick={() => void navigate("/pilot")}
                  >
                    <span className="screen-step__title">
                      <b className="screen-mono">{job.ticketKey}</b>
                      <span className="screen-note">
                        {" "}
                        {job.flowType !== null ? `${job.flowType} · ` : ""}
                        {t("pilot.history.steps", {
                          done: String(job.stepsDone),
                          total: String(job.stepsTotal),
                        })}
                        {age === null ? "" : ` · ${t(age.key, age.params)}`}
                      </span>
                    </span>
                    <span className="screen-step__state">
                      <Badge tone={PILOT_OUTCOME_TONE[job.outcome] ?? "gray"}>{job.outcome}</Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {showGuide && (
        <StartGuide
          setup={setup}
          onWebhookAck={setWebhookAck}
          onDismiss={() => {
            writeFlag(GUIDE_DISMISSED_KEY, true);
            setDismissed(true);
          }}
        />
      )}

      {/* Hidden but not finished: one honest line, and the way back. Without
          this, "gizle" would quietly become "tamamlandı". */}
      {setupIncomplete && dismissed && (
        <div className="dash-setup-note" role="note">
          <span>{t("dash.start.hidden_note")}</span>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              writeFlag(GUIDE_DISMISSED_KEY, false);
              setDismissed(false);
            }}
          >
            {t("dash.start.show_again")}
          </Button>
        </div>
      )}

      <QueryState
        isPending={isPending}
        error={error}
        onRetry={() => void refetch()}
        skeletonRows={6}
        isEmpty={runs.length === 0}
        emptyTitle={t("dash.empty.title")}
        emptyDescription={t("dash.empty.description")}
      >
        <div className="screen-grid screen-grid--4">
          <Kpi
            label={t("dash.kpi.active")}
            value={String(stats.open.length)}
            note={t("dash.kpi.active_note", { n: String(stats.broken.length) })}
          />
          <Kpi
            label={t("dash.kpi.gate")}
            value={String(stats.gate.length)}
            note={t("dash.kpi.gate_note")}
          />
          <Kpi
            label={t("dash.kpi.done")}
            value={String(stats.done.length)}
            note={t("dash.kpi.done_note")}
          />
          <Kpi
            label={t("dash.kpi.total")}
            value={String(runs.length)}
            note={t("dash.kpi.total_note")}
          />
        </div>

        <Card
          title={t("dash.attention.title")}
          subtitle={t("dash.attention.subtitle")}
        >
          {attention.length === 0 ? (
            <p className="screen-note">{t("dash.attention.empty")}</p>
          ) : (
            attention.map((run) => {
              const age = ageLabel(run.startedAt);
              const broken = needsHuman(run);
              return (
                <button
                  key={run.ticketKey}
                  type="button"
                  className={broken ? "screen-issue screen-issue--alert" : "screen-issue"}
                  onClick={() => void navigate(`/detail/${run.ticketKey}`)}
                >
                  <span aria-hidden="true">{broken ? "✕" : "⏳"}</span>
                  <span className="screen-issue__body">
                    <b className="screen-mono">{run.ticketKey}</b> <RunStatusCell status={run.status} />{" "}
                    <Badge tone={riskTone(run.risk)}>{t(`risk.${run.risk}`)}</Badge>
                    <span className="screen-note">
                      {run.title}
                      {run.step === null ? "" : ` · ${t(`steps.${run.step}`)}`}
                      {age === null
                        ? ""
                        : ` · ${t("dash.attention.age", { age: t(age.key, age.params) })}`}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </Card>

        {/* The full, filterable run list over /studio/runs. Labelled honestly:
            on a live install this is the DB catalog (seed/archive records) —
            the engine's real jobs are the section at the top. */}
        <div>
          <h2 className="dash-section">{t("dash.all.title")}</h2>
          <p className="screen-note">{t("dash.all.note")}</p>
          <TicketsList />
        </div>
      </QueryState>
    </div>
  );
}
