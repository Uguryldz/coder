import { describe, expect, it } from "vitest";
import {
  IncompleteRunContextError,
  PrismaRunContextStore,
  RunNotFoundError,
  toRunUpdate,
  type ApplicationRow,
  type RunRow,
  type RunCreate,
  type RunUpdate,
} from "../src/stores/run-context.js";

/**
 * The run context store, against a recording fake delegate.
 *
 * The delegate is a plain object because the store takes a structural type —
 * the same reason `users.test.ts` can exercise `PrismaUserDirectory` offline.
 * What is asserted here is the behaviour the database cannot enforce: which
 * run a ticket resolves to, what happens when there is none, and the exact
 * boundary between "patch this field" and "leave it alone".
 */

const APP: ApplicationRow = {
  appId: "core-api",
  displayName: "Core API",
  adoProject: "Core",
  adoRepo: "core-api",
  platform: "linux-node",
  jiraComponent: "payments",
  maestroYamlPresent: true,
  createdVia: "onboarding",
};

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-pay-101-0001",
    ticketKey: "PAY-101",
    mode: "full_auto",
    risk: null,
    dataClass: "dahili",
    locale: "tr",
    variantId: "v1",
    templateVersion: "analysis@1.0.0",
    workspacePath: "/w/pay-101",
    workspacePresent: true,
    protectedPathsJson: ["infra/**"],
    verificationJson: [{ name: "test", command: ["pnpm", "test"] }],
    branch: "maestro/PAY-101",
    targetBranch: "main",
    prId: null,
    resumeToken: null,
    application: APP,
    ...over,
  };
}

interface Recorded {
  queries: unknown[];
  updates: Array<{ where: { id: string }; data: RunUpdate }>;
  creates: RunCreate[];
}

function fakeDelegate(result: RunRow | null): {
  delegate: ConstructorParameters<typeof PrismaRunContextStore>[0];
  recorded: Recorded;
} {
  const recorded: Recorded = { queries: [], updates: [], creates: [] };
  return {
    recorded,
    delegate: {
      findFirst: (args) => {
        recorded.queries.push(args);
        return Promise.resolve(result);
      },
      update: (args) => {
        recorded.updates.push(args);
        return Promise.resolve(undefined);
      },
      create: (args) => {
        recorded.creates.push(args.data);
        return Promise.resolve(undefined);
      },
    },
  };
}

