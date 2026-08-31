import {
  APPROVAL_GATE_STEPS,
  GateDecision,
  type StepId,
  type TicketKey,
} from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { workflowIdFor } from "./gateway.js";
import { projectKeyOf } from "./jira-intake.js";
import { SIGNALS } from "./signal-names.js";

/**
 * The one place a gate is closed, shared by the Jira comment path (M51's
 * primary channel) and Studio's secondary one. Both go through the same
 * membership check, the same audit record and the same signal, so there is no
 * second, weaker way in — that asymmetry is what SoD (M32) actually rests on.
 */

export interface GateRequest {
  ticket: TicketKey;
  /**
   * `return_analysis` ("eksik var, bir daha bak") üçüncü karar. Yolun geri
   * kalanı — üyelik kontrolü, denetim zinciri, sinyal — onay ve retle
   * BİREBİR aynı: bu fonksiyonun var olma sebebi, kapıya girmenin ikinci ve
   * zayıf bir yolunun olmaması. Ayrıştığı tek yer, hangi denetim eyleminin
   * yazıldığı ve hangi kapılarda kabul edildiği.
   */
  decision: "approve" | "reject" | "return_analysis";
  reason?: string;
  /** Audit actor, `user@corp`; also the identity four-eyes compares across gates. */
  actor: string;
  /** The id the work system knows the person by (Jira login / corporate account). */
  membershipId: string;
  source: "jira" | "studio";
  at: string;
}

export type GateFailure =
  | "no_run"
  | "no_open_gate"
  | "not_member"
  | "not_delivered"
  /**
   * "Analize geri gönder" bu kapıda geçerli değil — analiz kapıları (4/5)
   * dışındaki her kapı. Sinyal HİÇ gönderilmez ve denetime hiçbir şey
   * yazılmaz: workflow tarafındaki `canCloseGate` aynı kararı zaten verecekti
   * (`not_returnable`), ama orada kapı bir tur boşuna açılıp kapanır ve
   * denetim zincirine kabul edilmemiş bir imza düşerdi.
   */
  | "gate_not_returnable";

export type GateResult =
  | { ok: true; step: StepId; group: string; signatureSeq: number }
  | { ok: false; reason: GateFailure; step?: StepId; group?: string };

/**
 * The audit action each verdict writes. `return_analysis` has its own
 * (`GATE_RETURN`, `outcome: success`) rather than borrowing `GATE_REJECT`:
 * counting routine "look again" turns as refusals would misstate both the
 * number and its meaning on every governance screen.
 */
const AUDIT_ACTION_OF: Readonly<
  Record<GateRequest["decision"], "GATE_APPROVE" | "GATE_REJECT" | "GATE_RETURN">
> = {
  approve: "GATE_APPROVE",
  reject: "GATE_REJECT",
  return_analysis: "GATE_RETURN",
};

function isApprovalGate(step: StepId): boolean {
  return (APPROVAL_GATE_STEPS as readonly StepId[]).includes(step);
}

export async function decideGate(deps: ResolvedDeps, request: GateRequest): Promise<GateResult> {
  const workflowId = workflowIdFor(request.ticket);
  const state = await deps.runs.queryRunState(workflowId);
  if (state === null) return { ok: false, reason: "no_run" };

  // A decision is only meaningful at an OPEN approval gate. The clarification
  // wait (2b) also reports `gate`, and it is not something to approve.
  if (state.status !== "gate" || !isApprovalGate(state.step)) {
    return { ok: false, reason: "no_open_gate", step: state.step };
  }

  /**
   * "Bir daha bak" YALNIZ analiz kapılarında bir cevap.
   *
   * 9/11/12'de analiz onaylanmış, kod yazılmış ve PR açılmıştır; oradan analize
   * dönmek yazılmış işi ıskartaya çıkarmak olurdu. Üyelik kontrolünden ÖNCE,
   * çünkü bu bir yetki sorusu değil bir anlam sorusu — ve dizin çağrısını
   * cevabı zaten belli olan bir istek için harcamamak gerekir.
   */
  if (request.decision === "return_analysis" && state.step !== "4" && state.step !== "5") {
    return { ok: false, reason: "gate_not_returnable", step: state.step };
  }

  const group = await deps.gates.ownerGroup(state.step, projectKeyOf(request.ticket));
  if (group === null) return { ok: false, reason: "no_open_gate", step: state.step };

  // M32/M35: group membership is the whole authority behind a gate decision,
  // and it is checked before anything is recorded or signalled. An unverifiable
  // membership throws out of the port — fail-closed, never "assume yes".
  const member = await deps.work.verifyMembership(request.membershipId, group);
  if (!member) return { ok: false, reason: "not_member", step: state.step, group };

  // Audit first, on purpose: `signatureSeq` IS the position in the hash chain
  // (M33), so a signature can be located in the trail by its number and cannot
  // be minted by a counter that lives somewhere the auditor cannot see. The
  // trail also refuses a non-human actor for these two actions, which is the
  // last line of defence behind M101's "no gate tool for the AI".
  const event = await deps.audit.append({
    actor: request.actor,
    action: AUDIT_ACTION_OF[request.decision],
    subject: request.ticket,
    at: request.at,
    meta: {
      step: state.step,
      group,
      source: request.source,
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    },
  });

  const decision = GateDecision.parse({
    step: state.step,
    decision: request.decision,
    actorUserId: request.actor,
    actorGroup: group,
    sodVerified: true,
    signatureSeq: event.seq,
    source: request.source,
    at: request.at,
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  });

  const delivered = await deps.runs.signal(workflowId, SIGNALS.gateDecision, decision);
  if (delivered === "no_run") {
    return { ok: false, reason: "not_delivered", step: state.step, group };
  }
  return { ok: true, step: state.step, group, signatureSeq: event.seq };
}
