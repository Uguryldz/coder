import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Table, runStatusTone } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { ageLabel } from "./shared/format.ts";
import { projectKeyOf, useRuns, type RunSummary } from "./shared/runs.ts";
import { statusKey } from "./Tickets.tsx";
import "./shared/screens.css";

/**
 * Screen: fanout — a coordinator ticket and the child tickets its impact
 * matrix opened (M99/M100).
 *
 * IMPORTANT LIMIT, stated rather than papered over: nothing the BFF serves
 * today records the parent→child link. `RunSummary` has no `parentTicket`, and
 * the impact matrix lives in the analysis document, which has no endpoint. So
 * this screen does NOT claim to know the tree.
 *
 * What it can do honestly is group the runs it can see by Jira project and let
 * the operator enter a parent key to see the sibling runs in that project. That
 * is a weaker statement than the mock's, and it is the true one until
 * `GET /runs/:ticket/children` exists (requested in RAPOR-ekranlar-A.md).
 */
export function FanoutScreen(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const [parent, setParent] = useState("");

  const { data, isPending, error, refetch } = useRuns(200);
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const project = parent.trim() === "" ? null : projectKeyOf(parent.trim());
  const related = useMemo(
    () =>
      project === null
        ? []
        : runs.filter(
            (run) =>
              projectKeyOf(run.ticketKey) === project && run.ticketKey !== parent.trim(),
          ),
    [runs, project, parent],
  );

  const columns: readonly Column<RunSummary>[] = [
    {
      key: "ticket",
      header: t("col.ticket"),
      cell: (run) => <b className="screen-mono">{run.ticketKey}</b>,
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (run) => <Badge tone={runStatusTone(run.status)}>{t(statusKey(run.status))}</Badge>,
    },
    {
      key: "age",
      header: t("col.age"),
      align: "right",
      cell: (run) => {
        const age = ageLabel(run.startedAt);
        return age === null ? "—" : t(age.key, age.params);
      },
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("fanout.pick.title")} subtitle={t("fanout.pick.subtitle")}>
        <Input
          label={t("fanout.field.parent")}
          value={parent}
          onChange={(event) => setParent(event.target.value)}
          hint={t("fanout.field.parent_hint")}
        />
      </Card>

      <Card title={t("fanout.matrix.title")}>
        <p className="screen-note">{t("fanout.matrix.unavailable")}</p>
      </Card>

      <Card
        title={t("fanout.siblings.title")}
        subtitle={project === null ? t("fanout.siblings.none") : project}
        padded={false}
      >
        <QueryState
          isPending={isPending}
          error={error}
          onRetry={() => void refetch()}
          skeletonRows={4}
        >
          <Table
            columns={columns}
            rows={related}
            rowKey={(run) => run.runId}
            emptyLabel={
              project === null ? t("fanout.siblings.prompt") : t("fanout.siblings.empty")
            }
            caption={t("fanout.siblings.caption")}
            onRowClick={(run) => void navigate(`/detail/${run.ticketKey}`)}
          />
        </QueryState>
      </Card>

      <Card title={t("fanout.rules.title")}>
        <dl className="screen-kv">
          <dt>{t("fanout.rules.assignment")}</dt>
          <dd>{t("fanout.rules.assignment_value")}</dd>
          <dt>{t("fanout.rules.closure")}</dt>
          <dd>{t("fanout.rules.closure_value")}</dd>
          <dt>{t("fanout.rules.evidence")}</dt>
          <dd>{t("fanout.rules.evidence_value")}</dd>
        </dl>
      </Card>
    </div>
  );
}
