import { useMemo } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Kpi, runStatusTone } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { useRuns, type RunSummary } from "./shared/runs.ts";
import { statusKey } from "./Tickets.tsx";
import "./shared/screens.css";

/**
 * Screen: dash — the operator's landing page.
 *
 * Every number on it is counted from `GET /runs`. The mock also shows runner
 * pool capacity and a 24-hour activity feed; both need endpoints that do not
 * exist (`/runners`, `/activity`), so they are requested in the report rather
 * than filled with plausible-looking constants. A dashboard that invents its
 * own figures is worse than one that admits it has none.
 */

const ATTENTION_LIMIT = 5;

export function DashScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const { data, isPending, error, refetch } = useRuns(200);

  const runs = useMemo(() => data?.runs ?? [], [data]);

  const stats = useMemo(() => {
    const open = runs.filter((run) => run.status === "running");
    const done = runs.filter((run) => run.status === "completed");
    const broken = runs.filter(
      (run) =>
        run.status === "failed" || run.status === "terminated" || run.status === "timed_out",
    );
    return { open, done, broken };
  }, [runs]);

  /**
   * "Needs attention" is derived, not guessed: a failed run, or an open one
   * that has been going longest. Ordering by age is the only urgency signal
   * `/runs` carries today — the gate-level detail the mock shows (who owns the
   * gate, how long it has waited) lives behind `/runs/:ticket`.
   */
  const attention = useMemo(() => {
    const byAgeAsc = (a: RunSummary, b: RunSummary) =>
      Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return [...stats.broken.sort(byAgeAsc), ...stats.open.sort(byAgeAsc)].slice(
      0,
      ATTENTION_LIMIT,
    );
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
            label={t("dash.kpi.done")}
            value={String(stats.done.length)}
            note={t("dash.kpi.done_note")}
          />
          <Kpi
            label={t("dash.kpi.failed")}
            value={String(stats.broken.length)}
            note={t("dash.kpi.failed_note")}
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
              const failed = run.status !== "running";
              return (
                <button
                  key={run.runId}
                  type="button"
                  className={
                    failed ? "screen-issue screen-issue--alert" : "screen-issue"
                  }
                  onClick={() => void navigate(`/detail/${run.ticketKey}`)}
                >
                  <span aria-hidden="true">{failed ? "✕" : "⏳"}</span>
                  <span className="screen-issue__body">
                    <b className="screen-mono">{run.ticketKey}</b>{" "}
                    <Badge tone={runStatusTone(run.status)}>{t(statusKey(run.status))}</Badge>
                    <span className="screen-note">
                      {age === null ? "" : t("dash.attention.age", { age: t(age.key, age.params) })}
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
