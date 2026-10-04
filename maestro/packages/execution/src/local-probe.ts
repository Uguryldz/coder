import { WorkspaceProbeError } from "./errors.js";
import { mergeCounts, parseInternalPaths, parseNumstatZ, parsePorcelainZ } from "./git-status.js";
import { runLocal } from "./local-exec.js";
import type { ChangedFile, WorkspaceProbe } from "./types.js";

export interface LocalProbeOptions {
  readonly runId: string;
  readonly signal?: AbortSignal;
}

const PROBE_TIMEOUT_MS = 120_000;

/**
 * `SandboxWorkspaceProbe`'s twin for a worker without a sandbox fleet: the
 * same git questions, asked of the clone directly. The answers are what
 * protected-path enforcement (M52) is proven from, so the commands are
 * byte-for-byte the sandbox's — a probe that asked a softer question would
 * let a softer answer through.
 */
export class LocalWorkspaceProbe implements WorkspaceProbe {
  constructor(private readonly options: LocalProbeOptions) {}

  async changedFiles(workspacePath: string): Promise<readonly ChangedFile[]> {
    const status = await this.git(workspacePath, ["status", "--porcelain=v1", "-z", "-uall", "--renames"]);
    const files = parsePorcelainZ(status);
    if (files.length === 0) return [];
    const numstat = await this.git(workspacePath, ["diff", "--numstat", "-z", "HEAD"]).catch(() => "");
    return mergeCounts(files, parseNumstatZ(numstat));
  }

  async internalChangedFiles(workspacePath: string): Promise<readonly ChangedFile[]> {
    const stdout = await this.run(
      workspacePath,
      [
        "sh",
        "-c",
        'cd "$0"/.git 2>/dev/null || exit 0; ' +
          'if [ -f ../.maestro-workspace ]; then find . -type f -newer ../.maestro-workspace -print0; ' +
          "else find . -type f -print0; fi",
        workspacePath,
      ],
      "internal-scan",
    );
    return parseInternalPaths(
      stdout
        .split("\0")
        .map((line) => (line.startsWith("./") ? line.slice(2) : line))
        .join("\0"),
    );
  }

  private git(workspacePath: string, args: readonly string[]): Promise<string> {
    return this.run(workspacePath, ["git", "-C", workspacePath, ...args], `git ${args[0] ?? ""}`);
  }

  private async run(workspacePath: string, command: readonly string[], label: string): Promise<string> {
    const result = await runLocal({
      cwd: workspacePath,
      command,
      timeoutMs: PROBE_TIMEOUT_MS,
      tailLimitBytes: 0,
      runId: this.options.runId,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceProbeError(workspacePath, `${label} exited ${String(result.exitCode)}: ${result.stderrTail.trim()}`);
    }
    return result.stdoutTail;
  }
}
