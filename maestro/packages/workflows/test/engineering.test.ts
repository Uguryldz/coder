import type { LlmCallLog } from "@maestro/contracts";
import type { AgentTurnResult, SessionReport } from "@maestro/execution";
import { describe, expect, it } from "vitest";
import { designTests, reviewDiff, reviewTests, runEngineering, runTests } from "../src/impl/engineering.js";
import { QUOTA_WAIT } from "../src/impl/outcome.js";
import { makeFakes } from "./fakes.js";
import { analysisDoc } from "./harness.js";

const LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
  runId: null,
  role: "dev_reviewer",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    runId: "run-pay-101-0001",
    ticketKey: "PAY-101",
    resumeToken: "session-2",
    workspacePath: "/w/pay-101",
    finalText: "bitti",
    changedFiles: [],
    diff: { files: 3, insertions: 30, deletions: 4 },
    commands: [
      { name: "test", command: ["pnpm", "test"], exitCode: 0, stdoutTail: "42 passed", stderrTail: "", durationMs: 10 },
    ],
    protectedViolations: [],
    strikes: null,
    at: "2026-08-09T09:05:00+03:00",
    ...over,
  };
}

const ok = (over: Partial<SessionReport> = {}): AgentTurnResult => ({ status: "ok", report: report(over) });

describe("runEngineering (step 6a)", () => {
  it("carries the workflow's resume token into the session (M30)", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "kabul kriterleri");

    expect(fakes.recorded.turns[0]?.resumeToken).toBe("session-1");
    expect(result.ok).toBe(true);
    expect(result.resumeToken).toBe("session-2");
    expect(fakes.patches).toContainEqual({ resumeToken: "session-2", workspacePresent: true });
  });

  it("opens a NEW session when there is no token yet", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "ilk tur");
    expect(fakes.recorded.turns[0]?.resumeToken).toBeUndefined();
  });

  it("gives a new session the journal and the living summary as its context", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "ilk tur");
    await runEngineering(fakes.deps, "PAY-101", "session-2", "ikinci tur");

    // The first turn had nothing to summarise; the second one did.
    expect(fakes.recorded.turns[0]?.context.livingSummary).toBeNull();
    expect(fakes.recorded.turns[1]?.context.livingSummary).not.toBeNull();
    expect(fakes.recorded.turns[1]?.context.journal.length).toBeGreaterThan(0);
  });

  it("a protected-path violation is a handover on the first offence (M52)", async () => {
    const violation = {
      status: "failed" as const,
      reason: "protected_path" as const,
      report: report({
        protectedViolations: [{ path: "db/migrations/001.sql", pattern: "**/migrations/**", status: "added" }],
      }),
      handover: {
        handover: false,
        key: { runId: "run-pay-101-0001", scope: "agent" as const, ref: "protected_path" },
        count: 1,
        limit: 3,
        workMode: "ai_assist" as const,
        messageKey: "run.handover_stuck",
        reasons: [],
      },
    };
    const fakes = makeFakes({ runTurn: () => violation });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "task");

    expect(result.ok).toBe(false);
    expect(result.handoverReason).toContain("db/migrations/001.sql");
  });

  it("a red build only hands over once the strike limit is reached (M54)", async () => {
    const failed = (count: number): AgentTurnResult => ({
      status: "failed",
      reason: "verification",
      report: report(),
      handover: {
        handover: count >= 3,
        key: { runId: "run-pay-101-0001", scope: "ci", ref: "fp" },
        count,
        limit: 3,
        workMode: "ai_assist",
        messageKey: "run.handover_stuck",
        reasons: [],
      },
    });

    const early = makeFakes({ runTurn: () => failed(1) });
    expect((await runEngineering(early.deps, "PAY-101", "s", "t")).handoverReason).toBeUndefined();

    const stuck = makeFakes({ runTurn: () => failed(3) });
    expect((await runEngineering(stuck.deps, "PAY-101", "s", "t")).handoverReason).toContain("M54");
  });

  it("a quota wait is retryable; the run parks instead of failing (M55)", async () => {
    const fakes = makeFakes({
      runTurn: () => ({ status: "queued", resumeAt: "2026-08-09T14:00:00+03:00" }),
    });
    await expect(runEngineering(fakes.deps, "PAY-101", "s", "t")).rejects.toMatchObject({
      type: QUOTA_WAIT,
    });
  });

  it("a degraded gateway hands the turn to a human and keeps the token", async () => {
    const fakes = makeFakes({ runTurn: () => ({ status: "degraded", messageKey: "llm.degraded" }) });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "t");

    expect(result.ok).toBe(false);
    expect(result.handoverReason).toContain("M97");
    expect(result.resumeToken).toBe("session-1");
  });

  /**
   * O4: a policy block DOES hand the ticket to a human, and the handover is
   * fully recorded — but the activity then throws, so the run closes as a
   * failure and Studio shows "başarısız" for a ticket that is sitting in
   * somebody's queue, correctly handed over. The two facts must agree.
   */
  it("a policy block is reported as a handover, not a bare failure (O4)", async () => {
    const fakes = makeFakes({
      runTurn: () => ({ status: "blocked", messageKey: "llm.blocked", dataClass: "gizli" }),
    });
    const result = await runEngineering(fakes.deps, "PAY-101", "session-1", "t");

    expect(result.ok).toBe(false);
    expect(result.handoverReason).toContain("llm.blocked");
    // The handover itself was recorded before the decision came back.
    expect(fakes.journalStore.entries.some((e) => e.kind === "handover")).toBe(true);
  });
});

