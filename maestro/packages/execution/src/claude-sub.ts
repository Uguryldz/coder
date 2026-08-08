import type { AgentRunInput, AgentRunOutput, AgentRunner } from "@maestro/llm-gateway";
import { buildClaudeArgs, buildClaudeEnv, type PermissionMode } from "./cli.js";
import { ClaudeCliError, ExecutionConfigError } from "./errors.js";
import { parseStreamJson } from "./stream-json.js";
import type { SpawnFn, SpawnResult } from "./types.js";

/**
 * M55 subscription driver, execution half. The gateway decides WHICH seat and
 * session a doing-role turn belongs to; this class makes the turn happen by
 * driving the operator's local `claude` login non-interactively. There is no API
 * key anywhere on this path — that is the point of the driver class.
 */
export interface ClaudeSubRunnerOptions {
  readonly binPath: string;
  /** `PATH` handed to the child; the binary's own directory must be on it. */
  readonly basePath: string;
  /** `HOME` handed to the child (where the seat's login lives). */
  readonly home: string;
  readonly permissionMode: PermissionMode;
  readonly mcpConfigPath: string | null;
  readonly timeoutMs: number;
  /** Resolves the pool's `credentialRef` into a seat. A function, so no token
   * is ever held by this object. */
  readonly resolveSeat: (credentialRef: string | null) => Promise<SeatCredential>;
  /** New session id when we pin one ourselves (`--session-id`). */
  readonly newSessionId?: () => string;
  readonly onStdoutLine?: (line: string) => void;
}

export interface SeatCredential {
  /** `null` when the seat is the machine's own interactive login (HOME-based). */
  readonly oauthToken: string | null;
  readonly configDir: string | null;
}

/** Driver ids this runner serves. Anything else is a wiring bug, not a fallback. */
export const CLAUDE_SUB_DRIVER = "claude-sub";

export class ClaudeSubRunner implements AgentRunner {
  constructor(
    private readonly spawn: SpawnFn,
    private readonly opts: ClaudeSubRunnerOptions,
  ) {
    if (opts.timeoutMs <= 0) throw new ExecutionConfigError("timeoutMs must be positive");
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    if (input.driver !== CLAUDE_SUB_DRIVER) {
      throw new ExecutionConfigError(
        `ClaudeSubRunner was handed driver "${input.driver}"; it only drives "${CLAUDE_SUB_DRIVER}"`,
      );
    }
    const seat = await this.opts.resolveSeat(input.credentialRef);
    const resumeSessionId = input.vendorSessionId;
    const args = buildClaudeArgs({
      binPath: this.opts.binPath,
      model: input.model,
      mcpServers: input.mcpServers,
      mcpConfigPath: this.opts.mcpConfigPath,
      permissionMode: this.opts.permissionMode,
      sessionId: resumeSessionId === null ? (this.opts.newSessionId?.() ?? null) : null,
      resumeSessionId,
    });

    const spawned = await this.spawn({
      command: this.opts.binPath,
      args,
      cwd: input.workspacePath,
      // The prompt goes over stdin, never argv (see cli.ts).
      stdin: input.task,
      env: buildClaudeEnv({
        basePath: this.opts.basePath,
        home: this.opts.home,
        oauthToken: seat.oauthToken,
        configDir: seat.configDir,
      }),
      timeoutMs: this.opts.timeoutMs,
      ...(this.opts.onStdoutLine ? { onStdoutLine: this.opts.onStdoutLine } : {}),
    });

    return this.readTurn(spawned, resumeSessionId);
  }

  /** A timeout, a non-zero exit and an `is_error` result all throw: the
   * gateway's contract says an exception means something broke, and a broken
   * turn must not be logged as an answer. */
  private readTurn(spawned: SpawnResult, resumeSessionId: string | null): AgentRunOutput {
    const fail = (why: string): never => {
      throw new ClaudeCliError(why, spawned.exitCode, tail(spawned.stderr));
    };
    if (spawned.timedOut) fail(`claude CLI exceeded ${this.opts.timeoutMs}ms and was killed`);
    // Parse even on a non-zero exit: the result message usually carries the real
    // reason, and `stderr` alone would lose it.
    const parsed = spawned.stdout.trim() === "" ? null : parseStreamJson(spawned.stdout);
    if (parsed === null) return fail(`claude CLI exited ${spawned.exitCode} without any stream output`);
    if (parsed.isError || spawned.exitCode !== 0) {
      const why = parsed.errors.length > 0 ? parsed.errors.join("; ") : tail(spawned.stderr);
      fail(`claude CLI turn failed (exit ${spawned.exitCode}): ${why}`);
    }
    if (resumeSessionId !== null && parsed.sessionId !== resumeSessionId) {
      // `--resume` without `--fork-session` keeps the id; a different one means
      // the CLI started a fresh conversation and M30's context is gone.
      fail(`resume of session ${resumeSessionId} came back as ${parsed.sessionId}; the previous context was lost`);
    }
    return {
      finalText: parsed.finalText,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      vendorSessionId: parsed.sessionId,
    };
  }
}

const TAIL_CHARS = 2000;

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(-TAIL_CHARS);
}
