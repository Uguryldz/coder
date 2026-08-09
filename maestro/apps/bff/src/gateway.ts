import type {
  DataClass,
  TicketKey,
  WorkMode,
  WorkflowRunState,
} from "@maestro/contracts";

/**
 * The workflow engine as the BFF sees it. Temporal lives behind this interface
 * so no route imports a client library, and so every test in this package runs
 * offline against a fake (M44 DI, insa-plani §2).
 */

/** One Temporal execution per ticket; the id is derived, never stored. */
export function workflowIdFor(ticket: TicketKey): string {
  return `maestro-${ticket}`;
}

/** Inverse of {@link workflowIdFor}; `null` for ids this deployment did not mint. */
export function ticketOfWorkflowId(workflowId: string): string | null {
  const prefix = "maestro-";
  return workflowId.startsWith(prefix) ? workflowId.slice(prefix.length) : null;
}

/** Closed-run outcomes Temporal reports, plus the one open state. */
export type RunExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"
  | "continued_as_new"
  | "timed_out";

export interface RunSummary {
  workflowId: string;
  ticketKey: TicketKey;
  runId: string;
  status: RunExecutionStatus;
  startedAt: string;
  closedAt: string | null;
}

export interface StartRunInput {
  ticket: TicketKey;
  appId: string;
  mode: WorkMode;
  dataClass: DataClass;
}

export interface SignalWithStartInput extends StartRunInput {
  /**
   * Delivered to the run whether it had to be created or was already going.
   * Omitted for a plain intake, where the start itself is the whole event.
   */
  signal?: { name: string; args: readonly unknown[] };
}

export interface StartOutcome {
  workflowId: string;
  /** False when the call joined a run that was already going. */
  started: boolean;
}

/** `no_run` instead of a throw: "nobody is listening" is an answer, not a fault. */
export type SignalOutcome = "delivered" | "no_run";

export interface RunGateway {
  /** Cheap reachability probe for `/readyz`; throws when the engine is down. */
  ping(): Promise<void>;
  list(options?: { limit?: number; onlyRunning?: boolean }): Promise<RunSummary[]>;
  /** `null` when no execution exists for that id. */
  queryRunState(workflowId: string): Promise<WorkflowRunState | null>;
  /**
   * Signal an EXISTING run. Never creates one: a gate decision or a build
   * result for a ticket Maestro is not running is a mistake to report, not a
   * reason to invent a workflow (M14).
   */
  signal(workflowId: string, name: string, arg: unknown): Promise<SignalOutcome>;
  /**
   * Start-or-signal in one atomic call — the intake path. A ticket that has no
   * run gets one; a ticket that already has one just hears the signal, so two
   * webhook deliveries racing on the same ticket cannot produce two runs.
   */
  signalWithStart(input: SignalWithStartInput): Promise<StartOutcome>;
}
