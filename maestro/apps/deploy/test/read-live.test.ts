import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@maestro/bff";
import {
  parentOf,
  PrismaRunCatalog,
  scopeWhere,
  toRunRecord,
  type RunCatalogDelegate,
  type RunCatalogRow,
  type RunCatalogWhere,
  type RunCostDelegate,
} from "../src/stores/read-runs.js";
import { toKnowledgeDoc } from "../src/stores/read-catalog.js";
import { ProbeHealthReader, safeNote, type ServiceProbe } from "../src/stores/read-health.js";
import { liveReadModels } from "../src/stores/read-live.js";
import { UNBACKED_READ_MODELS } from "../src/stores/read-models.js";

/**
 * The read side's logic, against fakes that enforce what the database enforces.
 *
 * The properties worth testing here are the ones a wrong implementation gets
 * wrong silently: a project scope that is applied AFTER the page (so the page
 * comes back short), a cursor that restarts instead of continuing, a total
 * that counts rows the caller may not see. Each of those renders as a plausible
 * screen, which is why they are asserted rather than eyeballed.
 */

/**
 * A `WorkflowRun` fake that applies the store's `WHERE` the way Postgres does:
 * the scope narrows the set BEFORE the offset and the count, so `count` and
 * `findMany` always agree about which rows exist.
 */
function fakeRuns(rows: RunCatalogRow[]): RunCatalogDelegate & { queries: RunCatalogWhere[] } {
  const queries: RunCatalogWhere[] = [];
  const matching = (where: RunCatalogWhere): RunCatalogRow[] => {
    queries.push(where);
    return rows
      .filter((row) => where.ticketKey === undefined || row.ticketKey === where.ticketKey)
      .filter((row) => where.appId === undefined || row.appId === where.appId)
      .filter(
        (row) =>
          where.OR === undefined ||
          where.OR.some((clause) => row.ticketKey.startsWith(clause.ticketKey.startsWith)),
      )
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  };
  return {
    queries,
    findMany: (args) => {
      const found = matching(args.where);
      const from = args.skip ?? 0;
      return Promise.resolve(found.slice(from, from + (args.take ?? found.length)));
    },
    count: (args) => Promise.resolve(matching(args.where).length),
  };
}

const noCosts: RunCostDelegate = { groupBy: () => Promise.resolve([]) };

function run(ticketKey: string, updatedAt: string, extra: Partial<RunCatalogRow> = {}): RunCatalogRow {
  return {
    id: `run-${ticketKey.toLowerCase()}`,
    ticketKey,
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    prId: null,
    matchJson: { via: "rule", ruleId: "rule-1", appId: "ugurpay" },
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(updatedAt),
    ...extra,
  };
}

describe("run catalog: project scope is a WHERE, not a post-filter", () => {
  it("never returns a run outside the caller's projects", async () => {
    const runs = fakeRuns([
      run("UGURPAY-1", "2026-01-03T00:00:00.000Z"),
      run("UGURWEB-2", "2026-01-02T00:00:00.000Z"),
      run("UGURMOB-3", "2026-01-01T00:00:00.000Z"),
    ]);
    const catalog = new PrismaRunCatalog(runs, noCosts);

    const page = await catalog.list({
      limit: 50,
      cursor: null,
      appId: null,
      projectKeys: ["UGURPAY"],
    });

    expect(page.items.map((item) => item.ticketKey)).toEqual(["UGURPAY-1"]);
  });

  it("fills a full page from the caller's own projects rather than shortening it", async () => {
    // Ten rows, only five visible. A store that paged first and filtered after
    // would return two of them; the caller asked for five they may see.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        run(`UGURPAY-${i}`, `2026-01-1${5 - i}T00:00:00.000Z`),
      ),
      ...Array.from({ length: 5 }, (_, i) => run(`OTHER-${i}`, `2026-01-2${i}T00:00:00.000Z`)),
    ];
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);

    const page = await catalog.list({
      limit: 5,
      cursor: null,
      appId: null,
      projectKeys: ["UGURPAY"],
    });

    expect(page.items).toHaveLength(5);
    expect(page.items.every((item) => item.ticketKey.startsWith("UGURPAY-"))).toBe(true);
    // Nothing beyond the visible five, so no cursor promising a further page.
    expect(page.nextCursor).toBeNull();
  });

  it("an account in no project group sees nothing, not everything", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([run("UGURPAY-1", "2026-01-01T00:00:00.000Z")]),
      noCosts,
    );

    const page = await catalog.list({ limit: 50, cursor: null, appId: null, projectKeys: [] });

    expect(page.items).toEqual([]);
  });

  it("a cross-project role (null) sees every project", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-1", "2026-01-02T00:00:00.000Z"),
        run("UGURWEB-2", "2026-01-01T00:00:00.000Z"),
      ]),
      noCosts,
    );

    const page = await catalog.list({ limit: 50, cursor: null, appId: null, projectKeys: null });

    expect(page.items.map((item) => item.ticketKey)).toEqual(["UGURPAY-1", "UGURWEB-2"]);
  });

  it("scopes by whole key segment, so UGURPAY does not match UGURPAYMENTS", () => {
    // The clause is `startsWith("UGURPAY-")`, not `startsWith("UGURPAY")`.
    const where = scopeWhere(["UGURPAY"]);
    expect(where.OR).toEqual([{ ticketKey: { startsWith: "UGURPAY-" } }]);
  });
});

