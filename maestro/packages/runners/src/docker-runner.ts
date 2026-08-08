import type { PlatformProfile } from "@maestro/contracts";
import { CapabilityNotSupportedError, type RunJob, type RunnerLease, type RunnerPort, type RunResult } from "@maestro/ports";
import { DOCKER_LINUX_DRIVER, type DockerRunnerConfig, LinuxPlatform } from "./config.js";
import { DockerClient } from "./docker-client.js";
import { tail } from "./docker-client.js";
import {
  type AuditSink,
  type Clock,
  type DockerTransport,
  type IdSource,
  RUNNER_ACTOR,
  systemClock,
  systemTimer,
  type Timer,
} from "./deps.js";
import { RunnerCapacityError, RunnerConfigError } from "./errors.js";
import { RunnerPool } from "./pool.js";
import { buildContainerSpec, containerName } from "./sandbox.js";
import {
  assertCacheKey,
  cacheVolumeName,
  expiredWorkspaces,
  type WorkspaceRecord,
  workspaceVolumeName,
} from "./workspace.js";

/**
 * `RunnerPort` over ephemeral hardened containers (M21 `docker-linux`).
 *
 * Timeout discipline (M23): a session that outlives its budget is KILLED and
 * still answers, with whatever the job managed to print. A runner that hangs
 * silently is worse than one that fails — the workflow above it would wait for
 * a durable timer that never fires.
 */

/** Exit code for a killed-on-timeout session (the `timeout(1)` convention). */
export const TIMEOUT_EXIT_CODE = 124;

/** How many log lines are pulled back before the byte tail is applied. */
const LOG_TAIL_LINES = 2_000;

/** Upper bound on caches mounted into one job — an unbounded mount list is a bind-mount sprawl. */
const MAX_CACHE_MOUNTS = 8;

export interface DockerRunnerDeps {
  transport: DockerTransport;
  clock?: Clock;
  timer?: Timer;
  newId?: IdSource;
  audit?: AuditSink;
}

export class DockerLinuxRunner implements RunnerPort {
  readonly #config: DockerRunnerConfig;
  readonly #client: DockerClient;
  readonly #pool: RunnerPool;
  readonly #clock: Clock;
  readonly #timer: Timer;
  readonly #audit: AuditSink;

  constructor(config: DockerRunnerConfig, deps: DockerRunnerDeps) {
    this.#config = config;
    this.#clock = deps.clock ?? systemClock;
    this.#timer = deps.timer ?? systemTimer;
    this.#audit = deps.audit ?? (() => undefined);
    this.#client = new DockerClient({
      transport: deps.transport,
      apiVersion: config.apiVersion,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    this.#pool = new RunnerPool(config.platforms, deps.newId ?? defaultIdSource());
  }

  /** Liveness of the daemon behind the injected transport (used by the smoke test). */
  ping(): Promise<boolean> {
    return this.#client.ping();
  }

  snapshot(): ReturnType<RunnerPool["snapshot"]> {
    return this.#pool.snapshot();
  }

  async acquire(platform: PlatformProfile): Promise<RunnerLease> {
    const linux = LinuxPlatform.safeParse(platform);
    if (!linux.success) {
      // mac/win runners are agent-connected (M21/M22) — a different driver.
      throw new CapabilityNotSupportedError(DOCKER_LINUX_DRIVER, `platform:${platform}`);
    }
    if (this.#config.platforms[linux.data] === undefined) {
      throw new RunnerCapacityError(platform, 0);
    }
    return this.#pool.acquire(linux.data);
  }

