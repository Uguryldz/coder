/**
 * Message KEYS only (M104) — no user-facing text is embedded in this package.
 * `run.queued_quota` / `notify.quota_wait` already exist in packages/config/locales;
 * the `llm.*` keys are requested in RAPOR.md (tr+en proposal) and must be added
 * to the catalog before any surface translates them.
 */
export const MSG_QUEUED_QUOTA = "run.queued_quota";
export const MSG_DEGRADED_AI_ASSIST = "llm.degraded_ai_assist";
export const MSG_BLOCKED_CONFIDENTIAL = "llm.blocked_confidential";
