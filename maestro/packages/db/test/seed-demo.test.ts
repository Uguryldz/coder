import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppId,
  ApplicationRecord,
  AuditAction,
  DataClass,
  GateDecision,
  JournalEntry,
  LlmCallLog,
  LlmDriverId,
  MatchResult,
  ProjectKey,
  RepoCard,
  RiskTier,
  RuleCondition,
  STEP_IDS,
  TicketKey,
  WorkflowRunStatus,
  WorkMode,
} from "@maestro/contracts";
import {
  auditPayload,
  buildDemoDataset,
  chainAuditEvents,
  DEMO_GATE_DECISIONS,
  DEMO_TICKETS,
  demoRunId,
  NO_PASSWORD_SET,
  seedDemo,
} from "../src/index.js";

const data = buildDemoDataset();

describe("demo dataset shape (insa-plani: seed = the mock dataset)", () => {
  it("carries the headline counts", () => {
    expect(data.applications.length).toBe(5);
    expect(data.repoCards.length).toBe(5);
    expect(data.bindings.filter((b) => b.state === "active").length).toBe(4);
    expect(data.runs.length).toBe(22);
    expect(data.routingRules.length).toBeGreaterThanOrEqual(5);
    expect(data.users.length).toBe(7);
  });

  it("spreads the 22 runs over every interesting status", () => {
    const byStatus = new Map<string, number>();
    for (const run of data.runs) {
      byStatus.set(String(run.status), (byStatus.get(String(run.status)) ?? 0) + 1);
    }
    expect(byStatus.get("gate")).toBe(7);
    expect(byStatus.get("running")).toBe(8);
    expect(byStatus.get("queued")).toBe(1);
    expect(byStatus.get("fail")).toBe(1);
    expect(byStatus.get("done")).toBe(5);
    expect([...byStatus.values()].reduce((a, b) => a + b, 0)).toBe(22);
  });

  it("is deterministic — two builds are identical", () => {
    expect(JSON.stringify(buildDemoDataset(), replacer)).toBe(JSON.stringify(data, replacer));
  });
});

