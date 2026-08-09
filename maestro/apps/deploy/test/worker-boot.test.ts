import { describe, expect, it } from "vitest";
import { DEGRADED_CAPABILITIES, MISSING_CORE_DEPS } from "../src/boot.js";
import { buildCoreStores } from "../src/stores/core.js";
import { unwiredAgentTurnRunner } from "../src/stores/execution.js";

/**
 * The worker's start-up precondition.
 *
 * Through wave 4 `bin/worker.ts` composed every port and then threw, because
 * `MISSING_CORE_DEPS` named six unimplemented stores. These tests are what
 * make the change to that list a deliberate act rather than a side effect: if
 * somebody re-adds an entry, the worker refuses to poll again, and the first
 * test below says so out loud.
 */
describe("the worker's core dependencies", () => {
  /**
   * THE assertion of this wave. An empty list is what lets `bin/worker.ts`
   * reach `startMaestroWorker` instead of throwing.
   */
  it("names nothing missing, so the worker may poll", () => {
    expect([...MISSING_CORE_DEPS]).toEqual([]);
  });

  /**
   * `buildCoreStores` is what replaced those six entries, so it must produce
   * all six. A store that quietly went missing would otherwise show up as an
   * `undefined` dependency at the first activity that used it.
   */
  it("builds every store the activities need", () => {
    const stores = buildCoreStores(stubDb(), {
      sql: { query: () => Promise.resolve([]) },
      transactions: { transaction: (fn) => fn({ query: () => Promise.resolve([]) }) },
    });

    for (const name of ["runs", "gates", "params", "directory", "idempotency", "audit"] as const) {
      expect(stores[name], name).toBeDefined();
    }
  });

  /**
   * The turn runner is the one seam still unfilled, and it must fail LOUDLY at
   * the first engineering turn rather than quietly return a plausible result.
   * `endRun` stays a no-op: it is cleanup, and throwing there would replace a
   * run's real failure with this one.
   */
  it("refuses an engineering turn with a message naming what is missing", async () => {
    const runner = unwiredAgentTurnRunner();
    await expect(
      runner.runTurn({
        context: {} as never,
        dataClass: "dahili",
        variantId: "v1",
        verification: [],
      }),
    ).rejects.toThrow(/AgentTurnRunner|WorkspaceProbe/);
    expect(() => runner.endRun("run-1")).not.toThrow();
  });

  /**
   * The refusal above is correct but INVISIBLE at start-up, and that is its own
   * problem: the worker logs "polling", an operator reads a healthy image, and
   * the gap only appears when a real ticket reaches the engineering turn. This
   * pair keeps the declaration and the refusal tied together.
   */
  describe("declared degraded capabilities", () => {
    it("declares the turn runner, so a started worker is not read as a working one", () => {
      expect(DEGRADED_CAPABILITIES.length).toBe(1);
      const [entry = ""] = DEGRADED_CAPABILITIES;
      // Named precisely enough that an operator can tell what will not run.
      expect(entry).toMatch(/AgentTurnRunner/);
      expect(entry).toMatch(/engineering turn/);
      expect(entry).toMatch(/engineering\.ts:107/);
    });

    /**
     * The anti-drift assertion. If somebody wires a real `AgentTurnRunner` and
     * forgets this list, the image would keep announcing a gap it no longer
     * has — and a warning that is wrong once is ignored forever after.
     */
    it("declares it only for as long as the seam actually refuses", async () => {
      const declared = DEGRADED_CAPABILITIES.some((entry) => entry.includes("AgentTurnRunner"));
      const refuses = await unwiredAgentTurnRunner()
        .runTurn({ context: {} as never, dataClass: "dahili", variantId: "v1", verification: [] })
        .then(
          () => false,
          () => true,
        );
      expect(declared).toBe(refuses);
    });
  });
});

/** Just enough shape for `buildCoreStores`; nothing here is called. */
function stubDb(): Parameters<typeof buildCoreStores>[0] {
  const never = (): never => {
    throw new Error("not called");
  };
  return {
    workflowRun: { findFirst: never, update: never, findUnique: never },
    gate: { findUnique: never, update: never },
    auditLog: { findFirst: never, findMany: never, create: never },
    paramVersion: { findMany: never },
    routingRule: { findMany: never },
    user: { findMany: never },
    idempotencyKey: { findUnique: never, update: never, delete: never },
  };
}
