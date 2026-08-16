import type { ApplicationRecord } from "@maestro/contracts";
import type { RunContext, RunContextStore } from "@maestro/workflows";

/**
 * `CommandSpec`, taken from the interface rather than imported.
 *
 * The type lives in `@maestro/execution`, which this package does not depend
 * on and should not start depending on for one structural shape. Deriving it
 * from `RunContext` is also strictly safer: if the contract's verification
 * shape changes, this alias changes with it and the mapper below stops
 * compiling, which is exactly the notification we want.
 */
type CommandSpec = RunContext["verification"][number];

/**
 * The Postgres-backed `RunContextStore` (Dalga 5).
 *
 * M44 clean room: `@maestro/workflows` defines the interface and never imports
 * Prisma — its activity tests all run offline against a Map. This is the real
 * one, and it lives in the composition root for the same reason
 * `PrismaUserDirectory` does: the package that owns the interface must stay
 * free of the driver.
 *
 * The delegate is structural rather than `PrismaClient["workflowRun"]`. That is
 * the house pattern (see `users.ts`) and it buys two things: this file
 * typechecks before `prisma generate` has run, and the four methods below are a
 * written-down statement of exactly how much of the table this store may touch.
 */

/** The `WorkflowRun` row as read back, joined to its application. */
export interface RunRow {
  id: string;
  ticketKey: string;
  mode: string;
  risk: string | null;
  dataClass: string;
  locale: string;
  variantId: string;
  templateVersion: string;
  workspacePath: string;
  workspacePresent: boolean;
  protectedPathsJson: unknown;
  verificationJson: unknown;
  branch: string;
  targetBranch: string;
  prId: number | null;
  resumeToken: string | null;
  application: ApplicationRow | null;
}

export interface ApplicationRow {
  appId: string;
  displayName: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  jiraComponent: string | null;
  maestroYamlPresent: boolean;
  createdVia: string;
}

/**
 * The columns `patch` may write. Every one is optional — that is the point.
 *
 * `risk` is typed as the contract's tier union rather than `string` because
 * the column is a Prisma enum; see `TERMINAL_STATUSES` for why that strictness
 * is the useful kind.
 */
export interface RunUpdate {
  risk?: NonNullable<RunContext["risk"]>;
  locale?: string;
  variantId?: string;
  templateVersion?: string;
  workspacePath?: string;
  workspacePresent?: boolean;
  protectedPathsJson?: string[];
  /**
   * The verification commands as WRITTEN. `CommandSpec`'s own fields are
   * `readonly`, and Prisma's JSON input type rejects that — reasonably, since
   * it serialises the value. The write shape is the same data with mutable
   * fields, which is also the shape `parseCommands` validates on the way back.
   */
  verificationJson?: Array<{ name: string; command: string[] }>;
  branch?: string;
  targetBranch?: string;
  prId?: number | null;
  resumeToken?: string | null;
}

/** The two `PrismaClient.workflowRun` methods this store uses, and no more. */
export interface RunDelegate {
  findFirst(args: {
    where: { ticketKey: string; status: { notIn: TerminalStatus[] } };
    orderBy: { startedAt: "desc" };
    include: { application: true };
  }): Promise<RunRow | null>;
  update(args: { where: { id: string }; data: RunUpdate }): Promise<unknown>;
}

/**
 * Statuses that mean "this run is over". `get` reads the newest run that is
 * NOT one of them, which is the same definition of "live" the partial unique
 * index uses (migration 0002, widened by 0011) — one place to change it, and
 * the store and the database agree on which run a ticket means.
 *
 * `fail` joined the set in 0011, and it had to join both halves at once. Until
 * then nothing ever wrote the status, so the omission was invisible; the
 * reconciler (`reconcile.ts`) writes it, and a `fail` row that still counted as
 * live would have been the worse bug of the two — the ticket's live slot stays
 * occupied, so `get` keeps handing activities a dead run's context and the next
 * `/ai-start` on that ticket dies on the unique index with P2002. A failed run
 * is over. Re-running it is the whole point of noticing it failed.
 *
 * The literal type is load-bearing: `WorkflowRun.status` is a Prisma enum, and
 * a `string[]` filter is rejected by the generated client. That rejection is
 * welcome — it is what stops a typo'd status from becoming a filter that
 * silently matches nothing and makes every run look live.
 */