describe("the AI reviews (steps 6c and 8)", () => {
  it("passes findings through so the next turn can act on them", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { approved: false, findings: ["test yok"] }, log: LOG }),
    });
    expect(await reviewDiff(fakes.deps, "PAY-101")).toEqual({ approved: false, findings: ["test yok"] });
  });

  it("a degraded gateway is NOT an approval", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
    });
    const verdict = await reviewTests(fakes.deps, "PAY-101");
    expect(verdict.approved).toBe(false);
    expect(verdict.findings[0]).toContain("M97");
  });

  it("designTests journals the scenario count", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { scenarios: 6 }, log: LOG }),
    });
    expect(await designTests(fakes.deps, "PAY-101")).toEqual({ scenarios: 6 });
    expect(fakes.journalStore.entries.at(-1)?.detail).toBe("6 senaryo");
  });
});

describe("runTests (step 10)", () => {
  const digest = { status: "ok" as const, value: { total: 42, failed: 0, coveragePct: 88 }, log: LOG };

  it("is green only when every command exited zero", async () => {
    const fakes = makeFakes({ runTurn: () => ok(), generateObject: () => digest });
    expect(await runTests(fakes.deps, "PAY-101")).toEqual({
      passed: true,
      total: 42,
      failed: 0,
      coveragePct: 88,
    });
  });

  it("a summariser that claims success over a red build cannot open the PR", async () => {
    const red = ok({
      commands: [
        { name: "test", command: ["pnpm", "test"], exitCode: 1, stdoutTail: "1 failed", stderrTail: "", durationMs: 9 },
      ],
    });
    const fakes = makeFakes({ runTurn: () => red, generateObject: () => digest });
    const result = await runTests(fakes.deps, "PAY-101");

    // The model said "0 failed"; the exit code said otherwise, and it wins.
    expect(result.passed).toBe(false);
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("testler kırmızı");
  });
});

/**
 * ── Müşterinin geliştirici ve doğrulayıcı ajanları ──────────────────────────
 * The developer gets the approved plan and the rules on its first turn and
 * logs every "PLAN SAPMASI"; the verifier is a separate session that reports
 * the build and a PASS/FAIL row per business rule.
 */
describe("developer brief (step 6a)", () => {
  const stored = async (fakes: ReturnType<typeof makeFakes>) => {
    const run = await fakes.deps.runs.get("PAY-101");
    const doc = {
      ...analysisDoc("orta"),
      businessRules: ["Limit 500.000 TL'yi aşamaz"],
      plan: {
        files: [{ path: "src/pay/Limit.java", change: "üst sınır kontrolü" }],
        endpoints: [],
        dtos: [],
        conventions: [],
        notes: "",
      },
    };
    await fakes.deps.storage.put(`${run.runId}/analysis/analysis.json`, new TextEncoder().encode(JSON.stringify(doc)));
  };

  it("a fresh session reads the developer rules, the plan and the business rules under the task", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await stored(fakes);
    await runEngineering(fakes.deps, "PAY-101", null, "analizdeki kabul kriterlerini karşıla");
    const task = fakes.recorded.turns[0]?.context.task ?? "";
    expect(task).toContain("agent.engineering_brief(PAY-101)");
    expect(task).toContain("ONAYLI PLAN");
    expect(task).toContain("src/pay/Limit.java — üst sınır kontrolü");
    expect(task).toContain("K1. Limit 500.000 TL'yi aşamaz");
    expect(task).toContain("## Bu turun görevi\nanalizdeki kabul kriterlerini karşıla");
  });

  it("a resumed session gets the rules and the task, not the plan again", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await stored(fakes);
    await runEngineering(fakes.deps, "PAY-101", "session-1", "review bulgularını düzelt");
    const task = fakes.recorded.turns[0]?.context.task ?? "";
    expect(task).toContain("agent.engineering_brief(PAY-101)");
    expect(task).not.toContain("ONAYLI PLAN");
    expect(task).toContain("review bulgularını düzelt");
  });

  it("without a stored analysis the turn carries the rules and the task only — today's behaviour", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "ilk tur");
    const task = fakes.recorded.turns[0]?.context.task ?? "";
    expect(task).not.toContain("ONAYLI PLAN");
    expect(task).toContain("ilk tur");
  });

  it("every PLAN SAPMASI line the developer wrote becomes its own journal entry", async () => {
    const fakes = makeFakes({
      runTurn: () =>
        ok({
          finalText:
            "Değişen dosyalar: Limit.java\nPLAN SAPMASI: DTO'ya currency eklendi — servis onsuz 400 veriyor\n- PLAN SAPMASI: V12 migration eklendi — kolon yoktu",
        }),
    });
    await runEngineering(fakes.deps, "PAY-101", null, "t");
    const deviations = fakes.journalStore.entries.filter((e) => e.title === "plan sapması").map((e) => e.detail);
    expect(deviations).toEqual([
      "DTO'ya currency eklendi — servis onsuz 400 veriyor",
      "V12 migration eklendi — kolon yoktu",
    ]);
  });
});

