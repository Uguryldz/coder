import { type Locale, NonEmpty, type Notification, NotifyChannel, NotifyEventKey } from "@maestro/contracts";
import { z } from "zod";
import { BusinessCalendar, addWorkingMinutes, workingMinutesBetween } from "./calendar.js";
import { NotifyConfigError, NotifyRecipientError } from "./errors.js";

/**
 * Escalation ladder (M88) — FULLY parametric: the steps, their delays, their
 * channels, the message keys, the recipients and the working calendar all come
 * from the `escalation.ladder` parameter in the DB (M71). The default below is
 * the plain "24h Jira → 72h Teams+e-mail → 7d delegate to the deputy", and it
 * is a default, not a rule: nothing here special-cases 24, 72 or 168.
 *
 * The schema is a superset of the persisted parameter shape
 * (`{ steps: [{ afterHours, channel, event }], businessHoursOnly }`), so the
 * stored value from `@maestro/db` parses unchanged.
 */
export const EscalationAction = z.enum(["notify", "delegate"]);
export type EscalationAction = z.infer<typeof EscalationAction>;

export const EscalationStep = z.object({
  /** Delay from the anchor (the moment the gate opened). Fractions allowed. */
  afterHours: z.number().positive().max(24 * 365),
  channel: NotifyChannel,
  event: NotifyEventKey,
  /** Stable id; derived from the content when absent. */
  id: NonEmpty.optional(),
  /** Catalog key (M104); defaults to `notify.<event>`. */
  messageKey: NonEmpty.optional(),
  /** Fixed audience for this step; otherwise the caller resolves it. */
  to: z.array(NonEmpty).min(1).optional(),
  /** "delegate" = hand the gate to the deputy; the caller performs it. */
  action: EscalationAction.default("notify"),
});
export type EscalationStep = z.infer<typeof EscalationStep>;

export const EscalationLadder = z.object({
  steps: z.array(EscalationStep).min(1),
  /** false = wall-clock hours; true = the calendar below applies. */
  businessHoursOnly: z.boolean().default(false),
  calendar: BusinessCalendar.prefault({}),
});
export type EscalationLadder = z.infer<typeof EscalationLadder>;

/** The M88 default, kept in one place so Studio can seed it. */
export const DEFAULT_LADDER: EscalationLadder = EscalationLadder.parse({
  steps: [
    { afterHours: 24, channel: "jira", event: "gate_reminder" },
    { afterHours: 72, channel: "teams", event: "escalation" },
    { afterHours: 72, channel: "smtp", event: "escalation" },
    { afterHours: 168, channel: "teams", event: "escalation", action: "delegate" },
  ],
  businessHoursOnly: false,
});

export interface ResolvedStep extends EscalationStep {
  /** Unique within the ladder and stable across step insertions. */
  stepId: string;
  thresholdMinutes: number;
}

/**
 * Ids are content-derived (`24h.jira.gate_reminder`), not index-derived: a step
 * inserted at the top of the ladder in Studio must not renumber the steps that
 * already fired, or every open gate would be re-notified.
 */
export function resolveSteps(ladder: EscalationLadder): ResolvedStep[] {
  const seen = new Map<string, number>();
  return ladder.steps.map((step) => {
    const base = step.id ?? `${step.afterHours}h.${step.channel}.${step.event}.${step.action}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return {
      ...step,
      stepId: count === 1 ? base : `${base}#${count}`,
      thresholdMinutes: Math.round(step.afterHours * 60),
    };
  });
}

export interface LadderQuery {
  /** When the clock started: the gate opened, the question was asked… */
  openedAt: string;
  now: string;
  /** Steps already sent — the ladder never fires the same step twice. */
  firedStepIds?: readonly string[];
}

export interface EscalationDecision {
  /** Steps that must fire at `now`, in ladder order. */
  due: ResolvedStep[];
  /** The next step and the instant it becomes due — feeds a Temporal timer. */
  next: { step: ResolvedStep; dueAt: string } | null;
  /** Elapsed time under the ladder's own time model. */
  elapsedMinutes: number;
}

/**
 * THE pure function: "at instant `now`, which step must fire?". No I/O, no
 * ambient clock, no hidden state — the answer depends only on its arguments,
 * so a workflow replay and a unit test agree by construction.
 */
export function escalationDueAt(ladder: EscalationLadder, query: LadderQuery): EscalationDecision {
  const openedAt = parseInstant("openedAt", query.openedAt);
  const now = parseInstant("now", query.now);
  if (now < openedAt) {
    throw new NotifyConfigError(`now (${query.now}) is before openedAt (${query.openedAt})`);
  }
  const fired = new Set(query.firedStepIds ?? []);
  const elapsedMinutes = ladder.businessHoursOnly
    ? workingMinutesBetween(openedAt, now, ladder.calendar)
    : Math.floor((now - openedAt) / 60_000);

  const steps = resolveSteps(ladder);
  const due = steps.filter((step) => step.thresholdMinutes <= elapsedMinutes && !fired.has(step.stepId));
  const pending = steps
    .filter((step) => step.thresholdMinutes > elapsedMinutes && !fired.has(step.stepId))
    .sort((a, b) => a.thresholdMinutes - b.thresholdMinutes);

  const nextStep = pending[0];
  const next = nextStep
    ? { step: nextStep, dueAt: new Date(dueInstant(ladder, openedAt, nextStep.thresholdMinutes)).toISOString() }
    : null;

  return { due, next, elapsedMinutes };
}

function dueInstant(ladder: EscalationLadder, openedAt: number, thresholdMinutes: number): number {
  return ladder.businessHoursOnly
    ? addWorkingMinutes(openedAt, thresholdMinutes, ladder.calendar)
    : openedAt + thresholdMinutes * 60_000;
}

export interface EscalationContext extends LadderQuery {
  locale: Locale;
  /** Catalog parameters shared by every step ({ticket}, {gate}, {days}…). */
  params: Record<string, string>;
  /** Audience for a step without its own `to` (gate owner, deputy, ops…). */
  recipients: (step: ResolvedStep) => readonly string[];
}

export interface EscalationPlan extends EscalationDecision {
  /** One notification per due step, ready for `NotifyPort.send`. */
  notifications: Notification[];
  /** Due steps whose action is "delegate": the caller must reassign. */
  delegations: ResolvedStep[];
}

/**
 * Turns the decision into notifications. Message text stays in the catalog
 * (M104): a step contributes a KEY, never a sentence. A step that resolves to
 * no recipient throws — a notification addressed to nobody is exactly the
 * silent death this ladder exists to prevent.
 */
export function planEscalation(ladder: EscalationLadder, ctx: EscalationContext): EscalationPlan {
  const decision = escalationDueAt(ladder, ctx);
  const notifications = decision.due.map((step) => {
    const to = [...(step.to ?? ctx.recipients(step))];
    if (to.length === 0) {
      throw new NotifyRecipientError(step.channel, step.stepId, "escalation step resolved to no recipient");
    }
    return {
      event: step.event,
      channel: step.channel,
      to,
      locale: ctx.locale,
      messageKey: step.messageKey ?? `notify.${step.event}`,
      params: ctx.params,
      at: ctx.now,
    };
  });

  return {
    ...decision,
    notifications,
    delegations: decision.due.filter((step) => step.action === "delegate"),
  };
}

function parseInstant(field: string, iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new NotifyConfigError(`${field} is not an ISO-8601 instant: "${iso}"`);
  return ms;
}
