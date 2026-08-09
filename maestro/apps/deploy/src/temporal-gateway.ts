import type {
  RunExecutionStatus,
  RunGateway,
  RunSummary,
  SignalOutcome,
  SignalWithStartInput,
  StartOutcome,
} from "@maestro/bff";
import { workflowIdFor } from "@maestro/bff";
import type { TicketKey, WorkflowRunState } from "@maestro/contracts";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { MAESTRO_TASK_QUEUE } from "@maestro/workflows";

/**
 * The BFF's `RunGateway`, backed by a real Temporal client.
 *
 * `apps/bff` declares this interface and never imports a Temporal package —
 * that is what keeps every BFF test offline (M44). Binding it to the engine is
 * composition-root work, so the implementation lives here.
 */

/** Temporal's status enum as the BFF's narrower vocabulary. */
const STATUS_BY_NAME: Readonly<Record<string, RunExecutionStatus>> = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TERMINATED: "terminated",
  CONTINUED_AS_NEW: "continued_as_new",
  TIMED_OUT: "timed_out",
};

export interface TemporalGatewayOptions {
  readonly client: Client;
  readonly taskQueue?: string;
  /** Workflow type name; must match what the worker registers. */
  readonly workflowType?: string;
}

export class TemporalRunGateway implements RunGateway {
  private readonly client: Client;
  private readonly taskQueue: string;
  private readonly workflowType: string;

  constructor(options: TemporalGatewayOptions) {
    this.client = options.client;
    this.taskQueue = options.taskQueue ?? MAESTRO_TASK_QUEUE;
    this.workflowType = options.workflowType ?? "ticketWorkflow";
  }

  /**
   * Readiness probe.
   *
   * `describeNamespace` on the deployment's OWN namespace, not a bare
   * connection check: a TCP connect proves only that something is listening,
   * and a client pointed at a namespace that does not exist would pass it
   * while every start and signal failed. The call is cheap and touches
   * precisely the thing the write paths need.
   */
  async ping(): Promise<void> {
    await this.client.connection.workflowService.describeNamespace({
      namespace: this.client.options.namespace,
    });
  }

  async list(options: { limit?: number; onlyRunning?: boolean } = {}): Promise<RunSummary[]> {
    const limit = options.limit ?? 50;
    const query =
      options.onlyRunning === true
        ? `WorkflowType='${this.workflowType}' AND ExecutionStatus='Running'`
        : `WorkflowType='${this.workflowType}'`;

    const summaries: RunSummary[] = [];
    for await (const execution of this.client.workflow.list({ query, pageSize: limit })) {
      const ticketKey = ticketOf(execution.workflowId);
      // An execution whose id this deployment did not mint is not ours to
      // report: the namespace may be shared, and a foreign workflow has no
      // ticket key to show a user.
      if (ticketKey === null) continue;
      summaries.push({
        workflowId: execution.workflowId,
        ticketKey: ticketKey as TicketKey,
        runId: execution.runId,
        status: STATUS_BY_NAME[execution.status.name] ?? "running",
        startedAt: execution.startTime.toISOString(),
        closedAt: execution.closeTime?.toISOString() ?? null,
      });
      if (summaries.length >= limit) break;
    }
    return summaries;
  }

  /** `null` rather than a throw: "no such run" is an answer the UI renders. */
  async queryRunState(workflowId: string): Promise<WorkflowRunState | null> {
    try {
      return await this.client.workflow.getHandle(workflowId).query<WorkflowRunState>("runState");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Signal an EXISTING run, never create one. A gate decision for a ticket
   * Maestro is not running is a mistake to report, not a reason to invent a
   * workflow (M14) — hence `no_run` instead of a start.
   */
  async signal(workflowId: string, name: string, arg: unknown): Promise<SignalOutcome> {
    try {
      await this.client.workflow.getHandle(workflowId).signal(name, arg);
      return "delivered";
    } catch (error) {
      if (isNotFound(error)) return "no_run";
      throw error;
    }
  }

  /**
   * The intake path, atomic by construction.
   *
   * `signalWithStart` is what stops two webhook deliveries racing on one ticket
   * from producing two runs: the server resolves the race, not the BFF. The
   * `started` flag comes from whether the returned run id belonged to a fresh
   * execution — a caller that joined a live run must not be told it started one.
   */
  async signalWithStart(input: SignalWithStartInput): Promise<StartOutcome> {
    const workflowId = workflowIdFor(input.ticket);
    const args = [
      { ticket: input.ticket, appId: input.appId, mode: input.mode, dataClass: input.dataClass },
    ];
    const signal = input.signal;

    // A plain intake carries no signal, and `signalWithStart` has no "no
    // signal" mode — passing a name nothing handles would work only because
    // Temporal drops unknown signals silently, which is a behaviour to depend
    // on deliberately or not at all. `start` says what is meant, and its
    // already-started error is the same race resolution, reported honestly.
    if (signal === undefined) {
      try {
        await this.client.workflow.start(this.workflowType, {
          workflowId,
          taskQueue: this.taskQueue,
          args,
        });
        return { workflowId, started: true };
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          return { workflowId, started: false };
        }
        throw error;
      }
    }

    // With a signal, atomicity is the whole point: two deliveries racing on
    // one ticket must produce one run, and the server — not this process —
    // decides which of them created it.
    //
    // Whether this call was the creator is read from the run id that existed
    // BEFORE it. Temporal's signalWithStart reports the run it signalled but
    // not whether it had to create it, and asking again afterwards cannot
    // recover the difference: a joined run and a created one both answer with
    // the id the signal reached. Under a genuine race the pre-read can be
    // stale, so `started` is best-effort by construction — which is why no
    // caller may treat it as a lock. The atomicity that matters (one run per
    // ticket) comes from the server regardless of this flag.
    const before = await this.currentRunId(workflowId);
    const handle = await this.client.workflow.signalWithStart(this.workflowType, {
      workflowId,
      taskQueue: this.taskQueue,
      args,
      signal: signal.name,
      signalArgs: [...signal.args],
    });

    return { workflowId, started: before === null || before !== handle.signaledRunId };
  }

  /** Run id of the current execution, or `null` when there is none. */
  private async currentRunId(workflowId: string): Promise<string | null> {
    try {
      const description = await this.client.workflow.getHandle(workflowId).describe();
      return description.runId;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

/** Inverse of `workflowIdFor`; `null` for ids this deployment did not mint. */
function ticketOf(workflowId: string): string | null {
  const prefix = "maestro-";
  return workflowId.startsWith(prefix) ? workflowId.slice(prefix.length) : null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof WorkflowNotFoundError;
}

/** Connect to Temporal and build the gateway the BFF injects. */
export async function connectTemporal(options: {
  address: string;
  namespace?: string;
  taskQueue?: string;
}): Promise<{ gateway: TemporalRunGateway; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: options.address });
  const client = new Client({ connection, namespace: options.namespace ?? "default" });
  const gateway = new TemporalRunGateway({
    client,
    ...(options.taskQueue === undefined ? {} : { taskQueue: options.taskQueue }),
  });
  return { gateway, close: () => connection.close() };
}