describe("verifier (step 6c)", () => {
  it("runs in the sandbox when a fleet answers: the build commands' exit codes reach the digest, no read-only session is opened", async () => {
    let sessionOpened = false;
    const fakes = makeFakes({
      runTurn: () =>
        ok({
          finalText: "K1 PASS\nK2 PASS",
          commands: [{ name: "build", command: ["mvn", "-q", "compile"], exitCode: 1, stdoutTail: "", stderrTail: "3 errors", durationMs: 5 }],
        }),
      agentSession: () => {
        sessionOpened = true;
        return { status: "ok", value: { resumeToken: "v", finalText: "x", log: LOG as never }, log: LOG };
      },
      generateObject: () => ({ status: "ok", value: { approved: true, findings: [], build: { status: "fail", detail: "3 errors" }, rules: [] }, log: LOG }),
    });
    const verdict = await reviewDiff(fakes.deps, "PAY-101");
    expect(sessionOpened).toBe(false);
    const digest = fakes.recorded.llm.find((c) => c.schemaName === "diff-review");
    expect((digest?.input as { report: string }).report).toContain("mvn -q compile): exit 1 — 3 errors");
    expect(verdict.approved).toBe(false);
    expect(fakes.recorded.turns[0]?.context.task).toContain("agent.verify_task(PAY-101");
  });

  const verifierSession = () => ({
    status: "ok" as const,
    value: { resumeToken: "verify-1", finalText: "derleme ok\nK1 PASS\nK2 FAIL Limit.java:40", log: LOG as never },
    log: LOG,
  });
  const stored = async (fakes: ReturnType<typeof makeFakes>) => {
    const run = await fakes.deps.runs.get("PAY-101");
    const doc = { ...analysisDoc("orta"), businessRules: ["Limit üst sınırı 500.000 TL", "Aşımda 422 döner"] };
    await fakes.deps.storage.put(`${run.runId}/analysis/analysis.json`, new TextEncoder().encode(JSON.stringify(doc)));
  };

  it("opens a separate session with the rule checklist and the verification commands, then reports rule by rule", async () => {
    const fakes = makeFakes({
      agentSession: verifierSession,
      generateObject: () => ({
        status: "ok",
        value: {
          approved: true,
          findings: [],
          build: { status: "ok", detail: "" },
          rules: [
            { rule: "K1. Limit üst sınırı 500.000 TL", status: "PASS", evidence: "Limit.java:12" },
            { rule: "K2. Aşımda 422 döner", status: "FAIL", evidence: "Limit.java:40 500 dönüyor" },
          ],
        },
        log: LOG,
      }),
    });
    await stored(fakes);
    const verdict = await reviewDiff(fakes.deps, "PAY-101");
    // A FAIL row is not an approval, whatever the flag says.
    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toEqual(["K2. Aşımda 422 döner: FAIL — Limit.java:40 500 dönüyor"]);
    const digest = fakes.recorded.llm.find((c) => c.schemaName === "diff-review");
    const input = digest?.input as { businessRules: string[]; report: string };
    expect(input.businessRules).toEqual(["K1. Limit üst sınırı 500.000 TL", "K2. Aşımda 422 döner"]);
    expect(input.report).toContain("K2 FAIL");
    const entry = fakes.journalStore.entries.find((e) => e.title === "doğrulama bulguları");
    expect(entry?.detail).toBe("derleme: ok\nPASS — K1. Limit üst sınırı 500.000 TL (Limit.java:12)\nFAIL — K2. Aşımda 422 döner (Limit.java:40 500 dönüyor)");
  });

  it("a red build blocks even when every rule passes", async () => {
    const fakes = makeFakes({
      agentSession: verifierSession,
      generateObject: () => ({
        status: "ok",
        value: { approved: true, findings: [], build: { status: "fail", detail: "mvn compile: 3 errors" }, rules: [] },
        log: LOG,
      }),
    });
    await stored(fakes);
    const verdict = await reviewDiff(fakes.deps, "PAY-101");
    expect(verdict.approved).toBe(false);
    expect(verdict.findings[0]).toContain("derleme kırmızı: mvn compile: 3 errors");
  });

  it("falls back to the ticket-only review when no verifier session can be opened", async () => {
    // No agentSession scripted: the fake throws, the step degrades to the
    // structured review it always had (the existing test above covers it).
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: { approved: true, findings: [] }, log: LOG }),
    });
    await stored(fakes);
    expect(await reviewDiff(fakes.deps, "PAY-101")).toEqual({ approved: true, findings: [] });
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("inceleme onaylandı");
  });

  it("the test designer gets the acceptance criteria and the business rules from the stored analysis", async () => {
    const fakes = makeFakes({ generateObject: () => ({ status: "ok", value: { scenarios: 2 }, log: LOG }) });
    await stored(fakes);
    await designTests(fakes.deps, "PAY-101");
    const call = fakes.recorded.llm.find((c) => c.schemaName === "test-design");
    const input = call?.input as { businessRules?: string[]; acceptanceCriteria?: string[] };
    expect(input.businessRules).toEqual(["Limit üst sınırı 500.000 TL", "Aşımda 422 döner"]);
    expect(input.acceptanceCriteria?.length).toBeGreaterThan(0);
  });
});

