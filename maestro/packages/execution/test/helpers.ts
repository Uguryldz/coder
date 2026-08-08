import type { JournalEntry } from "@maestro/contracts";
import type { AgentSessionOptions, AgentSessionResult, LlmOutcome, LlmPort } from "@maestro/ports";
import type { z } from "zod";
import type { BootstrapContext } from "../src/bootstrap.js";
import type { ChangedFile, CommandResult, CommandSpec, SpawnFn, SpawnSpec, VerificationRunner, WorkspaceProbe } from "../src/types.js";

export const SESSION_ID = "7f1c2b90-4a1d-4a55-9f3e-0c9c8b7a6d54";
export const OTHER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** A checksum-valid TR IBAN — real shape, fictional owner. */
export const SAMPLE_IBAN = "TR330006100519786457841326";

export function initLine(sessionId = SESSION_ID): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/w",
    session_id: sessionId,
    tools: ["Read", "Edit"],
    mcp_servers: [{ name: "jira", status: "connected" }],
    model: "claude-opus-4",
    permissionMode: "acceptEdits",
  });
}

export function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { id: "m1", model: "claude-opus-4", role: "assistant", content: [{ type: "text", text }] },
    session_id: SESSION_ID,
  });
}

export function resultLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 2,
    result: "done",
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 5,
      output_tokens: 40,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: SESSION_ID,
    uuid: "9d5a2f2e-1111-4222-8333-444444444444",
    ...over,
  });
}

export function stream(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export interface SpawnStub {
  readonly calls: SpawnSpec[];
  readonly fn: SpawnFn;
}

/** Records every invocation and replays canned process results in order. */
export function stubSpawn(results: Array<Partial<SpawnStubResult>>): SpawnStub {
  const calls: SpawnSpec[] = [];
  let index = 0;
  const fn: SpawnFn = (spec) => {
    calls.push(spec);
    const canned = results[index];
    index += 1;
    if (!canned) throw new Error(`unexpected spawn call #${index}`);
    return Promise.resolve({
      exitCode: canned.exitCode ?? 0,
      stdout: canned.stdout ?? "",
      stderr: canned.stderr ?? "",
      timedOut: canned.timedOut ?? false,
    });
  };
  return { calls, fn };
}

export interface SpawnStubResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function journalEntry(seq: number, over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    runId: "run-000001",
    seq,
    at: `2026-08-08T10:0${seq}:00.000Z`,
    actor: "ai",
    kind: "engineering",
    title: `entry ${seq}`,
    detail: "",
    ...over,
  };
}

export function bootstrapContext(over: Partial<BootstrapContext> = {}): BootstrapContext {
  return {
    ticketKey: "UGURPAY-42",
    runId: "run-000001",
    task: "Add the missing null check in the payment mapper.",
    journal: [journalEntry(0, { kind: "intake", title: "ticket picked up" })],
    livingSummary: { runId: "run-000001", upToSeq: 0, text: "Ticket accepted; analysis approved." },
    workspace: { path: "/w/UGURPAY-42", present: true, branch: "feat/x", baseSha: "abc1234", dirtyFiles: [] },
    protectedPaths: ["**/migrations/**"],
    mcpServers: ["jira", "workspace"],
    ...over,
  };
}

export function changed(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", insertions: 3, deletions: 1, ...over };
}

export function fixedProbe(files: readonly ChangedFile[]): WorkspaceProbe {
  return { changedFiles: () => Promise.resolve(files) };
}

export function failingProbe(message: string): WorkspaceProbe {
  return { changedFiles: () => Promise.reject(new Error(message)) };
}

/** Verification runner double: exit codes keyed by command name. */
export function stubVerifier(exitCodes: Record<string, number>, output = ""): VerificationRunner & { seen: CommandSpec[] } {
  const seen: CommandSpec[] = [];
  return {
    seen,
    run(_workspacePath: string, spec: CommandSpec): Promise<CommandResult> {
      seen.push(spec);
      const exitCode = exitCodes[spec.name] ?? 0;
      return Promise.resolve({
        name: spec.name,
        command: spec.command,
        exitCode,
        stdoutTail: exitCode === 0 ? "" : output,
        stderrTail: "",
        durationMs: 10,
      });
    },
  };
}

export interface LlmStub extends LlmPort {
  readonly calls: AgentSessionOptions[];
}

/** LlmPort double — only `agentSession` is exercised by this package. */
export function stubLlm(outcomes: Array<LlmOutcome<AgentSessionResult>>): LlmStub {
  const calls: AgentSessionOptions[] = [];
  let index = 0;
  return {
    calls,
    generateObject<T>(_req: unknown, _schema: z.ZodType<T>): Promise<LlmOutcome<T>> {
      return Promise.reject(new Error("generateObject is not used by @maestro/execution"));
    },
    agentSession(opts: AgentSessionOptions): Promise<LlmOutcome<AgentSessionResult>> {
      calls.push(opts);
      const outcome = outcomes[index];
      index += 1;
      if (!outcome) throw new Error(`unexpected agentSession call #${index}`);
      return Promise.resolve(outcome);
    },
  };
}

export function okSession(over: Partial<AgentSessionResult> = {}): LlmOutcome<AgentSessionResult> {
  return {
    status: "ok",
    value: {
      resumeToken: "resume-1",
      finalText: "done",
      log: llmLog(),
      ...over,
    },
    log: llmLog(),
  };
}

function llmLog() {
  return {
    at: "2026-08-08T10:00:00.000Z",
    runId: null,
    role: "engineer" as const,
    variantId: "v1",
    driver: "claude-sub" as const,
    model: "claude-opus-4",
    tokensIn: 10,
    tokensOut: 5,
    cachePct: null,
    usd: null,
    dataClass: "dahili" as const,
  };
}

/** A clock that ticks one second per call — deterministic, never `Date.now`. */
export function tickingClock(startIso = "2026-08-08T10:00:00.000Z"): () => Date {
  let ms = Date.parse(startIso);
  return () => {
    const at = new Date(ms);
    ms += 1000;
    return at;
  };
}
