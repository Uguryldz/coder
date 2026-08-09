import type {
  AnalysisDoc,
  CiResultSignal,
  DataClass,
  GateDecision,
  MatchResult,
  RiskTier,
  ScanResult,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";

/**
 * The workflow's whole contact with the world.
 *
 * A Temporal workflow must be deterministic and may not touch I/O, so every
 * side effect lives behind this interface and is implemented in
 * `packages/workflows/src/impl` against the wave 1-2 ports. Keeping the shape
 * here (and not in the implementation) is what lets the workflow be tested with
 * `TestWorkflowEnvironment` and a stub: sixteen days of waiting take
 * milliseconds because nothing real is called.
 */

export interface IntakeResult {
  complete: boolean;
  /** Present when the ticket is missing something (step 2b, M98). */
  question?: string;
}

export interface EngineeringResult {
  ok: boolean;
  resumeToken: string;
  changedFiles: number;
  diffSummary: string;
  /** Set when the agent gave up or hit a protected path (M52/M54). */
  handoverReason?: string;
}

export interface ReviewResult {
  approved: boolean;
  findings: string[];
}

export interface TestRunResult {
  passed: boolean;
  total: number;
  failed: number;
  coveragePct: number;
}

export type GateVerdict = { accepted: true } | { accepted: false; reason: string };

export interface PrRef {
  adoProject: string;
  adoRepo: string;
  prId: number;
}

export interface MaestroActivities {
  // ── step 0-3: intake, matching, analysis ────────────────────────────────
  resolveWorkMode(ticket: TicketKey): Promise<{ mode: WorkMode; dataClass: DataClass }>;
  matchApplication(ticket: TicketKey): Promise<MatchResult | null>;
  runIntake(ticket: TicketKey): Promise<IntakeResult>;
  askClarification(ticket: TicketKey, question: string): Promise<void>;
  discoverRepo(ticket: TicketKey, appId: string): Promise<{ files: number; modules: string[] }>;
  writeAnalysis(ticket: TicketKey, appId: string): Promise<{ analysis: AnalysisDoc; risk: RiskTier }>;
  publishAnalysis(ticket: TicketKey, analysis: AnalysisDoc): Promise<void>;
  fanOutChildren(ticket: TicketKey, analysis: AnalysisDoc): Promise<TicketKey[]>;

  // ── gates ───────────────────────────────────────────────────────────────
  openGate(ticket: TicketKey, step: StepId, ownerGroup: string): Promise<void>;
  /**
   * Persist a decision — and report whether the DIRECTORY accepted it.
   * `gates.ts` can only check what the payload claims; group membership is a
   * live lookup, so its verdict has to come back here. A refusal must leave the
   * gate open and tell the person why, never fail the run.
   */
  recordGateDecision(ticket: TicketKey, decision: GateDecision): Promise<GateVerdict>;
  /** Reminder ladder tick (M88); returns the next due moment, or null when done. */
  escalateGate(ticket: TicketKey, step: StepId, waitingHours: number): Promise<string | null>;

  // ── step 6-10: engineering, scanning, review, tests ──────────────────────
  runEngineering(
    ticket: TicketKey,
    resumeToken: string | null,
    task: string,
    attempt?: number,
  ): Promise<EngineeringResult>;
  /**
   * `attempt` distinguishes one lap of the M54 loop from the next. Without it
   * the idempotency key would have to come from the results, and three rounds
   * that failed identically would collapse into a single record — the evidence
   * package would then under-report what was actually run.
   */
  runScans(ticket: TicketKey, attempt?: number): Promise<ScanResult[]>;
  reviewDiff(ticket: TicketKey, attempt?: number): Promise<ReviewResult>;
  designTests(ticket: TicketKey, attempt?: number): Promise<{ scenarios: number }>;
  reviewTests(ticket: TicketKey, attempt?: number): Promise<ReviewResult>;
  runTests(ticket: TicketKey, attempt?: number): Promise<TestRunResult>;

  // ── step 10b-13: PR, CI, closure ─────────────────────────────────────────
  openPullRequest(ticket: TicketKey): Promise<PrRef>;
  activatePullRequest(ticket: TicketKey, pr: PrRef): Promise<void>;
  /** Rejects a signal whose origin does not match the run's application (M106). */
  verifyCiOrigin(ticket: TicketKey, signal: CiResultSignal): Promise<boolean>;
  mergePullRequest(ticket: TicketKey, pr: PrRef): Promise<{ mergeSha: string }>;
  buildEvidencePackage(ticket: TicketKey): Promise<{ files: number; storageKey: string }>;
  closeTicket(ticket: TicketKey): Promise<void>;

  // ── cross-cutting ────────────────────────────────────────────────────────
  journal(ticket: TicketKey, kind: string, title: string, detail: string): Promise<void>;
  handOverToHuman(ticket: TicketKey, reason: string): Promise<void>;
}
