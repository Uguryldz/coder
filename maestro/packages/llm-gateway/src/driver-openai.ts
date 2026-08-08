import type { ApiDriverId } from "@maestro/contracts";
import { z } from "zod";
import type { DriverConfig } from "./config.js";
import { trimSlash } from "./driver-anthropic.js";
import type { DriverCall, DriverDeps, DriverResult, LlmDriver } from "./driver-types.js";
import { LlmResponseError } from "./errors.js";
import { postJson } from "./http.js";

/** Chat Completions response — the OpenAI-compatible shape vLLM also serves. */
const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).optional(),
  }),
});

/**
 * `openai-compat` (M16): the on-prem vLLM lane as well as any OpenAI-shaped
 * vendor. Whether it counts as on-prem is config (`onPrem`), not a guess made
 * from the URL — the M18 confidential rule leans on that flag.
 */
export class OpenAiCompatDriver implements LlmDriver {
  readonly id: ApiDriverId = "openai-compat";

  constructor(
    private readonly cfg: Extract<DriverConfig, { driver: "openai-compat" }>,
    private readonly deps: DriverDeps,
  ) {}

  async complete(call: DriverCall): Promise<DriverResult> {
    const apiKey = await this.deps.secrets.get(call.credentialRef ?? this.cfg.apiKeyRef);
    const messages = [
      ...(call.system === null ? [] : [{ role: "system", content: call.system }]),
      { role: "user", content: call.prompt },
    ];

    const json = await postJson(
      {
        driver: this.id,
        url: `${trimSlash(this.cfg.baseUrl)}/v1/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        body: { model: call.model, max_tokens: call.maxTokens, temperature: call.temperature, messages },
        timeoutMs: this.cfg.timeoutMs,
      },
      { deps: this.deps, bucket: this.deps.bucket, retry: this.deps.retry, counter: call.counter },
    );

    const parsed = ChatResponse.safeParse(json);
    if (!parsed.success) {
      throw new LlmResponseError(this.id, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    const text = parsed.data.choices[0]?.message.content ?? "";
    if (text.trim().length === 0) throw new LlmResponseError(this.id, ["first choice carries no content"]);

    const usage = parsed.data.usage;
    const cached = usage.prompt_tokens_details?.cached_tokens;
    return {
      text,
      tokensIn: usage.prompt_tokens,
      tokensOut: usage.completion_tokens,
      cachePct:
        cached === undefined || usage.prompt_tokens === 0
          ? null
          : Math.round((cached / usage.prompt_tokens) * 10_000) / 100,
    };
  }
}
