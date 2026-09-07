/**
 * The NAMED, non-retryable ways an activity ends a run on purpose. Declared
 * here, in a module with no Node imports, because the workflow bundle must
 * read them too: the workflow catches these and hands the ticket to a human
 * instead of letting the execution FAIL — a failed execution shows "hatalı"
 * in Studio with no sentence under it (the engine's failure record never
 * reaches the BFF), while a hand-over writes its reason into the journal.
 */
export const AI_ASSIST_REQUIRED = "AiAssistRequired";
export const LLM_BLOCKED = "LlmBlocked";
export const LLM_AUTH_REJECTED = "LlmAuthRejected";
export const LLM_SCHEMA_UNMET = "LlmSchemaUnmet";

export const HANDOVER_FAILURE_TYPES: ReadonlySet<string> = new Set([
  AI_ASSIST_REQUIRED,
  LLM_BLOCKED,
  LLM_AUTH_REJECTED,
  LLM_SCHEMA_UNMET,
]);

/**
 * The reason a caught activity error asks for a hand-over, or `null` when the
 * error is something else (which must keep propagating). Duck-typed on
 * purpose: inside the workflow sandbox an activity error arrives as an
 * `ActivityFailure` whose `cause` is the `ApplicationFailure` the activity
 * threw, and the same shape is what a test can build from plain objects.
 */
export function handoverReasonOf(error: unknown): string | null {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (typeof node === "object" && node !== null && !seen.has(node)) {
    seen.add(node);
    const record = node as { type?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.type === "string" && HANDOVER_FAILURE_TYPES.has(record.type)) {
      const message = typeof record.message === "string" ? record.message.trim() : "";
      return message === "" ? record.type : message;
    }
    node = record.cause;
  }
  return null;
}
