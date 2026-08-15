import type {
  FlowType,
  ListeningRuleRecord,
  ListeningStore,
  MatchKind,
} from "@maestro/bff";

/**
 * The Postgres-backed `ListeningStore` ("dinleme kuralları" surface).
 *
 * A listening rule is platform configuration an admin edits from Studio, so it
 * must survive a restart the same way connections and parameters do. This reads
 * and writes the `ListeningRule` table (migration 0011).
 *
 * The delegate is structural, like every other store here: `apps/bff` must not
 * depend on the generated client, and this file compiles before
 * `prisma generate` has run. The DB's CHECK constraints (matchKind/flowType
 * domains) are the source of truth; the narrowing casts below are honest because
 * the Zod validator on the write path is the only producer.
 */

/** One `ListeningRule` row, as read/written. */
export interface ListeningRuleRow {
  ruleId: string;
  projectKey: string;
  assigneeAccountId: string;
  matchKind: string;
  matchValue: string;
  flowType: string;
  priority: number;
  enabled: boolean;
}

export interface ListeningDelegate {
  findMany(args: {
    orderBy: [{ projectKey: "asc" }, { priority: "asc" }];
  }): Promise<ListeningRuleRow[]>;
  findUnique(args: { where: { ruleId: string } }): Promise<ListeningRuleRow | null>;
  upsert(args: {
    where: { ruleId: string };
    create: ListeningRuleRow;
    update: Omit<ListeningRuleRow, "ruleId">;
  }): Promise<unknown>;
  delete(args: { where: { ruleId: string } }): Promise<ListeningRuleRow>;
}

export class PrismaListeningStore implements ListeningStore {
  constructor(private readonly rules: ListeningDelegate) {}

  async list(): Promise<readonly ListeningRuleRecord[]> {
    const rows = await this.rules.findMany({
      orderBy: [{ projectKey: "asc" }, { priority: "asc" }],
    });
    return rows.map(toRecord);
  }

  async get(ruleId: string): Promise<ListeningRuleRecord | null> {
    const row = await this.rules.findUnique({ where: { ruleId } });
    return row === null ? null : toRecord(row);
  }

  async put(record: ListeningRuleRecord): Promise<void> {
    const row = toRow(record);
    const { ruleId: _ruleId, ...update } = row;
    await this.rules.upsert({ where: { ruleId: record.ruleId }, create: row, update });
  }

  async remove(ruleId: string): Promise<boolean> {
    // `delete` throws when the row is absent; a concurrent delete becomes the
    // "not found" the contract wants rather than an unhandled Prisma error.
    try {
      await this.rules.delete({ where: { ruleId } });
      return true;
    } catch {
      return false;
    }
  }
}

function toRecord(row: ListeningRuleRow): ListeningRuleRecord {
  return {
    ruleId: row.ruleId,
    projectKey: row.projectKey,
    assigneeAccountId: row.assigneeAccountId,
    matchKind: row.matchKind as MatchKind,
    matchValue: row.matchValue,
    flowType: row.flowType as FlowType,
    priority: row.priority,
    enabled: row.enabled,
  };
}

function toRow(record: ListeningRuleRecord): ListeningRuleRow {
  return {
    ruleId: record.ruleId,
    projectKey: record.projectKey,
    assigneeAccountId: record.assigneeAccountId,
    matchKind: record.matchKind,
    matchValue: record.matchValue,
    flowType: record.flowType,
    priority: record.priority,
    enabled: record.enabled,
  };
}
