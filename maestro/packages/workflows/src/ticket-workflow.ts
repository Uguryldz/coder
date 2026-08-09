import {
  condition,
  proxyActivities,
  setHandler,
  workflowInfo,
  ApplicationFailure,
} from "@temporalio/workflow";
import type {
  AnalysisDoc,
  CiResultSignal,
  DataClass,
  GateDecision,
  RiskTier,
  StepId,
  TicketKey,
  WorkMode,
  WorkflowRunState,
  WorkflowRunStatus,
} from "@maestro/contracts";
import type { EngineeringResult, MaestroActivities, PrRef } from "./activities.js";
import { canCloseGate, GATE_OWNER, gatesFor, isApprovalGate } from "./gates.js";
import {
  ciResultSignal,
  clarificationAnsweredSignal,
  gateDecisionSignal,
  killSwitchSignal,
  modeChangeSignal,
  prChangesRequestedSignal,
  runStateQuery,
} from "./signals.js";

/**
 * The delivery workflow: one Temporal execution per ticket, from the webhook
 * that created it to the merge that closes it.
 *
 * Three properties this file exists to guarantee, and which every change here
 * must preserve:
 *
 *  1. **It waits without cost.** A gate open for sixteen days is a `condition`,
 *     not a poll. Nothing is auto-approved, ever, and nothing times out into a
 *     decision — only reminders escalate (M88).
 *  2. **Context survives.** Engineering resumes the SAME agent session after a
 *     rejection, a CI failure or a PR thread (M30). The resume token is
 *     workflow state, so a redeploy does not lose it.
 *  3. **It fails closed.** Scans, CI origin, gate authority and the kill switch
 *     all stop the flow rather than let it through. The only way forward is a
 *     positive result.
 *
 * Determinism: no Date.now(), no Math.random(), no I/O. Everything real is an
 * activity; every decision is a pure function in `gates.ts`.
 */

const HOUR = 60 * 60 * 1000;

const acts = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

/** Long jobs get their own budget; the engineer may legitimately run for hours. */
const longActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "4 hours",
  retry: { maximumAttempts: 1 },
});

export interface TicketWorkflowInput {
  ticket: TicketKey;
  appId: string;
  mode: WorkMode;
  dataClass: DataClass;
}

