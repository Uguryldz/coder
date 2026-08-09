import { condition, continueAsNew, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type {
  DataClass,
  RiskTier,
  StepId,
  TicketKey,
  WorkMode,
  WorkflowRunState,
  WorkflowRunStatus,
} from "@maestro/contracts";
import type { EngineeringResult, MaestroActivities, PrRef } from "./activities.js";
import { awaitGreenBuild, runEngineeringLoop } from "./engineering-loop.js";
import { answerModeRequests, assertNotKilled, awaitGate } from "./gate-loop.js";
import { gatesFor } from "./gates.js";
import { countRejection, emptyInbox, initialRunState, rejectionCounts } from "./run-state.js";
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
 *     rejection, a CI failure or a PR thread (M30), and the resume token is
 *     carried across `continueAsNew` in the input — a rejection loop is a
 *     continuation, not a restart (M29).
 *  3. **It fails closed.** Scans, CI origin, gate authority and the kill switch
 *     all stop the flow rather than let it through. The only way forward is a
 *     positive result.
 *
 * Determinism: no `Math.random()`, no `process.env`, no I/O, and the only clock
 * reading is `workflowNow()` below. Everything real is an activity; every
 * decision is a pure function in `gates.ts`.
 */

const acts = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * Thinking roles get a patient proxy. `queued` (M55: the subscription pool is
 * full) comes back as a retryable failure, and waiting for a quota window is a
 * legitimate hours-long wait — a three-attempt budget would drop the run.
 *
 * The budget is UNLIMITED rather than fifty, because fifty attempts on the
 * ladder below tops out around fifty hours, and a WEEKLY subscription quota can
 * legitimately be spent for longer than that: a run told "come back on Monday"
 * must not be dropped on Saturday. This is not an infinite-retry hazard — a
 * quota failure carries `nextRetryDelay` naming the moment the window reopens,
 * so the run sleeps until then and costs nothing, and every non-quota fault
 * here is non-retryable and still stops on the first attempt.
 *
 * `POSITIVE_INFINITY` is the SDK's spelling of "no limit": it drops the field,
 * which is the protocol's default. A literal `0` does NOT mean unlimited here —
 * `compileRetryPolicy` rejects it, and the run fails on its first thinking call.
 */
const thinkActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: Number.POSITIVE_INFINITY,
    initialInterval: "1 minute",
    maximumInterval: "1 hour",
    backoffCoefficient: 2,
  },
});

/** Long jobs get their own budget; the engineer may legitimately run for hours. */
const longActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "4 hours",
  retry: { maximumAttempts: 1 },
});

/**
 * The workflow clock, as an ISO string.
 *
 * Inside the Temporal sandbox `Date.now()` is replaced by the SDK with the
 * deterministic workflow time, so this replays identically. It is wrapped here,
 * once, so the rule the rest of this file follows — no ambient time anywhere
 * else — stays mechanically checkable.
 */
function workflowNow(): string {
  return new Date(Date.now()).toISOString();
}

export interface TicketWorkflowInput {
  ticket: TicketKey;
  appId: string;
  mode: WorkMode;
  dataClass: DataClass;
  /**
   * State that must OUTLIVE a `continueAsNew` (M29). A rejection loop starts a
   * new execution with a fresh history, so anything held in a local is gone:
   * the strike counter would reset (M54 never fires) and the agent session
   * would be lost on the second rejection (M30). Carrying it in the input is
   * what makes the continuation a continuation rather than a restart.
   */
  rejectionCounts?: Record<string, number>;
  /** The agent session to resume; `null`/absent starts a fresh one. */
  resumeToken?: string | null;
  /** The tier the analysis established, so a continuation reuses its gate set. */
  risk?: RiskTier;
}