describe("run catalog: paging", () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    run(`UGURPAY-${i}`, `2026-01-0${7 - i}T00:00:00.000Z`),
  );

  it("walks the whole list exactly once and then stops", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof catalog.list>> = await catalog.list({
        limit: 3,
        cursor,
        appId: null,
        projectKeys: null,
      });
      seen.push(...page.items.map((item) => item.ticketKey));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("restarts rather than continuing when handed another query's cursor", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);

    // A cursor minted for a DIFFERENT filter (a different appId fingerprint).
    const foreign = encodeCursor(4, "runs:someone-elses-app");
    const page = await catalog.list({
      limit: 3,
      cursor: foreign,
      appId: null,
      projectKeys: null,
    });

    // Page one again — a silent skip in a work queue is a ticket nobody sees.
    expect(page.items.map((item) => item.ticketKey)).toEqual([
      "UGURPAY-0",
      "UGURPAY-1",
      "UGURPAY-2",
    ]);
  });

  it("ignores a garbage cursor instead of throwing", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const page = await catalog.list({
      limit: 2,
      cursor: "not-a-cursor",
      appId: null,
      projectKeys: null,
    });
    expect(page.items).toHaveLength(2);
  });

  it("counts only rows inside the scope, so the cursor does not promise a page the caller cannot see", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-1", "2026-01-03T00:00:00.000Z"),
        run("OTHER-1", "2026-01-02T00:00:00.000Z"),
        run("OTHER-2", "2026-01-01T00:00:00.000Z"),
      ]),
      noCosts,
    );

    const page = await catalog.list({
      limit: 1,
      cursor: null,
      appId: null,
      projectKeys: ["UGURPAY"],
    });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("emits a cursor that decodes against its own fingerprint", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);
    const page = await catalog.list({ limit: 3, cursor: null, appId: null, projectKeys: null });

    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor, "runs:")).toBe(3);
  });
});

