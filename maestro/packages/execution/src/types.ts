/**
 * Injection points. Everything touching the outside world (a process, the
 * clock, the working copy) is an interface, so the package is testable offline
 * and deterministically — no test here may start the real `claude` binary.
 */

/** One child process invocation. `stdin` is written then closed. */
export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** One complete stdout line at a time: how a long turn reaches the journal
   * before it ends (M30). Optional — the parser works off buffered output. */
  readonly onStdoutLine?: (line: string) => void;
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when `timeoutMs` elapsed and the process was killed. */
  readonly timedOut: boolean;
}

export type SpawnFn = (spec: SpawnSpec) => Promise<SpawnResult>;

/** Working-copy status of one file the agent session left behind. */
export interface ChangedFile {
  /** Workspace-relative, forward slashes. Absolute or `..` paths are rejected. */
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Reads what the session changed (Wave 3 / docker-linux runner implements it).
 * A failure here is fatal, never "no changes" — fail-closed for M52.
 */
export interface WorkspaceProbe {
  changedFiles(workspacePath: string): Promise<readonly ChangedFile[]>;
}

/** A verification command (lint / build / test) and what it printed. */
export interface CommandResult {
  readonly name: string;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface CommandSpec {
  readonly name: string;
  readonly command: readonly string[];
}

/** Runs the repo's own lint/build/test commands (`.maestro.yaml`, M71). */
export interface VerificationRunner {
  run(workspacePath: string, spec: CommandSpec): Promise<CommandResult>;
}

export interface DiffSummary {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}
