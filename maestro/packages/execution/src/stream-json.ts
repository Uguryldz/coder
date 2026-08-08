import { ClaudeCliProtocolError } from "./errors.js";

/**
 * Reader for `claude --print --output-format stream-json --verbose`.
 *
 * Both message shapes were read out of the shipped v2.1.226 binary (RAPOR §2):
 *   {"type":"system","subtype":"init","cwd","session_id","tools","mcp_servers",
 *    "model","permissionMode",…}
 *   {"type":"result","subtype":"success"|"error_during_execution","is_error",
 *    "num_turns","result","total_cost_usd","session_id",
 *    "usage":{"input_tokens","cache_creation_input_tokens",
 *             "cache_read_input_tokens","output_tokens"}}
 * Everything else (assistant/user turns, tool traffic) is progress: counted,
 * not interpreted.
 */
export interface AgentStreamResult {
  readonly sessionId: string;
  readonly finalText: string;
  /** input + cache-read + cache-creation, so a cached turn is not free (M55). */
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly numTurns: number;
  readonly isError: boolean;
  readonly errors: readonly string[];
  readonly totalCostUsd: number | null;
  /** Lines that were not JSON at all — surfaced, never silently dropped. */
  readonly unparsedLines: number;
  /** Messages seen before the result, for the journal's progress note. */
  readonly progressMessages: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const ok = typeof value === "object" && value !== null && !Array.isArray(value);
  return ok ? (value as Record<string, unknown>) : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function usageTokens(usage: unknown): { tokensIn: number; tokensOut: number } {
  const u = asRecord(usage);
  if (u === null) return { tokensIn: 0, tokensOut: 0 };
  const cached = nonNegativeInt(u["cache_read_input_tokens"]) + nonNegativeInt(u["cache_creation_input_tokens"]);
  return { tokensIn: nonNegativeInt(u["input_tokens"]) + cached, tokensOut: nonNegativeInt(u["output_tokens"]) };
}

function errorList(message: Record<string, unknown>): string[] {
  const raw = message["errors"];
  if (Array.isArray(raw)) return raw.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  const subtype = message["subtype"];
  return typeof subtype === "string" && subtype !== "success" ? [subtype] : [];
}

export function splitLines(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * Parse a completed turn. Fail-closed: no `result` message means we cannot say
 * what the agent did, which is an error rather than an empty answer; two of
 * them mean the protocol moved under us and must break loudly instead of being
 * resolved by picking one.
 */
export function parseStreamJson(stdout: string): AgentStreamResult {
  let unparsedLines = 0;
  let progressMessages = 0;
  let initSessionId: string | null = null;
  const results: Record<string, unknown>[] = [];

  for (const line of splitLines(stdout)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparsedLines += 1;
      continue;
    }
    const message = asRecord(parsed);
    if (message === null) {
      unparsedLines += 1;
      continue;
    }
    if (message["type"] === "result") {
      results.push(message);
      continue;
    }
    if (message["type"] === "system" && message["subtype"] === "init") {
      const id = message["session_id"];
      if (typeof id === "string" && id !== "") initSessionId = id;
    }
    progressMessages += 1;
  }

  if (results.length === 0) {
    const seen = `${progressMessages} stream messages (${unparsedLines} unparsable lines)`;
    throw new ClaudeCliProtocolError(`no result message in ${seen}`);
  }
  if (results.length > 1) {
    throw new ClaudeCliProtocolError(`expected exactly one result message, found ${results.length}`);
  }
  const result = results[0] as Record<string, unknown>;

  const resultSessionId = result["session_id"];
  const sessionId = typeof resultSessionId === "string" && resultSessionId !== "" ? resultSessionId : initSessionId;
  if (sessionId === null || sessionId === undefined) {
    throw new ClaudeCliProtocolError("result message carries no session_id; the turn could never be resumed (M30)");
  }
  if (initSessionId !== null && initSessionId !== sessionId) {
    throw new ClaudeCliProtocolError(`init announced session ${initSessionId} but the result belongs to ${sessionId}`);
  }

  const finalText = typeof result["result"] === "string" ? result["result"] : "";
  const { tokensIn, tokensOut } = usageTokens(result["usage"]);
  const cost = result["total_cost_usd"];

  return {
    sessionId,
    finalText,
    tokensIn,
    tokensOut,
    numTurns: nonNegativeInt(result["num_turns"]),
    isError: result["is_error"] === true || result["subtype"] !== "success",
    errors: errorList(result),
    totalCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    unparsedLines,
    progressMessages,
  };
}