describe("run catalog: totals and the fan-out family", () => {
  it("sums consumption from the call log", async () => {
    const calls: RunCostDelegate = {
      groupBy: () =>
        Promise.resolve([
          {
            runId: "run-ugurpay-1",
            _sum: { tokensIn: 1200, tokensOut: 300, usd: { toNumber: () => 0.42 } },
          },
        ]),
    };
    const catalog = new PrismaRunCatalog(fakeRuns([run("UGURPAY-1", "2026-01-01T00:00:00.000Z")]), calls);

    const [record] = (await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null }))
      .items;

    expect(record?.costUsd).toBe(0.42);
    expect(record?.tokensIn).toBe(1200);
    expect(record?.tokensOut).toBe(300);
  });

  it("reports zero spend for a subscription run whose usd sums to null", async () => {
    const calls: RunCostDelegate = {
      groupBy: () =>
        Promise.resolve([
          { runId: "run-ugurpay-1", _sum: { tokensIn: 900, tokensOut: 100, usd: null } },
        ]),
    };
    const catalog = new PrismaRunCatalog(fakeRuns([run("UGURPAY-1", "2026-01-01T00:00:00.000Z")]), calls);

    const [record] = (await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null }))
      .items;

    expect(record?.costUsd).toBe(0);
    expect(record?.tokensIn).toBe(900);
  });

  it("reads the parent out of an analysis_fanout match", () => {
    expect(
      parentOf({ via: "analysis_fanout", appId: "ugurpay", parentTicketKey: "UGURPAY-500" }),
    ).toBe("UGURPAY-500");
  });

  it("treats a rule match, a null and a malformed match as having no parent", () => {
    expect(parentOf({ via: "rule", ruleId: "r", appId: "a" })).toBeNull();
    expect(parentOf(null)).toBeNull();
    expect(parentOf("not-json")).toBeNull();
    expect(parentOf({ via: "analysis_fanout", parentTicketKey: 42 })).toBeNull();
  });

  it("links children to their parent within the page", async () => {
    const catalog = new PrismaRunCatalog(
      fakeRuns([
        run("UGURPAY-500", "2026-01-03T00:00:00.000Z"),
        run("UGURPAY-501", "2026-01-02T00:00:00.000Z", {
          matchJson: { via: "analysis_fanout", appId: "ugurweb", parentTicketKey: "UGURPAY-500" },
        }),
      ]),
      noCosts,
    );

    const page = await catalog.list({ limit: 5, cursor: null, appId: null, projectKeys: null });
    const parent = page.items.find((item) => item.ticketKey === "UGURPAY-500");
    const child = page.items.find((item) => item.ticketKey === "UGURPAY-501");

    expect(parent?.childTicketKeys).toEqual(["UGURPAY-501"]);
    expect(child?.parentTicketKey).toBe("UGURPAY-500");
  });

  it("does not claim a run was assessed low risk when it has not been assessed", () => {
    const record = toRunRecord(
      run("UGURPAY-1", "2026-01-01T00:00:00.000Z", { risk: null }),
      undefined,
      undefined,
    );
    expect(record.risk).not.toBe("dusuk");
    expect(record.risk).toBe("orta");
  });
});

