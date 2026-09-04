import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../../ui/index.ts";
import type { BadgeTone, Column } from "../../ui/index.ts";
import { type McpScope, type McpTool, type McpView } from "../common/index.ts";
import { useLabel } from "../common/label.ts";
import { QueryState } from "../shared/QueryState.tsx";

const SCOPE_TONE: Readonly<Record<McpScope, BadgeTone>> = {
  read: "green",
  operate: "blue",
  "admin-proposal": "amber",
};

/**
 * Help → "Maestro MCP": the platform's own MCP surface (M101) — an AI assistant
 * operating Maestro with the calling human's RBAC, never more. Read from
 * `GET /mcp/manifest`, which is built from the real server definition.
 *
 * Two things must be legible here or the section misleads. First, scope:
 * `read` observes, `operate` acts on a flow, `admin-proposal` can only QUEUE a
 * change for a human to confirm. Second, and more important, the tools that do
 * NOT exist: `approve_gate`, `reject_gate`, `merge_pr`. Listing them as absent
 * is the point — an operator who cannot see the boundary assumes there isn't
 * one, and M32's "producer ≠ approver" would be a slogan rather than a
 * property of the system.
 */
export function McpServerSection(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: ({ signal }) => api.get<McpView>("/mcp/manifest", { signal }),
  });

  const columns: readonly Column<McpTool>[] = [
    {
      key: "name",
      header: t("mcp.col.tool"),
      cell: (row) => <code className="scr-mono">{row.name}</code>,
    },
    {
      key: "scope",
      header: t("mcp.col.scope"),
      cell: (row) => <Badge tone={SCOPE_TONE[row.scope]}>{t(`mcp.scope.${row.scope}`)}</Badge>,
    },
    {
      key: "what",
      header: t("mcp.col.what"),
      cell: (row) => <span className="scr-mini">{label(row.descriptionKey, row.name)}</span>,
    },
  ];

  const forbidden = mcp.data?.forbiddenTools ?? [];

  // The four facts an operator needs before connecting, as one compact list
  // rather than a KPI row: none of them is a number to watch.
  const facts: readonly { readonly key: string; readonly value: string }[] = [
    { key: "endpoint", value: mcp.data?.endpoint ?? "—" },
    { key: "identity", value: t("mcp.kpi.identity_value") },
    { key: "audit_actor", value: mcp.data?.auditActor ?? "—" },
    { key: "gate_decision", value: t("mcp.kpi.gate_decision_value") },
  ];

  return (
    <QueryState isPending={mcp.isPending} error={mcp.error} onRetry={() => void mcp.refetch()}>
      <div className="scr-stack">
        <Card title={t("help.tab.mcp")} subtitle={t("mcp.card.connect_sub")}>
          <div className="help-guide">
            <section className="help-guide__block">
              <h4 className="help-guide__h">{t("mcp.card.connect")}</h4>
              <ul className="help-fields">
                {facts.map((fact) => (
                  <li key={fact.key}>
                    <b>{t(`mcp.kpi.${fact.key}`)}</b>{" "}
                    <span className="scr-mono">{fact.value}</span>{" "}
                    <span className="scr-hint">{t(`mcp.kpi.${fact.key}_note`)}</span>
                  </li>
                ))}
              </ul>
              <p className="scr-mini">{t("mcp.connect.token_note")}</p>
            </section>

            <section className="help-guide__block">
              <h4 className="help-guide__h">{t("mcp.card.forbidden")}</h4>
              <p className="scr-hint">{t("mcp.card.forbidden_sub")}</p>
              {forbidden.length === 0 ? (
                <p className="scr-mini">{t("mcp.empty.forbidden")}</p>
              ) : (
                <div className="scr-row">
                  {forbidden.map((tool) => (
                    <Badge key={tool} tone="red" icon="⛔">
                      <code className="scr-mono">{tool}</code>
                    </Badge>
                  ))}
                </div>
              )}
              <div className="scr-note scr-note--warn" style={{ marginTop: 11 }}>
                {t("mcp.note.no_gate_decision")}
              </div>
            </section>
          </div>
        </Card>

        <Card title={t("mcp.card.tools")} subtitle={t("mcp.card.tools_sub")} padded={false}>
          <Table
            columns={columns}
            rows={mcp.data?.tools ?? []}
            rowKey={(row) => row.name}
            emptyLabel={t("mcp.empty.tools")}
            caption={t("mcp.card.tools")}
          />
        </Card>
      </div>
    </QueryState>
  );
}
