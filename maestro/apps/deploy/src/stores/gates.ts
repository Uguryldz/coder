import { GateDecision, type AuditAction, type StepId } from "@maestro/contracts";
import type { GateRecord, GateStore } from "@maestro/workflows";

/**
 * The Postgres-backed `GateStore` (M88).
 *
 * Two things make this more than a table wrapper:
 *
 *  1. `open` is idempotent at the DATABASE level, not in a read-then-write.
 *     `openedAt` is the escalation ladder's anchor, so a duplicated signal
 *     that moved it would silently restart the ladder on a gate that has been
 *     waiting three days.
 *  2. `decisions` does not read a decisions table, because there is no such
 *     table and there must not be. A gate decision's `signatureSeq` IS the seq
 *     of the audit record it produced (M33), so the audit chain is the only
 *     place a signed approval can honestly come from — a second copy would be
 *     a second answer to "who approved this", and the copy is the one that
 *     cannot be verified.
 */

/** The `Gate` row as read back. */
export interface GateRow {
  runId: string;
  step: string;
  ownerGroup: string;
  openedAt: Date;
  firedStepIds: string[];
  closedAt: Date | null;
}

export interface GateDelegate {
  findUnique(args: {
    where: { runId_step: { runId: string; step: string } };
  }): Promise<GateRow | null>;
  upsert(args: {
    where: { runId_step: { runId: string; step: string } };
    create: {
      runId: string;
      step: string;
      ownerGroup: string;
      openedAt: Date;
      firedStepIds: string[];
    };
    update: Record<string, never>;
  }): Promise<GateRow>;
  update(args: {
    where: { runId_step: { runId: string; step: string } };
    data: { firedStepIds?: { push: string[] }; closedAt?: Date };
  }): Promise<unknown>;
}

/**
 * The two audit actions that record a human decision on a gate (M33).
 *
 * `GATE_APPROVE`/`GATE_REJECT` are `humanOnly` in `@maestro/audit`'s action
 * table, which is what makes a decision found here a decision a PERSON signed
 * — an AI or a service account cannot produce one of these records at all.
 */
const DECISION_ACTIONS = ["GATE_APPROVE", "GATE_REJECT"] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** The `AuditLog` rows a decision is reconstructed from. */
export interface AuditRow {
  seq: bigint;
  at: Date;
  actor: string;
  action: AuditAction;
  metaJson: unknown;
}

export interface AuditDelegate {
  findMany(args: {
    where: {
      action: { in: DecisionAction[] };
      metaJson: { path: string[]; equals: string };
    };
    orderBy: { seq: "asc" };
  }): Promise<AuditRow[]>;
}

export class GateNotFoundError extends Error {
  constructor(runId: string, step: string) {
    super(`gate: no gate ${step} on run ${runId}`);
    this.name = "GateNotFoundError";
  }
}

export class PrismaGateStore implements GateStore {
  constructor(
    private readonly gates: GateDelegate,
    private readonly audit: AuditDelegate,
    /** Resolves the run a decision belongs to; the audit row keys by ticket. */
    private readonly ticketOfRun: (runId: string) => Promise<string>,
  ) {}

  /**
   * Idempotent by primary key.
   *
   * `upsert` with an EMPTY update is the whole trick: two workers racing the
   * same signal both issue it, one inserts, the other's update writes nothing
   * and returns the existing row. A read-then-insert would let both read "no
   * gate" and both insert, and a `findFirst`-then-`create` would make the
   * ladder's anchor depend on which one lost.
   */
  async open(runId: string, step: StepId, ownerGroup: string, at: string): Promise<GateRecord> {
    const row = await this.gates.upsert({
      where: { runId_step: { runId, step } },
      create: { runId, step, ownerGroup, openedAt: new Date(at), firedStepIds: [] },
      update: {},
    });
    return toRecord(row);
  }

  async get(runId: string, step: StepId): Promise<GateRecord | null> {
    const row = await this.gates.findUnique({ where: { runId_step: { runId, step } } });
    return row === null ? null : toRecord(row);
  }

  /**
   * Appends with `push`, never with a read-modify-write.
   *
   * Two reminders resolving at the same instant would both read `["s24"]`,
   * both write `["s24","s72"]` and lose one of the two — and a ladder step
   * that was recorded as unfired fires again. `push` is a single UPDATE the
   * database serialises for us.
   *
   * A missing gate is an error rather than a no-op (the in-memory reference
   * double returns silently): marking a step fired on a gate that does not
   * exist means the ladder is escalating something nobody is waiting for, and
   * that is worth a page, not a shrug.
   */
  async markFired(runId: string, step: StepId, stepIds: readonly string[]): Promise<void> {
    if (stepIds.length === 0) return;
    await this.requireGate(runId, step);
    await this.gates.update({
      where: { runId_step: { runId, step } },
      data: { firedStepIds: { push: [...stepIds] } },
    });
  }

  /** Closing a gate that was never opened is a bug, and it is reported as one. */
  async close(runId: string, step: StepId, at: string): Promise<void> {
    await this.requireGate(runId, step);
    await this.gates.update({
      where: { runId_step: { runId, step } },
      data: { closedAt: new Date(at) },
    });
  }

  /**
   * The run's signed approvals, rebuilt from the audit chain.
   *
   * Every field of a `GateDecision` is either the audit row's own (`seq` →
   * `signatureSeq`, `actor` → `actorUserId`, `at`, and the action → approve or
   * reject) or was written into its `meta` when the decision was recorded. The
   * result is parsed with the CONTRACT schema rather than cast: a row whose
   * meta is missing `actorGroup`, or a rejection with no reason, is not a
   * decision this platform can put in an evidence package, and letting it
   * through as a half-built object would put an unsigned approval in front of
   * an auditor.
   */
  async decisions(runId: string): Promise<GateDecision[]> {
    const ticket = await this.ticketOfRun(runId);
    const rows = await this.audit.findMany({
      where: {
        action: { in: [...DECISION_ACTIONS] },
        metaJson: { path: ["ticketKey"], equals: ticket },
      },
      orderBy: { seq: "asc" },
    });

    const decisions: GateDecision[] = [];
    for (const row of rows) {
      const meta = (typeof row.metaJson === "object" && row.metaJson !== null ? row.metaJson : {}) as
        Record<string, unknown>;
      decisions.push(
        GateDecision.parse({
          step: meta["step"],
          decision: row.action === "GATE_APPROVE" ? "approve" : "reject",
          actorUserId: row.actor,
          actorGroup: meta["actorGroup"],
          sodVerified: meta["sodVerified"] === true,
          signatureSeq: Number(row.seq),
          source: meta["source"],
          at: row.at.toISOString(),
          ...(typeof meta["reason"] === "string" ? { reason: meta["reason"] } : {}),
        }),
      );
    }
    return decisions;
  }

  private async requireGate(runId: string, step: StepId): Promise<GateRow> {
    const row = await this.gates.findUnique({ where: { runId_step: { runId, step } } });
    if (row === null) throw new GateNotFoundError(runId, step);
    return row;
  }
}

function toRecord(row: GateRow): GateRecord {
  return {
    runId: row.runId,
    step: row.step as StepId,
    ownerGroup: row.ownerGroup,
    openedAt: row.openedAt.toISOString(),
    firedStepIds: [...row.firedStepIds],
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  };
}