describe("run catalog: get", () => {
  it("returns null for a ticket with no run rather than an empty record", async () => {
    const catalog = new PrismaRunCatalog(fakeRuns([]), noCosts);
    expect(await catalog.get("UGURPAY-404")).toBeNull();
  });

  it("returns the newest row for a ticket that was re-run", async () => {
    const rows = [
      { ...run("UGURPAY-9", "2026-01-01T00:00:00.000Z"), id: "run-old" },
      { ...run("UGURPAY-9", "2026-06-01T00:00:00.000Z"), id: "run-new" },
    ];
    const catalog = new PrismaRunCatalog(fakeRuns(rows), noCosts);

    const record = await catalog.get("UGURPAY-9");

    expect(record?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("knowledge: an unlabelled corpus is confidential (M18)", () => {
  it("classifies every document gizli, never dahili", () => {
    const doc = toKnowledgeDoc({
      id: "bddk-uyum",
      kind: "policy",
      title: "bddk-uyum.md",
      version: 2,
      contentRef: "knowledge/bddk-uyum.md",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    // The table has no classification column, and the interface says an index
    // that cannot classify MUST report the strictest class.
    expect(doc.dataClass).toBe("gizli");
  });

  it("does not invent a relevance score", () => {
    const doc = toKnowledgeDoc({
      id: "api-tasarim",
      kind: "standard",
      title: "api-tasarim.md",
      version: 4,
      contentRef: "knowledge/api-tasarim.md",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    // There is no vector store; a confident-looking 0.93 would be a fiction.
    expect(doc.score).toBe(0);
  });

  it("versions the id so two versions of a document are distinguishable", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const base = { id: "analiz-sablonu", kind: "template", title: "t.md", contentRef: "k/t.md", updatedAt: at };
    expect(toKnowledgeDoc({ ...base, version: 2 }).id).not.toBe(
      toKnowledgeDoc({ ...base, version: 3 }).id,
    );
  });
});

describe("health: probes report what they established", () => {
  const ok = (service: string): ServiceProbe => ({
    service,
    version: "1.0",
    check: () => Promise.resolve(),
  });
  const broken = (service: string, error: Error): ServiceProbe => ({
    service,
    version: "1.0",
    check: () => Promise.reject(error),
  });

  it("reports a reachable service healthy", async () => {
    const reader = new ProbeHealthReader([ok("postgres")]);
    const [service] = await reader.services();

    expect(service?.state).toBe("healthy");
    expect(service?.note).toBeNull();
  });

  it("reports an unreachable service down instead of omitting it", async () => {
    const reader = new ProbeHealthReader([broken("temporal", new Error("connect ECONNREFUSED"))]);
    const [service] = await reader.services();

    expect(service?.service).toBe("temporal");
    expect(service?.state).toBe("down");
  });

  it("one broken probe does not take down the whole health page", async () => {
    const reader = new ProbeHealthReader([
      ok("postgres"),
      broken("temporal", new Error("nope")),
    ]);

    const services = await reader.services();

    expect(services.map((s) => s.state)).toEqual(["healthy", "down"]);
  });

  it("never lets a connection string reach the note", async () => {
    const leaky = new Error(
      "failed to connect to postgresql://maestro:hunter2@db.internal:5432/maestro",
    );
    const reader = new ProbeHealthReader([broken("postgres", leaky)]);

    const [service] = await reader.services();

    expect(service?.note).not.toContain("hunter2");
    expect(service?.note).not.toContain("postgresql://");
    expect(service?.note).toContain("withheld");
  });

  it("scrubs a non-Error rejection too", () => {
    expect(safeNote("postgresql://user:pw@host/db")).not.toContain("pw@host");
  });

  it("stamps every service with the same checked-at instant", async () => {
    const reader = new ProbeHealthReader([ok("postgres"), ok("temporal")], {
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    const services = await reader.services();

    expect(services.map((s) => s.checkedAt)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
    ]);
  });
});

describe("the wired set: what answers and what refuses", () => {
  const db = {
    workflowRun: fakeRuns([]),
    llmCall: { ...noCosts, findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    journalEntry: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    gate: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    application: {
      findUnique: () => Promise.resolve(null),
      findMany: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
    },
    repoCard: { findFirst: () => Promise.resolve(null) },
    knowledgeDoc: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    subscriptionAccount: { findMany: () => Promise.resolve([]) },
    evidencePackageRow: { findFirst: () => Promise.resolve(null) },
    jiraProjectBinding: {
      findMany: () => Promise.resolve([]),
      findUnique: () => Promise.resolve(null),
    },
  };
  const build = () =>
    liveReadModels({
      db,
      audit: { head: () => Promise.resolve(null), append: () => Promise.resolve(), read: () => Promise.resolve([]) },
      probes: [],
    });

  it("wires every model the platform has data for", () => {
    const read = build();
    for (const model of ["runs", "journal", "gates", "apps", "knowledge", "quota", "cost", "evidence", "audit", "health"] as const) {
      expect(read[model]).toBeDefined();
    }
  });

  it("refuses runners rather than reporting an empty fleet", async () => {
    // An empty page here would render "no runners" — indistinguishable from a
    // fleet that is present and idle.
    await expect(build().runners.list({ limit: 10, cursor: null })).rejects.toThrow(/not wired/);
    await expect(build().runners.sandboxes({ limit: 10, cursor: null })).rejects.toThrow(/not wired/);
  });

  it("refuses scans rather than reporting no findings", async () => {
    await expect(
      build().scans.list({ limit: 10, cursor: null, projectKeys: null }),
    ).rejects.toThrow(/not wired/);
  });

  it("names the two unbacked models for the boot banner", () => {
    expect(UNBACKED_READ_MODELS).toHaveLength(2);
    expect(UNBACKED_READ_MODELS.join(" ")).toContain("runners");
    expect(UNBACKED_READ_MODELS.join(" ")).toContain("scans");
  });

  it("refuses without leaking a connection string", async () => {
    const error = await build()
      .scans.list({ limit: 10, cursor: null, projectKeys: null })
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toMatch(/postgres(ql)?:\/\//);
  });
});
