import { AI_VIA_PREFIX, assertActor, parseActor } from "@maestro/audit";
import type { SessionRecord } from "./deps.js";

/**
 * Audit actors (M33/M101). The trail refuses anything it cannot classify, so
 * the BFF normalises here rather than at each call site: a Jira username is a
 * bare login on Data Center, and an unattributable approval is worse than none.
 */

/** The one system actor the frozen `packages/audit` contract accepts (see RAPOR). */
export const SYSTEM_ACTOR = "maestro-worker";

/** `mert.demir` + `ugurbank.local` → `mert.demir@ugurbank.local`; already-qualified names pass through. */
export function toActor(username: string, domain: string): string {
  const trimmed = username.trim();
  const actor = trimmed.includes("@") ? trimmed : `${trimmed}@${domain}`;
  assertActor(actor);
  return actor;
}

/**
 * The same normalisation, for input that arrives from OUTSIDE: the `author` on
 * a Jira webhook is whatever the instance sent, and nothing has validated it.
 *
 * `toActor` throws, which on a webhook route becomes a 500 — and Jira RETRIES a
 * 5xx delivery, so a single unparseable login turns into an endless redelivery
 * storm while the status difference leaks whether the parser accepted the name.
 * Returning `null` lets the caller answer 202 and tell the person instead.
 */
export function toActorOrNull(username: string, domain: string): string | null {
  if (typeof username !== "string") return null;
  const trimmed = username.trim();
  if (trimmed.length === 0) return null;
  const actor = trimmed.includes("@") ? trimmed : `${trimmed}@${domain}`;
  return parseActor(actor) === null ? null : actor;
}

/**
 * The actor a session writes as. An AI tool using a personal token keeps the
 * human it borrowed from in the record — "the AI did it" is never an answer an
 * auditor has to accept (M101).
 */
export function sessionActor(session: SessionRecord): string {
  return session.delegated ? `${AI_VIA_PREFIX}${session.userId}` : session.userId;
}

/**
 * Only a person acting directly may close a gate (M32/M101): maestro-mcp lists
 * pending gates but must never decide one, and the audit chain would refuse the
 * record anyway. Checked here so the refusal is an HTTP 403 with a reason
 * rather than a 500 from the trail.
 */
export function isHumanChannel(session: SessionRecord): boolean {
  return !session.delegated;
}
