import type { GateDecision } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { escalateGate, handOverToHuman, journal, openGate, recordGateDecision } from "../src/impl/gate.js";
import { makeFakes } from "./fakes.js";

const decision = (over: Partial<GateDecision> = {}): GateDecision =>
  ({
    step: "5",
    decision: "approve",
    actorUserId: "mert@bank",
    actorGroup: "tech-leads",
    sodVerified: true,
    signatureSeq: 3,
    source: "jira",
    at: "2026-08-09T12:00:00+03:00",
    ...over,
  }) as GateDecision;

describe("openGate", () => {
  it("records, audits, comments and notifies the owning group", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");

    expect((await fakes.gateStore.get("run-pay-101-0001", "5"))?.ownerGroup).toBe("tech-leads");
    expect(fakes.recorded.comments).toHaveLength(1);
    expect(fakes.recorded.notifications[0]?.event).toBe("gate_open");
    expect(fakes.recorded.notifications[0]?.to).toEqual(["tech-leads@bank"]);
    expect((await fakes.chain.verify()).checked).toBe(1);
  });

  it("a retry does not move the anchor the escalation ladder measures from", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    const first = await fakes.gateStore.get("run-pay-101-0001", "5");
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");

    expect((await fakes.gateStore.get("run-pay-101-0001", "5"))?.openedAt).toBe(first?.openedAt);
    expect(fakes.recorded.comments).toHaveLength(1);
    expect(fakes.recorded.notifications).toHaveLength(1);
  });
});

describe("recordGateDecision", () => {
  it("records the approval against the HUMAN who signed it (M32/M101)", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    await recordGateDecision(fakes.deps, "PAY-101", decision());

    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
    expect((await fakes.gateStore.get("run-pay-101-0001", "5"))?.closedAt).toBe(
      "2026-08-09T12:00:00+03:00",
    );
  });

  it("refuses a decision whose author the directory does not know", async () => {
    const fakes = makeFakes({ verifyMembership: false });
    await expect(recordGateDecision(fakes.deps, "PAY-101", decision())).rejects.toMatchObject({
      type: "GateAuthorityRejected",
      nonRetryable: true,
    });
  });

  it("refuses a group that does not own the gate, even if the person exists", async () => {
    const fakes = makeFakes();
    await expect(
      recordGateDecision(fakes.deps, "PAY-101", decision({ actorGroup: "product-owners" })),
    ).rejects.toMatchObject({ type: "GateAuthorityRejected" });
  });

  it("is idempotent: a retry does not fork the audit chain", async () => {
    const fakes = makeFakes();
    await recordGateDecision(fakes.deps, "PAY-101", decision());
    await recordGateDecision(fakes.deps, "PAY-101", decision());
    expect((await fakes.chain.verify()).checked).toBe(1);
  });
});

describe("escalateGate (M88)", () => {
  it("fires nothing before the ladder's first step is due", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    const next = await escalateGate(fakes.deps, "PAY-101", "5", 1);

    expect(fakes.recorded.notifications.filter((n) => n.event !== "gate_open")).toEqual([]);
    expect(next).not.toBeNull();
  });

  it("fires each ladder step exactly once, however many ticks pass", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    for (const hour of [24, 25, 30, 72, 100, 168, 200]) {
      await escalateGate(fakes.deps, "PAY-101", "5", hour);
    }
    const fired = fakes.recorded.notifications.filter((n) => n.event !== "gate_open");
    // Three ladder steps, three notifications — the extra ticks changed nothing.
    expect(fired.map((n) => n.messageKey)).toEqual([
      "notify.gate_reminder",
      "notify.escalation",
      "notify.delegated",
    ]);
  });

  it("hands a `delegate` step to the deputy, without closing the gate", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    await escalateGate(fakes.deps, "PAY-101", "5", 168);

    const delegated = fakes.recorded.notifications.find((n) => n.messageKey === "notify.delegated");
    expect(delegated?.to).toEqual(["tech-leads-deputy@bank"]);
    expect((await fakes.gateStore.get("run-pay-101-0001", "5"))?.closedAt).toBeNull();
  });

  it("stops reminding once the gate is closed", async () => {
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    await recordGateDecision(fakes.deps, "PAY-101", decision());
    expect(await escalateGate(fakes.deps, "PAY-101", "5", 240)).toBeNull();
    expect(fakes.recorded.notifications.filter((n) => n.event !== "gate_open")).toEqual([]);
  });

  it("measures from the gate's own anchor, not from the activity's clock", async () => {
    // The activity's `now` is fixed at 09:00; a 30-hour wait must still be
    // 30 hours, because it is the WORKFLOW that counted them.
    const fakes = makeFakes();
    await openGate(fakes.deps, "PAY-101", "5", "tech-leads");
    await escalateGate(fakes.deps, "PAY-101", "5", 30);
    expect(fakes.recorded.notifications.some((n) => n.event === "gate_reminder")).toBe(true);
  });
});

describe("journal and handover", () => {
  it("an unknown journal kind falls back to `other` instead of failing the step", async () => {
    const fakes = makeFakes();
    await journal(fakes.deps, "PAY-101", "not-a-kind", "adım 6a", "geliştirme turu 1");
    expect(fakes.journalStore.entries.at(-1)?.kind).toBe("other");
  });

  it("a gate entry also reaches the ticket, where the humans are (M61)", async () => {
    const fakes = makeFakes();
    await journal(fakes.deps, "PAY-101", "gate", "karar reddedildi", "mert@bank · wrong_group");
    expect(fakes.recorded.comments).toHaveLength(1);
    expect(String(fakes.recorded.comments[0]?.body)).toContain("wrong_group");
  });

  it("a step transition does not spam the ticket", async () => {
    const fakes = makeFakes();
    await journal(fakes.deps, "PAY-101", "other", "adım 7", "test senaryoları");
    expect(fakes.recorded.comments).toEqual([]);
  });

  it("a handover drops the mode, records it and tells a human", async () => {
    const fakes = makeFakes();
    await handOverToHuman(fakes.deps, "PAY-101", "3 tur ilerleme yok (M54)");

    expect(fakes.patches).toContainEqual({ mode: "ai_assist" });
    expect(fakes.recorded.notifications[0]?.event).toBe("handover");
    expect(fakes.journalStore.entries.at(-1)?.kind).toBe("handover");
    expect((await fakes.chain.verify()).checked).toBe(1);
  });
});
