import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, EmptyState, Table } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { KeyValue, QueryState, type SandboxSession, type SandboxView } from "./common/index.ts";

/**
 * Live sandbox sessions: which agent is running where, under what limits.
 *
 * This screen shows STATE, not output. The mock streams a log pane, but a live
 * agent transcript is the one place where unmasked ticket text (PII, M18) would
 * reach a browser, and there is no log endpoint to read it from today — so the
 * screen shows the session envelope (runner, image, limits, egress, tools) and
 * says nothing it cannot source. Inventing a transcript would be worse than
 * omitting one.
 */
export function SandboxScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sandbox = useQuery({
    queryKey: ["sandbox"],
    queryFn: ({ signal }) => api.get<SandboxView>("/sandbox", { signal }),
    refetchInterval: 15_000,
  });

  const sessions = sandbox.data?.sessions ?? [];
  const selected = sessions.find((session) => session.sessionId === selectedId) ?? sessions[0];

  const columns: readonly Column<SandboxSession>[] = [
    {
      key: "ticket",
      header: t("sandbox.col.ticket"),
      cell: (row) => <b className="scr-mono">{row.ticketKey}</b>,
    },
    {
      key: "runner",
      header: t("sandbox.col.runner"),
      cell: (row) => (
        <div>
          <span className="scr-mono">{row.runnerId}</span>
          <div className="scr-mini">{row.pool}</div>
        </div>
      ),
    },
    {
      key: "session",
      header: t("sandbox.col.session"),
      cell: (row) =>
        row.resumed ? (
          <Badge tone="blue">{t("sandbox.badge.resumed", { turn: String(row.turn) })}</Badge>
        ) : (
          <Badge tone="teal">{t("sandbox.badge.fresh")}</Badge>
        ),
    },
    {
      key: "workspace",
      header: t("sandbox.col.workspace"),
      cell: (row) => (
        <Badge tone={row.workspaceMounted ? "green" : "gray"}>
          {t(row.workspaceMounted ? "sandbox.workspace.mounted" : "sandbox.workspace.cold")}
        </Badge>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <QueryState
        isPending={sandbox.isPending}
        error={sandbox.error}
        onRetry={() => void sandbox.refetch()}
      >
        {sessions.length === 0 ? (
          <EmptyState
            icon="▶"
            title={t("sandbox.empty.title")}
            description={t("sandbox.empty.description")}
          />
        ) : (
          <div className="scr-grid scr-grid--2">
            <Card title={t("sandbox.card.sessions")} subtitle={t("sandbox.card.sessions_sub")} padded={false}>
              <Table
                columns={columns}
                rows={sessions}
                rowKey={(row) => row.sessionId}
                onRowClick={(row) => setSelectedId(row.sessionId)}
                emptyLabel={t("sandbox.empty.title")}
                caption={t("sandbox.card.sessions")}
              />
            </Card>

            {selected !== undefined && <SessionDetail session={selected} />}
          </div>
        )}
      </QueryState>

      <div className="scr-note">{t("sandbox.note.no_transcript")}</div>
    </div>
  );
}

function SessionDetail({ session }: { readonly session: SandboxSession }): ReactNode {
  const t = useT();

  return (
    <div className="scr-stack">
      <Card title={t("sandbox.card.detail")} subtitle={session.ticketKey}>
        <KeyValue
          entries={[
            {
              label: t("sandbox.field.runner"),
              value: <span className="scr-mono">{`${session.runnerId} · ${session.pool}`}</span>,
            },
            {
              label: t("sandbox.field.image"),
              value: <span className="scr-mono">{session.image}</span>,
            },
            {
              label: t("sandbox.field.limits"),
              value: t("sandbox.value.limits", {
                memory: String(session.memoryMb),
                cpus: String(session.cpus),
                pids: String(session.pids),
              }),
            },
            {
              label: t("sandbox.field.timeout"),
              value: t("sandbox.value.timeout", { minutes: String(session.timeoutMinutes) }),
            },
            {
              label: t("sandbox.field.egress"),
              value: t("sandbox.value.egress", { targets: String(session.egressTargets) }),
            },
          ]}
        />
      </Card>

      <Card title={t("sandbox.card.tools")} subtitle={t("sandbox.card.tools_sub")}>
        {session.tools.length === 0 ? (
          <p className="scr-mini">{t("sandbox.empty.tools")}</p>
        ) : (
          <ul className="scr-stack" style={{ gap: 8, listStyle: "none", margin: 0, padding: 0 }}>
            {session.tools.map((tool) => (
              <li key={tool.name} className="scr-row">
                <Badge tone="purple">{tool.name}</Badge>
                <span className="scr-mini">{t(`mcp.scope.${tool.scope}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
