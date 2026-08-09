import type { PlatformProfile } from "@maestro/contracts";
import type { RunJob, RunnerLease, RunnerPort, RunResult } from "@maestro/ports";
import type { RunnerAgentConfig } from "../src/config.js";
import type { LeasedJob } from "../src/protocol.js";

/** A clock the test drives by hand — nothing in this suite sleeps. */
export class FakeClock {
  #now: number;

  constructor(startIso = "2026-01-01T00:00:00.000Z") {
    this.#now = Date.parse(startIso);
  }

  now = (): Date => new Date(this.#now);

  advanceSeconds(seconds: number): void {
    this.#now += seconds * 1_000;
  }

  isoIn(seconds: number): string {
    return new Date(this.#now + seconds * 1_000).toISOString();
  }
}

export interface RecordedSession {
  lease: RunnerLease;
  job: RunJob;
}

/**
 * A `RunnerPort` double that RECORDS what it was asked to do. The point of the
 * recording is the negative assertion: "runSession was never called" is how a
 * cancellation test proves the job really did not run.
 */
export class FakeRunner implements RunnerPort {
  readonly acquired: PlatformProfile[] = [];
  readonly sessions: RecordedSession[] = [];
  readonly released: string[] = [];
  readonly mounted: { leaseId: string; keys: string[] }[] = [];

  /** Set to make `acquire` fail (no capacity). */
  acquireError?: Error;
  /** Set to make `runSession` fail. */
  sessionError?: Error;
  /** Set to make `release` fail — teardown must still be attempted. */
  releaseError?: Error;
  result: RunResult = { exitCode: 0, stdoutTail: "", stderrTail: "", durationMs: 5 };
  /** Runs while a session is in flight; lets a test flip the kill switch mid-job. */
  onSession?: () => void | Promise<void>;

  #counter = 0;

  async acquire(platform: PlatformProfile): Promise<RunnerLease> {
    this.acquired.push(platform);
    if (this.acquireError !== undefined) throw this.acquireError;
    this.#counter += 1;
    return await Promise.resolve({
      leaseId: `sandbox-${this.#counter}`,
      runnerId: `fake/${platform}/0`,
      platform,
    });
  }

  async runSession(lease: RunnerLease, job: RunJob): Promise<RunResult> {
    this.sessions.push({ lease, job });
    if (this.onSession !== undefined) await this.onSession();
    if (this.sessionError !== undefined) throw this.sessionError;
    return this.result;
  }

  async mountCache(lease: RunnerLease, keys: string[]): Promise<void> {
    this.mounted.push({ leaseId: lease.leaseId, keys });
    await Promise.resolve();
  }

  async release(lease: RunnerLease): Promise<void> {
    this.released.push(lease.leaseId);
    if (this.releaseError !== undefined) throw this.releaseError;
    await Promise.resolve();
  }
}

export function leasedJob(overrides: Partial<LeasedJob> = {}): LeasedJob {
  return {
    leaseId: "lease-1",
    runId: "run-00000001",
    workspaceKey: "UGURPAY-501",
    command: ["/bin/sh", "-c", "echo hi"],
    timeoutSeconds: 60,
    env: {},
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

export function agentConfig(overrides: Partial<RunnerAgentConfig> = {}): RunnerAgentConfig {
  return {
    platformUrl: "https://maestro.internal",
    agentId: "mac-mini-07",
    platform: "macos-xcode",
    agentVersion: "0.1.0",
    capacity: 2,
    labels: ["xcode-16"],
    tokenRef: { source: "env", key: "MAESTRO_AGENT_TOKEN" },
    workDir: "/tmp/maestro-agent",
    logLevel: "info",
    pullIntervalSeconds: 5,
    leaseRenewMarginSeconds: 30,
    shutdownGraceSeconds: 60,
    requestTimeoutMs: 15_000,
    ...overrides,
  };
}
