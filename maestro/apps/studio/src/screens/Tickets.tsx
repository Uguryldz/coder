import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Select, Table, riskTone, runStatusTone, workModeTone } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { ageLabel, dateTimeLabel } from "./shared/format.ts";
import { MAX_RUN_PAGE, projectKeyOf, useRuns, type RunRow, type RunStatus } from "./shared/runs.ts";
import { RUN_STATUS_PREFIX } from "./tickets/status.ts";
import "./shared/screens.css";

/**
 * Screen: tickets — every workflow the operator may see.
 *
 * The rows are exactly what `GET /studio/runs` returns: the platform catalog
 * record joined to the live workflow state. That endpoint speaks the WORKFLOW
 * status vocabulary (gate / queued / fail / handover / done / …), so the chips
 * below can finally filter on the thing operators actually queue by — "kapıda"
 * is a real filter now, not a wish. The old list read Temporal and could only
 * offer running/completed/failed.
 *
 * A row whose workflow has not started carries `status: null`. It is listed
 * (the BFF deliberately does not hide it) and shown with an em dash, because a
 * ticket waiting to start is a ticket the operator must still be able to see.
 */

/** Chip filters, over the statuses `/studio/runs` actually sends. */
const FILTERS = [
  { id: "all", labelKey: "tickets.filter.all", match: () => true },
  {
    id: "open",
    labelKey: "tickets.filter.open",
    match: (run: RunRow) => run.status === "running",
  },
  {
    id: "gate",
    labelKey: "tickets.filter.gate",
    match: (run: RunRow) => run.status === "gate",
  },
  {
    id: "done",
    labelKey: "tickets.filter.done",
    match: (run: RunRow) => run.status === "done",
  },
  {
    id: "failed",
    labelKey: "tickets.filter.failed",
    match: (run: RunRow) => run.status === "fail" || run.status === "handover",
  },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export function TicketsScreen(): ReactNode {
  return (
    <div className="screen-stack">
      <TicketsList />
    </div>
  );
}

/**
 * The filterable run list, split out of `TicketsScreen` so the Panel can show
 * it inline — the two used to be separate menu rows over the SAME `/studio/runs`
 * data (the Panel was literally the first-five summary of this list). Gathering
 * them means one page: summary on top, the full filterable list below.
 */
export function TicketsList(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const enumLabel = useEnumLabel();
  const [filter, setFilter] = useState<FilterId>("all");
  const [project, setProject] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  const RUN_PAGE = MAX_RUN_PAGE;
  const { data, isPending, error, refetch } = useRuns(RUN_PAGE);
  const runs = useMemo(() => data?.runs ?? [], [data]);
  // The list is capped at one page; if the cap is hit there may be more the
  // server did not send. Say so plainly instead of implying this is everything.
  const capped = runs.length >= RUN_PAGE;

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
    const q = search.trim().toLowerCase();
    return runs.filter(
      (run) =>
        active.match(run) &&
        (project === "all" || projectKeyOf(run.ticketKey) === project) &&
        (q === "" ||
          run.ticketKey.toLowerCase().includes(q) ||
          (run.title ?? "").toLowerCase().includes(q)),
    );
  }, [runs, filter, project, search]);

  const columns: readonly Column<RunRow>[] = [
    {
      key: "ticket",
      header: t("col.ticket"),
      cell: (run) => (
        <>
          <b className="screen-mono">{run.ticketKey}</b>
          <div className="screen-note">{run.title}</div>
        </>
      ),
    },
    {
      key: "app",
      header: t("col.app"),
      // `appId` is null until the ticket is matched to an application (M100).
      cell: (run) => (run.appId === null ? "—" : <span className="screen-mono">{run.appId}</span>),
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
            <span className="screen-mono">{run.step}</span> {t(`steps.${run.step}`)}
          </>
        ),
    },
    {
      key: "risk",
      header: t("col.risk"),
      cell: (run) => <Badge tone={riskTone(run.risk)}>{t(`risk.${run.risk}`)}</Badge>,
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
  ];

  return (
    <>
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
          <Input
            label={t("tickets.filter.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("tickets.filter.search_ph")}
          />
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
        {capped && (
          <p className="screen-note" style={{ marginTop: 8 }}>
            {t("tickets.capped", { n: String(RUN_PAGE) })}
          </p>
        )}
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
            rowKey={(run) => run.ticketKey}
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
    </>
  );
}

/**
 * A status badge that tells "not started" apart from a status.
 *
 * `null` is rendered as an em dash rather than as any word: the run exists in
 * the catalog and the workflow engine has never heard of it, and picking
 * "queued" for that would invent a queue position nothing assigned.
 */
export function RunStatusCell({ status }: { readonly status: RunStatus | null }): ReactNode {
  const t = useT();
  const enumLabel = useEnumLabel();
  if (status === null) return <span className="screen-note">{t("run.status.unknown")}</span>;
  return <Badge tone={runStatusTone(status)}>{enumLabel(RUN_STATUS_PREFIX, status).text}</Badge>;
}
