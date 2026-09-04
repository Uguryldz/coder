import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ApplicationRecord, WorkflowRunState } from "@maestro/contracts";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { Badge, ButtonLink, Card, riskTone, workModeTone } from "../../ui/index.ts";
import { useEnumLabel } from "../common/label.ts";
import { GatePanel } from "../shared/GatePanel.tsx";
import { ClarifyPanel } from "./ClarifyPanel.tsx";
import { ModeChange } from "./ModeChange.tsx";
import { RestartPanel } from "./RestartPanel.tsx";
import { isTerminal, moneyLabel } from "./run-state.ts";
import { isApprovalGate, isClarificationWait } from "../shared/gate-utils.ts";
import { ageLabel, dateTimeLabel } from "../shared/format.ts";
import { RunStatusCell } from "../shared/RunStatusCell.tsx";
import { projectKeyOf, type RunDetail } from "../shared/runs.ts";

/**
 * The right-hand column of the detail screen: the one action the run is
 * waiting on (if any), then the run's identifying facts.
 *
 * Every value comes from a field the BFF actually sent. `null` renders as an
 * em dash: an unassigned ticket, an unmatched application and a run with no
 * PR yet are all real states, and filling them in would be the one failure
 * this project treats as worse than a blank.
 */
export interface RunSidebarProps {
  readonly record: RunDetail["run"];
  /** `null` when the ticket exists but its workflow has not started. */
  readonly state: WorkflowRunState | null;
  readonly application: ApplicationRecord | null;
  /**
   * Where the state came from. `"record"` means the engine has no execution
   * for this run — which is a FAULT for an open run (its gate cannot be
   * decided) and the NORMAL state of a finished one (executions do not
   * outlive the run). Absent on a BFF that predates the field = `"engine"`.
   */
  readonly stateSource?: RunDetail["stateSource"];
}

export function RunSidebar({
  record,
  state,
  application,
  stateSource,
}: RunSidebarProps): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const enumLabel = useEnumLabel();
  const age = ageLabel(state?.startedAt ?? record.startedAt);

  const finished = isTerminal(state);
  // The engine has forgotten an OPEN run: the only useful control is restart.
  // A finished run is not "forgotten" — it is over, and nothing is offered.
  const engineForgot = stateSource === "record" && !finished;
  // Controls that send a SIGNAL need a live execution to receive it.
  const live = state !== null && !finished && !engineForgot;

  const risk = state?.risk ?? record.risk;

  return (
    <div className="scr-stack">
      {engineForgot && <RestartPanel ticket={record.ticketKey} />}

      {live && isApprovalGate(state) && <GatePanel ticket={record.ticketKey} step={state.step} />}

      {live && isClarificationWait(state) && <ClarifyPanel ticket={record.ticketKey} />}

      <Card
        title={t("detail.facts.title")}
        actions={
          <ButtonLink
            size="sm"
            variant="ghost"
            to={`/evidence?ticket=${encodeURIComponent(record.ticketKey)}`}
          >
            {t("detail.evidence")}
          </ButtonLink>
        }
      >
        <dl className="scr-kv">
          <dt>{t("detail.field.project")}</dt>
          <dd>{projectKeyOf(record.ticketKey)}</dd>

          <dt>{t("detail.field.status")}</dt>
          <dd>
            <RunStatusCell status={state?.status ?? null} />
          </dd>

          <dt>{t("detail.field.step")}</dt>
          <dd>
            {state === null ? (
              "—"
            ) : (
              <>
                <span className="scr-mono">{state.step}</span> {t(`steps.${state.step}`)}
              </>
            )}
          </dd>

          <dt>{t("detail.field.risk")}</dt>
          <dd>
            <Badge tone={riskTone(risk)}>{enumLabel("risk", risk).text}</Badge>
          </dd>

          <dt>{t("detail.field.mode")}</dt>
          <dd>
            <Badge tone={workModeTone(record.mode)}>{enumLabel("mode", record.mode).text}</Badge>{" "}
            {live && <ModeChange ticket={record.ticketKey} current={record.mode} />}
          </dd>

          <dt>{t("detail.field.data_class")}</dt>
          <dd>
            <Badge tone={record.dataClass === "gizli" ? "red" : "gray"}>
              {enumLabel("data_class", record.dataClass).text}
            </Badge>
          </dd>

          <dt>{t("detail.field.app")}</dt>
          {/* The matched application; the repo is written the way Azure
              DevOps addresses it (`<project>/_git/<repo>`), from the record's
              own fields. */}
          <dd>
            {application === null ? (
              "—"
            ) : (
              <>
                {application.displayName}
                <div className="scr-hint scr-mono">
                  {application.adoProject}/_git/{application.adoRepo}
                </div>
              </>
            )}
          </dd>

          <dt>{t("detail.field.reporter")}</dt>
          <dd>{record.reporter}</dd>

          <dt>{t("detail.field.assignee")}</dt>
          <dd>{record.assignee ?? "—"}</dd>

          <dt>{t("detail.field.pr")}</dt>
          <dd className="scr-mono">{record.prId === null ? "—" : `#${record.prId}`}</dd>

          <dt>{t("detail.field.cost")}</dt>
          <dd>
            {moneyLabel(record.costUsd, locale)}
            <div className="scr-hint">
              {t("detail.field.tokens", {
                in: String(record.tokensIn),
                out: String(record.tokensOut),
              })}
            </div>
          </dd>

          {state !== null && (
            <>
              <dt>{t("detail.field.run_id")}</dt>
              <dd className="scr-mono">{state.runId}</dd>
            </>
          )}

          <dt>{t("detail.field.started")}</dt>
          <dd>
            {dateTimeLabel(state?.startedAt ?? record.startedAt, locale)}
            {age !== null && <span className="scr-hint"> {t(age.key, age.params)}</span>}
          </dd>

          <dt>{t("detail.field.updated")}</dt>
          <dd>{dateTimeLabel(state?.updatedAt ?? record.updatedAt, locale)}</dd>
        </dl>
      </Card>

      {/* Fan-out: the link is recorded on both sides of the catalog, so the
          tree is READ, not inferred from the Jira project. */}
      {(record.parentTicketKey !== null || record.childTicketKeys.length > 0) && (
        <Card title={t("detail.fanout.title")}>
          <dl className="scr-kv">
            {record.parentTicketKey !== null && (
              <>
                <dt>{t("detail.fanout.parent")}</dt>
                <dd>
                  <Link className="scr-mono" to={`/detail/${record.parentTicketKey}`}>
                    {record.parentTicketKey}
                  </Link>
                </dd>
              </>
            )}
            {record.childTicketKeys.length > 0 && (
              <>
                <dt>{t("detail.fanout.children")}</dt>
                <dd>
                  {record.childTicketKeys.map((child) => (
                    <div key={child}>
                      <Link className="scr-mono" to={`/detail/${child}`}>
                        {child}
                      </Link>
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </Card>
      )}
    </div>
  );
}
