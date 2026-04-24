import Anthropic from "@anthropic-ai/sdk";
import { createLogger, loadConfig } from "@orkestra/config";
import type { AgentRole, KnowledgePack } from "@orkestra/contracts";
import { z } from "zod";
import { MockLLM } from "./mock.js";
import { estimateCostUsd } from "./pricing.js";
import { compileSystemPrompt } from "./prompt.js";
import { getRateLimiter } from "./rate-limit.js";

const log = createLogger("llm");

/**
 * Auth tipini belirler:
 *  - sk-ant-api... → klasik x-api-key (SDK default)
 *  - sk-ant-oat... → Authorization: Bearer + anthropic-beta: oauth-2025-04-20
 */
function isOAuthToken(token: string): boolean {
  return token.trim().startsWith("sk-ant-oat");
}

/**
 * Her çağrıda güncel client'ı çöz: UI'dan değişen token anında etkili olsun.
 * Basit per-token cache — aynı token için tekrar client yaratmayalım.
 */
const _clientCache = new Map<string, Anthropic>();

async function getClient(): Promise<Anthropic> {
  // DB Setting + env fallback (dynamic import — döngüsel bağımlılık koruması)
  const mod = await import("@orkestra/agents");
  const settings = await mod.getClaudeSettings();
  const key = settings.apiKey;
  if (!key) throw new Error("ANTHROPIC_API_KEY yok — Settings'ten ekle veya .env'e koy");

  const cacheKey = key;
  const cached = _clientCache.get(cacheKey);
  if (cached) return cached;

  const client = isOAuthToken(key)
    ? new Anthropic({
        authToken: key,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      })
    : new Anthropic({ apiKey: key });

  _clientCache.set(cacheKey, client);
  // Cache şişmesini önle: max 3 entry
  if (_clientCache.size > 3) {
    const oldest = _clientCache.keys().next().value;
    if (oldest && oldest !== cacheKey) _clientCache.delete(oldest);
  }
  return client;
}

export interface LLMCallOptions {
  role: AgentRole;
  model: string;
  systemPrompt: string;
  knowledgePack?: KnowledgePack | null;
  userInput: string;
  outputSchema: z.ZodTypeAny;
  outputSchemaName: string;
  temperature?: number;
  maxTokens?: number;
  correlationId: string;
  maxRetries?: number;
}

export interface LLMCallResult<T = unknown> {
  parsed: T;
  raw: string;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  costUsdCents: number;
  model: string;
  stopReason: string;
  attempt: number;
}

const MAX_RETRIES = 2;

function extractJson(text: string): string {
  // Tolerate accidental code fence or preamble
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1]!.trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text.trim();
}

export async function callLLM<T = unknown>(opts: LLMCallOptions): Promise<LLMCallResult<T>> {
  const cfg = loadConfig();
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      if (cfg.LLM_MODE === "mock") {
        const raw = MockLLM.output(opts.role, opts.userInput);
        const parsed = opts.outputSchema.parse(JSON.parse(raw));
        const { input, output } = MockLLM.tokens(opts.userInput);
        return {
          parsed: parsed as T,
          raw,
          tokensIn: input,
          tokensOut: output,
          cacheHits: 0,
          costUsdCents: 0,
          model: opts.model,
          stopReason: "end_turn",
          attempt,
        };
      }

      const compiled = compileSystemPrompt(opts.systemPrompt, opts.knowledgePack ?? null);
      const estimated = Math.ceil(
        (opts.systemPrompt.length +
          opts.userInput.length +
          JSON.stringify(opts.knowledgePack ?? {}).length) /
          3,
      );

      const rl = getRateLimiter();
      await rl.acquire(estimated);

      const client = await getClient();
      const started = Date.now();
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.2,
        system: compiled.systemBlocks as Anthropic.TextBlockParam[],
        messages: [{ role: "user", content: opts.userInput }],
      });

      const textBlock = response.content.find((b) => b.type === "text") as
        | Anthropic.TextBlock
        | undefined;
      const raw = textBlock?.text ?? "";
      const usage = response.usage;
      const tokensIn = usage.input_tokens ?? 0;
      const tokensOut = usage.output_tokens ?? 0;
      const cacheHits =
        (usage as Anthropic.Usage & { cache_read_input_tokens?: number }).cache_read_input_tokens ??
        0;
      const costUsd = estimateCostUsd(opts.model, tokensIn, tokensOut, cacheHits);

      const jsonCandidate = extractJson(raw);
      let parsed: T;
      try {
        parsed = opts.outputSchema.parse(JSON.parse(jsonCandidate)) as T;
      } catch (e) {
        if (attempt <= maxRetries) {
          log.warn({ attempt, role: opts.role, err: String(e) }, "schema failed, retrying");
          continue;
        }
        throw e;
      }

      log.info(
        {
          role: opts.role,
          model: opts.model,
          tokensIn,
          tokensOut,
          cacheHits,
          durationMs: Date.now() - started,
          correlationId: opts.correlationId,
          costUsdCents: Math.round(costUsd * 100),
        },
        "llm call success",
      );

      return {
        parsed,
        raw,
        tokensIn,
        tokensOut,
        cacheHits,
        costUsdCents: Math.round(costUsd * 100),
        model: opts.model,
        stopReason: response.stop_reason ?? "end_turn",
        attempt,
      };
    } catch (e) {
      lastErr = e as Error;
      const msg = (e as Error).message || "";
      // Transient: 429, 500, 502, 503, 504
      if (/429|5\d\d/.test(msg) && attempt <= maxRetries) {
        const backoff = 500 * Math.pow(2, attempt) + Math.random() * 500;
        log.warn({ attempt, backoff, msg }, "transient error, backing off");
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("LLM call failed after retries");
}
