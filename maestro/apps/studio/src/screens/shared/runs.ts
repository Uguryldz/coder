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
 * ENDPOINT REQUEST (not implemented by the BFF today — see RAPOR-ekranlar-A.md).
 * GET /runs/:ticket/journal -> { entries: JournalEntry[] }
 * The screens below call it; until it exists the query fails and the tab shows
 * a translated error rather than fabricated history.
 */
export interface JournalResponse {
  readonly entries: readonly JournalEntry[];
}

export function useJournal(
  ticket: string | undefined,
  enabled = true,
): UseQueryResult<JournalResponse> {
  const api = useApi();
  return useQuery({
    queryKey: ["journal", ticket ?? null],
    queryFn: ({ signal }) => api.get<JournalResponse>(`/runs/${ticket ?? ""}/journal`, { signal }),
    enabled: enabled && ticket !== undefined && ticket !== "",
    retry: false,
  });
}

/**
 * ENDPOINT REQUEST: GET /runs/:ticket/evidence -> EvidencePackage.
 * Same honesty rule: no package, no file list.
 */
export function useEvidence(
  ticket: string | undefined,
  enabled = true,
): UseQueryResult<EvidencePackage> {
  const api = useApi();
  return useQuery({
    queryKey: ["evidence", ticket ?? null],
    queryFn: ({ signal }) => api.get<EvidencePackage>(`/runs/${ticket ?? ""}/evidence`, { signal }),
    enabled: enabled && ticket !== undefined && ticket !== "",
    retry: false,
  });
}
