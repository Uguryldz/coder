import type { PlatformProfile } from "@maestro/contracts";

export interface RunnerLease {
  leaseId: string;
  runnerId: string;
  platform: PlatformProfile;
}

export interface RunJob {
  runId: string;
  workspaceKey: string;
  command: string[];
  timeoutSeconds: number;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

/**
 * Runner port (K60): docker-linux containers + outbound-connected
 * win/mac agents. No inbound ports to runners.
 */
export interface RunnerPort {
  acquire(platform: PlatformProfile): Promise<RunnerLease>;
  runSession(lease: RunnerLease, job: RunJob): Promise<RunResult>;
  mountCache(lease: RunnerLease, keys: string[]): Promise<void>;
  release(lease: RunnerLease): Promise<void>;
}
