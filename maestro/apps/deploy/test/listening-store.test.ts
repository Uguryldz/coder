import type { ListeningRuleRecord } from "@maestro/bff";
import { describe, expect, it } from "vitest";
import {
  PrismaListeningStore,
  type ListeningDelegate,
  type ListeningRuleRow,
} from "../src/stores/listening.js";

/**
 * The Postgres-backed listening-rule store, offline.
 *
 * The delegate is a Map keyed by `ruleId` — the `ListeningRule` table with its
 * primary key. Properties under test: a put/get round-trips every field, list is
 * ordered by (projectKey, priority), a restart (a new store over the same rows)
 * still reads them, and remove reports whether a row existed.
 */

function fakeDelegate(): { delegate: ListeningDelegate; rows: Map<string, ListeningRuleRow> } {
  const rows = new Map<string, ListeningRuleRow>();
  const delegate: ListeningDelegate = {
    findMany: () =>
      Promise.resolve(
        [...rows.values()].sort(
          (a, b) => a.projectKey.localeCompare(b.projectKey) || a.priority - b.priority,
        ),
      ),
    findUnique: (args) => Promise.resolve(rows.get(args.where.ruleId) ?? null),
    upsert: (args) => {
      const existing = rows.get(args.where.ruleId);
      rows.set(
        args.where.ruleId,
        existing === undefined ? args.create : { ...existing, ...args.update },
      );
      return Promise.resolve(rows.get(args.where.ruleId));
    },
    delete: (args) => {
      const existing = rows.get(args.where.ruleId);
      if (existing === undefined) return Promise.reject(new Error("not found"));
      rows.delete(args.where.ruleId);
      return Promise.resolve(existing);
    },
  };
  return { delegate, rows };
}

function record(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "OPS",
    assigneeAccountId: "712020:bot",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    // Faz 3 agent mapping — null is the stored form of "default agent".
    analystVariantId: null,
    engineerVariantId: null,
    ...over,
  };
}

describe("PrismaListeningStore", () => {
  it("round-trips every field through put/get", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record());
    expect(await store.get("lr_1")).toEqual(record());
  });

  it("survives a restart — a new store over the same rows reads them", async () => {
    const { delegate, rows } = fakeDelegate();
    await new PrismaListeningStore(delegate).put(record());
    const restarted = new PrismaListeningStore({
      ...delegate,
      findMany: () => Promise.resolve([...rows.values()]),
    });
    expect(await restarted.get("lr_1")).toEqual(record());
  });

  it("round-trips the Faz 3 agent-variant mapping (akış→ajan)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(
      record({ analystVariantId: "mobil-analist", engineerVariantId: "mobil-muhendis" }),
    );
    const read = await store.get("lr_1");
    expect(read?.analystVariantId).toBe("mobil-analist");
    expect(read?.engineerVariantId).toBe("mobil-muhendis");
  });

  it("an ABSENT variant field is stored as NULL (default agent), not dropped", async () => {
    const { delegate, rows } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    // A record written before the mapping existed carries no variant fields at
    // all — the column write must normalise that to NULL, never undefined.
    const { analystVariantId: _a, engineerVariantId: _e, ...legacy } = record();
    await store.put(legacy as ListeningRuleRecord);
    expect(rows.get("lr_1")?.analystVariantId).toBeNull();
    expect(rows.get("lr_1")?.engineerVariantId).toBeNull();
    expect((await store.get("lr_1"))?.analystVariantId).toBeNull();
  });

  it("lists ordered by (projectKey, priority)", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record({ ruleId: "b", projectKey: "OPS", priority: 200 }));
    await store.put(record({ ruleId: "a", projectKey: "OPS", priority: 50 }));
    await store.put(record({ ruleId: "c", projectKey: "APP", priority: 10 }));
    const list = await store.list();
    expect(list.map((r) => r.ruleId)).toEqual(["c", "a", "b"]);
  });

  it("remove reports whether the row existed", async () => {
    const { delegate } = fakeDelegate();
    const store = new PrismaListeningStore(delegate);
    await store.put(record());
    expect(await store.remove("lr_1")).toBe(true);
    expect(await store.remove("lr_1")).toBe(false);
    expect(await store.get("lr_1")).toBeNull();
  });
});
