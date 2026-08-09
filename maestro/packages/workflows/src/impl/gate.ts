import { type GateDecision, JournalKind, type StepId, type TicketKey } from "@maestro/contracts";
import { planEscalation, type ResolvedStep } from "@maestro/notify";
import { ApplicationFailure } from "@temporalio/common";
import type { GateVerdict } from "../activities.js";
import { GATE_OWNER } from "../gates.js";
import type { ActivityDeps } from "./deps.js";
import { handOver } from "./outcome.js";
import { audit, notifyEvent, record } from "./record.js";

/** Milliseconds in one hour — the unit the workflow counts its waiting in. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The human gates (M51/M88) and the two cross-cutting activities every step
 * uses. Nothing here ever decides anything: reminders escalate, they do not
 * approve, and a gate closes only when a person's decision arrives.
 */

/** Step 4/5/9/11/12 opening: the record, the trail, the ticket, the audience. */
export async function openGate(
  deps: ActivityDeps,
  ticket: TicketKey,
  step: StepId,
  ownerGroup: string,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  const at = deps.now().toISOString();
  // Idempotent: a retry re-reads the existing record, so `openedAt` — the
  // anchor the whole escalation ladder is measured from — never moves.
  await deps.gates.open(run.runId, step, ownerGroup, at);
  await audit(deps, run, { action: "GATE_OPEN", meta: { step, ownerGroup }, key: `open:${step}` });
  await record(deps, run, {
    kind: "gate",
    title: `kapı ${step} açıldı`,
    detail: ownerGroup,
    key: `open:${step}`,
  });
  await deps.idempotency.once(`${run.runId}:gate-comment:${step}`, () =>
    deps.work.addComment(ticket, deps.translate(run.locale, "jira.gate_open", { gate: step, group: ownerGroup })),
  );
  await notifyEvent(deps, run, {
    event: "gate_open",
    messageKey: "notify.gate_open",
    params: { ticket, gate: step, group: ownerGroup },
    to: await deps.directory.membersOf(ownerGroup),
    key: `open:${step}`,
  });
}

/**
 * A decision is on the record only after its author's group membership has been
 * checked against the directory (M32/M51).
 *
 * The workflow already refused everything `canCloseGate` could see, but that
 * function only compares the group the SIGNAL claims. A decision that reaches
 * here claiming a membership the directory does not know is a forgery, not a
 * mistake — but it is the CLAIM that is wrong, not the run. The verdict goes
 * back to the workflow, which leaves the gate open and tells the person why;
 * failing the activity would kill a healthy run over somebody else's typo.
 */
export async function recordGateDecision(
  deps: ActivityDeps,
  ticket: TicketKey,
  decision: GateDecision,
): Promise<GateVerdict> {
  const run = await deps.runs.get(ticket);
  const expected = GATE_OWNER[decision.step as keyof typeof GATE_OWNER];
  const member = await deps.work.verifyMembership(decision.actorUserId, decision.actorGroup);
  if (!member || (expected !== undefined && decision.actorGroup !== expected)) {
    await record(deps, run, {
      kind: "gate",
      title: "üyelik doğrulanamadı",
      detail: `${decision.actorUserId} · ${decision.actorGroup}`,
      key: `deny:${decision.step}:${decision.signatureSeq}`,
    });
    return {
      accepted: false,
      reason: `${decision.actorUserId} · "${decision.actorGroup}" üyeliği doğrulanamadı`,
    };
  }

  await audit(deps, run, {
    action: decision.decision === "approve" ? "GATE_APPROVE" : "GATE_REJECT",
    // M32/M101: an approval is only ever recorded against a human actor.
    actor: decision.actorUserId,
    meta: { step: decision.step, signatureSeq: decision.signatureSeq, reason: decision.reason ?? null },
    key: `decision:${decision.step}:${decision.signatureSeq}`,
  });
  await deps.gates.close(run.runId, decision.step, decision.at);
  await record(deps, run, {
    kind: "gate",
    actor: "human",
    title: `kapı ${decision.step}: ${decision.decision === "approve" ? "onay" : "ret"}`,
    detail: decision.reason ?? "",
    key: `decision:${decision.step}:${decision.signatureSeq}`,
  });
  return { accepted: true };
}

