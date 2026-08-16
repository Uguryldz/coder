import { describe, expect, it } from "vitest";
import { flowDecisionFor, ruleFor, rulesFor, type ClassifiableTicket } from "../src/flow-decision.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";

/**
 * Per-ticket flow selection.
 *
 * The point of this module is that TWO TICKETS IN ONE PROJECT can run different
 * flows — the thing `flowOf(env)` could not express, because it read the flow
 * off the process environment and so bound the whole deployment to one answer.
 */

function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "OPS",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    ...over,
  };
}

function ticket(over: Partial<ClassifiableTicket> = {}): ClassifiableTicket {
  return { projectKey: "OPS", status: null, issueType: null, assignee: null, ...over };
}

describe("flowDecisionFor — two tickets, one project, different flows", () => {
  // The headline behaviour. Both rules live in project OPS and both are
  // enabled; only the ticket differs.
  const rules = [
    rule({ ruleId: "lr_bug", matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    rule({ ruleId: "lr_analysis", matchKind: "issuetype", matchValue: "Analiz", flowType: "analiz", priority: 20 }),
  ];

  it("routes a 'Hata' ticket to the engineering fix flow", () => {
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    expect(decision).toEqual({ flow: "duzeltme", reason: "rule", ruleId: "lr_bug" });
  });

  it("routes an 'Analiz' ticket in the SAME project to the analysis flow", () => {
    const decision = flowDecisionFor(rules, ticket({ issueType: "Analiz" }), null);
    expect(decision).toEqual({ flow: "analiz", reason: "rule", ruleId: "lr_analysis" });
  });

  it("gives the two tickets genuinely different flows", () => {
    const bug = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    const analysis = flowDecisionFor(rules, ticket({ issueType: "Analiz" }), null);
    expect(bug.flow).not.toBe(analysis.flow);
  });

  it("matches on status as well as issue type", () => {
    const statusRules = [
      rule({ ruleId: "lr_todo", matchKind: "status", matchValue: "Yapılacak", flowType: "gelistirme" }),
    ];
    expect(flowDecisionFor(statusRules, ticket({ status: "Yapılacak" }), null).flow).toBe("gelistirme");
  });
});

describe("flowDecisionFor — fall back to the deployment default", () => {
  it("uses the deployment default when NO rule matches", () => {
    const decision = flowDecisionFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }), "analiz");
    expect(decision).toEqual({ flow: "analiz", reason: "default" });
  });

  it("uses the deployment default when there are no rules at all", () => {
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), "analiz")).toEqual({
      flow: "analiz",
      reason: "default",
    });
  });

  it("leaves the flow UNSET when no rule matches and the deployment names no default", () => {
    // `null` flow means the engine's own full-pipeline default (`planFor`).
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), null)).toEqual({ flow: null, reason: "none" });
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), undefined)).toEqual({ flow: null, reason: "none" });
  });

  it("lets a matching rule OVERRIDE the deployment default", () => {
    // The whole point: an `analiz` deployment can still run a fix ticket.
    const decision = flowDecisionFor([rule({ flowType: "duzeltme" })], ticket({ issueType: "Hata" }), "analiz");
    expect(decision.flow).toBe("duzeltme");
    expect(decision.reason).toBe("rule");
  });
});

describe("flowDecisionFor — what does NOT match", () => {
  it("ignores a rule belonging to another project", () => {
    const other = [rule({ projectKey: "PAY", flowType: "duzeltme" })];
    expect(flowDecisionFor(other, ticket({ projectKey: "OPS", issueType: "Hata" }), "analiz").reason).toBe("default");
  });

  it("ignores a disabled rule", () => {
    const off = [rule({ enabled: false, flowType: "duzeltme" })];
    expect(flowDecisionFor(off, ticket({ issueType: "Hata" }), "analiz").reason).toBe("default");
  });

  it("ignores a rule whose assignee is not the ticket's assignee", () => {
    const bot = [rule({ assigneeAccountId: "712020:bot", flowType: "duzeltme" })];
    const humanTicket = ticket({ issueType: "Hata", assignee: "ayse.kaya" });
    expect(flowDecisionFor(bot, humanTicket, "analiz").reason).toBe("default");
  });

  it("matches a rule whose assignee IS the ticket's assignee", () => {
    const bot = [rule({ assigneeAccountId: "712020:bot", flowType: "duzeltme" })];
    const botTicket = ticket({ issueType: "Hata", assignee: "712020:bot" });
    expect(flowDecisionFor(bot, botTicket, "analiz").flow).toBe("duzeltme");
  });

  it("treats an empty rule assignee as 'any assignee'", () => {
    const anyone = [rule({ assigneeAccountId: "  ", flowType: "duzeltme" })];
    expect(flowDecisionFor(anyone, ticket({ issueType: "Hata", assignee: "ayse.kaya" }), null).flow).toBe("duzeltme");
  });

  it("does NOT let a field the payload omitted match an empty matchValue", () => {
    // A delivery that carried no status must match nothing, rather than
    // matching a rule whose `matchValue` happens to be empty.
    const empty = [rule({ matchKind: "status", matchValue: "", flowType: "gelistirme" })];
    expect(flowDecisionFor(empty, ticket({ status: null }), "analiz").reason).toBe("default");
  });
});

