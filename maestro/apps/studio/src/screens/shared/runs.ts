import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  ApplicationRecord,
  DataClass,
  EvidencePackage,
  JournalEntry,
  RiskTier,
  StepId,
  TicketKey,
  WorkMode,
  WorkflowRunState,
  WorkflowRunStatus,
} from "@maestro/contracts";
import { useApi } from "../../auth/AuthProvider.tsx";

/**
 * The run data layer shared by the flow screens (dash, tickets, detail, live,
 * clarify, fanout, evidence).
 *
 * Field names here are copied from the BFF, not invented:
 *   GET /studio/runs        -> { items: (RunRecord & { state })[], nextCursor }
 *                              apps/bff/src/routes/studio-runs.ts:27
 *   GET /studio/runs/:ticket -> { run, state, application }
 *                              apps/bff/src/routes/studio-runs.ts:63
 *
 * WHY NOT `/runs`: that endpoint reads Temporal (`deps.runs.list`) and knows
 * only what the ENGINE knows — workflowId/runId/startedAt plus an execution
 * status. `/studio/runs` reads the platform catalog (`deps.read.runs`, Postgres)
 * and joins the workflow state onto it, so it carries the ticket's title, the
 * application it was matched to, its risk tier, its mode, its parent/child
 * links and its spend. Every one of those is a field a flow screen had to leave
 * blank while it read the engine, and a run that exists in the catalog but has
 * no live execution is a ticket the engine cannot see at all.
 *
 * ONE STATUS VOCABULARY, DELIBERATELY. `/runs` spoke Temporal's
 * (running/completed/failed/…); this file speaks the WORKFLOW's
 * (gate/queued/fail/handover/done/…, `WorkflowRunStatus` in the frozen
 * contract) because that is the one `state.status` carries. Nothing here
 * translates between them: a run parked at a gate now says "gate" instead of
 * "running", which is the truth the catalog holds, and mapping it back onto the
 * engine's word would throw away the distinction the screens exist to show.
 *
 * `status` is NULLABLE and that is load-bearing. The BFF lists a catalog record
 * whose workflow has not started as `state: null` rather than hiding it
 * (studio-runs.ts:43) — hiding it would make the queue look empty. So a row may
 * legitimately have no status, no step and no risk, and every screen below
 * renders that as an em dash rather than inventing "queued" for it.
 */

/** The workflow's own status vocabulary — `WorkflowRunStatus`, frozen contract. */
export type RunStatus = WorkflowRunStatus;

/**
 * One row of `GET /studio/runs`, flattened.
 *
 * The wire shape nests the workflow state (`{ ...record, state }`); this type
 * lifts `step`/`status`/`risk`/`updatedAt` to the top level so a screen reads
 * `run.status` rather than `run.state?.status` in every cell — and so the
 * "no execution yet" case is a single `null` check at the boundary instead of
 * an optional-chain each screen could forget.
 *
 * `risk` comes from the workflow state when it has one and falls back to the
 * catalog record, which always carries a tier. `startedAt` prefers the
 * execution's own clock and falls back to the catalog's.
 */
export interface RunRow {
  readonly ticketKey: TicketKey;
  readonly title: string;
  readonly appId: string | null;
  readonly mode: WorkMode;
  readonly risk: RiskTier;
  readonly dataClass: DataClass;
  readonly parentTicketKey: TicketKey | null;
  readonly childTicketKeys: readonly TicketKey[];
  readonly reporter: string;
  readonly assignee: string | null;
  readonly prId: number | null;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** `null` when the catalog has the ticket but no execution exists yet. */
  readonly runId: string | null;
  /** `null` for the same reason — NOT defaulted to a status the run lacks. */
  readonly status: RunStatus | null;
  /** `null` for the same reason. */
  readonly step: StepId | null;
}