export const TERMINAL_STATUSES = ["done", "cancelled", "fail"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export class RunNotFoundError extends Error {
  constructor(ticket: string) {
    super(`run context: no live run for ticket ${ticket}`);
    this.name = "RunNotFoundError";
  }
}

export class IncompleteRunContextError extends Error {
  constructor(ticket: string, missing: string) {
    super(`run context: run for ticket ${ticket} has no ${missing}`);
    this.name = "IncompleteRunContextError";
  }
}

export class PrismaRunContextStore implements RunContextStore {
  constructor(private readonly runs: RunDelegate) {}

  /**
   * Fail-closed on both halves.
   *
   * No live run is an error rather than an empty context: an activity that
   * gets `{}` back would carry on with an invented branch name and an empty
   * app, and the first thing it does with either is write to a bank's repo.
   *
   * A run with no `appId` is the same class of problem one level down. The
   * column is nullable — a run may be created before matching resolves an
   * application (M99) — but `RunContext.app` is not, and inventing a blank
   * `ApplicationRecord` here would send the engineering turn at repo "".
   */
  async get(ticket: string): Promise<RunContext> {
    const row = await this.liveRun(ticket);
    if (row === null) throw new RunNotFoundError(ticket);
    if (row.application === null) throw new IncompleteRunContextError(ticket, "application");
    return toRunContext(row, row.application);
  }

  /**
   * Partial update: a field the caller did not name is left alone.
   *
   * `undefined` is Prisma's "do not touch this column", so the mapping below
   * must never turn an absent key into an explicit value. `prId` and
   * `resumeToken` are the two that can be set BACK to null deliberately, so
   * they are forwarded when present and only then — which is why the
   * `in`-checks below are not the same as a truthiness test.
   */
  async patch(ticket: string, changes: Partial<RunContext>): Promise<void> {
    const row = await this.liveRun(ticket);
    if (row === null) throw new RunNotFoundError(ticket);

    const data = toRunUpdate(changes);
    // Nothing to write is not an error — a caller that patched only fields this
    // store does not own (runId, ticket, app) asked for no change to the row.
    if (Object.keys(data).length === 0) return;
    await this.runs.update({ where: { id: row.id }, data });
  }

  /**
   * The newest non-terminal run for a ticket.
   *
   * "Newest" matters as much as "non-terminal": a ticket that was re-run after
   * a kill switch has several rows, and the partial unique index from migration
   * 0002 only guarantees one of them is LIVE. Ordering by `startedAt` descending
   * means a race that briefly leaves two live rows resolves to the current one
   * rather than the abandoned one.
   */
  private liveRun(ticket: string): Promise<RunRow | null> {
    return this.runs.findFirst({
      where: { ticketKey: ticket, status: { notIn: [...TERMINAL_STATUSES] } },
      orderBy: { startedAt: "desc" },
      include: { application: true },
    });
  }
}

/** `Partial<RunContext>` -> the column subset, dropping absent keys. */
export function toRunUpdate(changes: Partial<RunContext>): RunUpdate {
  const data: RunUpdate = {};
  if (changes.risk !== undefined && changes.risk !== null) data.risk = changes.risk;
  if (changes.locale !== undefined) data.locale = changes.locale;
  if (changes.variantId !== undefined) data.variantId = changes.variantId;
  if (changes.templateVersion !== undefined) data.templateVersion = changes.templateVersion;
  if (changes.workspacePath !== undefined) data.workspacePath = changes.workspacePath;
  if (changes.workspacePresent !== undefined) data.workspacePresent = changes.workspacePresent;
  if (changes.protectedPaths !== undefined) data.protectedPathsJson = [...changes.protectedPaths];
  if (changes.verification !== undefined) {
    data.verificationJson = changes.verification.map((spec) => ({
      name: spec.name,
      command: [...spec.command],
    }));
  }
  if (changes.branch !== undefined) data.branch = changes.branch;
  if (changes.targetBranch !== undefined) data.targetBranch = changes.targetBranch;
  // Both are nullable in the contract, so `null` is a value to write, not an
  // absence to skip. `"prId" in changes` is what distinguishes the two.
  if ("prId" in changes) data.prId = changes.prId ?? null;
  if ("resumeToken" in changes) data.resumeToken = changes.resumeToken ?? null;
  return data;
}

function toRunContext(row: RunRow, app: ApplicationRow): RunContext {
  return {
    runId: row.id,
    ticket: row.ticketKey,
    app: toApplication(app),
    dataClass: row.dataClass as RunContext["dataClass"],
    mode: row.mode as RunContext["mode"],
    locale: row.locale as RunContext["locale"],
    variantId: row.variantId,
    templateVersion: row.templateVersion,
    workspacePath: row.workspacePath,
    workspacePresent: row.workspacePresent,
    protectedPaths: parseStrings(row.protectedPathsJson),
    verification: parseCommands(row.verificationJson),
    branch: row.branch,
    targetBranch: row.targetBranch,
    risk: (row.risk as RunContext["risk"]) ?? null,
    prId: row.prId,
    resumeToken: row.resumeToken,
  };
}

function toApplication(row: ApplicationRow): ApplicationRecord {
  return {
    appId: row.appId,
    displayName: row.displayName,
    adoProject: row.adoProject,
    adoRepo: row.adoRepo,
    platform: row.platform as ApplicationRecord["platform"],
    jiraComponent: row.jiraComponent,
    maestroYamlPresent: row.maestroYamlPresent,
    createdVia: row.createdVia as ApplicationRecord["createdVia"],
  };
}

/**
 * A JSON column holds whatever was written. Anything that is not an array of
 * strings reads as "none" — for `protectedPaths` that is the SAFE direction
 * only because the M52 deny-list these add to lives in `@maestro/workflows`
 * and applies regardless; this column carries the repo's additions, and a
 * malformed value must not be able to remove a path from the base list.
 */
function parseStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * `CommandSpec[]` from a JSON column, structurally validated.
 *
 * A half-parsed command is worse than none: `{ name: "test" }` with no argv
 * would reach the runner as a spawn of `undefined`. Entries that are not a
 * name plus a non-empty string argv are dropped, so what comes back is always
 * runnable.
 */
function parseCommands(value: unknown): CommandSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: CommandSpec[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, command } = entry as { name?: unknown; command?: unknown };
    if (typeof name !== "string" || name.length === 0) continue;
    if (!Array.isArray(command) || command.length === 0) continue;
    if (!command.every((part): part is string => typeof part === "string")) continue;
    specs.push({ name, command });
  }
  return specs;
}
