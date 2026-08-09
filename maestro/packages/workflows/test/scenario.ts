import type { WorkflowHandle } from "@temporalio/client";
import type {
  AnalysisDoc,
  CiResultSignal,
  GateDecision,
  RiskTier,
  ScanResult,
  StepId,
} from "@maestro/contracts";
import type { MaestroActivities } from "../src/activities.js";
import { gateDecisionSignal } from "../src/signals.js";
import type { TicketWorkflowInput } from "../src/ticket-workflow.js";

/**
 * The world one workflow run happens in: the fixtures it is fed, the record of
 * what it asked for, and the stubs that answer it.
 *
 * Everything real is a stub, which is the point: with no I/O in the way the
 * time-skipping server runs sixteen days of waiting in milliseconds, and the
 * assertions are about the FLOW — which gate opened, which step it went back
 * to, which session it resumed — not about any adapter.
 */

export const TICKET = "PAY-101";
export const REPO = { adoProject: "BANK", adoRepo: "pay" } as const;

export function analysisDoc(risk: RiskTier): AnalysisDoc {
  return {
    templateVersion: "analysis@1.0.0",
    language: "tr",
    purpose: "ödeme akışında hata düzeltmesi",
    scope: { included: ["pay-api"], excluded: [] },
    impactMatrix: [{ appId: "pay", impacted: true, summary: "ana repo", source: "primary_repo_discovery" }],
    acceptanceCriteria: ["hata tekrarlanmıyor"],
    uiApiChanges: "yok",
    testApproach: "birim + entegrasyon",
    riskAndRollback: { risk: "düşük", mitigation: "feature flag", rollback: "revert" },
    riskTier: risk,
    riskReason: "sınırlı kapsam",
    clarificationsUsed: [],
  };
}

export function approval(step: StepId, over: Partial<GateDecision> = {}): GateDecision {
  const group = step === "4" ? "product-owners" : step === "9" || step === "11" ? "qa" : "tech-leads";
  return {
    step,
    decision: "approve",
    actorUserId: `${group}-${step}@bank`,
    actorGroup: group,
    sodVerified: true,
    signatureSeq: 1,
    source: "jira",
    at: "2026-08-09T09:00:00+03:00",
    ...over,
  } as GateDecision;
}

export function ciSignal(over: Partial<CiResultSignal> = {}): CiResultSignal {
  return {
    ticketKey: TICKET,
    ...REPO,
    prId: 77,
    buildId: 1001,
    status: "succeeded",
    finishedAt: "2026-08-09T10:00:00+03:00",
    ...over,
  };
}

/** A clean run of the mandatory trio (M27). */
export const PASS_SCAN: ScanResult = {
  tool: "gitleaks",
  imageDigest: "sha256:aa",
  startedAt: "2026-08-09T09:00:00+03:00",
  finishedAt: "2026-08-09T09:00:01+03:00",
  findings: [],
  outcome: "pass",
};

/** What a gate does when it opens: approve at once, wait, or reject first. */
export type GatePolicy =
  | { kind: "approve" }
  | { kind: "approve_after_hours"; hours: number }
  | { kind: "reject_once"; reason: string };

export interface ScenarioOptions {
  risk?: RiskTier;
  mode?: TicketWorkflowInput["mode"];
  gate?: (step: StepId, visit: number) => GatePolicy;
  /**
   * The build-validation results the CI gate will be given, in order. The last
   * one is repeated once the queue runs dry, which is what a real pipeline does
   * too: it reports the branch's current state every time it is asked.
   */
  ci?: readonly Partial<CiResultSignal>[];
}

/** Records what the workflow asked for, and drives it through its stubs. */
export class Scenario {
  readonly opened: StepId[] = [];
  readonly escalations: Array<{ step: StepId; hours: number }> = [];
  readonly journal: Array<{ kind: string; title: string; detail: string }> = [];
  readonly engineering: Array<{ resumeToken: string | null; task: string }> = [];
  readonly decisions: GateDecision[] = [];
  readonly handovers: string[] = [];
  readonly ciSignals: CiResultSignal[] = [];
  readonly visits = new Map<StepId, number>();
  handle: WorkflowHandle | null = null;
  /** True while the run is parked at 10b waiting for a build result. */
  ciGateOpen = false;
  private consumedCi = 0;
  private readonly ciQueue: CiResultSignal[];

  constructor(readonly options: ScenarioOptions = {}) {
    this.ciQueue = (options.ci ?? [{}]).map((over) => ciSignal(over));
  }

