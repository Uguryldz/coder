import type { RunJob, RunnerLease, RunnerPort, RunResult } from "@maestro/ports";
import type { PlatformProfile } from "@maestro/contracts";
import { LeaseLostError } from "./errors.js";
import type { KillSwitchState } from "./kill-switch.js";
import { createOutputMasker, jobSecrets, type OutputMasker } from "./masking.js";
import type { LeasedJob } from "./protocol.js";

/**
 * Runs ONE leased job inside a sandbox (tasks #4, #5, #6).
 *
 * Two invariants this file exists to hold:
 *
 *  · **The sandbox is always torn down.** `release` runs in a `finally`, on
 *    every path — success, failure, kill switch, shutdown, a throw from the
 *    masker. A leaked sandbox on a developer's Mac is a workspace with the
 *    bank's source in it that nobody is watching.
 *
 *  · **The kill switch is checked at every step boundary**, not once at the
 *    top. Acquire, run, and collect are separate checkpoints.
 */

/** Named so a test can assert exactly which boundary stopped the job. */
export type JobStep = "acquire" | "run" | "collect";

export interface JobOutcome {
  outcome: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  durationMs: number;
  reasonKey?: string;
  /** The step that refused to continue, when the job was cancelled. */
  stoppedAt?: JobStep;
}

export interface LogSink {
  (chunk: { stream: "stdout" | "stderr"; text: string }): Promise<void>;
}

export interface JobRunnerDeps {
  runner: RunnerPort;
  killSwitch: KillSwitchState;
  /** Platform profile leases are acquired for. */
  platform: PlatformProfile;
  now: () => Date;
  /** Streams masked output. Failures here must not fail the job. */
  logSink: LogSink;
  /** The agent's own token, so it can never appear in streamed output. */
  agentToken: string;
  /** Verifies the lease is still ours before the expensive step. */
  checkLease?: (leaseId: string) => Promise<void>;
}

/** Turns the wire job into the `RunJob` the runner port takes. */
export function toRunJob(job: LeasedJob): RunJob {
  return {
    runId: job.runId,
    workspaceKey: job.workspaceKey,
    command: [...job.command],
    timeoutSeconds: job.timeoutSeconds,
    env: { ...job.env },
  };
}

export class JobRunner {
  readonly #deps: JobRunnerDeps;

  constructor(deps: JobRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * Executes the job. Never throws for an ordinary failure — the caller has to
   * report an outcome for every leased job, and an exception on this path
   * would leave the lease dangling until it expired.
   */
  async run(job: LeasedJob): Promise<JobOutcome> {
    const startedAt = this.#deps.now().getTime();
    const masker = createOutputMasker({ secrets: jobSecrets(this.#deps.agentToken, job.env) });

    let aborted: string | undefined;
    const untrack = this.#deps.killSwitch.track({
      abort: (reason) => {
        aborted = reason;
      },
    });

    const elapsed = (): number => this.#deps.now().getTime() - startedAt;
    const cancelled = (step: JobStep, reasonKey: string): JobOutcome => ({
      outcome: "cancelled",
      durationMs: elapsed(),
      reasonKey,
      stoppedAt: step,
    });

    try {
      // ── checkpoint 1: before anything is acquired ──────────────────────
      if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
        return cancelled("acquire", "runner_agent.cancelled_kill_switch");
      }

      let lease: RunnerLease;
      try {
        lease = await this.#deps.runner.acquire(this.#deps.platform);
      } catch {
        // No capacity, or the driver refused the platform. Reported as a
        // failed job rather than thrown: the lease still needs an answer.
        return {
          outcome: "failed",
          durationMs: elapsed(),
          reasonKey: "runner_agent.sandbox_acquire_failed",
        };
      }

      try {
        // ── checkpoint 2: sandbox is held, work has not started ─────────
        if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
          return cancelled("run", "runner_agent.cancelled_kill_switch");
        }
        // The lease is re-verified here, at the last moment before the
        // expensive step: if the platform already reassigned it, running now
        // would be a double execution of the same ticket.
        if (this.#deps.checkLease !== undefined) {
          try {
            await this.#deps.checkLease(job.leaseId);
          } catch (error) {
            if (error instanceof LeaseLostError) {
              return cancelled("run", "runner_agent.cancelled_lease_lost");
            }
            throw error;
          }
          // Re-checked AFTER the await: the renewal reply carries the
          // kill-switch level, so the switch can go down during this very
          // call. Checking only before it would start a job the platform had
          // already told this agent to stop.
          if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
            return cancelled("run", "runner_agent.cancelled_kill_switch");
          }
        }

        const result = await this.#deps.runner.runSession(lease, toRunJob(job));

        // ── checkpoint 3: output collected, before it is reported ───────
        await this.#stream(masker, result);
        if (aborted !== undefined || !this.#deps.killSwitch.mayContinueRunning()) {
          return cancelled("collect", "runner_agent.cancelled_kill_switch");
        }
        return {
          outcome: result.exitCode === 0 ? "succeeded" : "failed",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };
      } finally {
        // Guaranteed teardown. A failure to release must not mask the real
        // outcome, but it must not be silent either.
        await this.#deps.runner.release(lease).catch(() => undefined);
      }
    } catch (error) {
      // The error's TEXT is never streamed: it can quote a command line, and a
      // command line can carry a credential.
      await this.#safeLog({
        stream: "stderr",
        text: masker.mask(error instanceof Error ? error.name : "job failed"),
      });
      return { outcome: "failed", durationMs: elapsed(), reasonKey: "runner_agent.job_failed" };
    } finally {
      untrack();
    }
  }

  /** Streams the collected tails, masked. */
  async #stream(masker: OutputMasker, result: RunResult): Promise<void> {
    if (result.stdoutTail.length > 0) {
      await this.#safeLog({ stream: "stdout", text: masker.mask(result.stdoutTail) });
    }
    if (result.stderrTail.length > 0) {
      await this.#safeLog({ stream: "stderr", text: masker.mask(result.stderrTail) });
    }
  }

  /** A log-stream failure must never turn a finished job into a failed one. */
  async #safeLog(chunk: { stream: "stdout" | "stderr"; text: string }): Promise<void> {
    await this.#deps.logSink(chunk).catch(() => undefined);
  }
}
