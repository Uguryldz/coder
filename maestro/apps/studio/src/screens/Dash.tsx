import { useMemo } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Kpi, riskTone } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunRow } from "./shared/runs.ts";
import { RunStatusCell } from "./Tickets.tsx";
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

export function DashScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const { data, isPending, error, refetch } = useRuns(200);

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

  return (
    <div className="screen-stack">
      <Card>
        <div className="screen-filters">
          <span style={{ fontSize: 24 }} aria-hidden="true">
            🎬
          </span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>{t("dash.demo.title")}</b>
            <div className="screen-note">{t("dash.demo.body")}</div>
          </div>
          <Link className="ui-btn ui-btn--primary" to="/live">
            {t("dash.demo.action")}
          </Link>
        </div>
      </Card>

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
          actions={
            <Link className="ui-btn ui-btn--sm" to="/tickets">
              {t("dash.attention.all")}
            </Link>
          }
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

        <Card title={t("dash.recent.title")} subtitle={t("dash.recent.subtitle")}>
          <p className="screen-note">{t("dash.recent.unavailable")}</p>
          <div className="screen-actions">
            <Button onClick={() => void refetch()}>{t("action.refresh")}</Button>
          </div>
        </Card>
      </QueryState>
    </div>
  );
}