describe("agent trainings reach the doing-role sessions", () => {
  it("the developer turn leads with the engineer agent's persona", async () => {
    // engineerVariantId is "" in the fixture, so the engineer resolves to v1.
    const fakes = makeFakes({ persona: { v1: "GELİŞTİRİCİ-EĞİTİMİ" }, runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "t");
    const task = fakes.recorded.turns[0]?.context.task ?? "";
    expect(task.startsWith("GELİŞTİRİCİ-EĞİTİMİ\n\n")).toBe(true);
    expect(task).toContain("agent.engineering_brief(PAY-101)");
  });

  it("without a persona the developer gets the shipped training", async () => {
    const fakes = makeFakes({ runTurn: () => ok() });
    await runEngineering(fakes.deps, "PAY-101", null, "t");
    expect(fakes.recorded.turns[0]?.context.task.startsWith("agent.training.developer()")).toBe(true);
  });

  it("the verifier session leads with the verifier agent's persona (role dev_reviewer)", async () => {
    let task = "";
    const fakes = makeFakes({
      personaByRole: { dev_reviewer: "DOĞRULAYICI-EĞİTİMİ" },
      agentSession: () => ({
        status: "ok",
        value: { resumeToken: "verify-1", finalText: "ok", log: LOG as never },
        log: LOG,
      }),
      generateObject: () => ({ status: "ok", value: { approved: true, findings: [] }, log: LOG }),
    });
    const spy = fakes.deps.llm.agentSession;
    fakes.deps.llm.agentSession = (opts) => {
      task = opts.task;
      return spy(opts);
    };
    await reviewDiff(fakes.deps, "PAY-101");
    expect(task.startsWith("DOĞRULAYICI-EĞİTİMİ\n\n")).toBe(true);
    expect(task).toContain("agent.verify_task(PAY-101");
  });

  it("the verifier session and digest run on the VERIFIER agent's id when one is defined", async () => {
    let sessionVariant = "";
    const fakes = makeFakes({
      variantByRole: { dev_reviewer: "verifier-default" },
      agentSession: () => ({ status: "ok", value: { resumeToken: "verify-1", finalText: "ok", log: LOG as never }, log: LOG }),
      generateObject: () => ({ status: "ok", value: { approved: true, findings: [] }, log: LOG }),
    });
    const spy = fakes.deps.llm.agentSession;
    fakes.deps.llm.agentSession = (opts) => {
      sessionVariant = opts.variantId ?? "";
      return spy(opts);
    };
    await reviewDiff(fakes.deps, "PAY-101");
    expect(sessionVariant).toBe("verifier-default");
    expect(fakes.recorded.llm.find((c) => c.schemaName === "diff-review")?.variantId).toBe("verifier-default");
  });
});
