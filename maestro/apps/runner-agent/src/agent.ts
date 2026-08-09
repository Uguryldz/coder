import type { PlatformProfile } from "@maestro/contracts";
import type { RunnerPort } from "@maestro/ports";
import type { RunnerAgentConfig } from "./config.js";
import { executeJob } from "./execute-job.js";
import { KillSwitchState } from "./kill-switch.js";
import { LeaseManager } from "./lease-manager.js";
import type { PlatformClient } from "./platform-client.js";
import type { LeasedJob } from "./protocol.js";
import type { TokenResolver } from "./token.js";

/**
 * The agent's life cycle (tasks #1, #2, #3, #7).
 *
 * `start` registers; `tick` is one pass of the work loop; `shutdown` gives the
 * work back. Time is DRIVEN by the caller — `main.ts` schedules the ticks, the
 * tests call them directly — so every path here is testable without sleeping.
 */

export interface RunnerAgentDeps {
  config: RunnerAgentConfig;
  client: PlatformClient;
  runner: RunnerPort;
  token: TokenResolver;
  now: () => Date;
  /** Platform profile leases are acquired for on this machine. */
  runnerPlatform: PlatformProfile;
  /** Structured, already-safe log line sink. */
  log?: (event: { level: string; message: string; meta?: Record<string, unknown> }) => void;
}

export interface AgentSnapshot {
  state: "starting" | "idle" | "busy" | "draining" | "stopped";
  sessionId?: string;
  activeJobs: number;
  heldLeases: number;
  killLevel: string;
}

export class RunnerAgent {
  readonly #deps: RunnerAgentDeps;
  readonly #killSwitch = new KillSwitchState();
  #leases?: LeaseManager;
  #sessionId?: string;
  #heartbeatIntervalSeconds = 15;
  #draining = false;
  #stopped = false;
  readonly #active = new Map<string, Promise<void>>();

  constructor(deps: RunnerAgentDeps) {
    this.#deps = deps;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get heartbeatIntervalSeconds(): number {
    return this.#heartbeatIntervalSeconds;
  }

  snapshot(): AgentSnapshot {
    const state = this.#stopped
      ? "stopped"
      : this.#draining
        ? "draining"
        : this.#sessionId === undefined
          ? "starting"
          : this.#active.size > 0
            ? "busy"
            : "idle";
    return {
      state,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      activeJobs: this.#active.size,
      heldLeases: this.#leases?.size ?? 0,
      killLevel: this.#killSwitch.level,
    };
  }

