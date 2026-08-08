import type {
  ApiDriverId,
  DataClass,
  GenerateObjectRequest,
  LlmDriverId,
  LlmRole,
  SubscriptionAccount,
  SubscriptionDriverId,
} from "@maestro/contracts";
import { GenerateObjectRequest as GenerateObjectRequestSchema, LlmCallLog, isSubscriptionDriver } from "@maestro/contracts";
import type { PiiPolicy } from "@maestro/pii";
import type { AgentSessionOptions, LlmPort, SecretPort } from "@maestro/ports";
import type { z } from "zod";
import { type LlmGatewayConfig, parseGatewayConfig } from "./config.js";
import { AnthropicDirectDriver } from "./driver-anthropic.js";
import { BedrockDriver, VertexDriver } from "./driver-cloud.js";
import { OpenAiCompatDriver } from "./driver-openai.js";
import type { DriverDeps, LlmDriver } from "./driver-types.js";
import { AgentRunnerNotWiredError, LlmConfigError, SessionPolicyChangedError } from "./errors.js";
import { CallCounter, type FetchLike, TokenBucket } from "./http.js";
import { type MaskFn, type MaskedPayload, maskForEgress } from "./masking.js";
import {
  QUEUE_REASON_QUOTA,
  type GatewayOutcome,
  type QueuedOutcome,
  type SessionOutcome,
  haltedFrom,
} from "./outcomes.js";
import { LlmPolicy } from "./policy.js";
import { SubscriptionPool } from "./pool.js";
import { type AgentRunner, AgentSessionStore, type SessionPin, describePin } from "./session.js";
import { generateStructured } from "./structured.js";

export interface LlmGatewayDeps {
  secrets: SecretPort;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
  /** Wave 2 supplies the Claude Agent SDK runner (M17). */
  agentRunner?: AgentRunner;
  /**
   * Required only when the policy resolves to `masked_cloud` (M18/M20). Shaped
   * exactly like `@maestro/pii`'s `maskOutbound`, ReverseMap included.
   */
  mask?: MaskFn;
  /** Profile the gateway re-scans the masked payload with; defaults to the strict built-in. */
  piiPolicy?: PiiPolicy;
  onCallLog?: (log: LlmCallLog) => void;
  runId?: () => string | null;
  signRequest?: DriverDeps["signRequest"];
  accessToken?: DriverDeps["accessToken"];
}

interface Routed {
  status: "ready";
  driver: LlmDriverId;
  model: string;
  transport: LlmDriver;
  credentialRef: string | null;
  accountId: string | null;
}

/**
 * The LLM gateway (M16/M17/M18/M55). Driver choice is policy, invisible to
 * callers: data class picks the permitted backends, role+variant picks the
 * model, and a subscription binding goes through the quota-aware pool.
 *
 * Both port methods return an `LlmOutcome`: `queued` (pool exhausted, wait until
 * `resumeAt`), `degraded` (continue human-led, M97) and `blocked` (stop) are
 * decisions, not exceptions. Exceptions mean something broke — transport,
 * provider, wiring, schema.
 */
export class LlmGateway implements LlmPort {
  private readonly policy: LlmPolicy;
  private readonly pool: SubscriptionPool;
  private readonly sessions: AgentSessionStore;
  private readonly drivers = new Map<ApiDriverId, LlmDriver>();
  private readonly now: () => Date;

  constructor(
    private readonly cfg: LlmGatewayConfig,
    private readonly deps: LlmGatewayDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new LlmConfigError("no fetch implementation available");

    const driverDeps: DriverDeps = {
      secrets: deps.secrets,
      fetchImpl,
      now: this.now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: deps.random ?? Math.random,
      bucket: new TokenBucket(cfg.rateLimit, this.now),
      retry: cfg.retry,
      signRequest: deps.signRequest,
      accessToken: deps.accessToken,
    };

    for (const driverCfg of cfg.drivers) {
      if (!driverCfg.enabled) continue;
      this.drivers.set(driverCfg.driver, buildDriver(driverCfg, driverDeps));
    }

    const onPrem = new Map(cfg.drivers.map((d) => [d.driver, d.onPrem && d.enabled] as const));
    this.policy = new LlmPolicy(
      cfg,
      (id) => onPrem.get(id as ApiDriverId) === true,
      (id) => (isSubscriptionDriver(id) ? true : this.drivers.has(id as ApiDriverId)),
    );
    this.pool = new SubscriptionPool(cfg.subscriptionPool, this.now);
    this.sessions = new AgentSessionStore(deps.newId ?? (() => crypto.randomUUID()), this.now);
  }

  /** Thinking roles (M16/M19). One call, one schema, one outcome the caller branches on. */
  async generateObject<T>(request: GenerateObjectRequest, schema: z.ZodType<T>): Promise<GatewayOutcome<T>> {
    const req = GenerateObjectRequestSchema.parse(request);
    const decision = this.policy.resolve(req.role, req.variantId, req.dataClass);
    if (decision.kind !== "allow") return haltedFrom(decision);
    // Masking happens BEFORE a seat is taken: a missing masker is a wiring bug,
    // and a wiring bug must not cost quota.
    const masked = decision.masked ? this.mask(req.input, req.dataClass, "llm-gateway/generate-object") : null;
    const routed = this.route(decision.driver, decision.model);
    if (routed.status !== "ready") return routed;

    const counter = new CallCounter();
    try {
      const out = await generateStructured({
        driver: routed.transport,
        schemaName: req.schemaName,
        schema,
        input: masked === null ? req.input : masked.payload,
        call: {
          model: routed.model,
          maxTokens: this.cfg.maxTokens,
          temperature: this.cfg.temperature,
          counter,
          ...(routed.credentialRef === null ? {} : { credentialRef: routed.credentialRef }),
        },
      });
      const { tokensIn, tokensOut, cachePct } = out;
      const { role, variantId, dataClass } = req;
      const log = this.writeLog({ role, variantId, dataClass, driver: routed.driver, model: routed.model, tokensIn, tokensOut, cachePct });
      return { status: "ok", value: out.object, log, ...(masked === null ? {} : { unmask: masked.unmask }) };
    } finally {
      // A failed call still burned the seat's quota — retries included.
      if (routed.accountId !== null) this.pool.record(routed.accountId, Math.max(1, counter.attempts));
    }
  }

