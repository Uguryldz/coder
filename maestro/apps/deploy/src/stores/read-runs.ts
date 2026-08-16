import type {
  AppId,
  DataClass,
  MatchResult,
  RiskTier,
  TicketKey,
  WorkMode,
  WorkflowRunStatus,
} from "@maestro/contracts";
import {
  encodeCursor,
  decodeCursor,
  type Page,
  type RunCatalog,
  type RunCatalogFilter,
  type RunRecord,
} from "@maestro/bff";

/**
 * The Postgres-backed `RunCatalog` (M99/M100) — Studio's ticket list.
 *
 * Two things make this more than a `findMany`:
 *
 *  1. **The project scope is part of the QUERY, not a filter applied after.**
 *     `projectKeys` comes from the caller's directory groups (M86), and the
 *     BFF's contract is that a page of `limit` rows is a page of rows the
 *     caller may actually see. Fetching a page and then dropping the rows they
 *     may not see would silently shorten every page — and, worse, would let a
 *     caller measure another project's volume by how short their page came
 *     back. The scope is therefore a `WHERE` clause, applied before `LIMIT`.
 *
 *  2. **The fan-out family is derived from `matchJson`, not stored twice.**
 *     `RunRecord` carries `parentTicketKey` and `childTicketKeys`, and there is
 *     no parent/child column: the relationship IS the `analysis_fanout`
 *     `MatchResult` a child was created with (M100). Reading it back from the
 *     match is what keeps the two from disagreeing — a denormalised copy would
 *     eventually name a parent the match does not.
 */

/** The `WorkflowRun` columns this read model touches, and no more. */
export interface RunCatalogRow {
  id: string;
  ticketKey: string;
  appId: string | null;
  mode: WorkMode;
  risk: RiskTier | null;
  dataClass: DataClass;
  /**
   * `WorkflowRun.status` — the Prisma enum, whose members are exactly
   * `WorkflowRunStatus`'s. Selected because Studio's list needs the platform's
   * verdict alongside the engine's: the reconciler writes `fail` here for a run
   * that died inside an activity, and the engine goes on reporting that run as
   * `running` because a crashed workflow cannot correct its own history.
   */
  status: WorkflowRunStatus;
  prId: number | null;
  matchJson: unknown;
  startedAt: Date;
  updatedAt: Date;
}

/** The `WHERE` this store builds; `ticketKey.startsWith` is the project scope. */
export interface RunCatalogWhere {
  appId?: string;
  OR?: { ticketKey: { startsWith: string } }[];
  ticketKey?: string;
}

export interface RunCatalogDelegate {
  findMany(args: {
    where: RunCatalogWhere;
    orderBy: { updatedAt: "desc" };
    skip?: number;
    take?: number;
  }): Promise<RunCatalogRow[]>;
  count(args: { where: RunCatalogWhere }): Promise<number>;
}

/**
 * Per-run consumption, summed from the gateway call log (M16).
 *
 * `RunRecord.costUsd`/`tokensIn`/`tokensOut` are totals, and they are computed
 * from `LlmCall` rather than kept on the run row for the same reason the
 * fan-out family is: the call log is where a call is actually recorded, so a
 * total derived from it cannot drift from the calls it claims to sum.
 */
export interface RunCostDelegate {
  groupBy(args: {
    by: ["runId"];
    where: { runId: { in: string[] } };
    _sum: { tokensIn: true; tokensOut: true; usd: true };
  }): Promise<RunCostGroup[]>;
}

export interface RunCostGroup {
  runId: string | null;
  _sum: {
    tokensIn: number | null;
    tokensOut: number | null;
    usd: { toNumber(): number } | null;
  };
}

/** Totals for one run; absent from the map when the run made no calls. */
interface RunTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The scope as a `WHERE` fragment.
 *
 * `null` means "every project" (a cross-project role, M86) and produces no
 * clause at all. An EMPTY list is the opposite and must not be confused with
 * it: an account in no project group sees nothing, so the clause has to match
 * nothing rather than be omitted. `OR: []` is Prisma's "no row matches", which
 * is precisely the fail-closed reading.
 */
export function scopeWhere(projectKeys: readonly string[] | null): RunCatalogWhere {
  if (projectKeys === null) return {};
  return { OR: projectKeys.map((key) => ({ ticketKey: { startsWith: `${key}-` } })) };
}

/**
 * The parent a fan-out child was created under, from its `MatchResult`.
 *
 * Anything that is not an `analysis_fanout` match has no parent — including a
 * malformed `matchJson`, which is read as "no parent" rather than trusted for
 * a ticket key. The value is JSON from a column, so it is checked structurally
 * before a field is read off it.
 */
export function parentOf(matchJson: unknown): TicketKey | null {
  if (typeof matchJson !== "object" || matchJson === null) return null;
  const match = matchJson as Partial<MatchResult> & { parentTicketKey?: unknown };
  if (match.via !== "analysis_fanout") return null;
  return typeof match.parentTicketKey === "string" ? match.parentTicketKey : null;
}

export class PrismaRunCatalog implements RunCatalog {
  constructor(
    private readonly runs: RunCatalogDelegate,
    private readonly calls: RunCostDelegate,
  ) {}

