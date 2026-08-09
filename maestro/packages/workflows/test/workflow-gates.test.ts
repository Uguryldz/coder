import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { GATES_BY_RISK, type RiskTier, type StepId } from "@maestro/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, approval, createTestEnv, runTicket } from "./harness.js";

/**
 * The gates, under time skipping.
 *
 * These are the tests the package exists for: a gate that stays open for
 * sixteen days, a reminder ladder that never decides anything, and four
 * separate ways of refusing to close a gate. Sixteen days of workflow time
 * cost about a second of test time, which is exactly why the waiting is a
 * `condition` and not a poll.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("the risk tier decides which gates open (M51)", () => {
  const cases: RiskTier[] = ["dusuk", "orta", "kritik"];

  for (const risk of cases) {
    it(`opens exactly the ${risk} gate set and nothing else`, async () => {
      const run = await runTicket(env, new Scenario({ risk }));

      expect(run.error).toBeNull();
      expect(run.status).toBe("done");
      expect(run.scenario.opened).toEqual(GATES_BY_RISK[risk]);
      // A gate outside the tier is not "auto-approved" — it never opens, so no
      // decision was ever recorded for it.
      const decided = run.scenario.decisions.map((d) => d.step);
      expect(decided.sort()).toEqual([...GATES_BY_RISK[risk]].sort());
    });
  }

  it("a low-risk run never asks a product owner or QA for anything", async () => {
    const run = await runTicket(env, new Scenario({ risk: "dusuk" }));
    expect(run.scenario.opened).not.toContain("4");
    expect(run.scenario.opened).not.toContain("9");
    expect(run.scenario.opened).not.toContain("11");
  });
});

describe("a gate open for sixteen days (M61/M88)", () => {
  it("waits without deciding, reminds all along, and closes only on a human", async () => {
    const sixteenDays = 16 * 24;
    const startedAt = Date.now();
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        gate: (step) =>
          step === "5" ? { kind: "approve_after_hours", hours: sixteenDays } : { kind: "approve" },
      }),
    );
    const wallClockMs = Date.now() - startedAt;

    expect(run.status).toBe("done");

    const ticks = run.scenario.escalations.filter((e) => e.step === "5");
    // Nothing timed out into a decision: the ONLY decision on gate 5 is the
    // one a person signed, and it arrived after sixteen days of waiting.
    expect(Math.max(...ticks.map((t) => t.hours))).toBe(sixteenDays);
    expect(ticks).toHaveLength(sixteenDays);
    const gate5 = run.scenario.decisions.filter((d) => d.step === "5");
    expect(gate5).toHaveLength(1);
    expect(gate5[0]?.decision).toBe("approve");

    // Sixteen days of waiting, in a fraction of a minute of real time.
    expect(wallClockMs).toBeLessThan(120_000);
  });

  it("keeps reminding on every tier's gates, never on a gate that is closed", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "orta",
        gate: (step) => (step === "11" ? { kind: "approve_after_hours", hours: 72 } : { kind: "approve" }),
      }),
    );
    const steps = new Set(run.scenario.escalations.map((e) => e.step));
    expect([...steps]).toEqual(["11"]);
    expect(run.scenario.escalations).toHaveLength(72);
  });
});

describe("a gate refuses to close for the wrong person (M32/M51)", () => {
  /** Sends one unacceptable decision, then the acceptable one an hour later. */
  const refusedThenApproved = (): Scenario =>
    new Scenario({
      risk: "dusuk",
      gate: (step) => (step === "5" ? { kind: "approve_after_hours", hours: 1 } : { kind: "approve" }),
    });

  it("a product owner cannot close the tech lead's gate — and is told why", async () => {
    const scenario = refusedThenApproved();
    const run = await runTicket(env, scenario, {
      openGate: async (_ticket, step) => {
        scenario.opened.push(step);
        if (step !== "5") {
          await scenario.signal(approval(step));
          return;
        }
        await scenario.signal(approval("5", { actorGroup: "product-owners" }));
      },
    });

    expect(run.status).toBe("done");
    const refusal = run.scenario.journal.find((e) => e.title === "karar reddedildi");
    expect(refusal?.detail).toContain("wrong_group");
    // The gate stayed OPEN: it went on reminding until a tech lead signed.
    expect(run.scenario.escalations.some((e) => e.step === "5")).toBe(true);
    expect(run.scenario.decisions.filter((d) => d.step === "5")).toHaveLength(1);
    expect(run.scenario.decisions.find((d) => d.step === "5")?.actorGroup).toBe("tech-leads");
  });

  it("an unverified approval is refused even from the right group", async () => {
    const scenario = refusedThenApproved();
    const run = await runTicket(env, scenario, {
      openGate: async (_ticket, step) => {
        scenario.opened.push(step);
        if (step !== "5") {
          await scenario.signal(approval(step));
          return;
        }
        await scenario.signal(approval("5", { sodVerified: false }));
      },
    });

    expect(run.status).toBe("done");
    expect(run.scenario.journal.find((e) => e.title === "karar reddedildi")?.detail).toContain(
      "not_verified",
    );
  });

  it("four eyes: the PO who signed step 4 cannot also sign step 5 (M32)", async () => {
    const shared = "ayse.kaya@bank";
    const scenario = new Scenario({
      risk: "orta",
      gate: (step) => (step === "5" ? { kind: "approve_after_hours", hours: 1 } : { kind: "approve" }),
    });
    const run = await runTicket(env, scenario, {
      openGate: async (_ticket, step: StepId) => {
        scenario.opened.push(step);
        if (step === "4") {
          await scenario.signal(approval("4", { actorUserId: shared }));
          return;
        }
        if (step === "5") {
          // Same human, different hat — the four-eyes rule, not a group check.
          await scenario.signal(approval("5", { actorUserId: shared }));
          return;
        }
        await scenario.signal(approval(step));
      },
    });

    expect(run.status).toBe("done");
    expect(run.scenario.journal.find((e) => e.title === "karar reddedildi")?.detail).toContain(
      "sod_violation",
    );
    expect(run.scenario.decisions.find((d) => d.step === "5")?.actorUserId).not.toBe(shared);
  });
});
