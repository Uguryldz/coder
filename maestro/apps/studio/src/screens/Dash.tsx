import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, ButtonLink, Kpi, Section } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { MAX_RUN_PAGE, useRuns, type RunRow } from "./shared/runs.ts";
import { TicketsList, BOARD_SCOPE, STATUS_PARAM } from "./Tickets.tsx";
import { RunStatusCell } from "./shared/RunStatusCell.tsx";
import {
  GUIDE_DISMISSED_KEY,
  readFlag,
  useSetupState,
  webhookAcked,
  writeFlag,
} from "./dash/setup-state.ts";

/**
 * Screen: dash — the operator's landing page.
 *
 * Every number is counted from `GET /studio/runs`, the platform catalog joined
 * to the live workflow state, so "kapıda" counts runs whose status IS `gate`.
 *
 * The tiles and the list below read the SAME query: same limit, same archive
 * scope, same key. That is what makes "Yenile" refresh both, and what keeps a
 * tile from claiming a number the list does not show.
 */

const ATTENTION_LIMIT = 5;
/** The board re-reads itself on this cadence; "Yenile" is for the impatient. */
const BOARD_REFRESH_MS = 30_000;

/** Statuses that mean a human has to look: a failure, or a handover. */
function needsHuman(run: RunRow): boolean {
  return run.status === "fail" || run.status === "handover";
}

/**
 * TAKILI KOŞU — durumu `running` ama `updatedAt` bu kadar süredir kıpırdamamış.
 *
 * Bir adım normalde dakikalar sürer; yarım saat boyunca hiçbir şey yazmayan
 * bir koşu ya ölmüş bir işçinin elinde ya da cevap vermeyen bir servisi
 * bekliyor. İkisi de operatörün bakması gereken şey, ve ikisi de "Çalışıyor"
 * kutusunda sağlıklı görünüyordu.
 */
export const STUCK_AFTER_MS = 30 * 60_000;

/** `null` when the row carries no usable timestamp — never guessed. */
function updatedAtMs(run: RunRow): number | null {
  const ms = Date.parse(run.updatedAt);
  return Number.isNaN(ms) ? null : ms;
}

export function isStuck(run: RunRow, now: number): boolean {
  if (run.status !== "running") return false;
  const updated = updatedAtMs(run);
  return updated !== null && now - updated >= STUCK_AFTER_MS;
}