  /**
   * One run by ticket key.
   *
   * Unscoped on purpose: the route that calls this checks `assertProjectAccess`
   * BEFORE the lookup, so a caller never reaches here for a ticket they may not
   * see. Adding a second scope check here would need a `projectKeys` argument
   * the interface does not have, and inventing one would be a different answer
   * to "may I see this" than the route's — the copy that disagrees in the
   * caller's favour being the one nobody notices.
   */
  async get(ticketKey: string): Promise<RunRecord | null> {
    const [row] = await this.runs.findMany({
      where: { ticketKey },
      orderBy: { updatedAt: "desc" },
      take: 1,
    });
    if (row === undefined) return null;
    const [record] = await this.decorate([row]);
    return record ?? null;
  }

  /**
   * One page of the ticket list, newest activity first.
   *
   * The offset comes from the cursor and the count from the same `WHERE`, so
   * `nextCursor` is `null` exactly when the page reached the end of the
   * filtered set — the same rule `paginate` applies in memory, expressed in
   * SQL because the rows must not all be loaded to slice one page out.
   */
  async list(filter: RunCatalogFilter): Promise<Page<RunRecord>> {
    const where: RunCatalogWhere = {
      ...scopeWhere(filter.projectKeys),
      ...(filter.appId === null ? {} : { appId: filter.appId }),
    };
    // The same fingerprint the in-memory catalog uses, so a cursor means the
    // same thing whichever implementation issued it.
    const fingerprint = `runs:${filter.appId ?? ""}`;
    const offset = decodeCursor(filter.cursor, fingerprint);

    const rows = await this.runs.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: offset,
      take: filter.limit,
    });
    const total = await this.runs.count({ where });
    const next = offset + rows.length;

    return {
      items: await this.decorate(rows),
      nextCursor: next < total ? encodeCursor(next, fingerprint) : null,
    };
  }

  /**
   * Rows -> records: the two joins Studio's list needs.
   *
   * Both are batched across the whole page rather than issued per row — a
   * per-row query here is the classic N+1 that turns a 50-row page into 101
   * round trips.
   */
  private async decorate(rows: readonly RunCatalogRow[]): Promise<RunRecord[]> {
    const totals = await this.totalsFor(rows.map((row) => row.id));
    const children = this.childrenOf(rows);
    return rows.map((row) => toRunRecord(row, totals.get(row.id), children.get(row.ticketKey)));
  }

  /** Consumption per run id, from the call log. */
  private async totalsFor(runIds: readonly string[]): Promise<Map<string, RunTotals>> {
    const totals = new Map<string, RunTotals>();
    if (runIds.length === 0) return totals;

    const groups = await this.calls.groupBy({
      by: ["runId"],
      where: { runId: { in: [...runIds] } },
      _sum: { tokensIn: true, tokensOut: true, usd: true },
    });
    for (const group of groups) {
      if (group.runId === null) continue;
      totals.set(group.runId, {
        // `usd` is null for subscription drivers (M55) and sums to null when
        // every call on a run was one; that is zero spend, not unknown spend.
        costUsd: group._sum.usd?.toNumber() ?? 0,
        tokensIn: group._sum.tokensIn ?? 0,
        tokensOut: group._sum.tokensOut ?? 0,
      });
    }
    return totals;
  }

  /**
   * Children per parent ticket, for the rows ON THIS PAGE.
   *
   * Scoped to the page deliberately: a page's children are the ones the caller
   * can already see, and querying the whole table for every parent would leak
   * the existence of children in projects the caller has no access to.
   */
  private childrenOf(rows: readonly RunCatalogRow[]): Map<string, TicketKey[]> {
    const children = new Map<string, TicketKey[]>();
    for (const row of rows) {
      const parent = parentOf(row.matchJson);
      if (parent === null) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(row.ticketKey);
      children.set(parent, siblings);
    }
    return children;
  }
}

/**
 * Row -> `RunRecord`.
 *
 * `title`, `reporter` and `assignee` are Jira's facts, and `WorkflowRun` has
 * no column for any of them — see `read-degraded.ts` for why they are the
 * ticket key and `""` rather than a plausible-looking invention.
 */
export function toRunRecord(
  row: RunCatalogRow,
  totals: RunTotals | undefined,
  children: readonly TicketKey[] | undefined,
): RunRecord {
  return {
    ticketKey: row.ticketKey,
    // The ticket key, not a summary this store does not have. A blank title
    // would render as an unnamed row; the key at least names the ticket, and
    // is what the caller clicks through on.
    title: row.ticketKey,
    appId: row.appId as AppId | null,
    mode: row.mode,
    // `risk` is nullable until the analysis sets it (M51); the read model is
    // not, and "dusuk" would be a claim that the run was assessed as low risk.
    // `orta` is the middle tier and the one the platform defaults an
    // unassessed run to elsewhere.
    risk: row.risk ?? "orta",
    dataClass: row.dataClass,
    // Straight through, NOT defaulted. The column is NOT NULL and carries the
    // platform's verdict; passing it verbatim is what lets the route notice
    // that the row says `fail` while the engine still says `running`.
    status: row.status,
    parentTicketKey: parentOf(row.matchJson),
    childTicketKeys: children ?? [],
    reporter: "",
    assignee: null,
    prId: row.prId,
    costUsd: totals?.costUsd ?? 0,
    tokensIn: totals?.tokensIn ?? 0,
    tokensOut: totals?.tokensOut ?? 0,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