  /** Registers with the platform. Nothing else may run before this succeeds. */
  async start(options: { takeover?: boolean } = {}): Promise<void> {
    const reply = await this.#deps.client.register({
      type: "register",
      agentId: this.#deps.config.agentId,
      platform: this.#deps.config.platform,
      agentVersion: this.#deps.config.agentVersion,
      labels: [...this.#deps.config.labels],
      maxConcurrency: this.#deps.config.capacity,
      startedAt: this.#deps.now().toISOString(),
      takeover: options.takeover ?? false,
    });
    this.#sessionId = reply.sessionId;
    this.#heartbeatIntervalSeconds = reply.heartbeatIntervalSeconds;
    this.#leases = new LeaseManager({
      client: this.#deps.client,
      killSwitch: this.#killSwitch,
      now: this.#deps.now,
      sessionId: reply.sessionId,
      agentId: this.#deps.config.agentId,
      renewMarginSeconds: this.#deps.config.leaseRenewMarginSeconds,
    });
    this.#log("info", "runner_agent.registered", { sessionId: reply.sessionId });
  }

  /**
   * One heartbeat (task #2). Also the platform's chance to revoke leases; a
   * revoked lease's job is aborted rather than left running.
   */
  async heartbeat(): Promise<void> {
    const session = this.#requireSession();
    const ack = await this.#deps.client.heartbeat({
      type: "heartbeat",
      sessionId: session.sessionId,
      agentId: this.#deps.config.agentId,
      at: this.#deps.now().toISOString(),
      activeLeases: session.leases.held(),
      healthy: true,
    });
    this.#heartbeatIntervalSeconds = ack.nextIntervalSeconds;
    for (const leaseId of ack.revokedLeases) session.leases.forget(leaseId);
  }

  /**
   * One pass of the work loop: expire stale leases, then pull if allowed.
   * Returns the jobs started, so a test can assert on them directly.
   */
  async tick(): Promise<LeasedJob[]> {
    const session = this.#requireSession();

    // Leases that ran out are dropped BEFORE new work is requested: capacity
    // computed from stale claims would under-report what this machine can do.
    for (const job of session.leases.expire()) {
      this.#log("warn", "runner_agent.lease_expired", { leaseId: job.leaseId });
    }

    if (this.#draining || !this.#killSwitch.mayAcceptWork()) return [];

    const free = this.#deps.config.capacity - this.#active.size;
    if (free <= 0) return [];

    const reply = await this.#deps.client.pull({
      sessionId: session.sessionId,
      agentId: this.#deps.config.agentId,
      at: this.#deps.now().toISOString(),
      max: free,
    });

    // Applied BEFORE the jobs are started: a reply that grants work and also
    // says "stop_all" must not start it.
    this.#killSwitch.apply(reply.killLevel);
    if (!this.#killSwitch.mayAcceptWork()) return [];

    // Never start more than the free capacity, whatever the platform sent.
    const granted = reply.jobs.slice(0, free);
    for (const job of granted) {
      session.leases.track(job);
      this.#start(job);
    }
    return granted;
  }

  /** Waits for every running job. Used by shutdown and by the tests. */
  async settle(): Promise<void> {
    await Promise.all([...this.#active.values()]);
  }

  /**
   * Graceful shutdown (task #7): stop taking work, let what is running finish
   * within the grace, then hand back anything still held and deregister.
   */
  async shutdown(options: { force?: boolean; reasonKey?: string } = {}): Promise<void> {
    if (this.#stopped) return;
    this.#draining = true;

    if (options.force === true) {
      // No grace: abort the sandboxes so they cannot outlive the process.
      this.#killSwitch.abortAll("shutdown");
      await this.settle();
    } else {
      // Bounded grace. A job that will not finish inside it is aborted rather
      // than allowed to hold the process open for ever: a service manager that
      // gives up waiting SIGKILLs us, and that is how a sandbox is orphaned.
      await this.#settleWithin(this.#deps.config.shutdownGraceSeconds * 1_000);
    }

    const session = this.#leases === undefined || this.#sessionId === undefined ? undefined : this.#requireSession();
    if (session !== undefined) {
      // Whatever is still held goes back explicitly, so the platform can
      // reschedule now instead of waiting for the leases to time out.
      for (const job of session.leases.drain()) {
        await this.#deps.client
          .completeJob({
            sessionId: session.sessionId,
            agentId: this.#deps.config.agentId,
            leaseId: job.leaseId,
            runId: job.runId,
            outcome: "abandoned",
            durationMs: 0,
            reasonKey: "runner_agent.shutdown",
            at: this.#deps.now().toISOString(),
          })
          .catch(() => undefined);
      }
      await this.#deps.client
        .bye({
          type: "bye",
          sessionId: session.sessionId,
          agentId: this.#deps.config.agentId,
          at: this.#deps.now().toISOString(),
          ...(options.reasonKey === undefined ? {} : { reasonKey: options.reasonKey }),
        })
        .catch(() => undefined);
    }
    this.#stopped = true;
    this.#log("info", "runner_agent.stopped");
  }

  /**
   * Waits for the running jobs, but not for longer than the grace. On timeout
   * the sandboxes are aborted and then awaited — the wait after the abort is
   * what guarantees teardown actually ran before the process exits.
   */
  async #settleWithin(graceMs: number): Promise<void> {
    if (this.#active.size === 0) return;
    if (graceMs <= 0) {
      this.#killSwitch.abortAll("shutdown");
      await this.settle();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.settle().then(() => "settled" as const), expired]);
      if (outcome === "timeout") {
        this.#log("warn", "runner_agent.shutdown");
        this.#killSwitch.abortAll("shutdown");
        await this.settle();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Launches one job and keeps its promise so shutdown can wait for it. */
  #start(job: LeasedJob): void {
    const promise = this.#execute(job).finally(() => {
      this.#active.delete(job.leaseId);
    });
    this.#active.set(job.leaseId, promise);
  }

  #execute(job: LeasedJob): Promise<void> {
    const session = this.#requireSession();
    return executeJob(
      {
        client: this.#deps.client,
        runner: this.#deps.runner,
        killSwitch: this.#killSwitch,
        leases: session.leases,
        sessionId: session.sessionId,
        agentId: this.#deps.config.agentId,
        runnerPlatform: this.#deps.runnerPlatform,
        now: this.#deps.now,
        token: this.#deps.token,
        log: (level, message, meta) => {
          this.#log(level, message, meta);
        },
      },
      job,
    );
  }

  #requireSession(): { sessionId: string; leases: LeaseManager } {
    if (this.#sessionId === undefined || this.#leases === undefined) {
      throw new Error("runner agent is not registered — call start() first");
    }
    return { sessionId: this.#sessionId, leases: this.#leases };
  }

  #log(level: string, message: string, meta?: Record<string, unknown>): void {
    this.#deps.log?.({ level, message, ...(meta === undefined ? {} : { meta }) });
  }
}
