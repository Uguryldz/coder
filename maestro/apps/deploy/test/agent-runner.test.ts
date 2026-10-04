import type { AgentRunInput } from "@maestro/llm-gateway";
import { describe, expect, it } from "vitest";
import { buildAgentRunner, buildClaudeRunner } from "../src/agent-runner.js";
import { loadDeployEnv } from "../src/env.js";

const MINIMAL: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://maestro:x@localhost:5432/maestro",
  JIRA_BASE_URL: "https://jira.example.local",
  ADO_BASE_URL: "https://dev.azure.com",
  LLM_BASE_URL: "https://llm.example.local/v1",
  STORAGE_ENDPOINT: "https://s3.example.local",
  VAULT_ADDR: "https://vault.example.local",
};

function env(extra: Record<string, string> = {}) {
  return loadDeployEnv({ ...MINIMAL, ...extra });
}

const secrets = { get: () => Promise.resolve("sk-test") } as never;

function input(over: Partial<AgentRunInput>): AgentRunInput {
  return {
    driver: "openai-compat",
    model: "m",
    workspacePath: "/tmp",
    task: "t",
    mcpServers: [],
    vendorSessionId: null,
    credentialRef: null,
    ...over,
  };
}

describe("buildAgentRunner", () => {
  it("is always built: an HTTP model gets the in-process tool-calling runner without any CLI", async () => {
    const runner = buildAgentRunner(env(), secrets);
    expect(buildClaudeRunner(env(), secrets)).toBeUndefined();
    const chat = { id: "openai-compat" as const, complete: () => Promise.reject(new Error("x")), chat: () => Promise.resolve({ text: "hi", toolCalls: [], tokensIn: 1, tokensOut: 1, finishReason: null }) };
    const out = await runner.run(input({ transport: chat }));
    expect(out.finalText).toBe("hi");
  });

  it("a subscription seat without CLAUDE_BIN_PATH is refused with the variable named", async () => {
    const runner = buildAgentRunner(env(), secrets);
    await expect(runner.run(input({ driver: "claude-sub" }))).rejects.toThrow(/CLAUDE_BIN_PATH/);
  });

  it("with CLAUDE_BIN_PATH the subscription seat goes to the CLI runner", () => {
    expect(buildClaudeRunner(env({ CLAUDE_BIN_PATH: "/usr/bin/claude" }), secrets)).toBeDefined();
  });
});
