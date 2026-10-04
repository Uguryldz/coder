import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type { Page, SandboxRecord, SandboxState } from "./common/index.ts";
import { QueryState, useEnumLabel } from "./common/index.ts";
import { ageLabel } from "./shared/format.ts";

/**
 * `human_held` is the one state that means a person is inside the workspace,
 * so it is the one that earns a colour; the other two are ordinary.
 */
const STATE_TONE: Readonly<Record<SandboxState, BadgeTone>> = {
  active: "green",
  resumable: "gray",
  human_held: "amber",
};

/** An unknown state renders grey and marked rather than blanking the list. */
function stateTone(state: string): BadgeTone {
  return Object.hasOwn(STATE_TONE, state) ? STATE_TONE[state as SandboxState] : "gray";
}

/**
 * Live sandboxes and the workspaces they left behind.
 *
 * `GET /studio/sandboxes` folds the `SANDBOX_CREATE` / `SANDBOX_DESTROY`
 * audit events into one record per workspace, so what is shown is what the
 * platform observed: the state is derived from the last event, and the time
 * column is that event's time. No size column — nothing measures a workspace,
 * and a column that always read "0 B" was a measurement nobody took.
 *
 * Two deliberate absences: no session TRANSCRIPT (live agent output can carry
 * unmasked ticket text) and no DELETE control (the retention job owns removal;
 * a delete button is how somebody destroys the session a human is working in).
 */
export function SandboxScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const navigate = useNavigate();
  const enumLabel = useEnumLabel();

  const sandboxes = useQuery({
    queryKey: ["studio-sandboxes"],
    queryFn: ({ signal }) => api.get<Page<SandboxRecord>>("/studio/sandboxes", { signal }),
    refetchInterval: 30_000,
  });

  const rows = sandboxes.data?.items ?? [];

  const columns: readonly Column<SandboxRecord>[] = [
    {
      key: "ticket",
      header: t("sandbox.col.ticket"),
      cell: (row) => <b className="scr-mono">{row.ticketKey}</b>,
    },
    {
      key: "runner",
      header: t("sandbox.col.runner"),
      cell: (row) => <span className="scr-mono">{row.runnerId}</span>,
    },
    {
      key: "state",
      header: t("sandbox.col.session"),
      cell: (row) => {
        const label = enumLabel("sandbox.state", row.state);
        return (
          <Badge tone={label.unknown ? "gray" : stateTone(row.state)}>{label.text}</Badge>
        );
      },
    },
    {
      key: "last",
      header: t("sandbox.col.last_event"),
      align: "right",
      cell: (row) => {
        const age = ageLabel(row.lastAccessAt);
        return age === null ? "—" : t(age.key, age.params);
      },
    },
  ];

  return (
    <div className="scr-stack">
      <QueryState
        isPending={sandboxes.isPending}
        error={sandboxes.error}
        isEmpty={rows.length === 0}
        emptyTitle={t("sandbox.empty.title")}
        emptyDescription={t("sandbox.empty.description")}
        emptyIcon="▶"
        onRetry={() => void sandboxes.refetch()}
      >
        <Card title={t("sandbox.card.sessions")} padded={false}>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.ticketKey}:${row.runnerId}`}
            emptyLabel={t("sandbox.empty.title")}
            caption={t("sandbox.card.sessions")}
            onRowClick={(row) => void navigate(`/detail/${row.ticketKey}`)}
          />
        </Card>
        <p className="scr-hint">{t("sandbox.hint")}</p>
      </QueryState>

      <p className="scr-hint">
        {t("sandbox.note.no_transcript")} {t("sandbox.note.no_delete")}
      </p>
    </div>
  );
}
