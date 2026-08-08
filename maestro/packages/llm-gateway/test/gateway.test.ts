import type { GenerateObjectRequest } from "@maestro/contracts";
import { LlmCallLog } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentRunnerNotWiredError,
  LlmConfigError,
  LlmGateway,
  LlmPolicyBlockedError,
  MSG_DEGRADED_AI_ASSIST,
  MSG_QUEUED_QUOTA,
  SubscriptionQueuedError,
  UnknownModelError,
  WINDOW_MS,
  createLlmGateway,
  type AgentRunInput,
  type AgentRunOutput,
  type LlmGatewayDeps,
} from "../src/index.js";
import { type StubResponse, fakeClock, gatewayDeps, stubFetch, stubSecrets } from "./helpers.js";

const Analysis = z.object({ risk: z.enum(["dusuk", "orta", "kritik"]), reason: z.string().min(1) });
const ANSWER = '{"risk":"orta","reason":"payment path touched"}';

function anthropicBody(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 25 } };
}

const config = {
  drivers: [
    { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" },
    { driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true },
  ],
  bindings: [
    { role: "analyst", driver: "claude-sub", model: "claude-sonnet" },
    { role: "intake", driver: "anthropic-direct", model: "claude-haiku" },
    { role: "engineer", driver: "claude-sub", model: "claude-sonnet" },
    { role: "test_designer", driver: "openai-compat", model: "qwen-onprem" },
  ],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct", "openai-compat", "claude-sub"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "openai-compat", "claude-sub"] },
    { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
  ],
  subscriptionPool: {
    accounts: [
      {
        accountId: "sub-1",
        driver: "claude-sub",
        transport: "anthropic-direct",
        credentialRef: "llm/seat1",
        windows: [
          { kind: "5h", costPctPerCall: 95 },
          { kind: "weekly", costPctPerCall: 1 },
        ],
      },
    ],
  },
};

const request: GenerateObjectRequest = {
  role: "analyst",
  variantId: "backend",
  dataClass: "dahili",
  schemaName: "Analysis",
  input: { ticket: "UGURPAY-1" },
};

function build(
  over: Record<string, unknown> = {},
  extraDeps: Partial<LlmGatewayDeps> = {},
  responses: StubResponse[] = [{ body: anthropicBody(ANSWER) }],
) {
  const stub = stubFetch(responses);
  const clock = fakeClock();
  const logs: LlmCallLog[] = [];
  const deps = gatewayDeps(stub, clock, {
    secrets: stubSecrets({ "llm/seat1": "sk-seat1", "llm/anthropic": "sk-ant", "llm/vllm": "sk-vllm" }),
    onCallLog: (log) => logs.push(log),
    ...extraDeps,
  });
  const gateway = createLlmGateway({ ...config, ...over }, deps);
  return { gateway, stub, clock, logs };
}

describe("LlmGateway.generateObjectOrQueue", () => {
  it("routes a subscription binding through the seat's transport and credential", async () => {
    const { gateway, stub } = build();
    const outcome = await gateway.generateObjectOrQueue(request, Analysis);

    expect(outcome.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(stub.calls[0]?.headers["x-api-key"]).toBe("sk-seat1");
    expect(stub.calls[0]?.body).toMatchObject({ model: "claude-sonnet" });
  });

  it("produces a contract-valid call log with usd null and the subscription driver", async () => {
    const { gateway, logs } = build({}, { runId: () => "run-abcdefgh" });
    const outcome = await gateway.generateObjectOrQueue(request, Analysis);

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.object).toEqual({ risk: "orta", reason: "payment path touched" });
    expect(() => LlmCallLog.parse(outcome.log)).not.toThrow();
    expect(outcome.log).toEqual({
      at: "2026-08-08T09:00:00.000Z",
      runId: "run-abcdefgh",
      role: "analyst",
      variantId: "backend",
      driver: "claude-sub",
      model: "claude-sonnet",
      tokensIn: 125,
      tokensOut: 20,
      cachePct: 20,
      usd: null,
      dataClass: "dahili",
    });
    expect(logs).toEqual([outcome.log]);
  });

  it("queues with resumeAt instead of failing when the pool is exhausted (M55)", async () => {
    const { gateway, stub, clock } = build({}, {}, [{ body: anthropicBody(ANSWER) }]);
    await gateway.generateObjectOrQueue(request, Analysis);

    const queued = await gateway.generateObjectOrQueue(request, Analysis);
    expect(queued).toEqual({
      status: "queued",
      resumeAt: new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS["5h"]).toISOString(),
      messageKey: MSG_QUEUED_QUOTA,
    });
    // The queued call never reached the provider.
    expect(stub.calls).toHaveLength(1);

    clock.advance(WINDOW_MS["5h"]);
    expect(gateway.poolSnapshot()[0]?.state).toBe("ready");
  });

  it("burns the seat's quota even when the provider call fails", async () => {
    const { gateway } = build({}, {}, [{ status: 400, body: { error: "bad model" } }]);

    await expect(gateway.generateObjectOrQueue(request, Analysis)).rejects.toThrow(/HTTP 400/);
    expect(gateway.poolSnapshot()[0]?.state).toBe("exhausted");
  });

  it("degrades a confidential request when no on-prem backend serves the role (M18)", async () => {
    const { gateway, stub } = build();
    const outcome = await gateway.generateObjectOrQueue({ ...request, dataClass: "gizli" }, Analysis);

    expect(outcome).toEqual({ status: "degraded", dataClass: "gizli", messageKey: MSG_DEGRADED_AI_ASSIST });
    expect(stub.calls).toHaveLength(0);
  });

  it("sends a confidential request to the on-prem backend when one is bound", async () => {
    const { gateway, stub } = build({}, {}, [
      {
        body: {
          choices: [{ message: { content: ANSWER } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
      },
    ]);

    const outcome = await gateway.generateObjectOrQueue(
      { ...request, role: "test_designer", dataClass: "gizli" },
      Analysis,
    );

    expect(outcome.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://vllm.internal.bank/v1/chat/completions");
    if (outcome.status === "ok") expect(outcome.log.driver).toBe("openai-compat");
  });

  it("refuses masked_cloud routing when no masker is wired (fail-closed)", async () => {
    const cloudGizli = {
      onPremMissing: "masked_cloud",
      routes: [
        { dataClass: "acik", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
      ],
    };
    const { gateway, stub } = build(cloudGizli);

    await expect(
      gateway.generateObjectOrQueue({ ...request, role: "intake", dataClass: "gizli" }, Analysis),
    ).rejects.toBeInstanceOf(LlmConfigError);
    expect(stub.calls).toHaveLength(0);
  });

  it("masks the payload before a masked_cloud call leaves the bank", async () => {
    const cloudGizli = {
      onPremMissing: "masked_cloud",
      routes: [
        { dataClass: "acik", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "claude-sub"] },
        { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
      ],
    };
    const { gateway, stub } = build(cloudGizli, { mask: () => "***MASKED***" });

    await gateway.generateObjectOrQueue({ ...request, role: "intake", dataClass: "gizli" }, Analysis);

    const sent = JSON.stringify(stub.calls[0]?.body);
    expect(sent).toContain("***MASKED***");
    expect(sent).not.toContain("UGURPAY-1");
  });

  it("rejects an unbound role and a malformed request", async () => {
    const { gateway } = build();
    await expect(gateway.generateObjectOrQueue({ ...request, role: "dev_reviewer" }, Analysis)).rejects.toBeInstanceOf(
      UnknownModelError,
    );
    await expect(gateway.generateObjectOrQueue({ ...request, variantId: "" }, Analysis)).rejects.toThrow();
  });
});

describe("LlmGateway LlmPort surface", () => {
  it("returns object + log through the frozen port signature", async () => {
    const { gateway } = build();
    const result = await gateway.generateObject(request, Analysis);

    expect(result.object.risk).toBe("orta");
    expect(result.log.driver).toBe("claude-sub");
  });

  it("turns a queued pool into a typed error carrying resumeAt", async () => {
    const { gateway } = build();
    await gateway.generateObject(request, Analysis);

    const error = await gateway.generateObject(request, Analysis).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionQueuedError);
    expect((error as SubscriptionQueuedError).resumeAt).toBe(
      new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS["5h"]).toISOString(),
    );
  });

  it("turns a degraded policy decision into a typed error", async () => {
    const { gateway } = build();
    await expect(gateway.generateObject({ ...request, dataClass: "gizli" }, Analysis)).rejects.toBeInstanceOf(
      LlmPolicyBlockedError,
    );
  });
});

describe("LlmGateway.agentSession (M17 delegation)", () => {
  function runner(outputs: AgentRunOutput[] = [{ finalText: "done", tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" }]) {
    const inputs: AgentRunInput[] = [];
    let index = 0;
    return {
      inputs,
      run: (input: AgentRunInput) => {
        inputs.push(input);
        const out = outputs[index];
        index += 1;
        if (!out) throw new Error("unexpected runner call");
        return Promise.resolve(out);
      },
    };
  }

  const opts = { workspacePath: "/work/UGURPAY-1", task: "implement the change", mcpServers: ["maestro-mcp"] };

  it("picks the backend, opens a session and delegates the run", async () => {
    const agentRunner = runner();
    const { gateway, stub } = build({}, { agentRunner }, []);

    const outcome = await gateway.agentSessionOrQueue(opts);

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.resumeToken).toBe("session-1");
    expect(outcome.finalText).toBe("done");
    expect(outcome.log).toMatchObject({ role: "engineer", driver: "claude-sub", model: "claude-sonnet", usd: null });
    expect(agentRunner.inputs[0]).toEqual({
      driver: "claude-sub",
      model: "claude-sonnet",
      workspacePath: "/work/UGURPAY-1",
      task: "implement the change",
      mcpServers: ["maestro-mcp"],
      vendorSessionId: null,
      credentialRef: "llm/seat1",
    });
    // The gateway itself makes no provider call — execution is Wave 2's job.
    expect(stub.calls).toHaveLength(0);
  });

  it("resumes the same session and hands the vendor handle back", async () => {
    const agentRunner = runner([
      { finalText: "turn 1", tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" },
      { finalText: "turn 2", tokensIn: 5, tokensOut: 2 },
    ]);
    const { gateway } = build(
      {
        subscriptionPool: {
          accounts: [
            {
              accountId: "sub-1",
              driver: "claude-sub",
              transport: "anthropic-direct",
              credentialRef: "llm/seat1",
              windows: [{ kind: "5h", costPctPerCall: 1 }],
            },
          ],
        },
      },
      { agentRunner },
      [],
    );

    const first = await gateway.agentSession(opts);
    const second = await gateway.agentSession({ ...opts, resumeToken: first.resumeToken });

    expect(second.resumeToken).toBe(first.resumeToken);
    expect(agentRunner.inputs[1]?.vendorSessionId).toBe("v1");
    expect(second.finalText).toBe("turn 2");
  });

  it("queues an agent turn when the pool is exhausted, without calling the runner", async () => {
    const agentRunner = runner();
    const { gateway } = build({}, { agentRunner }, []);
    await gateway.agentSessionOrQueue(opts);

    const queued = await gateway.agentSessionOrQueue(opts);
    expect(queued).toMatchObject({ status: "queued", messageKey: MSG_QUEUED_QUOTA });
    expect(agentRunner.inputs).toHaveLength(1);
  });

  it("refuses to run when no agent runner is wired", async () => {
    const { gateway } = build({}, {}, []);
    await expect(gateway.agentSession(opts)).rejects.toBeInstanceOf(AgentRunnerNotWiredError);
  });

  it("degrades an agent turn when the configured agent data class has no backend", async () => {
    const agentRunner = runner();
    const { gateway } = build(
      { agentDataClass: "gizli" },
      { agentRunner },
      [],
    );

    expect(await gateway.agentSessionOrQueue(opts)).toMatchObject({ status: "degraded", dataClass: "gizli" });
    expect(agentRunner.inputs).toHaveLength(0);
  });
});

describe("LlmGateway wiring", () => {
  it("validates config before building anything", () => {
    expect(() => createLlmGateway({ ...config, bindings: [] }, gatewayDeps(stubFetch([]), fakeClock()))).toThrow(
      LlmConfigError,
    );
  });

  it("refuses to construct without a fetch implementation", () => {
    const deps = gatewayDeps(stubFetch([]), fakeClock());
    const originalFetch = globalThis.fetch;
    try {
      Reflect.deleteProperty(globalThis, "fetch");
      expect(() => createLlmGateway(config, { ...deps, fetchImpl: undefined })).toThrow(/no fetch implementation/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes a contract-valid quota snapshot for Studio (M62)", () => {
    const { gateway } = build();
    expect(gateway.poolSnapshot()).toEqual([
      {
        accountId: "sub-1",
        driver: "claude-sub",
        state: "ready",
        lastUsedAt: null,
        windows: [
          { kind: "5h", usedPct: 0, resetsAt: new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS["5h"]).toISOString() },
          { kind: "weekly", usedPct: 0, resetsAt: new Date(Date.parse("2026-08-08T09:00:00.000Z") + WINDOW_MS.weekly).toISOString() },
        ],
      },
    ]);
  });

  it("satisfies the frozen LlmPort interface", () => {
    const { gateway } = build();
    const port: LlmPort = gateway;

    expect(gateway).toBeInstanceOf(LlmGateway);
    expect(typeof port.generateObject).toBe("function");
    expect(typeof port.agentSession).toBe("function");
  });
});
