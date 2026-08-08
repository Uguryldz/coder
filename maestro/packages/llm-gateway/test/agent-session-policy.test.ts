import { describe, expect, it } from "vitest";
import {
  LlmGateway,
  LlmPolicyBlockedError,
  SessionPolicyChangedError,
  parseGatewayConfig,
  type LlmGatewayConfig,
} from "../src/index.js";
import { SAMPLE_IBAN, fakeClock, gatewayDeps, piiMask, stubFetch, stubRunner } from "./helpers.js";

/**
 * B2/B3/B4 regressions. An agent session is a multi-turn conversation, and every
 * one of its turns is an egress: masking must survive the resume (M20/M54), the
 * policy must be asked again on every turn so a narrowed route or a kill-switch
 * reaches sessions that are already open (M58), and the class an agent turn is
 * routed with must be the strictest one until the port carries a real class.
 */

const cloudDriver = { driver: "anthropic-direct", apiKeyRef: "llm/anthropic" };
const onPremDriver = { driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true };

const raw = {
  drivers: [cloudDriver, onPremDriver],
  bindings: [
    { role: "engineer", driver: "anthropic-direct", model: "claude-cloud" },
    { role: "engineer", driver: "openai-compat", model: "qwen-onprem" },
  ],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct", "openai-compat"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct", "openai-compat"] },
    { dataClass: "gizli", allowedDrivers: ["anthropic-direct", "openai-compat"] },
  ],
};

const opts = { workspacePath: "/work/UGURPAY-1", task: `fix the CI break on ${SAMPLE_IBAN}`, mcpServers: ["maestro-mcp"] };

function build(over: Record<string, unknown>, outputs = [turn("turn 1"), turn("turn 2")]) {
  const cfg: LlmGatewayConfig = parseGatewayConfig({ ...raw, ...over });
  const runner = stubRunner(outputs);
  const deps = gatewayDeps(stubFetch([]), fakeClock(), { agentRunner: runner, mask: piiMask() });
  // The parsed config object is the one the gateway reads on every turn, so a
  // compliance edit / kill-switch is simulated by editing it in place.
  return { cfg, runner, gateway: new LlmGateway(cfg, deps) };
}

function turn(finalText: string) {
  return { finalText, tokensIn: 10, tokensOut: 3, vendorSessionId: "v1" };
}

function gizli(dataClass: string, allowed: string[]) {
  return raw.routes.map((r) => (r.dataClass === dataClass ? { ...r, allowedDrivers: allowed } : r));
}

describe("agent session masking survives the resume (B2 · M20/M54)", () => {
  it("masks the second turn exactly like the first", async () => {
    const { gateway, runner } = build({
      agentDataClass: "gizli",
      onPremMissing: "masked_cloud",
      routes: gizli("gizli", ["anthropic-direct"]),
    });

    const first = await gateway.agentSession(opts);
    await gateway.agentSession({ ...opts, resumeToken: first.resumeToken, task: `retry after ${SAMPLE_IBAN}` });

    expect(runner.inputs).toHaveLength(2);
    for (const input of runner.inputs) {
      expect(input.task).toContain("[IBAN_1]");
      expect(input.task).not.toContain(SAMPLE_IBAN);
    }
  });

  it("hands back an unmask for the human-facing text only (M20)", async () => {
    const { gateway } = build(
      { agentDataClass: "gizli", onPremMissing: "masked_cloud", routes: gizli("gizli", ["anthropic-direct"]) },
      [turn(`done with [IBAN_1]`)],
    );

    const outcome = await gateway.agentSessionOrQueue(opts);
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    // What may be persisted stays masked; the reveal is an explicit call.
    expect(outcome.finalText).toBe("done with [IBAN_1]");
    expect(outcome.unmask?.(outcome.finalText)).toBe(`done with ${SAMPLE_IBAN}`);
  });
});

