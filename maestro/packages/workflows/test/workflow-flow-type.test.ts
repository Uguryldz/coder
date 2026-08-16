import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, createTestEnv, runTicket } from "./harness.js";

/**
 * What the listening rule's flow type actually CHANGES about a run.
 *
 * Until `planFor` was wired in, the flow type was a label: the rule recorded
 * it, and every ticket ran the full pipeline regardless. That failed live on
 * OPS-38 — an `analiz` ticket, on a deployment deliberately configured without
 * a code agent, sailed through both analysis gates and then died inside
 * `runEngineering` with `mcpServers were requested but no --mcp-config path
 * was given`. The analysis was finished and approved; the run failed anyway.
 *
 * These tests pin the three flows to the phases they are supposed to run.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("flow: analiz — the analysis IS the deliverable", () => {
  it("passes the analysis gates, delivers, and closes without writing code", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "analiz", risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.delivered).toBe(true);
    // The gate it DID open is an analysis one — at `dusuk` the tier's set is
    // step 5 alone (`GATES_BY_RISK`) — and no engineering step ran.
    expect(run.scenario.opened).toEqual(["5"]);
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(false);
    expect(run.scenario.journal.at(-1)?.title).toBe("analiz teslim edildi");
  });

  it("still honours a rejection — it is analysis-only, not approval-free", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        gate: (_step, visit) =>
          visit === 1 ? { kind: "reject_once", reason: "kapsam eksik" } : { kind: "approve" },
      }),
    );

    expect(run.status).toBe("done");
    // Rewritten once before the approval — the loop is untouched by the flow.
    expect(run.scenario.journal.filter((e) => e.title === "adım 3").length).toBeGreaterThan(1);
  });
});

describe("flow: gelistirme and an absent rule — the full pipeline", () => {
  it("runs engineering for gelistirme", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "gelistirme", risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(true);
    expect(run.scenario.delivered).toBe(false);
  });

  /**
   * The safe default, and the direction it is safe in: a ticket that matched
   * no rule is never silently under-processed. A run that does too much stops
   * at a human gate; a run that does too little just quietly ends.
   */
  it("runs the full pipeline when no rule named a flow", async () => {
    const run = await runTicket(
      env,
      new Scenario({ risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(true);
  });
});
