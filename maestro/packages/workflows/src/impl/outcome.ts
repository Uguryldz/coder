import type { LlmOutcome } from "@maestro/ports";
import { ApplicationFailure } from "@temporalio/common";
import type { ActivityDeps, RunContext } from "./deps.js";
import { audit, notifyEvent, record } from "./record.js";

/**
 * The four ends of an LLM call (M18/M55/M97), turned into the two things an
 * activity can do: return a value, or stop.
 *
 * `queued` and `blocked` both stop the activity, and it matters enormously
 * which one: a quota wait is a RETRYABLE failure, so Temporal holds the run
 * and comes back when the window opens — no work is lost and no human is
 * disturbed. A policy block is NON-retryable, because retrying a decision the
 * compliance policy already made just burns the retry budget.
 */

export const QUOTA_WAIT = "LlmQuotaWait";
export const LLM_BLOCKED = "LlmBlocked";

export type Resolved<T> =
  | { readonly status: "ok"; readonly value: T }
  /** M18 `degrade_ai_assist`: the flow continues, human-led (M97). */
  | { readonly status: "degraded"; readonly messageKey: string };

/**
 * Wait for a quota window (M55). Retryable on purpose, with the delay the
 * gateway itself named: the run sits in Temporal, costs nothing, and resumes
 * on its own.
 */
export function quotaWait(resumeAt: string, now: Date): ApplicationFailure {
  const delayMs = Math.max(0, new Date(resumeAt).getTime() - now.getTime());
  return ApplicationFailure.create({
    message: `LLM quota exhausted; retry after ${resumeAt}`,
    type: QUOTA_WAIT,
    nonRetryable: false,
    nextRetryDelay: delayMs,
  });
}

/**
 * Branch on the outcome of one thinking-role call and leave the right trace.
 *
 * The exhaustive switch is the point: `LlmOutcome` adding a fifth state must
 * break compilation here rather than fall through to "treat it as ok".
 */
export async function resolveOutcome<T>(
  deps: ActivityDeps,
  run: RunContext,
  what: string,
  outcome: LlmOutcome<T>,
): Promise<Resolved<T>> {
  switch (outcome.status) {
    case "ok":
      return { status: "ok", value: outcome.value };

    case "queued": {
      await record(deps, run, {
        kind: "quota",
        title: "LLM kotası doldu",
        detail: `${what} · ${outcome.reason} · ${outcome.resumeAt}`,
        key: `quota:${what}:${outcome.resumeAt}`,
      });
      await audit(deps, run, {
        action: "QUOTA_WARN",
        meta: { what, resumeAt: outcome.resumeAt },
        key: `quota:${what}:${outcome.resumeAt}`,
      });
      throw quotaWait(outcome.resumeAt, deps.now());
    }

    case "degraded": {
      // M18/M97: no permitted backend may see this data class, so the work
      // still happens — a human does it, in ai-assist mode.
      await deps.runs.patch(run.ticket, { mode: "ai_assist" });
      await record(deps, run, {
        kind: "other",
        title: "ai_assist moduna düşüldü",
        detail: `${what} · ${outcome.messageKey} · ${outcome.dataClass}`,
        key: `degrade:${what}`,
      });
      await audit(deps, run, {
        action: "MODE_CHANGED",
        meta: { what, to: "ai_assist", messageKey: outcome.messageKey },
        key: `degrade:${what}`,
      });
      return { status: "degraded", messageKey: outcome.messageKey };
    }

    case "blocked": {
      // M18 `block`: there is no ai-assist fallback. A human takes the ticket
      // and the compliance decision is on the record before the activity dies.
      await handOver(deps, run, `${what}: ${outcome.messageKey}`, `blocked:${what}`);
      throw ApplicationFailure.create({
        message: `LLM policy blocked ${what}: ${outcome.messageKey}`,
        type: LLM_BLOCKED,
        nonRetryable: true,
      });
    }
  }
}

/**
 * Hand the ticket to a human, with everything they need to continue: the
 * journal entry, the audit record and the notification. Shared by the blocked
 * branch above, by M52/M54 handovers and by the workflow's own `handOverToHuman`.
 */
export async function handOver(
  deps: ActivityDeps,
  run: RunContext,
  reason: string,
  key: string,
): Promise<void> {
  await deps.runs.patch(run.ticket, { mode: "ai_assist" });
  await record(deps, run, {
    kind: "handover",
    title: "insana devredildi",
    detail: reason,
    key: `handover:${key}`,
  });
  await audit(deps, run, { action: "HANDOVER", meta: { reason }, key: `handover:${key}` });
  await notifyEvent(deps, run, {
    event: "handover",
    messageKey: "notify.handover",
    params: { ticket: run.ticket, reason },
    to: await deps.directory.membersOf("tech-leads"),
    key: `handover:${key}`,
  });
}