describe("every agent turn is re-checked against the policy (B3 · M58)", () => {
  it("refuses a resume whose route no longer permits any backend", async () => {
    const { cfg, gateway, runner } = build({ agentDataClass: "dahili" });
    const first = await gateway.agentSession(opts);

    // Compliance narrows the class to a backend this role has no binding for.
    cfg.routes = gizli("dahili", ["aws-bedrock"]) as LlmGatewayConfig["routes"];

    await expect(gateway.agentSession({ ...opts, resumeToken: first.resumeToken })).rejects.toBeInstanceOf(
      LlmPolicyBlockedError,
    );
    expect(runner.inputs).toHaveLength(1);
  });

  it("refuses a resume that would contradict the session's pinned backend", async () => {
    const { cfg, gateway, runner } = build({ agentDataClass: "dahili" });
    const first = await gateway.agentSession(opts);
    expect(runner.inputs[0]?.driver).toBe("anthropic-direct");

    // Kill-switch on the cloud lane: the policy now resolves to on-prem, but the
    // session is pinned to the cloud driver. Neither answer is safe — refuse.
    cfg.routes = gizli("dahili", ["openai-compat"]) as LlmGatewayConfig["routes"];

    await expect(gateway.agentSession({ ...opts, resumeToken: first.resumeToken })).rejects.toBeInstanceOf(
      SessionPolicyChangedError,
    );
    expect(runner.inputs).toHaveLength(1);
  });

  it("stops an open confidential session when onPremMissing flips to block", async () => {
    const { cfg, gateway, runner } = build({
      agentDataClass: "gizli",
      onPremMissing: "masked_cloud",
      routes: gizli("gizli", ["anthropic-direct"]),
    });
    const first = await gateway.agentSession(opts);

    cfg.onPremMissing = "block";

    await expect(gateway.agentSession({ ...opts, resumeToken: first.resumeToken })).rejects.toBeInstanceOf(
      LlmPolicyBlockedError,
    );
    expect(runner.inputs).toHaveLength(1);
  });

  it("degrades an open session instead of resuming it when the policy degrades", async () => {
    const { cfg, gateway, runner } = build({
      agentDataClass: "gizli",
      onPremMissing: "masked_cloud",
      routes: gizli("gizli", ["anthropic-direct"]),
    });
    const first = await gateway.agentSession(opts);

    cfg.onPremMissing = "degrade_ai_assist";

    expect(await gateway.agentSessionOrQueue({ ...opts, resumeToken: first.resumeToken })).toMatchObject({
      status: "degraded",
      dataClass: "gizli",
    });
    expect(runner.inputs).toHaveLength(1);
  });
});

describe("agent turns are routed and logged with their real data class (B4 · M18)", () => {
  it("defaults the agent data class to the strictest one", () => {
    expect(parseGatewayConfig(raw).agentDataClass).toBe("gizli");
  });

  it("fails closed on the default rather than sending confidential work to the cloud", async () => {
    // gizli reaches on-prem only, and this deployment has no GPU yet.
    const { gateway, runner } = build({ routes: gizli("gizli", ["openai-compat"]) }, [turn("turn 1")]);
    const disabled = parseGatewayConfig({
      ...raw,
      drivers: [cloudDriver, { ...onPremDriver, enabled: false }],
      routes: gizli("gizli", ["openai-compat"]),
    });
    const blind = new LlmGateway(
      disabled,
      gatewayDeps(stubFetch([]), fakeClock(), { agentRunner: runner, mask: piiMask() }),
    );

    expect(await blind.agentSessionOrQueue(opts)).toMatchObject({ status: "degraded", dataClass: "gizli" });
    expect(runner.inputs).toHaveLength(0);
    // With the on-prem lane up, the same default routes there — not to the cloud.
    const outcome = await gateway.agentSessionOrQueue(opts);
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.log).toMatchObject({ driver: "openai-compat", dataClass: "gizli" });
  });

  it("writes the class the turn was actually routed with", async () => {
    const { gateway } = build({ agentDataClass: "acik" }, [turn("turn 1")]);
    const outcome = await gateway.agentSessionOrQueue(opts);

    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    expect(outcome.log.dataClass).toBe("acik");
  });
});
