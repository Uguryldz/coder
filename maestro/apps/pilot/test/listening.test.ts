import { describe, expect, it } from "vitest";
import { ListeningRulesStore, flowTypeLabel, isValidRule, type ListeningRule } from "../src/listening.js";
import { discoveryJql, PROJECT_KEY } from "../src/config.js";

/**
 * The pilot's listening rules — status/issuetype → flow-type, mirrored from the
 * DB and used to derive the discovery JQL and classify a ticket.
 *
 * The load-bearing behaviours: with NO rule the discovery JQL is unchanged (the
 * pilot behaves exactly as before), a `status` rule narrows discovery to those
 * statuses, disabled rules are ignored, and classification matches issue type
 * and honours priority.
 */

const BOT = "712020:bot";
const FALLBACK = discoveryJql(BOT);

function rule(over: Partial<ListeningRule> = {}): ListeningRule {
  return {
    projectKey: PROJECT_KEY,
    assigneeAccountId: BOT,
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    ...over,
  };
}

describe("discoveryJqlFor", () => {
  it("falls back to the default JQL when there are no status rules", () => {
    const store = new ListeningRulesStore();
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });

  it("an issuetype rule alone does NOT narrow the JQL (it only classifies)", () => {
    const store = new ListeningRulesStore([rule({ matchKind: "issuetype", matchValue: "Hata" })]);
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });

  it("a status rule narrows discovery to that status, keeping project + assignee", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    // The project is now quoted and OR-grouped, no longer a hard-coded literal.
    expect(jql).toContain(`project = "${PROJECT_KEY}"`);
    expect(jql).toContain(`assignee = "${BOT}"`);
    expect(jql).toContain('status IN ("Analiz Bekliyor")');
    expect(jql).not.toContain("statusCategory");
  });

  it("lists every distinct status across status rules", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
      rule({ matchKind: "status", matchValue: "Düzeltme", flowType: "duzeltme", priority: 50 }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    expect(jql).toContain('"Analiz Bekliyor"');
    expect(jql).toContain('"Düzeltme"');
  });

  it("ignores disabled rules", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", enabled: false }),
    ]);
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });

  it("covers a rule on ANY project, not just a hard-coded one (K4)", () => {
    // A status rule on a different project (SAM1, not OPS) must still take effect
    // — the old code hard-coded PROJECT_KEY="OPS" and silently ignored it.
    const store = new ListeningRulesStore([
      rule({ projectKey: "SAM1", matchKind: "status", matchValue: "İncelemede", flowType: "analiz" }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    expect(jql).toContain('project = "SAM1"');
    expect(jql).toContain('status IN ("İncelemede")');
  });

  it("OR-groups status rules across two projects into one JQL", () => {
    const store = new ListeningRulesStore([
      rule({ projectKey: "OPS", matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
      rule({ projectKey: "SAM1", matchKind: "status", matchValue: "İncelemede", flowType: "analiz", priority: 50 }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    expect(jql).toContain('project = "OPS"');
    expect(jql).toContain('project = "SAM1"');
    expect(jql).toContain(") OR (");
  });
});

describe("flowTypeFor", () => {
  it("matches an issue-type rule", () => {
    const store = new ListeningRulesStore([rule({ matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme" })]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" })).toBe("duzeltme");
  });

  it("returns null when no rule matches (default flow)", () => {
    const store = new ListeningRulesStore([rule({ matchValue: "Hata" })]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hikaye" })).toBeNull();
  });

  it("honours priority — the lower number wins", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "issuetype", matchValue: "Hikaye", flowType: "gelistirme", priority: 200 }),
      rule({ matchKind: "issuetype", matchValue: "Hikaye", flowType: "analiz", priority: 10 }),
    ]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hikaye" })).toBe("analiz");
  });

  it("does not match a rule for a different assignee", () => {
    const store = new ListeningRulesStore([rule({ assigneeAccountId: "someone-else" })]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" })).toBeNull();
  });

  it("matches a status rule on status", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
    ]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: "Analiz Bekliyor", issueType: "Görev" })).toBe("analiz");
  });
});

describe("isValidRule (mirror boundary guard)", () => {
  it("accepts a well-formed rule", () => {
    expect(isValidRule(rule())).toBe(true);
  });

  it("rejects an unknown flowType", () => {
    expect(isValidRule({ ...rule(), flowType: "silme" })).toBe(false);
  });

  it("rejects an unknown matchKind", () => {
    expect(isValidRule({ ...rule(), matchKind: "component" })).toBe(false);
  });

  it("rejects a missing field and non-objects", () => {
    const { priority: _p, ...noPriority } = rule();
    expect(isValidRule(noPriority)).toBe(false);
    expect(isValidRule(null)).toBe(false);
    expect(isValidRule("x")).toBe(false);
  });
});

describe("flowTypeLabel", () => {
  it("gives a Turkish label per flow", () => {
    expect(flowTypeLabel("analiz")).toBe("analiz");
    expect(flowTypeLabel("duzeltme")).toBe("düzeltme");
    expect(flowTypeLabel("gelistirme")).toBe("geliştirme");
  });
});
