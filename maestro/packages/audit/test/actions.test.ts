import { AuditAction } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_INFO, actionInfo } from "../src/index.js";

describe("AuditAction → SIEM metadata table", () => {
  it("covers every contract action and nothing else", () => {
    // The Record type makes a missing action a compile error; this guards the
    // other direction — a stale entry for an action that no longer exists.
    expect(Object.keys(AUDIT_ACTION_INFO).sort()).toEqual([...AuditAction.options].sort());
  });

  it("gives every action a CEF severity in range and a human-readable name", () => {
    for (const action of AuditAction.options) {
      const info = actionInfo(action);
      expect(Number.isInteger(info.severity), action).toBe(true);
      expect(info.severity, action).toBeGreaterThanOrEqual(0);
      expect(info.severity, action).toBeLessThanOrEqual(10);
      expect(info.name.length, action).toBeGreaterThan(3);
      expect(info.name, action).not.toBe(action);
    }
  });

  it("ranks the actions an operator must never miss above the routine ones", () => {
    expect(actionInfo("KILL_SWITCH").severity).toBe(10);
    expect(actionInfo("SECURITY_SCAN_FAIL").severity).toBeGreaterThan(actionInfo("SECURITY_SCAN_PASS").severity);
    expect(actionInfo("PARAM_CHANGED").severity).toBeGreaterThan(actionInfo("RUN_STARTED").severity);
    expect(actionInfo("BINDING_CHANGED").severity).toBeGreaterThan(actionInfo("RUN_STARTED").severity);
  });

  it("marks exactly the gate decisions as human-only (M32/M101)", () => {
    const humanOnly = AuditAction.options.filter((action) => AUDIT_ACTION_INFO[action].humanOnly);
    // Three verdicts, not two: `GATE_RETURN` ("eksik var, bir daha bak") is a
    // decision a named person takes at a gate, so the AI may no more write one
    // than it may write an approval.
    expect(humanOnly).toEqual(["GATE_APPROVE", "GATE_REJECT", "GATE_RETURN"]);
  });

  it("states an outcome only where the action itself is a verdict", () => {
    const withOutcome = AuditAction.options.filter((action) => AUDIT_ACTION_INFO[action].outcome);
    expect(withOutcome).toEqual([
      "GATE_APPROVE",
      "GATE_REJECT",
      "GATE_RETURN",
      "SECURITY_SCAN_PASS",
      "SECURITY_SCAN_FAIL",
    ]);
  });

  it("grades a return as a success, not a failure — it is a review turn, not a refusal", () => {
    // The whole reason `GATE_RETURN` is a third action rather than a flavour of
    // `GATE_REJECT`: every governance surface that counts by outcome would
    // otherwise read a healthy review loop as a troubled one, and an auditor
    // asking "how many times was this rejected" would be handed the routine
    // turns as refusals.
    expect(AUDIT_ACTION_INFO.GATE_RETURN.outcome).toBe("success");
    expect(AUDIT_ACTION_INFO.GATE_REJECT.outcome).toBe("failure");
    expect(AUDIT_ACTION_INFO.GATE_RETURN.severity).toBeLessThan(AUDIT_ACTION_INFO.GATE_REJECT.severity);
  });
});