describe("PrismaRunContextStore.get", () => {
  it("maps a row and its application into a RunContext", async () => {
    const { delegate } = fakeDelegate(row());
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");

    expect(context.runId).toBe("run-pay-101-0001");
    expect(context.app.adoRepo).toBe("core-api");
    expect(context.branch).toBe("maestro/PAY-101");
    expect(context.protectedPaths).toEqual(["infra/**"]);
    expect(context.verification).toEqual([{ name: "test", command: ["pnpm", "test"] }]);
    expect(context.risk).toBeNull();
  });

  it("asks only for runs that are not done or cancelled, newest first", async () => {
    const { delegate, recorded } = fakeDelegate(row());
    await new PrismaRunContextStore(delegate).get("PAY-101");

    expect(recorded.queries[0]).toMatchObject({
      where: { ticketKey: "PAY-101", status: { notIn: ["done", "cancelled"] } },
      orderBy: { startedAt: "desc" },
    });
  });

  /**
   * The fail-closed pair. An activity that received an empty context would
   * carry on with an invented branch and an empty repo — and the first thing
   * it does with either is write to a bank's repository.
   */
  it("throws rather than inventing a context when no live run exists", async () => {
    const { delegate } = fakeDelegate(null);
    await expect(new PrismaRunContextStore(delegate).get("PAY-999")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });

  it("throws when the run has no application rather than inventing a blank one", async () => {
    const { delegate } = fakeDelegate(row({ application: null }));
    await expect(new PrismaRunContextStore(delegate).get("PAY-101")).rejects.toBeInstanceOf(
      IncompleteRunContextError,
    );
  });

  /**
   * A JSON column holds whatever was written. A half-parsed command would
   * reach the runner as a spawn of `undefined`, so entries without a usable
   * argv are dropped rather than passed on.
   */
  it("drops malformed verification entries instead of passing them to a runner", async () => {
    const { delegate } = fakeDelegate(
      row({
        verificationJson: [
          { name: "ok", command: ["pnpm", "lint"] },
          { name: "no-argv" },
          { name: "", command: ["x"] },
          { name: "not-strings", command: [1, 2] },
          "nonsense",
        ],
      }),
    );
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");
    expect(context.verification).toEqual([{ name: "ok", command: ["pnpm", "lint"] }]);
  });

  it("reads a malformed protectedPaths column as no additions", async () => {
    const { delegate } = fakeDelegate(row({ protectedPathsJson: { not: "an array" } }));
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");
    expect(context.protectedPaths).toEqual([]);
  });
});

describe("PrismaRunContextStore.patch", () => {
  it("writes only the named fields and leaves the rest alone", async () => {
    const { delegate, recorded } = fakeDelegate(row());
    await new PrismaRunContextStore(delegate).patch("PAY-101", { branch: "maestro/PAY-101-v2" });

    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]?.data).toEqual({ branch: "maestro/PAY-101-v2" });
  });

  it("does not issue an update when nothing it owns changed", async () => {
    const { delegate, recorded } = fakeDelegate(row());
    // `runId`, `ticket` and `app` are not this store's columns to write.
    await new PrismaRunContextStore(delegate).patch("PAY-101", { runId: "other" });
    expect(recorded.updates).toHaveLength(0);
  });

  it("refuses to patch a ticket with no live run", async () => {
    const { delegate } = fakeDelegate(null);
    await expect(
      new PrismaRunContextStore(delegate).patch("PAY-999", { branch: "x" }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

/**
 * `toRunUpdate` is the whole partial-update contract, so it is tested directly:
 * an absent key must never become an explicit value, and a deliberately-null
 * one must never be dropped.
 */
describe("toRunUpdate", () => {
  it("produces nothing for an empty patch", () => {
    expect(toRunUpdate({})).toEqual({});
  });

  it("distinguishes an absent nullable field from one set to null", () => {
    expect(toRunUpdate({})).not.toHaveProperty("prId");
    expect(toRunUpdate({ prId: null })).toEqual({ prId: null });
    expect(toRunUpdate({ prId: 77 })).toEqual({ prId: 77 });

    expect(toRunUpdate({})).not.toHaveProperty("resumeToken");
    expect(toRunUpdate({ resumeToken: null })).toEqual({ resumeToken: null });
    expect(toRunUpdate({ resumeToken: "tok" })).toEqual({ resumeToken: "tok" });
  });

  it("keeps false and empty string, which a truthiness test would drop", () => {
    expect(toRunUpdate({ workspacePresent: false })).toEqual({ workspacePresent: false });
    expect(toRunUpdate({ branch: "" })).toEqual({ branch: "" });
  });

  it("copies array fields rather than storing the caller's reference", () => {
    const paths = ["a/**"];
    const update = toRunUpdate({ protectedPaths: paths });
    paths.push("b/**");
    expect(update.protectedPathsJson).toEqual(["a/**"]);
  });

  it("converts readonly command specs into a writable JSON shape", () => {
    const update = toRunUpdate({ verification: [{ name: "t", command: ["pnpm", "t"] }] });
    expect(update.verificationJson).toEqual([{ name: "t", command: ["pnpm", "t"] }]);
  });
});

/**
 * `create` — the row that has to exist before any activity can read a context.
 *
 * The deployment this method was written for had a worker polling an empty
 * queue: `signalWithStart` started executions and nothing wrote a run, so the
 * first activity of every run failed with `RunNotFoundError`. These tests pin
 * the two properties that failure mode needs — the row is written with the
 * workflow's own opening state, and calling twice for one ticket writes once.
 */
describe("PrismaRunContextStore.create", () => {
  const newRun = {
    runId: "run-1",
    ticket: "OPS-1",
    appId: "payments",
    mode: "ai_assist",
    dataClass: "gizli",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as const;

  it("opens the row at step 0 and status running", async () => {
    const { delegate, recorded } = fakeDelegate(null);
    await new PrismaRunContextStore(delegate).create(newRun);

    expect(recorded.creates).toHaveLength(1);
    const created = recorded.creates[0] as RunCreate;
    expect(created.id).toBe("run-1");
    expect(created.ticketKey).toBe("OPS-1");
    expect(created.appId).toBe("payments");
    expect(created.step).toBe("0");
    expect(created.status).toBe("running");
  });

  it("is a no-op when the ticket already has a live run", async () => {
    // The second of two racing webhook deliveries: Temporal collapsed them into
    // one execution, so a second row would be the bug.
    const { delegate, recorded } = fakeDelegate(row());
    await new PrismaRunContextStore(delegate).create(newRun);
    expect(recorded.creates).toHaveLength(0);
  });

  it("treats a unique violation as success", async () => {
    // Both callers passed the pre-check simultaneously; the partial unique
    // index from migration 0002 rejected the loser. The row exists, which is
    // what the caller wanted, so the rejection must not propagate.
    const store = new PrismaRunContextStore({
      findFirst: () => Promise.resolve(null),
      update: () => Promise.resolve(undefined),
      create: () => Promise.reject(Object.assign(new Error("unique"), { code: "P2002" })),
    });
    await expect(store.create(newRun)).resolves.toBeUndefined();
  });

  it("propagates any other write failure", async () => {
    // A dead connection must not read as "run opened": intake would report a
    // started run whose row never existed, and the failure would surface one
    // activity later as "no live run" — far from its cause.
    const store = new PrismaRunContextStore({
      findFirst: () => Promise.resolve(null),
      update: () => Promise.resolve(undefined),
      create: () => Promise.reject(new Error("connection reset")),
    });
    await expect(store.create(newRun)).rejects.toThrow("connection reset");
  });
});