export async function ticketWorkflow(input: TicketWorkflowInput): Promise<WorkflowRunStatus> {
  const ticket = input.ticket;
  const state = initialRunState({
    startedAt: new Date(workflowInfo().startTime).toISOString(),
    mode: input.mode,
    risk: input.risk ?? "orta",
    resumeToken: input.resumeToken ?? null,
    rejectionCounts: input.rejectionCounts,
  });
  const inbox = emptyInbox();

  setHandler(runStateQuery, (): WorkflowRunState => ({
    runId: workflowInfo().runId,
    ticketKey: ticket,
    step: state.step,
    status: state.status,
    risk: state.risk,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  }));

  // Handlers only ever PUSH. Nothing here consumes, decides or clears — the
  // loops below do that, which is what stops a signal from being overwritten
  // between arriving and being read.
  setHandler(gateDecisionSignal, (d) => void inbox.decisions.push(d));
  setHandler(clarificationAnsweredSignal, () => void (inbox.clarified = true));
  setHandler(ciResultSignal, (s) => void inbox.ciResults.push(s));
  setHandler(prChangesRequestedSignal, (t) => void (inbox.changesRequested = t.text));
  setHandler(modeChangeSignal, (m) => void inbox.modeRequests.push(m));
  setHandler(killSwitchSignal, (k) => void (state.killed = k.level));

  const gate = (at: StepId) => awaitGate(acts, state, inbox, ticket, at);
  const stopIfKilled = () => assertNotKilled(acts, state, ticket);

  /**
   * Every step transition goes through here, which is what makes this the one
   * place the kill switch has to be checked. Guarding individual loops instead
   * left whole chains of steps running after the stop — scans, reviews and test
   * runs are all new sandbox work — because each loop only looked once, at its
   * own top.
   */
  const goto = async (next: StepId, note: string): Promise<void> => {
    await stopIfKilled();
    await answerModeRequests(acts, state, inbox, ticket);
    state.step = next;
    // D1: this used to report `startedAt` forever, so a run that had been
    // working for six hours looked untouched in Studio.
    state.updatedAt = workflowNow();
    await acts.journal(ticket, "other", `adım ${next}`, note);
  };

  const handOver = async (reason: string): Promise<WorkflowRunStatus> => {
    state.status = "handover";
    await acts.handOverToHuman(ticket, reason);
    return state.status;
  };

  const continueRun = (): Promise<never> =>
    continueAsNew<typeof ticketWorkflow>({
      ...input,
      risk: state.risk,
      resumeToken: state.resumeToken,
      rejectionCounts: rejectionCounts(state),
    });

  // ── 0 · work mode ────────────────────────────────────────────────────────
  await goto("0", `work mode: ${state.mode} · veri sınıfı: ${input.dataClass}`);
  if (state.mode === "human_only") {
    // M73: the humans do the work; Maestro only keeps the record.
    await acts.journal(ticket, "other", "human-only", "Maestro yalnız kanıt topluyor");
    return handOver("human_only");
  }

  // ── 2 · intake, 2b · clarification ───────────────────────────────────────
  await goto("2", "ticket tamlık kontrolü");
  const intake = await thinkActs.runIntake(ticket);
  if (!intake.complete) {
    await goto("2b", "reporter'a soru soruldu");
    state.status = "gate";
    await acts.askClarification(ticket, intake.question ?? "");
    // Unbounded on purpose (M61): no auto-reject, no timeout into a decision.
    await condition(() => inbox.clarified);
    state.status = "running";
  }

  // ── 3ö · discovery, 3 · analysis ─────────────────────────────────────────
  await goto("3o", "salt-okunur repo keşfi");
  await acts.discoverRepo(ticket, input.appId);

  await goto("3", "analiz üretiliyor");
  const written = await thinkActs.writeAnalysis(ticket, input.appId);
  state.analysis = written.analysis;
  state.risk = written.risk;
  await acts.publishAnalysis(ticket, state.analysis);
  const children = await acts.fanOutChildren(ticket, state.analysis);
  if (children.length > 0) {
    await acts.journal(ticket, "analysis", "fan-out", `${children.length} alt ticket açıldı`);
  }

  // ── 4-5 · analysis gates, with the rejection loop ────────────────────────
  const required = gatesFor(state.risk);
  for (const at of required.filter((g) => g === "4" || g === "5")) {
    await goto(at, "insan onayı bekleniyor");
    const verdict = await gate(at);
    if (verdict.decision === "reject") {
      const strike = countRejection(state, at);
      if (strike.exhausted) return handOver(`${at} kapısında ${strike.count} ret (M54)`);

      // Back to analysis with the reason — the agent keeps its context (M30).
      await goto("3", `ret: ${verdict.reason ?? ""} — analiz yeniden yazılıyor`);
      const redone = await thinkActs.writeAnalysis(ticket, input.appId);
      state.analysis = redone.analysis;
      // The rewrite may have re-tiered the ticket; keeping the old value would
      // send the continuation through the wrong gate set.
      state.risk = redone.risk;
      await acts.publishAnalysis(ticket, state.analysis);
      return continueRun();
    }
  }

  // ── 6a-10 · engineering loop ─────────────────────────────────────────────
  const built = await runEngineeringLoop({ acts, longActs, goto, gate }, state, inbox, ticket, required);
  if (built.kind === "handover") return handOver(built.reason);
  const attempt = built.attempts;

  // ── 10b · PR and the CI gate ─────────────────────────────────────────────
  await stopIfKilled();
  const pr: PrRef = await acts.openPullRequest(ticket);
  await acts.activatePullRequest(ticket, pr);
  await goto("10b", `PR #${pr.prId} · build validation bekleniyor`);

  const green = await awaitGreenBuild({ acts, longActs }, state, inbox, ticket, attempt);
  if (green.kind === "handover") return handOver(green.reason);

  // ── 11-12 · QA result and PR approval ────────────────────────────────────
  for (const at of required.filter((g) => g === "11" || g === "12")) {
    await goto(at, "insan onayı bekleniyor");
    const verdict = await gate(at);
    if (verdict.decision === "reject") {
      const strike = countRejection(state, at);
      if (strike.exhausted) return handOver(`${at} kapısında ${strike.count} ret (M54)`);

      inbox.changesRequested = verdict.reason ?? "";
      await goto("12b", "PR yorum döngüsü — aynı oturum devam");
      const fix: EngineeringResult = await longActs.runEngineering(
        ticket,
        state.resumeToken,
        inbox.changesRequested,
        // A round of its own: the 12b fix is neither the last 6a turn nor the
        // last CI fix repeated, and each must leave its own record.
        green.attempts + strike.count,
      );
      state.resumeToken = fix.resumeToken;
      if (!fix.ok && fix.handoverReason !== undefined) return handOver(fix.handoverReason);
      return continueRun();
    }
  }

  // ── 13 · merge, evidence, closure ────────────────────────────────────────
  // The last gate is closed and everything below is irreversible. This check
  // cannot be skipped: an emergency stop that does not stop the MERGE has not
  // stopped the only thing in this system that cannot be undone.
  await stopIfKilled();
  await acts.mergePullRequest(ticket, pr);
  await goto("13", "kanıt paketi");
  const evidence = await acts.buildEvidencePackage(ticket);
  await acts.journal(ticket, "closure", "kanıt paketi", `${evidence.files} dosya`);
  await acts.closeTicket(ticket);
  state.status = "done";
  return state.status;
}
