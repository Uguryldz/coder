import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Select, Table, riskTone, workModeTone } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { useToast } from "../ui/Toast.tsx";
import { useEnumLabel } from "./common/label.ts";
import { ageLabel, dateTimeLabel } from "./shared/format.ts";
import {
  MAX_RUN_PAGE,
  projectKeyOf,
  useArchiveRun,
  useRuns,
  type RunRow,
  type RunStatus,
  type UseRunsOptions,
} from "./shared/runs.ts";
import { RunStatusCell } from "./shared/RunStatusCell.tsx";

/**
 * The filterable run list — every workflow the operator may see, as
 * `GET /studio/runs` returns it: the catalog record joined to the live
 * workflow state, in the WORKFLOW's status vocabulary.
 *
 * A row whose workflow has not started carries `status: null`. It is listed
 * (the BFF deliberately does not hide it) and shown as "başlamadı", because a
 * ticket waiting to start is a ticket the operator must still be able to see.
 */

/** The board's default scope — shared with the Panel so both read ONE query. */
export const BOARD_SCOPE = { archived: "active" } satisfies UseRunsOptions;

/** Every status `/studio/runs` sends, in the order the chips show them. */
const STATUS_FILTERS: readonly { readonly id: RunStatus; readonly labelKey: string }[] = [
  { id: "running", labelKey: "tickets.filter.open" },
  { id: "gate", labelKey: "tickets.filter.gate" },
  { id: "queued", labelKey: "tickets.filter.queued" },
  { id: "fail", labelKey: "tickets.filter.failed" },
  { id: "handover", labelKey: "tickets.filter.handover" },
  { id: "done", labelKey: "tickets.filter.done" },
  { id: "cancelled", labelKey: "tickets.filter.cancelled" },
];

type FilterId = RunStatus | "all";