/** The platform record as `read-models.ts:RunRecord` sends it. */
interface RunRecordWire {
  readonly ticketKey: TicketKey;
  readonly title: string;
  readonly appId: string | null;
  readonly mode: WorkMode;
  readonly risk: RiskTier;
  readonly dataClass: DataClass;
  readonly parentTicketKey: TicketKey | null;
  readonly childTicketKeys: readonly TicketKey[];
  readonly reporter: string;
  readonly assignee: string | null;
  readonly prId: number | null;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** The nested wire row: the catalog record plus the joined workflow state. */
interface RunListItemWire extends RunRecordWire {
  readonly state: WorkflowRunState | null;
}

/** The page envelope every Studio list endpoint sends (routes/paging.ts:43). */
export interface RunPageWire {
  readonly items: readonly RunListItemWire[];
  readonly nextCursor: string | null;
}

/** What {@link useRuns} hands a screen: flattened rows plus the page cursor. */
export interface RunListResult {
  readonly runs: readonly RunRow[];
  readonly nextCursor: string | null;
}

/**
 * Flatten one wire row.
 *
 * Exported for the tests, which assert this function rather than only the
 * rendered output: reading `body.runs` off a `{ items }` envelope, or reading
 * `row.status` off a row whose status is nested under `state`, both produce an
 * EMPTY OR BLANK list with no error at all — the failure mode this project
 * treats as worse than a crash, because a screen that shows nothing looks
 * healthy while it lies.
 */
export function toRunRow(item: RunListItemWire): RunRow {
  const { state, ...record } = item;
  return {
    ...record,
    runId: state?.runId ?? null,
    status: state?.status ?? null,
    step: state?.step ?? null,
    risk: state?.risk ?? record.risk,
    startedAt: state?.startedAt ?? record.startedAt,
    updatedAt: state?.updatedAt ?? record.updatedAt,
  };
}

/**
 * Read a `/studio/runs` body into rows.
 *
 * Tolerates a missing/!Array `items` by yielding an empty list rather than
 * throwing: a shape change upstream should show "no runs" plus whatever the
 * query layer reports, not blank the screen behind the ErrorBoundary.
 */
export function toRunList(body: RunPageWire | undefined): RunListResult {
  if (body === undefined || !Array.isArray(body.items)) return { runs: [], nextCursor: null };
  return { runs: body.items.map(toRunRow), nextCursor: body.nextCursor ?? null };
}

/** The Jira project key of a ticket: `UGURPAY-501` -> `UGURPAY`. */
export function projectKeyOf(ticketKey: string): string {
  const dash = ticketKey.lastIndexOf("-");
  return dash === -1 ? ticketKey : ticketKey.slice(0, dash);
}

export interface UseRunsOptions {
  readonly limit?: number;
  /** Poll interval in ms; omit for a one-shot fetch. */
  readonly refetchInterval?: number;
}

/**
 * The ticket list. `select` does the flattening so every consumer gets `runs`
 * already in {@link RunRow} shape and no screen has to know the envelope.
 */
export function useRuns(
  limit?: number,
  options: UseRunsOptions = {},
): UseQueryResult<RunListResult> {
  const api = useApi();
  return useQuery({
    queryKey: ["studio-runs", limit ?? null],
    queryFn: ({ signal }) =>
      api.get<RunPageWire>("/studio/runs", {
        ...(limit === undefined ? {} : { query: { limit } }),
        signal,
      }),
    select: toRunList,
    ...(options.refetchInterval === undefined
      ? {}
      : { refetchInterval: options.refetchInterval }),
  });
}

/** What `GET /studio/runs/:ticket` sends — record, live state, matched app. */
export interface RunDetail {
  readonly run: RunRecordWire;
  readonly state: WorkflowRunState | null;
  readonly application: ApplicationRecord | null;
}

/**
 * One run's detail. `enabled` is false for an absent ticket so the detail
 * screen can render its "pick a ticket" state without firing a request for the
 * string "undefined".
 *
 * Unlike the old `/runs/:ticket`, this returns the state NESTED beside the
 * catalog record instead of bare, so `data.state` may be `null` for a ticket
 * that exists but never started. The detail screen shows the record either way
 * — a 404 here means "no such ticket", which is a different sentence.
 */
export function useRunDetail(ticket: string | undefined): UseQueryResult<RunDetail> {
  const api = useApi();
  return useQuery({
    queryKey: ["studio-run", ticket ?? null],
    queryFn: ({ signal }) =>
      api.get<RunDetail>(`/studio/runs/${encodeURIComponent(ticket ?? "")}`, { signal }),
    enabled: ticket !== undefined && ticket !== "",
    retry: false,
  });
}

/**
 * The ticket journal (M30).
 *
 * `GET /studio/runs/:ticket/journal` — apps/bff/src/routes/studio-runs.ts:80.
 * The BFF sends the shared page envelope `{ items, nextCursor }` (`pageBody`,
 * routes/paging.ts:43), NOT `{ entries }`. Keeping the wrong field name would
 * render an empty journal with no error at all, and an empty audit trail that
 * looks healthy is a lie a reader cannot detect.
 */
export interface JournalResponse {
  readonly items: readonly JournalEntry[];
  readonly nextCursor: string | null;
}

export function useJournal(
  ticket: string | undefined,
  enabled = true,
): UseQueryResult<JournalResponse> {
  const api = useApi();
  return useQuery({
    queryKey: ["journal", ticket ?? null],
    queryFn: ({ signal }) =>
      api.get<JournalResponse>(`/studio/runs/${encodeURIComponent(ticket ?? "")}/journal`, {
        signal,
      }),
    enabled: enabled && ticket !== undefined && ticket !== "",
    retry: false,
  });
}

/**
 * The evidence package manifest (M56).
 *
 * `GET /studio/runs/:ticket/evidence` — routes/studio-runs.ts:113. Sends the
 * bare `EvidencePackage` (no page envelope: a manifest is one object), so the
 * response type is used as-is. 404 `no_evidence` means the run has not produced
 * a package yet, which the screen shows as an error rather than an empty file
 * list — an audit screen must never imply "no files" when it means "no answer".
 */
export function useEvidence(
  ticket: string | undefined,
  enabled = true,
): UseQueryResult<EvidencePackage> {
  const api = useApi();
  return useQuery({
    queryKey: ["evidence", ticket ?? null],
    queryFn: ({ signal }) =>
      api.get<EvidencePackage>(`/studio/runs/${encodeURIComponent(ticket ?? "")}/evidence`, {
        signal,
      }),
    enabled: enabled && ticket !== undefined && ticket !== "",
    retry: false,
  });
}
