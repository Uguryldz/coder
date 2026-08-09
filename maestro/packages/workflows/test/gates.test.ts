import { describe, expect, it } from "vitest";
import { STEP_IDS, type GateDecision, type StepId } from "@maestro/contracts";
import { canCloseGate, gatesFor, isApprovalGate, nextStep } from "../src/gates.js";

const base: Omit<GateDecision, "step" | "decision"> = {
  actorUserId: "ayse.kaya@bank",
  actorGroup: "tech-leads",
  sodVerified: true,
  signatureSeq: 1,
  source: "jira",
  at: "2026-08-09T10:00:00+03:00",
};

const approve = (step: StepId, over: Partial<GateDecision> = {}): GateDecision =>
  ({ ...base, step, decision: "approve", ...over }) as GateDecision;

describe("nextStep — the risk tier decides which gates exist", () => {
  it("a low-risk run never opens the PO gate", () => {
    let step: StepId = "3";
    const seen: StepId[] = [];
    for (let i = 0; i < 25; i += 1) {
      const next = nextStep(step, "dusuk");
      if (next === null) break;
      seen.push(next);
      step = next;
    }
    expect(seen).not.toContain("4");
    expect(seen).not.toContain("9");
    expect(seen).toContain("5");
    expect(seen).toContain("12");
  });

  it("a critical run opens every approval gate", () => {
    for (const gate of gatesFor("kritik")) {
      expect(isApprovalGate(gate)).toBe(true);
    }
    expect(gatesFor("kritik")).toEqual(["4", "5", "9", "11", "12"]);
  });

  it("never goes backwards and ends at the last step", () => {
    let step: StepId = "0";
    let previous = -1;
    for (;;) {
      const next = nextStep(step, "orta");
      if (next === null) break;
      const index = STEP_IDS.indexOf(next);
      expect(index).toBeGreaterThan(previous);
      previous = index;
      step = next;
    }
    expect(step).toBe(STEP_IDS[STEP_IDS.length - 1]);
  });
});

describe("canCloseGate — fail-closed on every axis", () => {
  it("accepts the right group at the right step", () => {
    expect(canCloseGate(approve("5"), "5", new Map())).toEqual({ ok: true });
  });

  it("refuses a decision aimed at another step", () => {
    expect(canCloseGate(approve("5"), "12", new Map())).toEqual({
      ok: false,
      reason: "wrong_step",
    });
  });

  it("refuses the wrong group — a PO cannot close the Tech Lead gate", () => {
    const asPo = approve("5", { actorGroup: "product-owners" });
    expect(canCloseGate(asPo, "5", new Map())).toEqual({ ok: false, reason: "wrong_group" });
  });

  it("refuses an approval that never passed SoD verification", () => {
    const unverified = approve("5", { sodVerified: false });
    expect(canCloseGate(unverified, "5", new Map())).toEqual({ ok: false, reason: "not_verified" });
  });

  it("enforces four eyes: the step-4 approver cannot also sign step 5 (M32)", () => {
    const previous = new Map<StepId, string>([["4", "ayse.kaya@bank"]]);
    expect(canCloseGate(approve("5"), "5", previous)).toEqual({
      ok: false,
      reason: "sod_violation",
    });
    const other = approve("5", { actorUserId: "mert.demir@bank" });
    expect(canCloseGate(other, "5", previous)).toEqual({ ok: true });
  });

  it("enforces the QA split when it applies (M92)", () => {
    const previous = new Map<StepId, string>([["9", "deniz@bank"]]);
    const same = approve("11", { actorGroup: "qa", actorUserId: "deniz@bank" });
    expect(canCloseGate(same, "11", previous)).toEqual({ ok: false, reason: "sod_violation" });
  });

  // Stopping the flow needs no authority; letting it through does.
  it("lets any rejection close the gate, even an unverified one", () => {
    const reject: GateDecision = {
      ...base,
      step: "5",
      decision: "reject",
      reason: "kapsam yanlış",
      sodVerified: false,
      actorGroup: "someone-else",
    } as GateDecision;
    expect(canCloseGate(reject, "5", new Map())).toEqual({ ok: true });
  });
});
