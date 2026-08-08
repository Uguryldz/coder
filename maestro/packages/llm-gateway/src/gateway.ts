import type {
  ApiDriverId,
  GenerateObjectRequest,
  LlmDriverId,
  LlmRole,
  SubscriptionAccount,
  SubscriptionDriverId,
} from "@maestro/contracts";
import { GenerateObjectRequest as GenerateObjectRequestSchema, LlmCallLog, isSubscriptionDriver } from "@maestro/contracts";
import type { AgentSessionOptions, AgentSessionResult, LlmPort, SecretPort } from "@maestro/ports";
import type { z } from "zod";
import { ANY_VARIANT, type LlmGatewayConfig, parseGatewayConfig } from "./config.js";
import { AnthropicDirectDriver } from "./driver-anthropic.js";
import { BedrockDriver, VertexDriver } from "./driver-cloud.js";
import { OpenAiCompatDriver } from "./driver-openai.js";
import type { DriverDeps, LlmDriver } from "./driver-types.js";
import { AgentRunnerNotWiredError, LlmConfigError } from "./errors.js";
import { type FetchLike, TokenBucket } from "./http.js";
import { type ObjectOutcome, type QueuedOutcome, type SessionOutcome, asError } from "./outcomes.js";
import { MSG_QUEUED_QUOTA } from "./messages.js";
import { LlmPolicy } from "./policy.js";
import { SubscriptionPool } from "./pool.js";
import { type AgentRunner, AgentSessionStore } from "./session.js";
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
  /** Required only when the policy resolves to `masked_cloud` (M18/M20). */
  mask?: (text: string) => string;
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
 * model, and a subscription binding goes through the quota-aware pool. When the
 * pool is exhausted the queue-aware entry points RETURN `queued + resumeAt`.
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

  /** Queue-aware structured call — the shape Temporal activities should use. */
  async generateObjectOrQueue<T>(request: GenerateObjectRequest, schema: z.ZodType<T>): Promise<ObjectOutcome<T>> {
    const req = GenerateObjectRequestSchema.parse(request);
    const decision = this.policy.resolve(req.role, req.variantId, req.dataClass);
    if (decision.kind === "degrade") {
      return { status: "degraded", dataClass: decision.dataClass, messageKey: decision.messageKey };
    }
    const routed = this.route(decision.driver, decision.model);
    if (routed.status !== "ready") return routed;

    const input = decision.masked ? this.maskPayload(JSON.stringify(req.input)) : req.input;
    try {
      const out = await generateStructured({
        driver: routed.transport,
        schemaName: req.schemaName,
        schema,
        input,
        call: {
          model: routed.model,
          maxTokens: this.cfg.maxTokens,
          temperature: this.cfg.temperature,
          ...(routed.credentialRef === null ? {} : { credentialRef: routed.credentialRef }),
        },
      });
      const { tokensIn, tokensOut, cachePct } = out;
      const { role, variantId, dataClass } = req;
      const log = this.writeLog({ role, variantId, dataClass, driver: routed.driver, model: routed.model, tokensIn, tokensOut, cachePct });
      return { status: "ok", object: out.object, log };
    } finally {
      // A failed call still burned the seat's quota.
      if (routed.accountId !== null) this.pool.record(routed.accountId);
    }
  }

  /** Queue-aware agent turn; execution itself is delegated (Wave 2). */
  async agentSessionOrQueue(opts: AgentSessionOptions): Promise<SessionOutcome> {
    const runner = this.deps.agentRunner;
    if (!runner) throw new AgentRunnerNotWiredError();
    const role: LlmRole = this.cfg.agentRole;

    const existing = opts.resumeToken === undefined ? null : this.sessions.resume(opts.resumeToken, opts.workspacePath);
    let masked = false;
    let driver: LlmDriverId;
    let model: string;
    if (existing) {
      driver = existing.driver;
      model = existing.model;
    } else {
      const decision = this.policy.resolve(role, ANY_VARIANT, this.cfg.agentDataClass);
      if (decision.kind === "degrade") {
        return { status: "degraded", dataClass: decision.dataClass, messageKey: decision.messageKey };
      }
      driver = decision.driver;
      model = decision.model;
      masked = decision.masked;
    }

    const routed = this.route(driver, model);
    if (routed.status !== "ready") return routed;

    const record = existing ?? this.sessions.start(driver, model, opts.workspacePath);
    try {
      const out = await runner.run({
        driver: routed.driver,
        model: routed.model,
        workspacePath: opts.workspacePath,
        task: masked ? this.maskPayload(opts.task) : opts.task,
        mcpServers: opts.mcpServers,
        vendorSessionId: record.vendorSessionId,
        credentialRef: routed.credentialRef,
      });
      this.sessions.complete(record.resumeToken, out.vendorSessionId ?? null);
      const log = this.writeLog({
        role, variantId: ANY_VARIANT, dataClass: this.cfg.agentDataClass, driver: routed.driver,
        model: routed.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut, cachePct: null,
      });
      return { status: "ok", resumeToken: record.resumeToken, finalText: out.finalText, log };
    } finally {
      if (routed.accountId !== null) this.pool.record(routed.accountId);
    }
  }

  // --- LlmPort (frozen signatures; queue/degrade become typed errors) ---

  async generateObject<T>(request: GenerateObjectRequest, schema: z.ZodType<T>): Promise<{ object: T; log: LlmCallLog }> {
    const outcome = await this.generateObjectOrQueue(request, schema);
    if (outcome.status === "ok") return { object: outcome.object, log: outcome.log };
    throw asError(outcome);
  }

  async agentSession(opts: AgentSessionOptions): Promise<AgentSessionResult> {
    const outcome = await this.agentSessionOrQueue(opts);
    if (outcome.status === "ok") return { resumeToken: outcome.resumeToken, finalText: outcome.finalText, log: outcome.log };
    throw asError(outcome);
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
    if (!acquired.ok) return { status: "queued", resumeAt: acquired.resumeAt, messageKey: MSG_QUEUED_QUOTA };
    const { transport, credentialRef, accountId } = acquired.account;
    return { status: "ready", driver, model, transport: this.transport(transport), credentialRef, accountId };
  }

  private transport(id: ApiDriverId): LlmDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new LlmConfigError(`driver "${id}" is not configured or is disabled`);
    return driver;
  }

  private maskPayload(text: string): string {
    const mask = this.deps.mask;
    if (!mask) throw new LlmConfigError("policy resolved to masked_cloud but deps.mask was not wired");
    return mask(text);
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
