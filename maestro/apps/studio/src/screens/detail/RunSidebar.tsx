import type { ReactNode } from "react";
import { Link } from "react-router";
import { GATES_BY_RISK, type WorkflowRunState } from "@maestro/contracts";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Card, riskTone, runStatusTone } from "../../ui/index.ts";
import { GatePanel, isApprovalGate, isClarificationWait } from "../shared/GatePanel.tsx";
import { ageLabel, dateTimeLabel } from "../shared/format.ts";
import { projectKeyOf } from "../shared/runs.ts";

/**
 * The right-hand column of the detail screen: the open gate (if any), then the
 * run's identifying facts.
 *
 * Only fields `GET /runs/:ticket` actually returns are shown. The mock's
 * sidebar also carries the ADO PR, the branch, the runner and the token spend;
 * `WorkflowRunState` carries none of those, so they are requested in the report
 * instead of being displayed with invented values.
 */
export function RunSidebar({ run }: { readonly run: WorkflowRunState }): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const age = ageLabel(run.startedAt);
  const gateCount = run.risk === undefined ? undefined : GATES_BY_RISK[run.risk].length;

  return (
    <div className="screen-stack">
      {isApprovalGate(run) && <GatePanel ticket={run.ticketKey} step={run.step} />}

      {isClarificationWait(run) && (
        <Card title={t("detail.clarify.title")}>
          <p className="screen-note">{t("detail.clarify.body")}</p>
          <div className="screen-actions">
            <Link className="ui-btn ui-btn--sm" to="/clarify">
              {t("detail.clarify.action")}
            </Link>
          </div>
        </Card>
      )}

      <Card title={t("detail.facts.title")}>
        <dl className="screen-kv">
          <dt>{t("detail.field.ticket")}</dt>
          <dd className="screen-mono">{run.ticketKey}</dd>

          <dt>{t("detail.field.project")}</dt>
          <dd>{projectKeyOf(run.ticketKey)}</dd>

          <dt>{t("detail.field.status")}</dt>
          <dd>
            <Badge tone={runStatusTone(run.status)}>{t(`run.status.${run.status}`)}</Badge>
          </dd>

          <dt>{t("detail.field.step")}</dt>
          <dd>
            <span className="screen-mono">{run.step}</span> {t(`steps.${run.step}`)}
          </dd>

          <dt>{t("detail.field.risk")}</dt>
          <dd>
            {run.risk === undefined ? (
              "—"
            ) : (
              <>
                <Badge tone={riskTone(run.risk)}>{t(`risk.${run.risk}`)}</Badge>{" "}
                <span className="screen-note">
                  {t("detail.field.gates", { n: String(gateCount ?? 0) })}
                </span>
              </>
            )}
          </dd>

          <dt>{t("detail.field.run_id")}</dt>
          <dd className="screen-mono">{run.runId}</dd>

          <dt>{t("detail.field.started")}</dt>
          <dd>
            {dateTimeLabel(run.startedAt, locale)}
            {age !== null && <span className="screen-note"> {t(age.key, age.params)}</span>}
          </dd>

          <dt>{t("detail.field.updated")}</dt>
          <dd>{dateTimeLabel(run.updatedAt, locale)}</dd>
        </dl>
        <p className="screen-note">{t("detail.facts.missing")}</p>
      </Card>
    </div>
  );
}
