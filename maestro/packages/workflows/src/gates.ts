import {
  APPROVAL_GATE_STEPS,
  GATES_BY_RISK,
  STEP_IDS,
  STEP_META,
  type GateDecision,
  type RiskTier,
  type StepId,
} from "@maestro/contracts";

/**
 * Gate policy — pure functions, no Temporal, no I/O.
 *
 * The workflow must stay deterministic, so every decision it makes about
 * "which gate is next" and "may this person close it" lives here and is
 * exercised by ordinary unit tests. The workflow file only sequences them.
 */

/** Who owns each approval gate. The group name is resolved per project (M71). */
export const GATE_OWNER: Record<(typeof APPROVAL_GATE_STEPS)[number], string> = {
  "4": "product-owners",
  "5": "tech-leads",
  "9": "qa",
  "11": "qa",
  "12": "tech-leads",
};

export function isApprovalGate(step: StepId): boolean {
  return (APPROVAL_GATE_STEPS as readonly StepId[]).includes(step);
}

/** The gate set this run must pass, in flow order (M51). */
export function gatesFor(risk: RiskTier): readonly StepId[] {
  return GATES_BY_RISK[risk];
}

/**
 * The next step after `step`, skipping approval gates the risk tier does not
 * require. A gate that is not in the tier's set is not "auto-approved" — it is
 * never opened, which is why skipping happens here and not at decision time.
 */
export function nextStep(step: StepId, risk: RiskTier): StepId | null {
  const required = new Set(gatesFor(risk));
  for (let i = STEP_IDS.indexOf(step) + 1; i < STEP_IDS.length; i += 1) {
    const candidate = STEP_IDS[i]!;
    if (isApprovalGate(candidate) && !required.has(candidate)) continue;
    return candidate;
  }
  return null;
}

export type GateRejection =
  | { ok: true }
  | { ok: false; reason: "wrong_step" | "wrong_group" | "sod_violation" | "not_verified" };

/**
 * May this decision close this gate?
 *
 * Fail-closed on every axis, and deliberately stricter for approvals than for
 * rejections: stopping the flow needs no authority, letting it through does.
 * `previousApprovers` maps an already-passed gate to the person who signed it,
 * which is how four-eyes (M32) is enforced — the PO who approved step 4 cannot
 * also sign step 5.
 */
export function canCloseGate(
  decision: GateDecision,
  atStep: StepId,
  previousApprovers: ReadonlyMap<StepId, string>,
): GateRejection {
  if (decision.step !== atStep) return { ok: false, reason: "wrong_step" };
  if (decision.decision === "reject") return { ok: true };

  const owner = GATE_OWNER[atStep as (typeof APPROVAL_GATE_STEPS)[number]];
  if (owner !== undefined && decision.actorGroup !== owner) {
    return { ok: false, reason: "wrong_group" };
  }
  if (!decision.sodVerified) return { ok: false, reason: "not_verified" };

  // M32: the analysis gates (4 and 5) must carry two different signatures.
  if (atStep === "5" && previousApprovers.get("4") === decision.actorUserId) {
    return { ok: false, reason: "sod_violation" };
  }
  // M92 (optional, parameter-driven): QA scenario approver ≠ QA result approver.
  if (atStep === "11" && previousApprovers.get("9") === decision.actorUserId) {
    return { ok: false, reason: "sod_violation" };
  }
  return { ok: true };
}

/** Human gates block on a person; a wait gate blocks on an answer (2b). */
export function blocksOnHuman(step: StepId): boolean {
  const kind = STEP_META[step].kind;
  return kind === "human_gate" || kind === "human_wait";
}