export function TicketsList(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const enumLabel = useEnumLabel();
  const toast = useToast();
  const [filter, setFilter] = useState<FilterId>("all");
  const [project, setProject] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  /**
   * Board or archive. Separate from `filter` because it is a different
   * QUESTION: the chips slice one set by status, this decides which set.
   */
  const [showArchived, setShowArchived] = useState(false);

  // The scope goes to the SERVER: the page is capped at `MAX_RUN_PAGE`, so a
  // client-side hide would silently shrink an already-truncated page.
  const { data, isPending, error } = useRuns(MAX_RUN_PAGE, {
    archived: showArchived ? "archived" : BOARD_SCOPE.archived,
    refetchInterval: 30_000,
  });
  const archive = useArchiveRun();
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const capped = runs.length >= MAX_RUN_PAGE;

  const projects = useMemo(
    () => [...new Set(runs.map((run) => projectKeyOf(run.ticketKey)))].sort(),
    [runs],
  );

  const counts = useMemo(() => {
    const byStatus = new Map<FilterId, number>([["all", runs.length]]);
    for (const run of runs) {
      if (run.status === null) continue;
      byStatus.set(run.status, (byStatus.get(run.status) ?? 0) + 1);
    }
    return byStatus;
  }, [runs]);

  // Only statuses that are actually present get a chip — "Hatalı (0)" is a
  // pill that says nothing. A filter whose set emptied after a refetch falls
  // back to "all" rather than showing an empty table under a vanished chip.
  const chips = STATUS_FILTERS.filter((entry) => (counts.get(entry.id) ?? 0) > 0);
  const active: FilterId = filter === "all" || (counts.get(filter) ?? 0) > 0 ? filter : "all";
  const filtered = project !== "all" || search.trim() !== "" || active !== "all";

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter(
      (run) =>
        (active === "all" || run.status === active) &&
        (project === "all" || projectKeyOf(run.ticketKey) === project) &&
        (q === "" ||
          run.ticketKey.toLowerCase().includes(q) ||
          (run.title ?? "").toLowerCase().includes(q)),
    );
  }, [runs, active, project, search]);

  const columns: readonly Column<RunRow>[] = [
    {
      key: "ticket",
      header: t("col.ticket"),
      cell: (run) => (
        <>
          <b className="scr-mono">{run.ticketKey}</b>
          <div className="scr-hint">{run.title}</div>
        </>
      ),
    },
    {
      key: "app",
      header: t("col.app"),
      cell: (run) => (run.appId === null ? "—" : <span className="scr-mono">{run.appId}</span>),
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (run) => <RunStatusCell status={run.status} />,
    },
    {
      key: "step",
      header: t("col.step"),
      cell: (run) =>
        run.step === null ? (
          "—"
        ) : (
          <>
            <span className="scr-mono">{run.step}</span> {t(`steps.${run.step}`)}
          </>
        ),
    },
    {
      key: "risk",
      header: t("col.risk"),
      cell: (run) => <Badge tone={riskTone(run.risk)}>{enumLabel("risk", run.risk).text}</Badge>,
    },
    {
      key: "mode",
      header: t("col.mode"),
      cell: (run) => (
        <Badge tone={workModeTone(run.mode)}>{enumLabel("mode", run.mode).text}</Badge>
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
    /**
     * Archive / restore. `stopPropagation` because the row navigates; the
     * label is the OPPOSITE of the row's state so it says what will happen.
     */
    {
      key: "archive",
      header: t("col.actions"),
      align: "right",
      cell: (run) => {
        const archived = run.archivedAt !== null;
        return (
          <Button
            variant="ghost"
            size="sm"
            disabled={archive.isPending}
            onClick={(event) => {
              event.stopPropagation();
              archive.mutate(
                { ticketKey: run.ticketKey, archived: !archived },
                {
                  onSuccess: () =>
                    toast.show(
                      "success",
                      t(archived ? "tickets.archive.restored" : "tickets.archive.done", {
                        ticket: run.ticketKey,
                      }),
                    ),
                  // A 403 must not look like a button that did nothing.
                  onError: (mutationError) => toast.show("error", t(messageKeyOf(mutationError))),
                },
              );
            }}
          >
            {t(archived ? "tickets.archive.undo" : "tickets.archive.action")}
          </Button>
        );
      },
    },
  ];

  const emptyLabel = showArchived
    ? t("tickets.empty_archived")
    : filtered
      ? t("tickets.empty_filtered")
      : t("tickets.empty");

  return (
    <div className="scr-stack">
      <div className="scr-filters">
        <button
          type="button"
          className="scr-chip"
          aria-pressed={active === "all"}
          onClick={() => setFilter("all")}
        >
          {t("tickets.filter.all", { n: String(runs.length) })}
        </button>
        {chips.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="scr-chip"
            aria-pressed={active === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {t(entry.labelKey, { n: String(counts.get(entry.id) ?? 0) })}
          </button>
        ))}
        <button
          type="button"
          className="scr-chip"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((on) => !on)}
        >
          {t(showArchived ? "tickets.filter.show_active" : "tickets.filter.show_archived")}
        </button>
        {projects.length > 1 && (
          <Select
            label={t("tickets.filter.project")}
            value={project}
            onChange={(event) => setProject(event.target.value)}
            options={[
              { value: "all", label: t("tickets.filter.all_projects") },
              ...projects.map((key) => ({ value: key, label: key })),
            ]}
          />
        )}
        {runs.length > 0 && (
          <Input
            label={t("tickets.filter.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("tickets.filter.search_ph")}
          />
        )}
      </div>

      {error !== null ? (
        <p className="scr-hint" role="alert">
          {t(messageKeyOf(error))}
        </p>
      ) : (
        <Card padded={false}>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(run) => run.ticketKey}
            loading={isPending}
            emptyLabel={emptyLabel}
            caption={t("tickets.caption")}
            onRowClick={(run) => void navigate(`/detail/${run.ticketKey}`)}
          />
        </Card>
      )}

      {!isPending && error === null && runs.length === 0 && !showArchived && (
        <p className="scr-hint">{t("tickets.empty_hint")}</p>
      )}
      {capped && <p className="scr-hint">{t("tickets.capped", { n: String(MAX_RUN_PAGE) })}</p>}
      {rows.length > 0 && <p className="scr-hint">{t("tickets.hint")}</p>}
    </div>
  );
}
