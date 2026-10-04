import type {
  AnalysisDoc,
  CiResultSignal,
  GateDecision,
  RiskTier,
  StepId,
  WorkMode,
  WorkflowRunStatus,
} from "@maestro/contracts";

/**
 * One run's mutable state, and the queues the signal handlers write into.
 *
 * This lives apart from the workflow's step sequence for one reason: the
 * sequence is long, and a reader trying to answer "what does this run actually
 * remember, and what can the outside world change?" should not have to read it.
 * Everything here is plain data and pure functions — no Temporal, no activities
 * — so the queue semantics below are testable without a workflow environment.
 */

/**
 * The workflow clock, as an ISO string.
 *
 * Inside the Temporal sandbox `Date.now()` is replaced by the SDK with the
 * deterministic workflow time, so this replays identically. It lives HERE, in
 * the package's one shared no-Temporal-imports module, because two files now
 * stamp workflow time onto `RunState` — `ticket-workflow.ts` for the
 * clarification wait and `gate-loop.ts` for the gate — and two copies of "the
 * one place ambient time is read" is one copy too many for a rule that is only
 * worth anything while it stays mechanically checkable.
 */
export function workflowNow(): string {
  return new Date(Date.now()).toISOString();
}

/** How many times the SAME gate may reject before a human takes over (M54). */
export const MAX_GATE_REJECTIONS = 3;

/**
 * Signals are QUEUED, never latched into a single slot.
 *
 * A slot has two failure modes and both are real: a decision that arrives
 * before the gate opens is overwritten by the gate's own reset (the approver
 * answered a Jira comment early, and the gate then waits forever for a decision
 * that was already delivered), and two decisions in one task batch mean the
 * second overwrites the one the loop is about to consume — the run wedges
 * holding a signal it never looks at. The same applies to a build result that
 * lands while engineering is still running: ADO reports a finished build once
 * and never repeats it.
 *
 * A queue has neither failure mode: handlers only ever push, the loops only
 * ever shift, and nothing is ever bulk-cleared.
 */
export interface Inbox {
  decisions: GateDecision[];
  clarified: boolean;
  ciResults: CiResultSignal[];
  changesRequested?: string;
  /** Mode changes asked for mid-flight; answered, never silently dropped. */
  modeRequests: Array<{ mode: WorkMode; actor: string }>;
}

export function emptyInbox(): Inbox {
  return { decisions: [], clarified: false, ciResults: [], modeRequests: [] };
}

/**
 * Everything the run remembers. The workflow mutates this in place; the query
 * handler reads it. Keeping it in one object (rather than a dozen `let`s) is
 * what lets the step sequence stay readable and the handlers stay trivial.
 */
export interface RunState {
  step: StepId;
  status: WorkflowRunStatus;
  mode: WorkMode;
  risk: RiskTier;
  analysis?: AnalysisDoc;
  resumeToken: string | null;
  startedAt: string;
  updatedAt: string;
  killed: "intake_only" | "all" | null;
  /** Set once level ① has been answered, so the ledger says it exactly once. */
  intakeOnlyNoted: boolean;
  /** Who signed which gate — the four-eyes check reads this (M32). */
  approvers: Map<StepId, string>;
  /** Rejections per gate, carried across continuations (M54). */
  rejections: Map<StepId, number>;
  /**
   * Netleştirme sorusu sorulduktan sonraki an (ISO), koşu 2b'de beklerken.
   * Bekleme bitince `null`'a döner.
   *
   * Bu alan koşunun kendi verisi DEĞİL, dışarıya verilen bir eşik: Jira'dan
   * gelen bir olayın soruyu izleyip izlemediğini BFF ancak bununla ölçebilir.
   * Sorunun kendi yankısı (durum taşıma, yeniden atama, yorum) bu damgadan
   * ÖNCE düşer, kullanıcının düzeltmesi SONRA — tek ayrım noktası budur.
   */
  awaitingClarificationSince: string | null;
  /**
   * Onay kapısının açıldığı an (ISO), koşu o kapıda beklerken. Kapı kapanınca
   * `null`'a döner.
   *
   * `awaitingClarificationSince` ile aynı rolü, aynı gerekçeyle oynar: dışarıya
   * verilen bir ZAMAN EŞİĞİ. Kapı kararı artık statüyle de verilebiliyor
   * (`gateApproveStatus` / `gateReturnStatus`), ve ticket'ı incelemeye taşıyan
   * Maestro'nun kendisi olduğu için (`moveStatus("review", onReview)`) eşiksiz
   * bir okuma kapının kendi açılışını karar sanardı.
   */
  gateOpenedSince: string | null;
}

export function initialRunState(args: {
  startedAt: string;
  mode: WorkMode;
  risk: RiskTier;
  resumeToken: string | null;
  rejectionCounts: Record<string, number> | undefined;
}): RunState {
  return {
    step: "0",
    status: "running",
    mode: args.mode,
    risk: args.risk,
    resumeToken: args.resumeToken,
    startedAt: args.startedAt,
    updatedAt: args.startedAt,
    killed: null,
    intakeOnlyNoted: false,
    awaitingClarificationSince: null,
    gateOpenedSince: null,
    approvers: new Map(),
    rejections: new Map(
      Object.entries(args.rejectionCounts ?? {}).map(([step, count]) => [step as StepId, count]),
    ),
  };
}

/**
 * Count a rejection at `at` and say whether the strike limit is now spent.
 *
 * The counter lives in state that survives `continueAsNew` (M29). Held in a
 * local instead, it was reborn at zero on every re-entry, so M54 never fired
 * and a gate could be rejected indefinitely.
 */
export function countRejection(
  state: RunState,
  at: StepId,
): { count: number; exhausted: boolean } {
  const count = (state.rejections.get(at) ?? 0) + 1;
  state.rejections.set(at, count);
  return { count, exhausted: count >= MAX_GATE_REJECTIONS };
}

/** The counters, in the plain shape `continueAsNew` carries forward. */
export function rejectionCounts(state: RunState): Record<string, number> {
  return Object.fromEntries(state.rejections);
}
