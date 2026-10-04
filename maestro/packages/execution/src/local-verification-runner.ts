import { runLocal } from "./local-exec.js";
import type { CommandResult, CommandSpec, VerificationRunner } from "./types.js";
import { truncatedResult } from "./verification-runner.js";

export interface LocalVerificationOptions {
  readonly runId: string;
  readonly timeoutSeconds: number;
  readonly tailLimitBytes: number;
  readonly signal?: AbortSignal;
  readonly env?: Record<string, string>;
  readonly onTruncated?: "fail" | "throw";
}

/**
 * Runs the repo's derived build/typecheck commands in the worker's own clone.
 *
 * This is the "vibe coding but it must compile" gate for a deployment that
 * has no sandbox fleet: weaker isolation than the container (M21), and the
 * degraded-capabilities report says so — but a green build in the clone is
 * real evidence, where the previous behaviour was to refuse the turn and
 * produce nothing at all.
 */
export class LocalVerificationRunner implements VerificationRunner {
  constructor(private readonly options: LocalVerificationOptions) {}

  async run(workspacePath: string, spec: CommandSpec): Promise<CommandResult> {
    const result = await runLocal({
      cwd: workspacePath,
      command: spec.command,
      timeoutMs: this.options.timeoutSeconds * 1000,
      // One extra byte over the budget lets the truncation rule notice overflow.
      tailLimitBytes: this.options.tailLimitBytes > 0 ? this.options.tailLimitBytes + 1 : 0,
      runId: this.options.runId,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    const truncated = truncatedResult(spec, result.stdoutTail, result.stderrTail, this.options.tailLimitBytes, this.options.onTruncated);
    if (truncated !== null) return truncated;
    return {
      name: spec.name,
      command: spec.command,
      exitCode: result.exitCode,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      durationMs: result.durationMs,
    };
  }
}
