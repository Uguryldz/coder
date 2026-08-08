import type { DataClass, LlmCallLog } from "@maestro/contracts";
import type { AgentSessionResult } from "@maestro/ports";
import { LlmPolicyBlockedError, SubscriptionQueuedError } from "./errors.js";

/** M55: the pool is full — the caller waits (Temporal timer), nothing failed. */
export interface QueuedOutcome {
  status: "queued";
  resumeAt: string;
  /** i18n key (M104); the text lives in packages/config/locales. */
  messageKey: string;
}

/** M18: no permitted backend may see this data class; the run continues human-led. */
export interface DegradedOutcome {
  status: "degraded";
  dataClass: DataClass;
  messageKey: string;
}

export type ObjectOutcome<T> = { status: "ok"; object: T; log: LlmCallLog } | QueuedOutcome | DegradedOutcome;
export type SessionOutcome = ({ status: "ok" } & AgentSessionResult) | QueuedOutcome | DegradedOutcome;

/** The frozen `LlmPort` methods have no place for these states — see RAPOR.md request #1. */
export function asError(outcome: QueuedOutcome | DegradedOutcome): Error {
  return outcome.status === "queued"
    ? new SubscriptionQueuedError(outcome.resumeAt, outcome.messageKey)
    : new LlmPolicyBlockedError(outcome.dataClass, outcome.messageKey);
}
