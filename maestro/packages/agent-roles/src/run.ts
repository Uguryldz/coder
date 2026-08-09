import type { z } from "zod";
import type { DataClass, LlmCallLog, LlmRole } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { RoleOutputError } from "./errors.js";
import { buildRepairPrompt } from "./prompt.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts } from "./texts.js";
import type { Validation } from "./validate.js";

/**
 * Result of a thinking-role call.
 *
 * The three non-ok states are re-exposed unchanged from `LlmOutcome` on
 * purpose: a queued quota (M55), a data class no backend may see (M18/M97) and
 * a policy block are workflow decisions, not this package's business. Swallowing
 * them into an error here would turn "wait sixteen minutes" into "the run
 * failed".
 */
export type RoleResult<T> =
  | { status: "ok"; value: T; attempts: number; logs: LlmCallLog[] }
  | { status: "queued"; resumeAt: string; reason: "subscription_quota" }
  | { status: "degraded"; messageKey: string; dataClass: DataClass }
  | { status: "blocked"; messageKey: string; dataClass: DataClass };

export interface RoleCall<T> {
  llm: LlmPort;
  role: LlmRole;
  variantId: string;
  dataClass: DataClass;
  schemaName: string;
  schema: z.ZodType<T>;
  prompt: string;
  /**
   * The only gate that counts. It re-validates the SHAPE against the same
   * generated schema and then the semantics on top of it, so a port that
   * skipped validation, a stale fixture or a hand-fed document is refused here
   * too — this package never trusts its caller's parsing (M43).
   */
  check: (value: unknown) => Validation<T>;
  texts?: PromptTexts;
}

/**
 * One call, at most one repair round, then an error (M43).
 *
 * The repair prompt carries the CONCRETE deficiency list rather than "try
 * again": a model told what is missing fixes it, a model told to retry
 * rewrites the same document. A second deficient answer is a hard failure —
 * there is no third attempt and no partially valid document is ever returned.
 */
export async function runRole<T>(call: RoleCall<T>): Promise<RoleResult<T>> {
  const texts = call.texts ?? DEFAULT_PROMPT_TEXTS;
  const first = await generate(call, call.prompt);
  if (first.status !== "ok") return first;

  const firstCheck = call.check(first.value);
  if (firstCheck.ok) {
    return { status: "ok", value: firstCheck.value, attempts: 1, logs: [first.log] };
  }

  const repairPrompt = buildRepairPrompt(call.prompt, first.value, firstCheck.deficiencies, texts);
  const second = await generate(call, repairPrompt);
  if (second.status !== "ok") return second;

  const secondCheck = call.check(second.value);
  if (secondCheck.ok) {
    return { status: "ok", value: secondCheck.value, attempts: 2, logs: [first.log, second.log] };
  }
  throw new RoleOutputError(
    call.role,
    2,
    secondCheck.deficiencies.map((d) => d.message),
  );
}

type Generated<T> =
  | { status: "ok"; value: unknown; log: LlmCallLog }
  | Exclude<RoleResult<T>, { status: "ok" }>;

async function generate<T>(call: RoleCall<T>, prompt: string): Promise<Generated<T>> {
  const outcome = await call.llm.generateObject<T>(
    {
      role: call.role,
      variantId: call.variantId,
      dataClass: call.dataClass,
      schemaName: call.schemaName,
      input: prompt,
    },
    call.schema,
  );

  switch (outcome.status) {
    case "ok":
      // Handed to `check` unparsed on purpose: a shape miss must become a
      // repairable deficiency list, not an exception thrown mid-flight.
      return { status: "ok", value: outcome.value, log: outcome.log };
    case "queued":
      return { status: "queued", resumeAt: outcome.resumeAt, reason: outcome.reason };
    case "degraded":
      return { status: "degraded", messageKey: outcome.messageKey, dataClass: outcome.dataClass };
    case "blocked":
      return { status: "blocked", messageKey: outcome.messageKey, dataClass: outcome.dataClass };
  }
}