/** BigInt is not JSON-serializable; only used by the determinism check. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

describe("demo rows honour the contracts", () => {
  it("uses well-formed ticket keys, app ids and step ids", () => {
    for (const ticket of DEMO_TICKETS) {
      expect(TicketKey.safeParse(ticket.key).success, ticket.key).toBe(true);
      if (ticket.appId !== null) {
        expect(AppId.safeParse(ticket.appId).success, ticket.appId).toBe(true);
      }
      expect(STEP_IDS, ticket.key).toContain(ticket.step);
      expect(WorkflowRunStatus.options).toContain(ticket.status);
      expect(WorkMode.options).toContain(ticket.mode);
      expect(DataClass.options).toContain(ticket.dataClass);
      if (ticket.risk !== null) expect(RiskTier.options).toContain(ticket.risk);
    }
  });

  it("stores a valid MatchResult on every run (M99: no silent default)", () => {
    for (const ticket of DEMO_TICKETS) {
      const parsed = MatchResult.safeParse(ticket.match);
      expect(parsed.success, `${ticket.key}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("validates every application against ApplicationRecord", () => {
    for (const app of data.applications) {
      const parsed = ApplicationRecord.safeParse({
        appId: app.appId,
        displayName: app.displayName,
        adoProject: app.adoProject,
        adoRepo: app.adoRepo,
        platform: app.platform,
        jiraComponent: app.jiraComponent ?? null,
        maestroYamlPresent: app.maestroYamlPresent,
        createdVia: app.createdVia,
      });
      expect(parsed.success, `${app.appId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("validates every repo card against RepoCard", () => {
    for (const card of data.repoCards) {
      const parsed = RepoCard.safeParse({
        appId: card.appId,
        modules: card.modulesJson,
        generatedFromSha: card.generatedFromSha,
        version: card.version,
        updatedAt: (card.updatedAt as Date).toISOString(),
      });
      expect(parsed.success, `${card.appId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("validates routing rule conditions and keeps effects non-empty", () => {
    for (const rule of data.routingRules) {
      expect(RuleCondition.safeParse(rule.conditionJson).success, rule.ruleId).toBe(true);
      expect(ProjectKey.safeParse(rule.projectKey).success, rule.ruleId).toBe(true);
      expect(Object.keys(rule.effectJson as object).length, rule.ruleId).toBeGreaterThan(0);
    }
  });

  it("validates every journal entry against JournalEntry", () => {
    for (const entry of data.journal) {
      const parsed = JournalEntry.safeParse({
        runId: entry.runId,
        seq: entry.seq,
        at: (entry.at as Date).toISOString(),
        actor: entry.actor,
        kind: entry.kind,
        title: entry.title,
        detail: entry.detail,
        ...(entry.costJson === undefined ? {} : { cost: entry.costJson }),
      });
      expect(parsed.success, `${entry.runId}#${entry.seq}: ${parsed.error?.message ?? ""}`).toBe(
        true,
      );
    }
  });

  it("numbers journal entries from 0 without gaps per run", () => {
    const bySeq = new Map<string, number[]>();
    for (const entry of data.journal) {
      const list = bySeq.get(entry.runId) ?? [];
      list.push(entry.seq);
      bySeq.set(entry.runId, list);
    }
    expect(bySeq.size).toBe(22);
    for (const [runId, seqs] of bySeq) {
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(sorted, runId).toEqual(sorted.map((_, i) => i));
    }
  });

  it("validates every signed gate decision against GateDecision", () => {
    expect(DEMO_GATE_DECISIONS.length).toBeGreaterThanOrEqual(5);
    for (const gate of DEMO_GATE_DECISIONS) {
      const parsed = GateDecision.safeParse({
        step: gate.step,
        decision: gate.decision,
        actorUserId: gate.actorUserId,
        actorGroup: gate.actorGroup,
        sodVerified: true,
        signatureSeq: gate.signatureSeq,
        source: gate.source,
        at: gate.at.toISOString(),
        ...(gate.reason === undefined ? {} : { reason: gate.reason }),
      });
      expect(parsed.success, `${gate.ticketKey}/${gate.step}: ${parsed.error?.message ?? ""}`).toBe(
        true,
      );
    }
  });

  it("keeps separation of duties on UGURPAY-501 (PO ≠ Tech Lead)", () => {
    const gates = DEMO_GATE_DECISIONS.filter((g) => g.ticketKey === "UGURPAY-501");
    const po = gates.find((g) => g.step === "4");
    const techLead = gates.find((g) => g.step === "5");
    expect(po?.actorUserId).toBeDefined();
    expect(techLead?.actorUserId).toBeDefined();
    expect(po?.actorUserId).not.toBe(techLead?.actorUserId);
  });

  it("validates every llm call against LlmCallLog", () => {
    for (const call of data.llmCalls) {
      expect(LlmDriverId.options).toContain(call.driver);
      const parsed = LlmCallLog.safeParse({
        at: (call.at as Date).toISOString(),
        runId: call.runId ?? null,
        role: call.role,
        variantId: call.variantId,
        driver: call.driver,
        model: call.model,
        tokensIn: call.tokensIn,
        tokensOut: call.tokensOut,
        cachePct: call.cachePct ?? null,
        usd: call.usd === null || call.usd === undefined ? null : Number(call.usd),
        dataClass: call.dataClass,
      });
      expect(parsed.success, `${call.variantId}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("charges subscription drivers in quota, not dollars (M55)", () => {
    for (const call of data.llmCalls) {
      if (String(call.driver).endsWith("-sub")) expect(call.usd ?? null).toBeNull();
    }
  });
});

describe("referential integrity (the seed must load in one pass)", () => {
  const appIds = new Set(data.applications.map((a) => a.appId));
  const runIds = new Set(data.runs.map((r) => r.id));
  const projectKeys = new Set(data.bindings.map((b) => b.projectKey));
  const variantIds = new Set(data.variants.map((v) => v.id));

  it("points every run at a known application", () => {
    for (const run of data.runs) {
      if (run.appId !== null && run.appId !== undefined) expect(appIds).toContain(run.appId);
    }
  });

  it("points every repo card, rule, event, journal row and evidence row at a known parent", () => {
    for (const card of data.repoCards) expect(appIds).toContain(card.appId);
    for (const rule of data.routingRules) expect(projectKeys).toContain(rule.projectKey);
    for (const event of data.stepEvents) expect(runIds).toContain(event.runId);
    for (const entry of data.journal) expect(runIds).toContain(entry.runId);
    for (const version of data.variantVersions) expect(variantIds).toContain(version.variantId);
    for (const evidence of data.evidencePackages) expect(runIds).toContain(evidence.runId);
  });

  it("writes an evidence package for exactly the closed runs (M56)", () => {
    const done = data.runs.filter((r) => r.status === "done").map((r) => r.id).sort();
    expect(data.evidencePackages.map((e) => e.runId).sort()).toEqual(done);
  });

  it("derives run ids from ticket keys", () => {
    for (const run of data.runs) expect(run.id).toBe(demoRunId(String(run.ticketKey)));
  });
});

describe("audit chain (M33)", () => {
  const rows = data.auditLog;

  it("starts at genesis and links every row to its predecessor", () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(rows[0]?.prevHash).toBe("genesis");
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.prevHash).toBe(rows[i - 1]?.hash);
    }
  });

  it("re-verifies every hash independently", () => {
    let prevHash = "genesis";
    for (const row of rows) {
      const expected = createHash("sha256")
        .update(
          auditPayload(
            Number(row.seq),
            {
              at: row.at as Date,
              actor: row.actor,
              action: row.action,
              subject: row.subject,
            },
            prevHash,
          ),
        )
        .digest("hex");
      expect(row.hash).toBe(expected);
      prevHash = String(row.hash);
    }
  });

  it("uses contract actions, unique hashes and a strictly increasing seq", () => {
    const hashes = new Set(rows.map((r) => r.hash));
    expect(hashes.size).toBe(rows.length);
    for (let i = 1; i < rows.length; i++) {
      expect(Number(rows[i]?.seq)).toBeGreaterThan(Number(rows[i - 1]?.seq));
    }
    for (const row of rows) {
      expect(AuditAction.options).toContain(row.action);
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("detects tampering", () => {
    const [first, second] = chainAuditEvents(
      [
        { at: new Date("2026-08-08T10:00:00.000Z"), actor: "a", action: "RUN_STARTED", subject: "X" },
        { at: new Date("2026-08-08T10:01:00.000Z"), actor: "a", action: "RUN_CLOSED", subject: "X" },
      ],
      1,
    );
    const tampered = chainAuditEvents(
      [
        { at: new Date("2026-08-08T10:00:00.000Z"), actor: "mallory", action: "RUN_STARTED", subject: "X" },
        { at: new Date("2026-08-08T10:01:00.000Z"), actor: "a", action: "RUN_CLOSED", subject: "X" },
      ],
      1,
    );
    expect(tampered[0]?.hash).not.toBe(first?.hash);
    expect(tampered[1]?.hash).not.toBe(second?.hash); // the break propagates
  });
});

describe("users", () => {
  it("ships no usable credential", () => {
    for (const user of data.users) {
      expect(user.passwordHash).toBe(NO_PASSWORD_SET);
      expect(String(user.email)).toMatch(/@/);
    }
  });

  it("gives the approvers the groups their gate decisions claim", () => {
    const groupsByEmail = new Map(
      data.users.map((u) => [String(u.email), u.groupsJson as string[]]),
    );
    for (const gate of DEMO_GATE_DECISIONS) {
      expect(groupsByEmail.get(gate.actorUserId), gate.actorUserId).toContain(gate.actorGroup);
    }
  });
});

describe("seedDemo", () => {
  it("inserts every table in foreign-key order, skipping duplicates", async () => {
    const calls: { table: string; count: number; skipDuplicates: boolean }[] = [];
    const delegate = (table: string) => ({
      createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => {
        calls.push({
          table,
          count: args.data.length,
          skipDuplicates: args.skipDuplicates === true,
        });
        return Promise.resolve({ count: args.data.length });
      },
    });

    const db = {
      user: delegate("user"),
      application: delegate("application"),
      repoCard: delegate("repoCard"),
      jiraProjectBinding: delegate("jiraProjectBinding"),
      routingRule: delegate("routingRule"),
      workflowRun: delegate("workflowRun"),
      stepEvent: delegate("stepEvent"),
      journalEntry: delegate("journalEntry"),
      auditLog: delegate("auditLog"),
      llmCall: delegate("llmCall"),
      variant: delegate("variant"),
      variantVersion: delegate("variantVersion"),
      subscriptionAccount: delegate("subscriptionAccount"),
      knowledgeDoc: delegate("knowledgeDoc"),
      evidencePackageRow: delegate("evidencePackageRow"),
    } as unknown as Parameters<typeof seedDemo>[0];

    const counts = await seedDemo(db);

    expect(counts["runs"]).toBe(22);
    expect(counts["applications"]).toBe(5);
    expect(calls.every((c) => c.skipDuplicates)).toBe(true);

    const order = calls.map((c) => c.table);
    expect(order.indexOf("application")).toBeLessThan(order.indexOf("repoCard"));
    expect(order.indexOf("application")).toBeLessThan(order.indexOf("workflowRun"));
    expect(order.indexOf("jiraProjectBinding")).toBeLessThan(order.indexOf("routingRule"));
    expect(order.indexOf("workflowRun")).toBeLessThan(order.indexOf("stepEvent"));
    expect(order.indexOf("workflowRun")).toBeLessThan(order.indexOf("journalEntry"));
    expect(order.indexOf("workflowRun")).toBeLessThan(order.indexOf("evidencePackageRow"));
    expect(order.indexOf("variant")).toBeLessThan(order.indexOf("variantVersion"));
    expect(new Set(order).size).toBe(15);
  });
});
