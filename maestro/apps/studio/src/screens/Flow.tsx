import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Select } from "../ui/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { useJiraWorkflow } from "./flow/api.ts";
import { activeNodeId, layoutFlow } from "./flow/layout.ts";
import { FlowDiagram, categoryKey } from "./flow/FlowDiagram.tsx";
import "./flow/flow.css";
import "./shared/screens.css";

/**
 * Screen: flow — the live OPS Jira workflow as a picture (Dalga D).
 *
 * The mock never had this: operators reason about "hangi adımdayız" from a
 * ticket's status word, but the WORKFLOW that word lives in — which statuses
 * exist, what may transition to what — was invisible. This screen draws it,
 * hand-rolled in SVG (no graph library; bank CSP), straight from the live OPS
 * project via `GET /studio/jira-workflow`.
 *
 * THE HIGHLIGHT IS BY statusId, NEVER BY NAME. The operator selects the status
 * a ticket currently sits in — the same status ids the diagram's nodes carry —
 * and that node lights up. A name match would be one rename or one locale from
 * lying (OPS renders "İNCELEMEDE" in caps). The selector is fed ONLY from the
 * statuses the endpoint actually returned, so it can never point at a status
 * the workflow does not have; nothing about the ticket's position is invented.
 *
 * The picture is Maestro's Jira VIEW, not Maestro's own step machine — two
 * vocabularies, and the frozen contract owns the second. This is a read-only
 * presentation layer over a live external system: it writes nothing and edits
 * no frozen schema.
 */

/** The OPS project is the live pilot; the field defaults here, editable. */
const DEFAULT_PROJECT = "OPS";

export function FlowScreen(): ReactNode {
  const t = useT();

  const [project, setProject] = useState(DEFAULT_PROJECT);
  // The status the operator says a ticket is in — a Jira status id, or "" for
  // no highlight. Reset whenever the project changes so a stale id cannot leak
  // a highlight onto a different project's graph.
  const [statusId, setStatusId] = useState("");

  const workflow = useJiraWorkflow(project);

  const layout = useMemo(
    () =>
      workflow.data === undefined
        ? null
        : layoutFlow({
            statuses: workflow.data.statuses,
            transitions: workflow.data.transitions,
          }),
    [workflow.data],
  );

  // The chosen status must belong to THIS graph; a leftover id from a previous
  // project resolves to null rather than highlighting nothing-in-particular.
  const activeId = layout === null ? null : activeNodeId(layout, statusId);
  const activeStatus = workflow.data?.statuses.find((s) => s.id === activeId) ?? null;

  const isEmpty = workflow.data !== undefined && workflow.data.statuses.length === 0;
  const sampled = workflow.data?.edgesComplete === false;

  return (
    <div className="screen-stack">
      <Card title={t("flow.title")} subtitle={t("flow.sub")}>
        <div className="screen-filters">
          <Input
            label={t("flow.project")}
            value={project}
            onChange={(event) => {
              setProject(event.target.value.trim().toUpperCase());
              setStatusId("");
            }}
          />
          <Select
            label={t("flow.status")}
            value={statusId}
            onChange={(event) => setStatusId(event.target.value)}
            disabled={workflow.data === undefined || workflow.data.statuses.length === 0}
            options={[
              { value: "", label: t("flow.status.none") },
              ...(workflow.data?.statuses ?? []).map((status) => ({
                value: status.id,
                label: status.name,
              })),
            ]}
          />
        </div>
      </Card>

      <Card padded={false}>
        <div style={{ padding: 14 }}>
          <MaybeUnwired
            isPending={workflow.isPending && project !== ""}
            error={workflow.error}
            isEmpty={isEmpty}
            emptyTitle={t("flow.empty")}
            onRetry={() => void workflow.refetch()}
          >
            {layout !== null && workflow.data !== undefined && (
              <>
                <FlowDiagram
                  layout={layout}
                  activeId={activeId}
                  title={t("flow.diagram.title", { project: workflow.data.projectKey })}
                  description={t("flow.diagram.desc", {
                    n: String(layout.nodes.length),
                    e: String(layout.edges.length),
                  })}
                />

                <p className="screen-note" style={{ marginTop: 10 }} role="status">
                  {activeStatus === null ? (
                    t("flow.no_status")
                  ) : (
                    <>
                      {t("flow.position", { status: activeStatus.name })}{" "}
                      <Badge tone="purple">{t("flow.here")}</Badge>
                    </>
                  )}
                </p>

                <div className="flow-legend" aria-hidden="true">
                  {layout.columns.map((category) => (
                    <span key={category} className="flow-legend-item">
                      <span className={`flow-swatch flow-swatch--${category}`} />
                      {t(categoryKey(category))}
                    </span>
                  ))}
                  <span className="flow-legend-item">
                    <span className="flow-swatch flow-swatch--active" />
                    {t("flow.legend.active")}
                  </span>
                </div>

                {sampled && (
                  <p className="screen-note" style={{ marginTop: 8 }}>
                    {t("flow.sampled", {
                      n: String(workflow.data.sampledFrom.length),
                    })}
                  </p>
                )}
              </>
            )}
          </MaybeUnwired>
        </div>
      </Card>
    </div>
  );
}