  /**
   * Ensures the dependency cache volumes exist and binds them to the lease, so
   * the NEXT `runSession` on this lease mounts them (M31 layer ①).
   */
  async mountCache(lease: RunnerLease, keys: string[]): Promise<void> {
    const slot = this.#pool.slotOf(lease);
    if (keys.length + slot.cacheKeys.length > MAX_CACHE_MOUNTS) {
      throw new RunnerConfigError(`at most ${MAX_CACHE_MOUNTS} dependency caches may be mounted into one job`);
    }
    for (const key of keys) {
      assertCacheKey(key);
      await this.#volume(cacheVolumeName(key, this.#config.workspace.cachePrefix), {
        [`${this.#config.labelPrefix}.cache-key`]: key,
        [`${this.#config.labelPrefix}.layer`]: "dependency",
      });
    }
    this.#pool.attachCache(lease, keys);
  }

  async runSession(lease: RunnerLease, job: RunJob): Promise<RunResult> {
    // Validated BEFORE the slot is marked busy: a rejected job must not leave
    // the lease stuck in "running" with nothing running.
    const timeoutMs = this.#timeoutMsOf(job);
    const slot = this.#pool.beginSession(lease);
    const startedAt = this.#clock().getTime();
    let containerId: string | undefined;
    try {
      const image = this.#config.platforms[slot.platform]?.image;
      if (image === undefined) throw new RunnerConfigError(`platform "${slot.platform}" has no image configured`);
      const name = containerName(this.#config, job, lease.leaseId);
      const workspaceVolume = workspaceVolumeName(job.workspaceKey, this.#config.workspace.volumePrefix);
      // Created explicitly rather than left to the bind's auto-creation, so it
      // lands on the configured (encrypted, M31) volume driver and carries the
      // labels the M65 sweeper needs to find it again.
      await this.#volume(workspaceVolume, {
        [`${this.#config.labelPrefix}.workspace-key`]: job.workspaceKey,
        [`${this.#config.labelPrefix}.layer`]: "workspace",
      });
      const spec = buildContainerSpec({
        config: this.#config,
        image,
        job,
        leaseId: lease.leaseId,
        platform: slot.platform,
        cacheKeys: slot.cacheKeys,
      });
      containerId = await this.#client.createContainer(name, spec);
      this.#record("SANDBOX_CREATE", name, {
        runId: job.runId,
        platform: slot.platform,
        image,
        networkMode: (spec["HostConfig"] as { NetworkMode: string }).NetworkMode,
        workspaceVolume,
        cacheKeys: [...slot.cacheKeys],
      });
      await this.#client.startContainer(containerId);

      const { exitCode, timedOut } = await this.#awaitExit(containerId, timeoutMs);
      const tails = await this.#tails(containerId);
      const result: RunResult = {
        exitCode,
        stdoutTail: tails.stdout,
        stderrTail: tails.stderr,
        durationMs: this.#clock().getTime() - startedAt,
      };
      this.#record("SANDBOX_DESTROY", name, {
        runId: job.runId,
        exitCode,
        timedOut,
        durationMs: result.durationMs,
        ...(timedOut ? { messageKey: "runner.session_timeout", timeoutSeconds: job.timeoutSeconds } : {}),
      });
      return result;
    } finally {
      if (containerId !== undefined) {
        // Ephemeral by contract (M21): the container never outlives its job,
        // not even when the job blew up on the way in. A failed removal must
        // not mask the original error, but it leaves a trace — an orphan
        // container nobody knows about is how a host runs out of disk.
        await this.#client.removeContainer(containerId).catch((error: unknown) => {
          this.#record("SANDBOX_DESTROY", containerId as string, {
            removeFailed: true,
            reason: error instanceof Error ? error.name : "unknown",
          });
        });
      }
      this.#pool.endSession(lease);
    }
  }

  /** Provisions one volume on the configured (encrypted, M31) driver. */
  #volume(name: string, labels: Record<string, string>): Promise<void> {
    const { volumeDriver, volumeOptions } = this.#config.workspace;
    return this.#client.createVolume(
      name,
      { [`${this.#config.labelPrefix}.managed`]: "true", ...labels },
      volumeDriver,
      volumeOptions,
    );
  }

  /** Idempotent by contract: releasing an already-released lease is a no-op. */
  async release(lease: RunnerLease): Promise<void> {
    this.#pool.release(lease);
    await Promise.resolve();
  }

  /**
   * Audited workspace removal (M31 layer ② / M65). The caller archives session
   * + journal through StoragePort first; this deletes the disk copy and leaves
   * a record that says which ticket lost which volume, and why.
   */
  async removeWorkspace(workspaceKey: string, reason: string): Promise<void> {
    const volume = workspaceVolumeName(workspaceKey, this.#config.workspace.volumePrefix);
    await this.#client.removeVolume(volume, true);
    this.#record("RETENTION_ARCHIVE", volume, { workspaceKey, reason });
  }

  /** M65 sweeper: removes every workspace dormant past the configured age. */
  async sweepExpiredWorkspaces(records: readonly WorkspaceRecord[]): Promise<string[]> {
    const expired = expiredWorkspaces(records, this.#clock(), this.#config.workspace.maxAgeDays);
    for (const record of expired) {
      await this.removeWorkspace(record.workspaceKey, "workspace-max-age");
    }
    return expired.map((record) => record.workspaceKey);
  }

  #timeoutMsOf(job: RunJob): number {
    const seconds = job.timeoutSeconds;
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new RunnerConfigError(`job timeoutSeconds must be a positive integer, got ${String(seconds)}`);
    }
    if (seconds > this.#config.maxTimeoutSeconds) {
      throw new RunnerConfigError(`job timeoutSeconds ${seconds} exceeds the ceiling ${this.#config.maxTimeoutSeconds}`);
    }
    return seconds * 1_000;
  }

  /** Races the container's exit against the M23 budget; kills it if the budget wins. */
  async #awaitExit(containerId: string, timeoutMs: number): Promise<{ exitCode: number; timedOut: boolean }> {
    const delay = this.#timer(timeoutMs);
    // The transport gets the extra grace so a daemon that is slow to answer
    // does not look like a job that refused to die.
    const waited = this.#client.waitContainer(containerId, timeoutMs + this.#config.killGraceMs);
    // Nobody awaits `waited` once the timeout wins the race; without this the
    // rejection of an abandoned wait would surface as an unhandled rejection.
    waited.catch(() => undefined);
    try {
      const outcome = await Promise.race([
        waited.then((exitCode) => ({ exitCode, timedOut: false })),
        delay.promise.then(() => ({ exitCode: TIMEOUT_EXIT_CODE, timedOut: true })),
      ]);
      if (outcome.timedOut) await this.#client.killContainer(containerId);
      return outcome;
    } finally {
      delay.cancel();
    }
  }

  /**
   * Log tails. A failure to read logs must not swallow an exit code that the
   * workflow needs, so it degrades to empty tails — and says so in the audit
   * record rather than pretending the job printed nothing.
   */
  async #tails(containerId: string): Promise<{ stdout: string; stderr: string }> {
    const limit = this.#config.maxTailBytes;
    try {
      const logs = await this.#client.containerLogs(containerId, LOG_TAIL_LINES);
      return { stdout: tail(logs.stdout, limit), stderr: tail(logs.stderr, limit) };
    } catch {
      this.#record("SANDBOX_DESTROY", containerId, { logsUnavailable: true });
      return { stdout: "", stderr: "" };
    }
  }

  #record(action: "SANDBOX_CREATE" | "SANDBOX_DESTROY" | "RETENTION_ARCHIVE", subject: string, meta: Record<string, unknown>): void {
    this.#audit({ action, actor: RUNNER_ACTOR, subject, at: this.#clock().toISOString(), meta });
  }
}

/** Lease ids only have to be unique inside one process; `randomUUID` is enough. */
function defaultIdSource(): IdSource {
  return () => globalThis.crypto.randomUUID();
}
