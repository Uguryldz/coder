import type { ApiDriverId } from "@maestro/contracts";
import { z } from "zod";
import type { DriverConfig } from "./config.js";
import { trimSlash } from "./driver-anthropic.js";
import type { DriverCall, DriverDeps, DriverResult, LlmDriver } from "./driver-types.js";
import { LlmResponseError } from "./errors.js";
import { postJson } from "./http.js";

/**
 * Chat Completions response — the OpenAI-compatible shape vLLM also serves.
 *
 * ── WHY THE OPTIONAL FIELDS ARE ALSO NULLABLE ───────────────────────────────
 *
 * "OpenAI-compatible" is a family, not a specification. A server may omit an
 * optional field, and it may just as well send it as `null` — both are ordinary
 * JSON for "no value", and nothing in the ecosystem picks one.
 *
 * `prompt_tokens_details` was `.optional()` alone, so a server that sent
 * `"prompt_tokens_details": null` was REJECTED. Measured on the bank's on-prem
 * install: every intake call came back correct, this schema threw
 * `LlmResponseError`, Temporal retried the activity forever, and the run sat at
 * "çalışıyor" with the ticket showing only "işleme alındı". The model was fine;
 * the reader was too strict, and the strictness bought nothing — the value is a
 * cache statistic used for one display percentage.
 *
 * So: `.nullish()` on everything the response does not NEED. What this driver
 * cannot work without stays required — `choices[0].message.content` (the answer
 * itself) and the two token counts that feed quota accounting. Being lenient
 * about an answer's absence would trade a loud failure for a silent wrong one.
 *
 * `usage` itself is nullish for the same reason: a streaming-oriented or
 * cut-down server may omit the block entirely, and a missing token count is not
 * a reason to throw away a good answer. Absent counts read as 0 — see below.
 */
const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().nullish(),
      completion_tokens: z.number().int().nonnegative().nullish(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().nullish() })
        .nullish(),
    })
    .nullish(),
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
    /**
     * The address is taken from the CALL, not from the config, when the caller
     * supplied one — that is what lets a model added in the panel be dialled
     * without rebuilding the port. `this.cfg.baseUrl` remains the answer for a
     * deployment that still names its endpoint in the environment, so nothing
     * that used to work stops working.
     */
    const baseUrl = call.baseUrl ?? this.cfg.baseUrl;
    const apiKey = await this.deps.secrets.get(call.credentialRef ?? this.cfg.apiKeyRef);
    const messages = [
      ...(call.system === null ? [] : [{ role: "system", content: call.system }]),
      { role: "user", content: call.prompt },
    ];

    const json = await postJson(
      {
        driver: this.id,
        url: `${trimSlash(baseUrl)}/v1/chat/completions`,
        /**
         * An empty key means this server wants none. Sending a bare `Bearer `
         * with nothing after it makes some self-hosted servers 401 a request
         * that would otherwise have succeeded, so the header is omitted
         * entirely — the same rule the panel's `/v1/models` probe follows, so
         * the test and the run present identical credentials.
         */
        headers: {
          ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }),
          accept: "application/json",
        },
        body: { model: call.model, max_tokens: call.maxTokens, temperature: call.temperature, messages },
        timeoutMs: this.cfg.timeoutMs,
        // The row's explicit switch; `postJson` layers the internal-address
        // auto rule on top — the same pair the panel's probe applies, so the
        // run's handshake is the one the green test proved.
        skipTlsVerify: call.skipTlsVerify === true,
      },
      { deps: this.deps, bucket: this.deps.bucket, retry: this.deps.retry, counter: call.counter },
    );

    const parsed = ChatResponse.safeParse(json);
    if (!parsed.success) {
      throw new LlmResponseError(this.id, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    const text = parsed.data.choices[0]?.message.content ?? "";
    if (text.trim().length === 0) throw new LlmResponseError(this.id, ["first choice carries no content"]);

    /**
     * Absent counts read as 0, and an absent cache statistic as "unknown".
     *
     * A server that does not report usage is not a server that used no tokens,
     * so 0 is a lie — but it is the lie the quota ledger already tells for every
     * other driver that cannot count, and inventing a number would be worse.
     * `cachePct` stays `null` rather than 0: nobody cached anything is a claim,
     * and this response does not support it.
     */
    const usage = parsed.data.usage;
    const tokensIn = usage?.prompt_tokens ?? 0;
    const cached = usage?.prompt_tokens_details?.cached_tokens;
    return {
      text,
      tokensIn,
      tokensOut: usage?.completion_tokens ?? 0,
      cachePct:
        cached === undefined || cached === null || tokensIn === 0
          ? null
          : Math.round((cached / tokensIn) * 10_000) / 100,
    };
  }
}
