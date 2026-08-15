import {
  APPROVAL_GATE_STEPS,
  GATES_BY_RISK,
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

/**
 * Who owns each approval gate — the DEFAULT mapping.
 *
 * D7: M71 says the concrete group is a per-project parameter, and this constant
 * is not yet parameterised. It is a deliberate two-part story, not an oversight:
 * these names are the fallback, and the layer that resolves a group to actual
 * people (`DirectoryReader.membersOf`) is already a seam, so a project that
 * calls its tech leads something else is served by pointing that seam at its own
 * directory. What is NOT yet possible is a project that routes gate 5 to a
 * different KIND of owner; that needs a `gateOwners(runId)` reader on
 * `ParamReader`, and it must land before the second project is onboarded.
 * Until then this is the single source of truth, and `recordGateDecision`
 * re-checks against it so a forged `actorGroup` cannot slip past.
 */
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
  /**
   * When true, the cross-gate "two different signatures" rule (M32/M92) is
   * waived for THIS decision — used only for a master admin who may sign both
   * gates so a single-admin install is not deadlocked. The caller
   * (gate-loop / gate-decision) sets it from the actor's group membership and
   * records the solo approval in the audit trail. Every other axis
   * (wrong_step, wrong_group, not_verified) still applies. Defaults false, so
   * an ordinary caller keeps the strict four-eyes rule.
   */
  selfApproveAllowed = false,
): GateRejection {
  if (decision.step !== atStep) return { ok: false, reason: "wrong_step" };
  if (decision.decision === "reject") return { ok: true };

  const owner = GATE_OWNER[atStep as (typeof APPROVAL_GATE_STEPS)[number]];
  if (owner !== undefined && decision.actorGroup !== owner) {
    return { ok: false, reason: "wrong_group" };
  }
  if (!decision.sodVerified) return { ok: false, reason: "not_verified" };

  if (!selfApproveAllowed) {
    // M32: the analysis gates (4 and 5) must carry two different signatures.
    if (atStep === "5" && previousApprovers.get("4") === decision.actorUserId) {
      return { ok: false, reason: "sod_violation" };
    }
    // M92 (optional, parameter-driven): QA scenario approver ≠ QA result approver.
    if (atStep === "11" && previousApprovers.get("9") === decision.actorUserId) {
      return { ok: false, reason: "sod_violation" };
    }
  }
  return { ok: true };
}