export function DashScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const enumLabel = useEnumLabel();

  const { data, isPending, error, refetch, isFetching } = useRuns(MAX_RUN_PAGE, {
    ...BOARD_SCOPE,
    refetchInterval: BOARD_REFRESH_MS,
  });
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const stats = useMemo(
    () => ({
      running: runs.filter((run) => run.status === "running").length,
      gate: runs.filter((run) => run.status === "gate").length,
      fail: runs.filter((run) => run.status === "fail").length,
      handover: runs.filter((run) => run.status === "handover").length,
      done: runs.filter((run) => run.status === "done").length,
    }),
    [runs],
  );

  /**
   * Stuck runs, oldest update first. `now` is taken per render: the list polls
   * every 30 s, so the verdict refreshes without a timer of its own.
   *
   * `unknown` counts running rows with NO usable `updatedAt` — an older BFF or
   * a stripped fixture. The tile shows "—" rather than "0" when EVERY running
   * row is like that: a zero there would claim a health the data cannot vouch
   * for.
   */
  const now = Date.now();
  const stuck = useMemo(
    () =>
      runs
        .filter((run) => isStuck(run, now))
        .sort((a, b) => (updatedAtMs(a) ?? 0) - (updatedAtMs(b) ?? 0)),
    [runs, now],
  );
  const runningUnknown = runs.filter((run) => run.status === "running" && updatedAtMs(run) === null).length;
  const stuckValue = stats.running > 0 && runningUnknown === stats.running ? "—" : String(stuck.length);

  // The gate tile opens the list below already sliced to the gate chip.
  const openGateList = (): void => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set(STATUS_PARAM, "gate");
        return params;
      },
      { replace: true },
    );
  };

  /**
   * "Needs attention": broken first (a failure blocks everything behind it),
   * then runs parked at a gate (a decision only a person can make), each
   * group oldest-first.
   */
  const attention = useMemo(() => {
    const byAgeAsc = (a: RunRow, b: RunRow) => Date.parse(a.startedAt) - Date.parse(b.startedAt);
    const broken = runs.filter(needsHuman).sort(byAgeAsc);
    const gate = runs.filter((run) => run.status === "gate").sort(byAgeAsc);
    return [...broken, ...gate].slice(0, ATTENTION_LIMIT);
  }, [runs]);

  /**
   * Whether the platform's setup is still open — the ONE setup fact the Panel
   * keeps now that the checklist lives in the wizard. Same hook the wizard
   * reads, so the two can never disagree. The Panel does not need the agent
   * training read (that step is not part of "complete"), so it is skipped.
   *
   * A 403 on any of the reads is NOT "setup incomplete": it means this session
   * cannot see the setup at all, and a note it cannot act on is noise.
   */
  const [dismissed, setDismissed] = useState(() => readFlag(GUIDE_DISMISSED_KEY));
  const setup = useSetupState(webhookAcked(), { trainedAgent: false });
  const setupIncomplete = !setup.loading && !setup.complete && !setup.forbidden;

  return (
    <div className="scr-stack">
      {setupIncomplete && !dismissed && (
        <div className="dash-setup-note" role="note">
          <span>{t("dash.start.incomplete_note")}</span>
          <span className="scr-row">
            <ButtonLink size="sm" to="/setup">
              {t("dash.start.open_wizard")}
            </ButtonLink>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                writeFlag(GUIDE_DISMISSED_KEY, true);
                setDismissed(true);
              }}
            >
              {t("dash.start.dismiss")}
            </Button>
          </span>
        </div>
      )}

      {/* Hidden but not finished: "gizle" must not quietly become "tamamlandı". */}
      {setupIncomplete && dismissed && (
        <div className="dash-setup-note" role="note">
          <span>{t("dash.start.hidden_note")}</span>
          <Button
            variant="ghost"
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

      <QueryState isPending={isPending} error={error} onRetry={() => void refetch()} skeletonRows={6}>
        {/* Nothing to count → no tiles. The list below carries the empty state
            AND the archive toggle, so an emptied board still reaches its
            archive. */}
        {runs.length > 0 && (
          <div className="scr-grid scr-grid--4">
            <Kpi label={t("dash.kpi.active")} value={String(stats.running)} />
            <Kpi
              label={t("dash.kpi.gate")}
              value={String(stats.gate)}
              onClick={openGateList}
              title={t("dash.kpi.gate_action")}
              {...(stats.gate > 0 ? { note: t("dash.kpi.gate_note") } : {})}
            />
            <Kpi
              label={t("dash.kpi.stuck")}
              value={stuckValue}
              note={t(stuckValue === "—" ? "dash.kpi.stuck_unknown" : "dash.kpi.stuck_note")}
            />
            <Kpi
              label={t("dash.kpi.failed")}
              value={String(stats.fail)}
              {...(stats.handover > 0
                ? { note: t("dash.kpi.failed_note", { n: String(stats.handover) }) }
                : {})}
            />
            <Kpi
              label={t("dash.kpi.done")}
              value={String(stats.done)}
              {...(stats.done > 0 ? { note: t("dash.kpi.done_note") } : {})}
            />
          </div>
        )}

        {stuck.length > 0 && (
          <Section title={t("dash.stuck.title")} subtitle={t("dash.stuck.subtitle")}>
            <div>
              {stuck.map((run) => {
                const age = ageLabel(run.updatedAt, now);
                return (
                  <button
                    key={run.ticketKey}
                    type="button"
                    className="scr-issue scr-issue--alert"
                    onClick={() => void navigate(`/detail/${run.ticketKey}`)}
                  >
                    <span className="scr-issue__body">
                      {/* No status badge: every row here is `running` by definition. */}
                      <b className="scr-mono">{run.ticketKey}</b>{" "}
                      <span className="scr-hint">
                        {run.title}
                        {run.step === null ? "" : ` · ${t(`steps.${run.step}`)}`}
                        {age === null
                          ? ""
                          : ` · ${t("dash.stuck.age", { age: t(age.key, age.params) })}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {attention.length > 0 && (
          <Section title={t("dash.attention.title")} subtitle={t("dash.attention.subtitle")}>
            <div>
              {attention.map((run) => {
                const age = ageLabel(run.startedAt);
                const broken = needsHuman(run);
                return (
                  <button
                    key={run.ticketKey}
                    type="button"
                    className={broken ? "scr-issue scr-issue--alert" : "scr-issue"}
                    onClick={() => void navigate(`/detail/${run.ticketKey}`)}
                  >
                    <span className="scr-issue__body">
                      <b className="scr-mono">{run.ticketKey}</b> <RunStatusCell status={run.status} />{" "}
                      <Badge tone="gray">{enumLabel("risk", run.risk).text}</Badge>
                      <span className="scr-hint">
                        {run.title}
                        {run.step === null ? "" : ` · ${t(`steps.${run.step}`)}`}
                        {age === null
                          ? ""
                          : ` · ${t("dash.attention.age", { age: t(age.key, age.params) })}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        <Section
          title={t("dash.all.title")}
          actions={
            <Button variant="ghost" size="sm" busy={isFetching} onClick={() => void refetch()}>
              {t("action.refresh")}
            </Button>
          }
        >
          <TicketsList />
        </Section>
      </QueryState>
    </div>
  );
}