describe("flowDecisionFor — priority and conflicts (fail-closed)", () => {
  it("lets the lowest priority number win when rules agree on nothing else", () => {
    const rules = [
      rule({ ruleId: "lr_low", matchValue: "Hata", flowType: "duzeltme", priority: 50 }),
      rule({ ruleId: "lr_high", matchValue: "Hata", flowType: "duzeltme", priority: 5 }),
    ];
    expect(ruleFor(rules, ticket({ issueType: "Hata" }))?.ruleId).toBe("lr_high");
  });

  it("takes the NARROWEST flow when two rules disagree, and says so", () => {
    // A status rule and an issuetype rule can both match one ticket; no unique
    // index can prevent that. `analiz` writes no code, so it is the safe pick
    // even though the wider rule has the better priority.
    const rules = [
      rule({ ruleId: "lr_type", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
      rule({ ruleId: "lr_status", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 90 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);

    expect(decision.flow).toBe("analiz");
    expect(decision.reason).toBe("rule_conflict");
    expect(decision.ruleId).toBe("lr_status");
    expect([...(decision.conflictingRuleIds ?? [])].sort()).toEqual(["lr_status", "lr_type"]);
  });

  it("prefers duzeltme over gelistirme when those two conflict", () => {
    const rules = [
      rule({ ruleId: "lr_a", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
      rule({ ruleId: "lr_b", matchKind: "status", matchValue: "Yapılacak", flowType: "duzeltme", priority: 2 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.flow).toBe("duzeltme");
    expect(decision.reason).toBe("rule_conflict");
  });

  it("does NOT report a conflict when both matching rules name the same flow", () => {
    const rules = [
      rule({ ruleId: "lr_a", matchKind: "issuetype", matchValue: "Hata", flowType: "analiz", priority: 1 }),
      rule({ ruleId: "lr_b", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 2 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.reason).toBe("rule");
    expect(decision.conflictingRuleIds).toBeUndefined();
  });

  it("decides the same way whatever order the store returned the rows in", () => {
    // Determinism: the flow travels into the workflow input, so the same rule
    // set must always produce the same answer.
    const rules = [
      rule({ ruleId: "lr_b", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
      rule({ ruleId: "lr_a", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    ];
    const forward = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    const reversed = flowDecisionFor([...rules].reverse(), ticket({ issueType: "Hata" }), null);
    expect(forward).toEqual(reversed);
    expect(forward.ruleId).toBe("lr_a");
  });
});

describe("rulesFor / ruleFor", () => {
  it("returns every matching rule, most important first", () => {
    const rules = [
      rule({ ruleId: "lr_2", matchValue: "Hata", priority: 20 }),
      rule({ ruleId: "lr_1", matchKind: "status", matchValue: "Yapılacak", priority: 10 }),
      rule({ ruleId: "lr_x", matchValue: "Görev", priority: 1 }),
    ];
    const matched = rulesFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }));
    expect(matched.map((r) => r.ruleId)).toEqual(["lr_1", "lr_2"]);
  });

  it("returns null when nothing matches", () => {
    expect(ruleFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }))).toBeNull();
  });

  it("returns a COPY, so a caller cannot mutate the stored rule", () => {
    const rules = [rule({ matchValue: "Hata" })];
    const found = ruleFor(rules, ticket({ issueType: "Hata" }));
    found!.flowType = "gelistirme";
    expect(rules[0]!.flowType).toBe("duzeltme");
  });

  it("carries the rule's agent-variant mapping through", () => {
    const rules = [rule({ matchValue: "Hata", analystVariantId: "analist-v2", engineerVariantId: "kodcu-v1" })];
    const found = ruleFor(rules, ticket({ issueType: "Hata" }));
    expect(found?.analystVariantId).toBe("analist-v2");
    expect(found?.engineerVariantId).toBe("kodcu-v1");
  });
});
