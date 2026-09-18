import { spawn } from "node:child_process";
import { SandboxAbortedError } from "./errors.js";

export interface LocalCommand {
  readonly cwd: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  /** Bytes of stdout/stderr kept (from the END, like a `tail`); 0 = unbounded. */
  readonly tailLimitBytes: number;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface LocalResult {
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Runs one command in the worker's own process space — the fallback for a
 * deployment with no sandbox fleet (`RUNNER_IMAGE_LINUX` unset).
 *
 * No shell: `command[0]` is the executable, the rest are its arguments, so a
 * model-derived argument can never become a second command. The process
 * runs in its own group and the whole group is killed on timeout/abort, so a
 * `pnpm build` that forks a compiler does not outlive the turn.
 *
 * The environment is the worker's own minus nothing: the clone's build must
 * see PATH, HOME and proxies. Secrets never reach the worker environment by
 * design (M52 — they live behind the SecretPort), so nothing here can leak
 * one to a build script.
 */
export function runLocal(cmd: LocalCommand): Promise<LocalResult> {
  if (cmd.signal?.aborted === true) {
    return Promise.reject(new SandboxAbortedError(cmd.runId ?? "local", "aborted before start"));
  }
  const [file, ...args] = cmd.command;
  if (file === undefined || file === "") {
    return Promise.resolve({ exitCode: 127, stdoutTail: "", stderrTail: "empty command", durationMs: 0, timedOut: false });
  }
  const startedAt = Date.now();
  return new Promise<LocalResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: cmd.cwd,
        env: { ...process.env, ...(cmd.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const out = new Tail(cmd.tailLimitBytes);
    const err = new Tail(cmd.tailLimitBytes);
    let timedOut = false;
    let settled = false;
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, cmd.timeoutMs);
    const onAbort = (): void => {
      kill();
    };
    cmd.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cmd.signal?.removeEventListener("abort", onAbort);
      // A missing executable is a result, not a crash: the turn must read it.
      resolve({
        exitCode: 127,
        stdoutTail: out.text(),
        stderrTail: `${err.text()}\n${error.message}`.trim(),
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cmd.signal?.removeEventListener("abort", onAbort);
      if (cmd.signal?.aborted === true) {
        reject(new SandboxAbortedError(cmd.runId ?? "local", "aborted"));
        return;
      }
      const exitCode = code ?? (signal === null ? -1 : 128 + signalNumber(signal));
      resolve({
        exitCode: timedOut ? 124 : exitCode,
        stdoutTail: out.text(),
        stderrTail: timedOut ? `${err.text()}\n[maestro] command timed out after ${String(cmd.timeoutMs)} ms`.trim() : err.text(),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/** Keeps the LAST `limit` bytes; the beginning of a long build log is noise. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    if (this.limit <= 0) return;
    // Keep one extra chunk over the limit so `text()` can report the overflow.
    while (this.size - (this.chunks[0]?.byteLength ?? 0) > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.byteLength ?? 0;
    }
  }
  text(): string {
    const joined = Buffer.concat(this.chunks);
    if (this.limit > 0 && joined.byteLength > this.limit) {
      return joined.subarray(joined.byteLength - this.limit).toString("utf8");
    }
    return joined.toString("utf8");
  }
  /** Whether more than the limit arrived at any point. */
  get overflowed(): boolean {
    return this.limit > 0 && this.size > this.limit;
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 1;
}
