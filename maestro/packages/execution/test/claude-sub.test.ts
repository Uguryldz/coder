import type { AgentRunInput } from "@maestro/llm-gateway";
import { describe, expect, it } from "vitest";
import { ClaudeSubRunner, type ClaudeSubRunnerOptions } from "../src/claude-sub.js";
import { OAUTH_TOKEN_ENV } from "../src/cli.js";
import { ClaudeCliError, ClaudeCliProtocolError, ExecutionConfigError } from "../src/errors.js";
import { initLine, OTHER_SESSION_ID, resultLine, SESSION_ID, stream, stubSpawn } from "./helpers.js";

function runnerOptions(over: Partial<ClaudeSubRunnerOptions> = {}): ClaudeSubRunnerOptions {
  return {
    binPath: "/home/svc/.local/bin/claude",
    basePath: "/usr/bin",
    home: "/home/seat1",
    permissionMode: "acceptEdits",
    mcpConfigPath: "/etc/maestro/mcp.json",
    timeoutMs: 60_000,
    resolveSeat: (ref) => Promise.resolve({ oauthToken: ref === null ? null : `token-for-${ref}`, configDir: null }),
    newSessionId: () => SESSION_ID,
    ...over,
  };
}

function input(over: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    driver: "claude-sub",
    model: "claude-opus-4",
    workspacePath: "/w/UGURPAY-42",
    task: "Fix the mapper.",
    mcpServers: ["jira"],
    vendorSessionId: null,
    credentialRef: "seat-1",
    ...over,
  };
}

describe("ClaudeSubRunner", () => {
  it("drives the local CLI with the prompt on stdin and the seat token in env", async () => {
    const spawn = stubSpawn([{ stdout: stream(initLine(), resultLine()) }]);
    const out = await new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input());

    const call = spawn.calls[0];
    expect(call?.command).toBe("/home/svc/.local/bin/claude");
    expect(call?.cwd).toBe("/w/UGURPAY-42");
    expect(call?.stdin).toBe("Fix the mapper.");
    expect(call?.env[OAUTH_TOKEN_ENV]).toBe("token-for-seat-1");
    expect(call?.args).not.toContain("Fix the mapper.");
    expect(out).toEqual({ finalText: "done", tokensIn: 125, tokensOut: 40, vendorSessionId: SESSION_ID });
  });

  it("carries no API key: the subscription path never sets ANTHROPIC_API_KEY", async () => {
    const spawn = stubSpawn([{ stdout: stream(resultLine()) }]);
    await new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input());
    expect(spawn.calls[0]?.env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("resumes the vendor session on the second turn (M30)", async () => {
    const spawn = stubSpawn([{ stdout: stream(resultLine()) }]);
    await new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input({ vendorSessionId: SESSION_ID }));
    const args = spawn.calls[0]?.args ?? [];
    expect(args[args.indexOf("--resume") + 1]).toBe(SESSION_ID);
    expect(args).not.toContain("--session-id");
  });

  it("fails when a resume comes back under a different session id", async () => {
    const spawn = stubSpawn([{ stdout: stream(resultLine({ session_id: OTHER_SESSION_ID })) }]);
    await expect(
      new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input({ vendorSessionId: SESSION_ID })),
    ).rejects.toThrow(/previous context was lost/);
  });

  it("refuses any driver other than claude-sub instead of guessing", async () => {
    const spawn = stubSpawn([]);
    await expect(
      new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input({ driver: "anthropic-direct" })),
    ).rejects.toThrow(ExecutionConfigError);
  });

  it("turns a non-zero exit into an error carrying the CLI's own reason", async () => {
    const spawn = stubSpawn([
      {
        exitCode: 1,
        stdout: stream(resultLine({ subtype: "error_during_execution", is_error: true, errors: ["quota exhausted"] })),
        stderr: "boom",
      },
    ]);
    await expect(new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input())).rejects.toThrow(/quota exhausted/);
  });

  it("fails a silent process rather than reporting an empty answer", async () => {
    const spawn = stubSpawn([{ exitCode: 1, stdout: "   ", stderr: "not logged in" }]);
    const error = await new ClaudeSubRunner(spawn.fn, runnerOptions())
      .run(input())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCliError);
    expect((error as ClaudeCliError).stderrTail).toBe("not logged in");
  });

  it("reports a timeout as a failure, not as a finished turn", async () => {
    const spawn = stubSpawn([{ timedOut: true, exitCode: -1, stdout: stream(resultLine()) }]);
    await expect(new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input())).rejects.toThrow(/exceeded 60000ms/);
  });

  it("propagates a protocol break instead of inventing a result", async () => {
    const spawn = stubSpawn([{ stdout: stream(initLine()) }]);
    await expect(new ClaudeSubRunner(spawn.fn, runnerOptions()).run(input())).rejects.toThrow(ClaudeCliProtocolError);
  });

  it("streams stdout lines onward while the turn runs", async () => {
    const seen: string[] = [];
    const spawn = stubSpawn([{ stdout: stream(resultLine()) }]);
    await new ClaudeSubRunner(spawn.fn, runnerOptions({ onStdoutLine: (l) => seen.push(l) })).run(input());
    expect(spawn.calls[0]?.onStdoutLine).toBeDefined();
    spawn.calls[0]?.onStdoutLine?.("x");
    expect(seen).toEqual(["x"]);
  });

  it("rejects a non-positive timeout at construction", () => {
    expect(() => new ClaudeSubRunner(stubSpawn([]).fn, runnerOptions({ timeoutMs: 0 }))).toThrow(ExecutionConfigError);
  });
});
