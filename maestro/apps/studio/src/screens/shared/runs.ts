import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  EvidencePackage,
  JournalEntry,
  TicketKey,
  WorkflowRunState,
} from "@maestro/contracts";
import { useApi } from "../../auth/AuthProvider.tsx";

/**
 * The run data layer shared by the flow screens (dash, tickets, detail, live,
 * clarify, workmode, fanout, evidence, jira).
 *
 * Field names here are copied from the BFF, not invented:
 *   GET /runs          -> { runs: RunSummary[] }      apps/bff/src/gateway.ts
 *   GET /runs/:ticket  -> WorkflowRunState            packages/contracts/src/workflow.ts
 *
 * The two carry DIFFERENT status vocabularies on purpose — the list is what
 * Temporal knows about an execution (running/completed/failed/…), the detail is
 * what the workflow knows about the delivery (gate/fail/done/…). `runStatusTone`
 * in src/ui covers both, and nothing here collapses one into the other: a list
 * row saying "running" while the run sits at a gate is the truth of that
 * endpoint, and inventing "gate" for it would be a lie with a nice colour.
 */

/** Mirrors `RunExecutionStatus` in apps/bff/src/gateway.ts. */
export type RunExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"
  | "continued_as_new"
  | "timed_out";

/** Mirrors `RunSummary` in apps/bff/src/gateway.ts — the shape `/runs` sends. */
export interface RunSummary {
  readonly workflowId: string;
  readonly ticketKey: TicketKey;
  readonly runId: string;
  readonly status: RunExecutionStatus;
  readonly startedAt: string;
  readonly closedAt: string | null;
}

export interface RunListResponse {
  readonly runs: readonly RunSummary[];
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

export function useRuns(
  limit?: number,
  options: UseRunsOptions = {},
): UseQueryResult<RunListResponse> {
  const api = useApi();
  return useQuery({
    queryKey: ["runs", limit ?? null],
    queryFn: ({ signal }) =>
      api.get<RunListResponse>("/runs", {
        ...(limit === undefined ? {} : { query: { limit } }),
        signal,
      }),
    ...(options.refetchInterval === undefined
      ? {}
      : { refetchInterval: options.refetchInterval }),
  });
}

/**
 * One run's workflow state. `enabled` is false for an absent ticket so the
 * detail screen can render its "pick a ticket" state without firing a request
 * for the string "undefined".
 */
export function useRunState(ticket: string | undefined): UseQueryResult<WorkflowRunState> {
  const api = useApi();
  return useQuery({
    queryKey: ["run", ticket ?? null],
    queryFn: ({ signal }) => api.get<WorkflowRunState>(`/runs/${ticket ?? ""}`, { signal }),
    enabled: ticket !== undefined && ticket !== "",
    retry: false,
  });
}

/**
 * The ticket journal (M30).
 *
 * `GET /studio/runs/:ticket/journal` — apps/bff/src/routes/studio-runs.ts:80.
 * The route EXISTS and always did; an earlier revision of this file called
 * `/runs/:ticket/journal`, which Fastify answers 404 for because
 * apps/bff/src/routes/runs.ts registers no sub-resources. That is the exact
 * failure mode this project treats as fatal — calling a real capability down an
 * invented path — so the path here is copied from the route registration rather
 * than inferred from the sibling `/runs` prefix.
 *
 * The BFF sends the shared page envelope `{ items, nextCursor }` (`pageBody`,
 * routes/paging.ts:43), NOT `{ entries }`. Getting the path right while keeping
 * the wrong field name would be worse than the 404: the tab would render an
 * empty journal with no error at all, and an empty audit trail that looks
 * healthy is a lie a reader cannot detect.
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
