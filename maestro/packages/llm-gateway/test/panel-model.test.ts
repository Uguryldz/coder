import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLlmGateway,
  isModelNotConfigured,
  MSG_BLOCKED_CONFIDENTIAL,
  MSG_DEGRADED_AI_ASSIST,
  type ResolvedModel,
} from "../src/index.js";
import { fakeClock, gatewayDeps, stubFetch, stubSecrets } from "./helpers.js";

/**
 * A model added in the panel is the model a run actually dials (M107).
 *
 * WHAT THESE PIN. The connections screen has collected an address, a model name
 * and an optional key for a self-hosted server since the `openai_compat` kind
 * existed — and none of it reached a run, because `llmConfig` read
 * `LLM_BASE_URL`/`LLM_MODEL` synchronously while composing the port. The panel
 * stored, tested and displayed three facts nothing used, which is the same
 * split `ConnectionSecretPort` had already closed for the API key alone. These
 * tests are the evidence that the other three facts now travel too — and that
 * the confidential rule did not become negotiable on the way.
 */

const ANSWER = {
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

const Schema = z.object({ ok: z.boolean() });

/** The static config an install with `.env` values composes today. */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    drivers: [
      {
        driver: "openai-compat",
        baseUrl: "https://from-env.invalid",
        apiKeyRef: "kv/llm#api-key",
        onPrem: false,
      },
    ],
    bindings: [
      { role: "intake", driver: "openai-compat", model: "env-model" },
      { role: "analyst", driver: "openai-compat", model: "env-model" },
    ],
    routes: [
      { dataClass: "acik", allowedDrivers: ["openai-compat"] },
      { dataClass: "dahili", allowedDrivers: ["openai-compat"] },
      { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
    ],
    ...overrides,
  };
}

function request(dataClass = "acik") {
  return {
    role: "analyst" as const,
    variantId: "v1",
    dataClass: dataClass as "acik" | "dahili" | "gizli",
    schemaName: "Verdict",
    input: { ticket: "UGURPAY-1" },
  };
}

/** A panel row, as `connectionModelFrom` would answer with one. */
function panelModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    baseUrl: "https://gpt-oss.openshift.internal",
    model: "gpt-oss-120b",
    onPrem: true,
    apiKeyRef: "kv/llm#api-key",
    ...overrides,
  };
}

describe("a model configured in the panel", () => {
  it("is the endpoint and the model the call actually uses", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel()) }),
    );

    const out = await gateway.generateObject(request(), Schema);

    expect(out.status).toBe("ok");
    // The address comes from the row, not from `baseUrl` in the static config.
    // `/v1` is appended by the driver, which is why the stored base carries none.
    expect(stub.calls[0]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    expect((stub.calls[0]?.body as { model: string }).model).toBe("gpt-oss-120b");
    // And the audit row names what answered, not what a config file still says.
    expect(out.status === "ok" && out.log.model).toBe("gpt-oss-120b");
  });

  it("takes effect on the NEXT call, with no restart", async () => {
    const stub = stubFetch([{ body: ANSWER }, { body: ANSWER }]);
    const clock = fakeClock();
    // The operator edits the row between the two calls. The gateway instance is
    // never rebuilt — which is the whole property being pinned here, because a
    // port that had captured the endpoint at composition time could not do this.
    let active = panelModel();
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(active) }),
    );

    await gateway.generateObject(request(), Schema);
    active = panelModel({ baseUrl: "https://yeni-sunucu.internal", model: "qwen3-32b" });
    await gateway.generateObject(request(), Schema);

    expect(stub.calls[0]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    expect(stub.calls[1]?.url).toBe("https://yeni-sunucu.internal/v1/chat/completions");
    expect((stub.calls[1]?.body as { model: string }).model).toBe("qwen3-32b");
  });

  it("sends NO Authorization header when the server wants no key", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    // A self-hosted server commonly needs no credential, and the panel stores
    // "" to say so. A bare `Bearer ` 401s some servers on a request that would
    // otherwise have succeeded, so the header must be absent — not empty.
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, {
        secrets: stubSecrets({ "kv/llm#api-key": "" }),
        resolveModel: () => Promise.resolve(panelModel()),
      }),
    );

    await gateway.generateObject(request(), Schema);

    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("still sends the key when the server wants one", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, {
        secrets: stubSecrets({ "kv/llm#api-key": "panelden-gelen-anahtar" }),
        resolveModel: () => Promise.resolve(panelModel()),
      }),
    );

    await gateway.generateObject(request(), Schema);

    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer panelden-gelen-anahtar");
  });
});

