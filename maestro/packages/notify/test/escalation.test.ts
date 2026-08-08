import { describe, expect, it } from "vitest";
import { NotifyRecipientError } from "../src/errors.js";
import {
  DEFAULT_LADDER,
  EscalationLadder,
  escalationDueAt,
  planEscalation,
  resolveSteps,
} from "../src/escalation.js";

const OPENED = "2026-08-03T09:00:00+03:00"; // Monday 09:00 Istanbul
const plus = (hours: number): string => new Date(Date.parse(OPENED) + hours * 3_600_000).toISOString();

describe("escalation ladder (M88)", () => {
  it("defaults to 24h Jira → 72h Teams+e-mail → 7d delegation", () => {
    expect(
      DEFAULT_LADDER.steps.map((step) => [step.afterHours, step.channel, step.action]),
    ).toEqual([
      [24, "jira", "notify"],
      [72, "teams", "notify"],
      [72, "smtp", "notify"],
      [168, "teams", "delegate"],
    ]);
  });

  it("parses the persisted `escalation.ladder` parameter shape unchanged", () => {
    const stored = {
      steps: [
        { afterHours: 24, channel: "jira", event: "gate_reminder" },
        { afterHours: 72, channel: "teams", event: "escalation" },
        { afterHours: 168, channel: "smtp", event: "escalation" },
      ],
      businessHoursOnly: false,
    };
    expect(() => EscalationLadder.parse(stored)).not.toThrow();
  });

  it("fires nothing before the first threshold", () => {
    const decision = escalationDueAt(DEFAULT_LADDER, { openedAt: OPENED, now: plus(23.9) });
    expect(decision.due).toEqual([]);
    expect(decision.next?.step.channel).toBe("jira");
    expect(decision.next?.dueAt).toBe(new Date(plus(24)).toISOString());
  });

  it("fires exactly the crossed steps at t", () => {
    const at72 = escalationDueAt(DEFAULT_LADDER, { openedAt: OPENED, now: plus(72) });
    expect(at72.due.map((step) => step.stepId)).toEqual([
      "24h.jira.gate_reminder.notify",
      "72h.teams.escalation.notify",
      "72h.smtp.escalation.notify",
    ]);
    expect(at72.next?.step.action).toBe("delegate");
  });

  it("never fires a step twice", () => {
    const fired = ["24h.jira.gate_reminder.notify", "72h.teams.escalation.notify"];
    const decision = escalationDueAt(DEFAULT_LADDER, { openedAt: OPENED, now: plus(100), firedStepIds: fired });
    expect(decision.due.map((step) => step.stepId)).toEqual(["72h.smtp.escalation.notify"]);
  });

  it("is deterministic: the same arguments give the same answer", () => {
    const query = { openedAt: OPENED, now: plus(80), firedStepIds: ["24h.jira.gate_reminder.notify"] };
    expect(escalationDueAt(DEFAULT_LADDER, query)).toEqual(escalationDueAt(DEFAULT_LADDER, query));
  });

  it("gives distinct ids to two identical steps", () => {
    const ladder = EscalationLadder.parse({
      steps: [
        { afterHours: 24, channel: "teams", event: "escalation" },
        { afterHours: 24, channel: "teams", event: "escalation" },
      ],
    });
    const ids = resolveSteps(ladder).map((step) => step.stepId);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps ids stable when a step is inserted at the top", () => {
    const grown = EscalationLadder.parse({
      steps: [{ afterHours: 1, channel: "slack", event: "gate_reminder" }, ...DEFAULT_LADDER.steps],
    });
    expect(resolveSteps(grown).map((step) => step.stepId)).toContain("24h.jira.gate_reminder.notify");
  });

  it("counts business hours only when the parameter says so", () => {
    // Friday 17:00 + 24 wall-clock hours is Saturday: nothing is due yet in
    // business mode, while wall-clock mode fires the 24h step.
    const friday = "2026-08-07T17:00:00+03:00";
    const saturday = "2026-08-08T17:00:00+03:00";
    const business = EscalationLadder.parse({ ...DEFAULT_LADDER, businessHoursOnly: true });
    expect(escalationDueAt(business, { openedAt: friday, now: saturday }).due).toEqual([]);
    expect(escalationDueAt(DEFAULT_LADDER, { openedAt: friday, now: saturday }).due).toHaveLength(1);
  });

  it("reports the next due instant on the business calendar", () => {
    const business = EscalationLadder.parse({
      steps: [{ afterHours: 4, channel: "jira", event: "gate_reminder" }],
      businessHoursOnly: true,
    });
    const decision = escalationDueAt(business, {
      openedAt: "2026-08-07T17:00:00+03:00", // Friday 17:00 -> 1h left that day
      now: "2026-08-07T18:00:00+03:00",
    });
    expect(decision.next?.dueAt).toBe("2026-08-10T09:00:00.000Z"); // Monday 12:00 Istanbul
  });

  it("rejects a `now` that precedes the anchor", () => {
    expect(() => escalationDueAt(DEFAULT_LADDER, { openedAt: OPENED, now: plus(-1) })).toThrow(/before openedAt/);
  });

  it("rejects a ladder with no steps", () => {
    expect(() => EscalationLadder.parse({ steps: [] })).toThrow();
  });
});

describe("escalation plan (M88 + M104)", () => {
  const ctx = {
    openedAt: OPENED,
    now: plus(72),
    locale: "tr" as const,
    params: { ticket: "UGURPAY-501", gate: "5", days: "3" },
    recipients: () => ["ops"],
  };

  it("emits one notification per due step, with catalog keys and no text", () => {
    const plan = planEscalation(DEFAULT_LADDER, ctx);
    expect(plan.notifications.map((notification) => [notification.channel, notification.messageKey])).toEqual([
      ["jira", "notify.gate_reminder"],
      ["teams", "notify.escalation"],
      ["smtp", "notify.escalation"],
    ]);
    expect(plan.notifications[0]?.at).toBe(ctx.now);
    expect(plan.notifications[0]?.to).toEqual(["ops"]);
  });

  it("honours a per-step audience and message key", () => {
    const ladder = EscalationLadder.parse({
      steps: [
        {
          afterHours: 1,
          channel: "smtp",
          event: "handover",
          to: ["deputy@bank.local"],
          messageKey: "notify.handover",
        },
      ],
    });
    const plan = planEscalation(ladder, { ...ctx, params: { ticket: "UGURPAY-501", reason: "timeout" } });
    expect(plan.notifications[0]?.to).toEqual(["deputy@bank.local"]);
    expect(plan.notifications[0]?.messageKey).toBe("notify.handover");
  });

  it("lists the delegation steps so the caller reassigns the gate", () => {
    const plan = planEscalation(DEFAULT_LADDER, { ...ctx, now: plus(168) });
    expect(plan.delegations.map((step) => step.stepId)).toEqual(["168h.teams.escalation.delegate"]);
  });

  it("refuses a step that resolves to nobody", () => {
    expect(() => planEscalation(DEFAULT_LADDER, { ...ctx, recipients: () => [] })).toThrow(NotifyRecipientError);
  });
});
