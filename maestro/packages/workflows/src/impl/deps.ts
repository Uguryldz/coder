import type {
  ApplicationRecord,
  DataClass,
  GateDecision,
  Locale,
  RiskTier,
  RoutingRule,
  RunId,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";
import type { AuditChain } from "@maestro/audit";
import type { AgentTurnRequest, AgentTurnResult, CommandSpec } from "@maestro/execution";
import type { JournalDeps } from "@maestro/memory";
import type { EscalationLadder, NotifyRouting } from "@maestro/notify";
import type {
  LlmPort,
  NotifyPort,
  PublishPort,
  ScanPort,
  ScmPort,
  SecretPort,
  StoragePort,
  WorkPort,
} from "@maestro/ports";

/**
 * Everything an activity needs, as INTERFACES.
 *
 * M44: no concrete driver is named anywhere in this package — `worker.ts`
 * resolves them from the registry and hands the result in. That is also what
 * keeps the activity tests offline: the same seams take fakes.
 */

/**
 * What a run is, beyond its ticket key.
 *
 * Activities receive a `TicketKey` and nothing else (the workflow may not carry
 * mutable business state through its arguments), so every fact an activity
 * needs about the run is read back from here. The store is the run's row in the
 * database; in tests it is a Map.
 */
export interface RunContext {
  readonly runId: RunId;
  readonly ticket: TicketKey;
  readonly app: ApplicationRecord;
  readonly dataClass: DataClass;
  readonly mode: WorkMode;
  readonly locale: Locale;
  /** Prompt-variant this run is pinned to (M38). */
  readonly variantId: string;
  /** Analysis template pinned at run start (M83). */
  readonly templateVersion: string;
  readonly workspacePath: string;
  /** False after an M65 archive — the clone is gone, the context is not. */
  readonly workspacePresent: boolean;
  /** The repo's ADDITIONS to the M52 deny-list, from `.maestro.yaml` (M71). */
  readonly protectedPaths: readonly string[];
  /** The repo's own lint/build/test commands (`.maestro.yaml`, M71). */
  readonly verification: readonly CommandSpec[];
  readonly branch: string;
  readonly targetBranch: string;
  readonly risk: RiskTier | null;
  readonly prId: number | null;
  /** Resume token of the live agent session (M30); null before the first turn. */
  readonly resumeToken: string | null;
}

export interface RunContextStore {
  get(ticket: TicketKey): Promise<RunContext>;
  patch(ticket: TicketKey, changes: Partial<RunContext>): Promise<void>;
}

/** One open (or closed) approval gate — the escalation ladder's anchor (M88). */
export interface GateRecord {
  readonly runId: RunId;
  readonly step: StepId;
  readonly ownerGroup: string;
  readonly openedAt: string;
  /** Ladder steps already sent; the ladder never fires the same one twice. */
  readonly firedStepIds: readonly string[];
  readonly closedAt: string | null;
}

export interface GateStore {
  /** Idempotent: re-opening an open gate returns the existing record. */
  open(runId: RunId, step: StepId, ownerGroup: string, at: string): Promise<GateRecord>;
  get(runId: RunId, step: StepId): Promise<GateRecord | null>;
  markFired(runId: RunId, step: StepId, stepIds: readonly string[]): Promise<void>;
  close(runId: RunId, step: StepId, at: string): Promise<void>;
  /** Approvers of already-closed gates — the evidence package's signature chain. */
  decisions(runId: RunId): Promise<GateDecision[]>;
}

/**
 * Operational settings (M71). All of them live in the database and are read
 * through here, so this package holds no second copy of any default.
 */
export interface ParamReader {
  escalationLadder(runId: RunId): Promise<EscalationLadder>;
  notifyRouting(runId: RunId): Promise<NotifyRouting>;
  routingRules(ticket: TicketKey): Promise<RoutingRule[]>;
  /** Publish targets for a document kind (M47). */
  publishTargets(runId: RunId, doc: "analysis" | "evidence_summary"): Promise<string[]>;
}

/** Who a notification goes to. Group → corporate addresses (M71). */
export interface DirectoryReader {
  membersOf(group: string): Promise<string[]>;
}

/** One doing-role turn (`@maestro/execution`'s `AgentExecution`). */
export interface AgentTurnRunner {
  runTurn(req: AgentTurnRequest): Promise<AgentTurnResult>;
  endRun(runId: string): void;
}

/**
 * Temporal retries activities, so every write goes through here: the guard
 * remembers the key and replays the first result instead of writing twice.
 * Production backs it with a table; tests back it with a Map.
 */
export interface IdempotencyGuard {
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Message-catalog lookup (M104), injected so this package owns no catalog. */
export type Translate = (locale: Locale, key: string, params?: Record<string, string>) => string;

export interface ActivityDeps {
  readonly runs: RunContextStore;
  readonly gates: GateStore;
  readonly params: ParamReader;
  readonly directory: DirectoryReader;
  readonly work: WorkPort;
  readonly scm: ScmPort;
  readonly llm: LlmPort;
  readonly scan: ScanPort;
  readonly storage: StoragePort;
  readonly secrets: SecretPort;
  readonly notify: NotifyPort;
  readonly publish: PublishPort;
  readonly memory: JournalDeps;
  readonly execution: AgentTurnRunner;
  readonly audit: AuditChain;
  readonly idempotency: IdempotencyGuard;
  readonly translate: Translate;
  readonly now: () => Date;
}

/** Actor recorded on everything the worker writes (M33 actor conventions). */
export const WORKER_ACTOR = "maestro-worker";