describe("an install with no model configured", () => {
  it("refuses by name at first use rather than failing to boot", async () => {
    const stub = stubFetch([]);
    const clock = fakeClock();
    // Building the gateway MUST succeed: the panel is how a model gets added,
    // so a process that refused to start without one could never be configured
    // through its own screen. The refusal belongs at first use.
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(null) }),
    );

    const error = await gateway.generateObject(request(), Schema).catch((e: unknown) => e);

    expect(isModelNotConfigured(error)).toBe(true);
    // Catchable as a named state, and the sentence points at the panel rather
    // than at a file on the server — the panel is where a model is added now.
    expect((error as Error).message).toContain("MAESTRO_NOT_CONFIGURED");
    expect((error as Error).message).toContain("Ayarlar & bağlantılar");
    // Nothing was dialled: a placeholder endpoint is never contacted.
    expect(stub.calls).toHaveLength(0);
  });
});

describe("the gizli class against a panel-added model", () => {
  it("refuses a model the operator marked as cloud", async () => {
    const stub = stubFetch([]);
    const clock = fakeClock();
    /**
     * THE RULE THAT MUST NOT BECOME NEGOTIABLE (M18). The static driver row is
     * declared `onPrem: false`, and the panel row says the same — a UI-added
     * cloud model is treated exactly as a cloud `.env` binding is. The default
     * `onPremMissing` action is `degrade_ai_assist`, so the platform stops
     * offering AI assistance rather than shipping a bank's confidential payload
     * to an outside endpoint.
     */
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel({ onPrem: false })) }),
    );

    const out = await gateway.generateObject(request("gizli"), Schema);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.messageKey).toBe(MSG_DEGRADED_AI_ASSIST);
    // The decisive assertion: no request left the process.
    expect(stub.calls).toHaveLength(0);
  });

  it("blocks a cloud model outright when the deployment says block", async () => {
    const stub = stubFetch([]);
    const clock = fakeClock();
    const gateway = createLlmGateway(
      config({ onPremMissing: "block" }),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel({ onPrem: false })) }),
    );

    const out = await gateway.generateObject(request("gizli"), Schema);

    expect(out.status).toBe("blocked");
    expect(out.status === "blocked" && out.messageKey).toBe(MSG_BLOCKED_CONFIDENTIAL);
    expect(stub.calls).toHaveLength(0);
  });

  it("allows a model the operator marked as on-prem", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    /**
     * The mirror image, and the reason the flag has to be per-row rather than
     * per-deployment: the STATIC config still says `onPrem: false`, exactly as a
     * stack whose `.env` never set `LLM_ON_PREM` would. The panel row is what
     * grants on-prem standing, so a confidential run reaches the internal server
     * without anyone editing a file — which is the entire point of the change.
     */
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel({ onPrem: true })) }),
    );

    const out = await gateway.generateObject(request("gizli"), Schema);

    expect(out.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    // Unmasked: an on-prem endpoint is inside the bank, so `masked_cloud` never
    // applied and the analyst sees the real ticket.
    expect(out.status === "ok" && out.unmask).toBeUndefined();
  });
});

describe("a deployment that still configures its model in .env", () => {
  it("behaves exactly as before when no resolver is wired", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    // No `resolveModel` at all — the shape every existing install and every
    // pre-existing test composes. Nothing may change for it.
    const gateway = createLlmGateway(config(), gatewayDeps(stub, clock));

    const out = await gateway.generateObject(request(), Schema);

    expect(out.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://from-env.invalid/v1/chat/completions");
    expect((stub.calls[0]?.body as { model: string }).model).toBe("env-model");
  });
});
