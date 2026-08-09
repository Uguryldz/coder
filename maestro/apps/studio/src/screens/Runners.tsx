import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import { QueryState, type RunnerNode, type RunnersView, type RunnerStatus } from "./common/index.ts";
import { useLabel } from "./common/label.ts";

const STATUS_TONE: Readonly<Record<RunnerStatus, BadgeTone>> = {
  ok: "green",
  warn: "amber",
  unreachable: "red",
};

/**
 * Runner pools: where the agents' sandboxes actually execute.
 *
 * `unreachable` machines are sorted to the TOP and counted in a dedicated tile.
 * A node that stopped answering is not a node with no problems — it is the one
 * whose jobs are silently not running, and the natural alphabetical ordering
 * would bury it under healthy hosts. Capacity numbers exclude it too: counting
 * the slots of a machine nobody can reach is how a pool looks like it has
 * headroom it does not have.
 */
export function RunnersScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: ({ signal }) => api.get<RunnersView>("/runners", { signal }),
    refetchInterval: 30_000,
  });

  const nodes = useMemo(() => sortByUrgency(runners.data?.runners ?? []), [runners.data]);
  const pools = useMemo(() => summarise(nodes), [nodes]);
  const unreachable = nodes.filter((node) => node.status === "unreachable").length;

  const columns: readonly Column<RunnerNode>[] = [
    {
      key: "id",
      header: t("runners.col.machine"),
      cell: (row) => (
        <div>
          <b className="scr-mono">{row.id}</b>
          <div className="scr-mini">{row.host}</div>
        </div>
      ),
    },
    {
      key: "pool",
      header: t("runners.col.pool"),
      cell: (row) => <Badge tone="blue">{label(`platform.${row.platform}`, row.platform)}</Badge>,
    },
    {
      key: "slots",
      header: t("runners.col.slots"),
      cell: (row) => (
        <span className="scr-mono">
          {row.busy}/{row.capacity}
        </span>
      ),
      align: "right",
    },
    {
      key: "jobs",
      header: t("runners.col.jobs"),
      cell: (row) => (
        <span className="scr-mini">{row.jobs.length === 0 ? "—" : row.jobs.join(", ")}</span>
      ),
    },
    {
      key: "status",
      header: t("runners.col.status"),
      cell: (row) => (
        <div>
          <Badge tone={STATUS_TONE[row.status]} icon="●">
            {t(`runners.status.${row.status}`)}
          </Badge>
          {row.messageKey !== null && (
            <div className="scr-mini">{label(row.messageKey, row.id)}</div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <QueryState
        isPending={runners.isPending}
        error={runners.error}
        onRetry={() => void runners.refetch()}
      >
        {unreachable > 0 && (
          <div className="scr-note scr-note--danger">
            {t("runners.alert.unreachable", { count: String(unreachable) })}
          </div>
        )}

        <div className="scr-grid scr-grid--3">
          {pools.map((pool) => (
            <Kpi
              key={pool.pool}
              label={pool.pool}
              value={`${pool.busy}/${pool.capacity}`}
              note={
                pool.unreachable > 0
                  ? t("runners.kpi.note_unreachable", {
                      machines: String(pool.machines),
                      unreachable: String(pool.unreachable),
                    })
                  : t("runners.kpi.note_healthy", { machines: String(pool.machines) })
              }
            />
          ))}
        </div>

        <Card title={t("runners.card.machines")} subtitle={t("runners.card.machines_sub")} padded={false}>
          <Table
            columns={columns}
            rows={nodes}
            rowKey={(row) => row.id}
            emptyLabel={t("runners.empty")}
            caption={t("runners.card.machines")}
          />
        </Card>
      </QueryState>

      <div className="scr-grid scr-grid--2">
        <Card title={t("runners.card.isolation")}>
          <dl className="scr-kv">
            {(["linux", "windows_macos", "network", "identity"] as const).map((row) => (
              <div key={row} style={{ display: "contents" }}>
                <dt>{t(`runners.isolation.${row}`)}</dt>
                <dd>{t(`runners.isolation.${row}.value`)}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={t("runners.card.accepted_risk")}>
          <p className="scr-prose">{t("runners.accepted_risk.body")}</p>
        </Card>
      </div>
    </div>
  );
}

interface PoolSummary {
  readonly pool: string;
  readonly machines: number;
  readonly capacity: number;
  readonly busy: number;
  readonly unreachable: number;
}

/** Unreachable first, then warnings, then healthy — worst news at the top. */
function sortByUrgency(nodes: readonly RunnerNode[]): readonly RunnerNode[] {
  const rank: Readonly<Record<RunnerStatus, number>> = { unreachable: 0, warn: 1, ok: 2 };
  return [...nodes].sort((left, right) => {
    const byStatus = rank[left.status] - rank[right.status];
    return byStatus !== 0 ? byStatus : left.id.localeCompare(right.id);
  });
}

function summarise(nodes: readonly RunnerNode[]): readonly PoolSummary[] {
  const pools = new Map<string, { machines: number; capacity: number; busy: number; unreachable: number }>();
  for (const node of nodes) {
    const entry = pools.get(node.pool) ?? { machines: 0, capacity: 0, busy: 0, unreachable: 0 };
    entry.machines += 1;
    if (node.status === "unreachable") {
      entry.unreachable += 1;
    } else {
      // Only reachable machines contribute usable slots.
      entry.capacity += node.capacity;
      entry.busy += node.busy;
    }
    pools.set(node.pool, entry);
  }
  return [...pools.entries()].map(([pool, entry]) => ({ pool, ...entry }));
}