export async function ticketWorkflow(input: TicketWorkflowInput): Promise<WorkflowRunStatus> {
  const started = new Date(workflowInfo().startTime).toISOString();

  // ── mutable run state, all of it workflow state (survives redeploys) ──────
  let step: StepId = "0";
  let status: WorkflowRunStatus = "running";
  let mode: WorkMode = input.mode;
  let risk: RiskTier = "orta";
  let analysis: AnalysisDoc | undefined;
  let resumeToken: string | null = null;

  let killed: "intake_only" | "all" | null = null;

  const approvers = new Map<StepId, string>();
  /**
   * Signal state lives on an object, not in `let`s: a handler mutates it from
   * outside the main flow, and TypeScript's narrowing would otherwise conclude
   * the variable is still `undefined` after we set it to `undefined` ourselves.
   */
  const inbox: {
    decision?: GateDecision;
    clarified: boolean;
    ci?: CiResultSignal;
    changesRequested?: string;
  } = { clarified: false };

  /**
   * Signal state is read through these, never directly. A `const x = inbox.y`
   * would be narrowed by TypeScript to whatever the last assignment in this
   * function put there (`undefined`), because property narrowing is not reset
   * across the `condition()` call that actually waits for the handler to run.
   * A function call result carries the declared type instead.
   */
  const takeDecision = (): GateDecision | undefined => inbox.decision;
  const takeCi = (): CiResultSignal | undefined => inbox.ci;

  setHandler(runStateQuery, (): WorkflowRunState => ({
    runId: workflowInfo().workflowId,
    ticketKey: input.ticket,
    step,
    status,
    risk,
    startedAt: started,
    updatedAt: started,
  }));

  setHandler(gateDecisionSignal, (d) => {
    inbox.decision = d;
  });
  setHandler(clarificationAnsweredSignal, () => {
    inbox.clarified = true;
  });
  setHandler(ciResultSignal, (s) => {
    inbox.ci = s;
  });
  setHandler(prChangesRequestedSignal, (t) => {
    inbox.changesRequested = t.text;
  });
  setHandler(modeChangeSignal, (m) => {
    mode = m.mode;
  });
  setHandler(killSwitchSignal, (k) => {
    killed = k.level;
  });

  /** Every step transition goes through here so the journal never has holes. */
  const goto = async (next: StepId, note: string): Promise<void> => {
    step = next;
    await acts.journal(input.ticket, "other", `adım ${next}`, note);
  };

  /**
   * Wait at a human gate until somebody decides. Reminders fire on the
   * parameterised ladder; they never decide anything themselves (M88).
   * Returns the decision — approve continues, reject sends the flow back.
   */
  const awaitGate = async (at: StepId): Promise<GateDecision> => {
    const owner = GATE_OWNER[at as keyof typeof GATE_OWNER] ?? "tech-leads";
    status = "gate";
    inbox.decision = undefined;
    await acts.openGate(input.ticket, at, owner);

    let waited = 0;
    for (;;) {
      await condition(() => inbox.decision !== undefined, HOUR);
      const closed = takeDecision();
      if (closed !== undefined) {
        const verdict = canCloseGate(closed, at, approvers);
        if (!verdict.ok) {
          // Refused, not ignored: the person is told why and the gate stays open.
          await acts.journal(
            input.ticket,
            "gate",
            "karar reddedildi",
            `${closed.actorUserId} · ${verdict.reason}`,
          );
          inbox.decision = undefined;
          continue;
        }
        await acts.recordGateDecision(input.ticket, closed);
        if (closed.decision === "approve") approvers.set(at, closed.actorUserId);
        status = "running";
        return closed;
      }
      waited += 1;
      await acts.escalateGate(input.ticket, at, waited);
    }
  };

  /** The kill switch stops work between steps; it never abandons an open gate. */
  const assertNotKilled = async (): Promise<void> => {
    if (killed === "all") {
      status = "cancelled";
      await acts.journal(input.ticket, "other", "kill-switch", "tüm işler durduruldu (M58)");
      throw ApplicationFailure.nonRetryable("kill switch: all", "KillSwitch");
    }
  };

  const handOver = async (reason: string): Promise<WorkflowRunStatus> => {
    status = "handover";
    await acts.handOverToHuman(input.ticket, reason);
    return status;
  };

  // ── 0 · work mode ────────────────────────────────────────────────────────
  await goto("0", `work mode: ${mode} · veri sınıfı: ${input.dataClass}`);
  if (mode === "human_only") {
    // M73: the humans do the work; Maestro only keeps the record.
    await acts.journal(input.ticket, "other", "human-only", "Maestro yalnız kanıt topluyor");
    return handOver("human_only");
  }

  // ── 2 · intake, 2b · clarification ───────────────────────────────────────
  await assertNotKilled();
  await goto("2", "ticket tamlık kontrolü");
  const intake = await acts.runIntake(input.ticket);
  if (!intake.complete) {
    await goto("2b", "reporter'a soru soruldu");
    status = "gate";
    await acts.askClarification(input.ticket, intake.question ?? "");
    // Unbounded on purpose (M61): no auto-reject, no timeout into a decision.
    await condition(() => inbox.clarified);
    status = "running";
  }

  // ── 3ö · discovery, 3 · analysis ─────────────────────────────────────────
  await assertNotKilled();
  await goto("3o", "salt-okunur repo keşfi");
  await acts.discoverRepo(input.ticket, input.appId);

  await goto("3", "analiz üretiliyor");
  const written = await acts.writeAnalysis(input.ticket, input.appId);
  analysis = written.analysis;
  risk = written.risk;
  await acts.publishAnalysis(input.ticket, analysis);
  const children = await acts.fanOutChildren(input.ticket, analysis);
  if (children.length > 0) {
    await acts.journal(input.ticket, "analysis", "fan-out", `${children.length} alt ticket açıldı`);
  }

  // ── 4-5 · analysis gates, with the rejection loop ────────────────────────
  const required = gatesFor(risk);
  for (const gate of required.filter((g) => g === "4" || g === "5")) {
    await assertNotKilled();
    await goto(gate, "insan onayı bekleniyor");
    const verdict = await awaitGate(gate);
    if (verdict.decision === "reject") {
      // Back to analysis with the reason — the agent keeps its context (M54).
      await goto("3", `ret: ${verdict.reason ?? ""} — analiz yeniden yazılıyor`);
      const redone = await acts.writeAnalysis(input.ticket, input.appId);
      analysis = redone.analysis;
      await acts.publishAnalysis(input.ticket, analysis);
      approvers.clear();
      return ticketWorkflowContinue(input, { step: "4", risk });
    }
  }

  // ── 6a-10 · engineering loop ─────────────────────────────────────────────
  let attempt = 0;
  for (;;) {
    await assertNotKilled();
    attempt += 1;
    if (attempt > 3) return handOver("3 tur ilerleme yok (M54)");

    await goto("6a", `geliştirme turu ${attempt}`);
    const task = inbox.changesRequested ?? "analizdeki kabul kriterlerini karşıla";
    inbox.changesRequested = undefined;
    const eng: EngineeringResult = await longActs.runEngineering(input.ticket, resumeToken, task);
    resumeToken = eng.resumeToken;
    if (!eng.ok) {
      if (eng.handoverReason !== undefined) return handOver(eng.handoverReason);
      continue;
    }

    // 6b · scans — fail-closed: anything but a clean pass goes back (M27).
    await goto("6b", "güvenlik taraması");
    const scans = await acts.runScans(input.ticket);
    if (scans.some((s) => s.outcome !== "pass")) {
      await acts.journal(input.ticket, "scan", "tarama bloke etti", "bulgularla 6a'ya dönüldü");
      continue;
    }

    // 6c · dev-reviewer
    await goto("6c", "diff incelemesi");
    const review = await acts.reviewDiff(input.ticket);
    if (!review.approved) {
      inbox.changesRequested = review.findings.join("\n");
      continue;
    }

    // 7-8 · test design and its four-eyes review
    await goto("7", "test senaryoları");
    await acts.designTests(input.ticket);
    await goto("8", "senaryo denetimi");
    const testReview = await acts.reviewTests(input.ticket);
    if (!testReview.approved) {
      inbox.changesRequested = testReview.findings.join("\n");
      continue;
    }

    // 9 · QA scenario gate (only in the tiers that require it)
    if (required.includes("9")) {
      await assertNotKilled();
      await goto("9", "QA senaryo onayı");
      const qa = await awaitGate("9");
      if (qa.decision === "reject") {
        inbox.changesRequested = qa.reason ?? "";
        continue;
      }
    }

    // 10 · the tests actually run
    await goto("10", "testler koşuyor");
    const run = await acts.runTests(input.ticket);
    if (!run.passed) {
      await acts.journal(input.ticket, "test_run", "testler kırmızı", `${run.failed}/${run.total}`);
      continue;
    }
    break;
  }

  // ── 10b · PR and the CI gate ─────────────────────────────────────────────
  await assertNotKilled();
  const pr: PrRef = await acts.openPullRequest(input.ticket);
  await acts.activatePullRequest(input.ticket, pr);
  await goto("10b", `PR #${pr.prId} · build validation bekleniyor`);

  for (;;) {
    inbox.ci = undefined;
    await condition(() => inbox.ci !== undefined);
    const signal = takeCi();
    if (signal === undefined) continue;
    // M106: a signal whose origin is not this run's repo is not evidence.
    if (!(await acts.verifyCiOrigin(input.ticket, signal))) {
      await acts.journal(input.ticket, "ci", "yabancı CI sinyali reddedildi", signal.adoRepo ?? "?");
      continue;
    }
    if (signal.status === "succeeded") break;
    await acts.journal(input.ticket, "ci", "CI kırmızı", "6a'ya dönülüyor");
    const fix: EngineeringResult = await longActs.runEngineering(
      input.ticket,
      resumeToken,
      "CI hatasını düzelt",
    );
    resumeToken = fix.resumeToken;
    if (!fix.ok && fix.handoverReason !== undefined) return handOver(fix.handoverReason);
  }

  // ── 11-12 · QA result and PR approval ────────────────────────────────────
  for (const gate of required.filter((g) => g === "11" || g === "12")) {
    await assertNotKilled();
    await goto(gate, "insan onayı bekleniyor");
    const verdict = await awaitGate(gate);
    if (verdict.decision === "reject") {
      inbox.changesRequested = verdict.reason ?? "";
      await goto("12b", "PR yorum döngüsü — aynı oturum devam");
      const fix: EngineeringResult = await longActs.runEngineering(
        input.ticket,
        resumeToken,
        inbox.changesRequested,
      );
      resumeToken = fix.resumeToken;
      if (!fix.ok && fix.handoverReason !== undefined) return handOver(fix.handoverReason);
      return ticketWorkflowContinue(input, { step: gate, risk });
    }
  }

  // ── 13 · merge, evidence, closure ────────────────────────────────────────
  await acts.mergePullRequest(input.ticket, pr);
  await goto("13", "kanıt paketi");
  const evidence = await acts.buildEvidencePackage(input.ticket);
  await acts.journal(input.ticket, "closure", "kanıt paketi", `${evidence.files} dosya`);
  await acts.closeTicket(input.ticket);
  status = "done";
  return status;
}

/**
 * Re-entry after a rejection loop. Kept as a named seam rather than a `goto`
 * so the history stays readable: wave 3's integration step replaces it with
 * `continueAsNew` once the activity set is wired, and the tests pin the shape.
 */
async function ticketWorkflowContinue(
  input: TicketWorkflowInput,
  _from: { step: StepId; risk: RiskTier },
): Promise<WorkflowRunStatus> {
  return ticketWorkflow(input);
}

export { isApprovalGate };
