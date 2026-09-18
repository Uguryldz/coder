import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunInput, ChatCall, ChatResult, LlmDriver } from "@maestro/llm-gateway";
import { describe, expect, it } from "vitest";
import { AgentStepBudgetError, AgentTransportError, HttpAgentRunner, NodeWorkspaceFs } from "../src/index.js";

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maestro-runner-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(root, "package.json"), '{"name":"demo"}\n');
  return root;
}

/** A driver whose answers are scripted; every call it received is kept. */
function scripted(script: readonly ChatResult[]): LlmDriver & { calls: ChatCall[] } {
  const calls: ChatCall[] = [];
  let i = 0;
  return {
    id: "openai-compat",
    calls,
    complete: () => Promise.reject(new Error("not used")),
    chat: (call) => {
      // Snapshot: the runner keeps appending to the same array after the call.
      calls.push({ ...call, messages: [...call.messages] });
      const next = script[i];
      i += 1;
      if (next === undefined) throw new Error("script exhausted");
      return Promise.resolve(next);
    },
  };
}

const usage = { tokensIn: 10, tokensOut: 5, finishReason: null };

function input(transport: LlmDriver, over: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    driver: "openai-compat",
    model: "gpt-x",
    workspacePath: "",
    task: "Inventory the repo",
    mcpServers: [],
    vendorSessionId: null,
    credentialRef: null,
    transport,
    ...over,
  };
}

describe("HttpAgentRunner", () => {
  it("loops over tool calls until the model answers, feeding real file contents back", async () => {
    const root = await repo();
    const transport = scripted([
      { text: null, toolCalls: [{ id: "c1", name: "list_dir", arguments: '{"path":"."}' }], ...usage },
      { text: null, toolCalls: [{ id: "c2", name: "read_file", arguments: '{"path":"src/index.ts"}' }], ...usage },
      { text: "Found `a = 1` in src/index.ts", toolCalls: [], ...usage },
    ]);
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p) });
    const out = await runner.run(input(transport, { workspacePath: root }));
    expect(out.finalText).toContain("a = 1");
    expect(out.tokensIn).toBe(30);
    expect(out.tokensOut).toBe(15);
    expect(out.vendorSessionId).toBeTruthy();
    // Third call carries both tool results in order, with the file content.
    const last = transport.calls[2]!;
    const toolMessages = last.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]!.content).toContain("export const a = 1");
    // Read-only session: no write tool offered.
    expect(last.tools.map((t) => t.name)).toEqual(["read_file", "list_dir", "search_workspace"]);
  });

  it("offers write_file only to the engineering turn and refuses protected paths without ending the session", async () => {
    const root = await repo();
    const transport = scripted([
      { text: null, toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: ".github/workflows/ci.yml", content: "x" }) }], ...usage },
      { text: null, toolCalls: [{ id: "w2", name: "write_file", arguments: JSON.stringify({ path: "src/index.ts", content: "export const a = 2;\n" }) }], ...usage },
      { text: "Changed src/index.ts", toolCalls: [], ...usage },
    ]);
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p) });
    const out = await runner.run(input(transport, { workspacePath: root, mcpServers: ["workspace", "jira"] }));
    expect(out.finalText).toBe("Changed src/index.ts");
    expect(transport.calls[0]!.tools.map((t) => t.name)).toContain("write_file");
    const refusal = transport.calls[1]!.messages.at(-1)!;
    expect(refusal.role).toBe("tool");
    expect(refusal.content).toMatch(/protected|rule/);
    expect(await readFile(join(root, "src", "index.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("a read-only session that tries to write gets a refusal, not a file", async () => {
    const root = await repo();
    const transport = scripted([
      { text: null, toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "src/index.ts", content: "boom" }) }], ...usage },
      { text: "ok", toolCalls: [], ...usage },
    ]);
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p) });
    await runner.run(input(transport, { workspacePath: root }));
    expect(transport.calls[1]!.messages.at(-1)!.content).toContain("read_only");
    expect(await readFile(join(root, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("resumes a conversation by vendor session id and passes the panel override through", async () => {
    const root = await repo();
    const transport = scripted([
      { text: "first", toolCalls: [], ...usage },
      { text: "second", toolCalls: [], ...usage },
    ]);
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p), newSessionId: () => "sess-1" });
    const first = await runner.run(input(transport, { workspacePath: root, baseUrl: "https://llm.bank.local", skipTlsVerify: true, credentialRef: "k1" }));
    expect(first.vendorSessionId).toBe("sess-1");
    await runner.run(input(transport, { workspacePath: root, vendorSessionId: "sess-1", task: "continue" }));
    const second = transport.calls[1]!;
    // system + user + assistant + user
    expect(second.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(transport.calls[0]).toMatchObject({ baseUrl: "https://llm.bank.local", skipTlsVerify: true, credentialRef: "k1" });
  });

  it("stops at the step budget with a named error", async () => {
    const root = await repo();
    const forever: ChatResult = { text: null, toolCalls: [{ id: "x", name: "list_dir", arguments: "{}" }], ...usage };
    const transport = scripted([forever, forever, forever, forever]);
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p), maxSteps: 3 });
    await expect(runner.run(input(transport, { workspacePath: root }))).rejects.toBeInstanceOf(AgentStepBudgetError);
  });

  it("refuses a subscription driver, a missing transport and a driver without chat", async () => {
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p) });
    const noChat: LlmDriver = { id: "anthropic-direct", complete: () => Promise.reject(new Error("x")) };
    await expect(runner.run(input(noChat, { driver: "claude-sub" }))).rejects.toBeInstanceOf(AgentTransportError);
    await expect(runner.run({ ...input(noChat), transport: undefined })).rejects.toBeInstanceOf(AgentTransportError);
    await expect(runner.run(input(noChat))).rejects.toThrow(/no tool-calling chat/);
  });

  it("returns malformed arguments to the model as an error result", async () => {
    const root = await repo();
    const transport = scripted([
      { text: null, toolCalls: [{ id: "b", name: "read_file", arguments: "{not json" }], ...usage },
      { text: null, toolCalls: [{ id: "u", name: "run_shell", arguments: "{}" }], ...usage },
      { text: "done", toolCalls: [], ...usage },
    ]);
    const runner = new HttpAgentRunner({ fsFor: (p) => new NodeWorkspaceFs(p) });
    await runner.run(input(transport, { workspacePath: root }));
    expect(transport.calls[1]!.messages.at(-1)!.content).toMatch(/error/);
    expect(transport.calls[2]!.messages.at(-1)!.content).toContain("unknown_tool");
  });
});
