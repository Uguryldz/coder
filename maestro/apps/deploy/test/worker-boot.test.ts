import { describe, expect, it } from "vitest";
import { MISSING_CORE_DEPS } from "../src/boot.js";
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
});

/** Just enough shape for `buildCoreStores`; nothing here is called. */
function stubDb(): Parameters<typeof buildCoreStores>[0] {
  const never = (): never => {
    throw new Error("not called");
  };
  return {
    workflowRun: { findFirst: never, update: never, findUnique: never },
    gate: { findUnique: never, upsert: never, update: never },
    auditLog: { findFirst: never, findMany: never, create: never },
    paramVersion: { findMany: never },
    routingRule: { findMany: never },
    user: { findMany: never },
    idempotencyKey: { findUnique: never, update: never, delete: never },
  };
}
