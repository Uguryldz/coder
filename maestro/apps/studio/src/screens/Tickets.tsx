import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Select, Table, runStatusTone } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { ageLabel, dateTimeLabel } from "./shared/format.ts";
import { projectKeyOf, useRuns, type RunExecutionStatus, type RunSummary } from "./shared/runs.ts";
import "./shared/screens.css";

/**
 * Screen: tickets — every workflow the operator may see.
 *
 * The rows are exactly what `GET /runs` returns. That endpoint speaks the
 * TEMPORAL status vocabulary (running / completed / failed / …), not the
 * delivery one the mock's chips use (kapıda / kuyrukta). The filter chips
 * therefore follow the endpoint rather than the mock: a "Kapıda" chip here
 * would have nothing to filter on, because whether a run sits at a gate is
 * in `GET /runs/:ticket`, one request per row. See RAPOR-ekranlar-A.md
 * "UÇ İSTEKLERİ" — a richer /runs is requested there.
 */

/** Chip filters, over statuses `/runs` actually sends. */
const FILTERS = [
  { id: "all", labelKey: "tickets.filter.all", match: () => true },
  {
    id: "open",
    labelKey: "tickets.filter.open",
    match: (run: RunSummary) => run.status === "running",
  },
  {
    id: "done",
    labelKey: "tickets.filter.done",
    match: (run: RunSummary) => run.status === "completed",
  },
  {
    id: "failed",
    labelKey: "tickets.filter.failed",
    match: (run: RunSummary) =>
      run.status === "failed" || run.status === "terminated" || run.status === "timed_out",
  },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export function TicketsScreen(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const enumLabel = useEnumLabel();
  const [filter, setFilter] = useState<FilterId>("all");
  const [project, setProject] = useState<string>("all");

  const { data, isPending, error, refetch } = useRuns(200);
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const projects = useMemo(
    () => [...new Set(runs.map((run) => projectKeyOf(run.ticketKey)))].sort(),
    [runs],
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((entry) => [entry.id, runs.filter((run) => entry.match(run)).length]),
      ) as Record<FilterId, number>,
    [runs],
  );

  const rows = useMemo(() => {
    const active = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0];
    return runs.filter(
      (run) =>
        active.match(run) && (project === "all" || projectKeyOf(run.ticketKey) === project),
    );
  }, [runs, filter, project]);

  const columns: readonly Column<RunSummary>[] = [
    {
      key: "ticket",
      header: t("col.ticket"),
      cell: (run) => <b className="screen-mono">{run.ticketKey}</b>,
    },
    {
      key: "project",
      header: t("col.project"),
      cell: (run) => projectKeyOf(run.ticketKey),
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (run) => (
        <Badge tone={runStatusTone(run.status)}>
          {enumLabel(RUN_STATUS_PREFIX, run.status).text}
        </Badge>
      ),
    },
    {
      key: "started",
      header: t("col.started"),
      cell: (run) => dateTimeLabel(run.startedAt, locale),
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
      <Card>
        <div className="screen-filters">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="screen-chip"
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {t(entry.labelKey, { n: String(counts[entry.id]) })}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <Select
            label={t("tickets.filter.project")}
            value={project}
            onChange={(event) => setProject(event.target.value)}
            options={[
              { value: "all", label: t("tickets.filter.all_projects") },
              ...projects.map((key) => ({ value: key, label: key })),
            ]}
          />
        </div>
      </Card>

      <Card padded={false}>
        {error !== null ? (
          <p className="screen-note" style={{ padding: 14 }} role="alert">
            {t(messageKeyOf(error))}
          </p>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(run) => run.runId}
            loading={isPending}
            emptyLabel={t("tickets.empty")}
            caption={t("tickets.caption")}
            onRowClick={(run) => void navigate(`/detail/${run.ticketKey}`)}
          />
        )}
      </Card>

      <p className="screen-note">
        {t("tickets.hint")}{" "}
        <button type="button" className="screen-chip" onClick={() => void refetch()}>
          {t("action.refresh")}
        </button>
      </p>
    </div>
  );
}

/**
 * Catalog key for a Temporal-level execution status.
 *
 * The key prefix is exported separately so callers can go through
 * `useEnumLabel`: `RunExecutionStatus` is a union in TypeScript but a plain
 * string on the wire, and Temporal owns the vocabulary. An eighth status would
 * otherwise throw out of `t()` and blank the whole ticket list.
 */
export const RUN_STATUS_PREFIX = "run.exec";

export function statusKey(status: RunExecutionStatus): string {
  return `${RUN_STATUS_PREFIX}.${status}`;
}