/**
 * One reminder tick (M88). The workflow says how long it has been waiting; the
 * ladder — which lives entirely in the `escalation.ladder` parameter (M71) —
 * says what that means.
 *
 * `now` is derived from the gate's own anchor plus the workflow's count, NOT
 * from the activity's wall clock: the workflow is the only clock that survives
 * a replay, and a reminder that fired on wall-clock time would fire again on
 * every retry.
 */
export async function escalateGate(
  deps: ActivityDeps,
  ticket: TicketKey,
  step: StepId,
  waitingHours: number,
): Promise<string | null> {
  const run = await deps.runs.get(ticket);
  const gate = await deps.gates.get(run.runId, step);
  if (gate === null || gate.closedAt !== null) return null;

  const ladder = await deps.params.escalationLadder(run.runId);
  const now = new Date(Date.parse(gate.openedAt) + waitingHours * HOUR_MS).toISOString();
  const owners = await deps.directory.membersOf(gate.ownerGroup);
  const deputies = await deps.directory.membersOf(`${gate.ownerGroup}-deputy`);

  const plan = planEscalation(ladder, {
    openedAt: gate.openedAt,
    now,
    firedStepIds: gate.firedStepIds,
    locale: run.locale,
    params: { ticket, gate: step, group: gate.ownerGroup, hours: String(waitingHours) },
    recipients: (ladderStep: ResolvedStep) => (ladderStep.action === "delegate" ? deputies : owners),
  });

  for (const notification of plan.notifications) {
    await deps.idempotency.once(
      `${run.runId}:escalate:${step}:${notification.messageKey}:${notification.at}:${notification.channel}`,
      () => deps.notify.send(notification),
    );
  }
  if (plan.due.length > 0) {
    await deps.gates.markFired(run.runId, step, plan.due.map((s) => s.stepId));
    await record(deps, run, {
      kind: "gate",
      title: `kapı ${step} hatırlatıcı`,
      detail: plan.due.map((s) => s.stepId).join(", "),
      key: `escalate:${step}:${plan.due.map((s) => s.stepId).join("-")}`,
    });
  }
  // A delegation moves the gate to the deputy; it never closes it (M88).
  for (const delegation of plan.delegations) {
    await record(deps, run, {
      kind: "gate",
      title: `kapı ${step} vekile devredildi`,
      detail: delegation.stepId,
      key: `delegate:${step}:${delegation.stepId}`,
    });
  }
  return plan.next?.dueAt ?? null;
}

/**
 * The ledger entry every step transition writes (M30). Gate and handover
 * entries are also posted to the ticket: Jira is where the humans are (M61),
 * and "your decision was refused because…" is useless inside a database.
 */
export async function journal(
  deps: ActivityDeps,
  ticket: TicketKey,
  kind: string,
  title: string,
  detail: string,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  const parsed = JournalKind.safeParse(kind);
  const resolved = parsed.success ? parsed.data : "other";
  await record(deps, run, {
    kind: resolved,
    title,
    detail,
    key: `flow:${resolved}:${title}:${detail}`,
  });
  if (resolved === "gate" || resolved === "handover") {
    await deps.idempotency.once(`${run.runId}:comment:${resolved}:${title}:${detail}`, () =>
      deps.work.addComment(ticket, `${title}${detail === "" ? "" : ` — ${detail}`}`),
    );
  }
}

export async function handOverToHuman(
  deps: ActivityDeps,
  ticket: TicketKey,
  reason: string,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  await handOver(deps, run, reason, `flow:${reason}`);
  deps.execution.endRun(run.runId);
}