  /**
   * Doing roles (M17); execution itself is delegated (Wave 2). EVERY turn is
   * re-resolved against the policy, so a narrowed route or a kill-switch (M58)
   * reaches sessions that are already open — and a resolution that contradicts
   * the session's pin is refused rather than quietly ignored.
   *
   * The data class comes from the CALLER (`opts.dataClass`): a resume that
   * arrives with a different class than the session was opened with produces a
   * different pin and is refused, exactly like a policy change would be.
   */
  async agentSession(opts: AgentSessionOptions): Promise<SessionOutcome> {
    const runner = this.deps.agentRunner;
    if (!runner) throw new AgentRunnerNotWiredError();
    const role: LlmRole = this.cfg.agentRole;
    const { dataClass, variantId } = opts;

    const existing = opts.resumeToken === undefined ? null : this.sessions.resume(opts.resumeToken, opts.workspacePath);
    const decision = this.policy.resolve(role, variantId, dataClass);
    if (decision.kind !== "allow") return haltedFrom(decision);
    const pin: SessionPin = { driver: decision.driver, model: decision.model, dataClass, masked: decision.masked };
    if (existing && !samePin(existing, pin)) {
      throw new SessionPolicyChangedError(existing.resumeToken, describePin(existing), describePin(pin));
    }

    const masked = pin.masked ? this.mask(opts.task, dataClass, "llm-gateway/agent-session") : null;
    const routed = this.route(pin.driver, pin.model);
    if (routed.status !== "ready") return routed;

    const record = existing ?? this.sessions.start(pin, opts.workspacePath);
    try {
      const out = await runner.run({
        driver: routed.driver,
        model: routed.model,
        workspacePath: opts.workspacePath,
        task: masked === null ? opts.task : masked.payload,
        mcpServers: opts.mcpServers,
        vendorSessionId: record.vendorSessionId,
        credentialRef: routed.credentialRef,
      });
      this.sessions.complete(record.resumeToken, out.vendorSessionId ?? null);
      const log = this.writeLog({
        role, variantId, dataClass, driver: routed.driver,
        model: routed.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut, cachePct: null,
      });
      return {
        status: "ok",
        value: { resumeToken: record.resumeToken, finalText: out.finalText, log },
        log,
        ...(masked === null ? {} : { unmask: masked.unmask }),
      };
    } finally {
      if (routed.accountId !== null) this.pool.record(routed.accountId);
    }
  }

  /** Quota view for Studio/KPI (M62). */
  poolSnapshot(): SubscriptionAccount[] {
    return this.pool.snapshot();
  }

  private route(driver: LlmDriverId, model: string): Routed | QueuedOutcome {
    if (!isSubscriptionDriver(driver)) {
      return { status: "ready", driver, model, transport: this.transport(driver as ApiDriverId), credentialRef: null, accountId: null };
    }
    const acquired = this.pool.acquire(driver as SubscriptionDriverId);
    if (!acquired.ok) return { status: "queued", resumeAt: acquired.resumeAt, reason: QUEUE_REASON_QUOTA };
    const { transport, credentialRef, accountId } = acquired.account;
    return { status: "ready", driver, model, transport: this.transport(transport), credentialRef, accountId };
  }

  private transport(id: ApiDriverId): LlmDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new LlmConfigError(`driver "${id}" is not configured or is disabled`);
    return driver;
  }

  private mask<T>(payload: T, dataClass: DataClass, boundary: string): MaskedPayload<T> {
    return maskForEgress(this.deps.mask, payload, { dataClass, boundary }, this.deps.piiPolicy);
  }

  private writeLog(fields: Omit<LlmCallLog, "at" | "runId" | "usd">): LlmCallLog {
    // usd is null by design: subscription cost is quota (M55) and no price
    // table lives in this package — a guessed dollar figure would be worse.
    const log = LlmCallLog.parse({
      at: this.now().toISOString(),
      runId: this.deps.runId?.() ?? null,
      usd: null,
      ...fields,
    });
    this.deps.onCallLog?.(log);
    return log;
  }
}

/** A session may only continue on the exact backend/class/masking it opened with. */
function samePin(a: SessionPin, b: SessionPin): boolean {
  return a.driver === b.driver && a.model === b.model && a.dataClass === b.dataClass && a.masked === b.masked;
}

function buildDriver(cfg: LlmGatewayConfig["drivers"][number], deps: DriverDeps): LlmDriver {
  switch (cfg.driver) {
    case "anthropic-direct": return new AnthropicDirectDriver(cfg, deps);
    case "openai-compat": return new OpenAiCompatDriver(cfg, deps);
    case "aws-bedrock": return new BedrockDriver(cfg, deps);
    case "google-vertex": return new VertexDriver(cfg, deps);
  }
}

/** Build a gateway from raw (unvalidated) config — the composition-root entry. */
export function createLlmGateway(config: unknown, deps: LlmGatewayDeps): LlmGateway {
  return new LlmGateway(parseGatewayConfig(config), deps);
}