  /**
   * The build result the pipeline is currently reporting.
   *
   * The queue only advances when the workflow has actually LOOKED at the
   * current result (`verifyCiOrigin` is its only way of doing so). Advancing on
   * send instead would let the pipeline push the next result over one the
   * workflow never saw — and the rejected-foreign-signal case would silently
   * stop being tested.
   */
  nextCi(): CiResultSignal {
    const index = Math.min(this.consumedCi, this.ciQueue.length - 1);
    const signal = this.ciQueue[index] ?? ciSignal();
    this.ciSignals.push(signal);
    return signal;
  }

  noteCiConsumed(): void {
    this.consumedCi += 1;
  }

  get risk(): RiskTier {
    return this.options.risk ?? "dusuk";
  }

  policy(step: StepId): GatePolicy {
    const visit = (this.visits.get(step) ?? 0) + 1;
    this.visits.set(step, visit);
    return this.options.gate?.(step, visit) ?? { kind: "approve" };
  }

  async signal(decision: GateDecision): Promise<void> {
    await this.handle?.signal(gateDecisionSignal, decision);
  }
}

export function makeActivities(
  scenario: Scenario,
  overrides: Partial<MaestroActivities> = {},
): MaestroActivities {
  const base: MaestroActivities = {
    resolveWorkMode: async () => ({ mode: "full_auto", dataClass: "dahili" }),
    matchApplication: async () => ({ via: "rule", ruleId: "r1", appId: "pay" }),
    runIntake: async () => ({ complete: true }),
    askClarification: async () => {},
    discoverRepo: async () => ({ files: 12, modules: ["pay-core"] }),
    writeAnalysis: async () => ({ analysis: analysisDoc(scenario.risk), risk: scenario.risk }),
    publishAnalysis: async () => {},
    fanOutChildren: async () => [],

    openGate: async (_ticket, step) => {
      scenario.opened.push(step);
      const policy = scenario.policy(step);
      if (policy.kind === "approve") await scenario.signal(approval(step));
      if (policy.kind === "reject_once") {
        await scenario.signal({ ...approval(step), decision: "reject", reason: policy.reason });
      }
    },
    recordGateDecision: async (_ticket, decision) => {
      scenario.decisions.push(decision);
    },
    escalateGate: async (_ticket, step, waitingHours) => {
      scenario.escalations.push({ step, hours: waitingHours });
      const policy = scenario.options.gate?.(step, scenario.visits.get(step) ?? 1) ?? { kind: "approve" };
      // Reminders NEVER decide (M88); this only simulates the human who
      // eventually reacts to one of them.
      if (policy.kind === "approve_after_hours" && waitingHours >= policy.hours) {
        await scenario.signal(approval(step));
      }
      return null;
    },

    runEngineering: async (_ticket, resumeToken, task) => {
      scenario.engineering.push({ resumeToken, task });
      return { ok: true, resumeToken: resumeToken ?? "session-1", changedFiles: 3, diffSummary: "+30 -4" };
    },
    runScans: async () => [PASS_SCAN],
    reviewDiff: async () => ({ approved: true, findings: [] }),
    designTests: async () => ({ scenarios: 6 }),
    reviewTests: async () => ({ approved: true, findings: [] }),
    runTests: async () => ({ passed: true, total: 42, failed: 0, coveragePct: 88 }),

    openPullRequest: async () => ({ ...REPO, prId: 77 }),
    activatePullRequest: async () => {},
    verifyCiOrigin: async (_ticket, signal) => {
      scenario.noteCiConsumed();
      const ok = signal.adoProject === REPO.adoProject && signal.adoRepo === REPO.adoRepo;
      // Only an accepted GREEN build lets the workflow leave 10b, so that is
      // the only thing that stops the pipeline from reporting again.
      if (ok && signal.status === "succeeded") scenario.ciGateOpen = false;
      return ok;
    },
    mergePullRequest: async () => ({ mergeSha: "abcdef1" }),
    buildEvidencePackage: async () => ({ files: 4, storageKey: "evidence/2026/PAY-101/run/manifest.json" }),
    closeTicket: async () => {},

    journal: async (_ticket, kind, title, detail) => {
      scenario.journal.push({ kind, title, detail });
      // The workflow announces the step it has moved to; 10b is where a build
      // result is expected, and a re-entry after 12b opens the gate again.
      if (title === "adım 10b") scenario.ciGateOpen = true;
    },
    handOverToHuman: async (_ticket, reason) => {
      scenario.handovers.push(reason);
    },
  };
  return { ...base, ...overrides };
}
