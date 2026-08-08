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

/**
 * M20/M82: on a masked route the returned value stays MASKED — that is the copy
 * an artifact store or a journal may keep — and `unmask` is the only way back
 * to the real values, for a surface that is showing them to a human right now.
 * It is absent when nothing was masked.
 */
export interface Unmaskable {
  unmask?: <R>(value: R) => R;
}

export type ObjectOutcome<T> =
  | ({ status: "ok"; object: T; log: LlmCallLog } & Unmaskable)
  | QueuedOutcome
  | DegradedOutcome;
export type SessionOutcome = ({ status: "ok" } & AgentSessionResult & Unmaskable) | QueuedOutcome | DegradedOutcome;

/** The frozen `LlmPort` methods have no place for these states — see RAPOR.md request #1. */
export function asError(outcome: QueuedOutcome | DegradedOutcome): Error {
  return outcome.status === "queued"
    ? new SubscriptionQueuedError(outcome.resumeAt, outcome.messageKey)
    : new LlmPolicyBlockedError(outcome.dataClass, outcome.messageKey);
}
