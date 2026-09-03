import {
  APPROVAL_GATE_STEPS,
  type FlowType,
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

/**
 * What a flow type CHANGES about the run — the counterpart of `gatesFor`.
 *
 * `gatesFor(risk)` turns a risk tier into a gate set; `planFor(flow)` turns a
 * listening rule's flow type into which phases run at all. Until this existed
 * the flow type was a label: every ticket ran the full pipeline whatever the
 * rule said, so an `analiz` ticket — analysis IS the deliverable — carried on
 * into the engineering loop and died there on a platform deliberately deployed
 * without a code agent (OPS-38, `runEngineering`: `mcpServers were requested
 * but no --mcp-config path was given`).
 *
 * Ported from the pilot (`apps/pilot/src/flow-plan.ts`), where it was proven
 * on real tickets.
 */
export interface FlowPlan {
  /** Run the analysis-approval gates (steps 4/5). `duzeltme` skips them. */
  readonly analysisGate: boolean;
  /** Run engineering + PR + PR gate + merge. `analiz` stops before this. */
  readonly engineering: boolean;
}

/**
 * The plan for a flow type.
 *
 * An absent or unrecognised flow gets the FULL pipeline. That is the safe
 * default in the one direction that matters: a ticket is never silently
 * under-processed because a rule was missing, and a run that does too much
 * stops at a human gate, while a run that does too little just ends.
 */
export function planFor(flow: FlowType | null | undefined): FlowPlan {
  switch (flow) {
    case "analiz":
      return { analysisGate: true, engineering: false };
    case "duzeltme":
      // Small fix — no analysis gate, but nothing merges unreviewed.
      return { analysisGate: false, engineering: true };
    default:
      return { analysisGate: true, engineering: true };
  }
}

export type GateRejection =
  | { ok: true }
  | {
      ok: false;
      reason: "wrong_step" | "wrong_group" | "sod_violation" | "not_verified" | "not_returnable";
    };

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
  /**
   * The group the gate was actually OPENED against, when it differs from the
   * role name (`openGate` resolves the role through the directory and answers
   * with it).
   *
   * Comparing the claim to `GATE_OWNER`'s role refused every real approval on
   * a site whose groups are named anything else: OPS-34's approver was in
   * `jira-users-uyildiz`, the gate wanted `product-owners`, and the decision
   * came back `wrong_group` from inside the workflow — before the activity that
   * checks the directory ever ran. Defaults to the role, so a deployment whose
   * groups already carry these names is unaffected.
   */
  openedAgainst?: string,
): GateRejection {
  if (decision.step !== atStep) return { ok: false, reason: "wrong_step" };
  if (decision.decision === "reject") return { ok: true };
  /**
   * "Analize geri gönder" YALNIZ analiz kapılarında (4/5) bir cevaptır.
   *
   * 9/11/12'de analiz çoktan onaylanmış, kod yazılmış, PR açılmıştır; oradan
   * `goto("3")` demek yazılmış işi ıskartaya çıkarmak olurdu. Reddetmek —
   * kapı AÇIK kalır, kişiye sebebi söylenir — yanlış tarafta hata yapmanın
   * ucuz olan yönü: onay saymak kodu onaysız geçirirdi, ret saymak kararı
   * verenin demediği bir şeyi ona söyletirdi.
   *
   * Ret gibi buranın da yetki kontrolüne İHTİYACI VAR ve ondan farklı olarak
   * atlanmıyor: `reject` akışı DURDURUR (yetkisiz biri en fazla işi geciktirir,
   * bu yüzden `canCloseGate` onu serbest bırakır), geri gönderme ise analizi
   * YENİDEN YAZDIRIR — yani model harcatır ve ticket'ın içeriğini değiştirir.
   * O bir "durdurma" değil, iş başlatmadır, dolayısıyla aşağıdaki grup/SoD
   * kontrollerine düşmeye devam eder.
   */
  if (decision.decision === "return_analysis" && atStep !== "4" && atStep !== "5") {
    return { ok: false, reason: "not_returnable" };
  }

  const role = GATE_OWNER[atStep as (typeof APPROVAL_GATE_STEPS)[number]];
  const owner = openedAgainst ?? role;
  if (owner !== undefined && decision.actorGroup !== owner) {
    return { ok: false, reason: "wrong_group" };
  }
  /**
   * `sodVerified` YALNIZ üyelik gerçekten ölçüldüğünde `true` olur.
   *
   * `unconfigured` — bu kurulumda eşlenmiş bir dizin grubu yok — o yüzden
   * `false` gelir, ve burada reddedilseydi düzeltme hiçbir işe yaramazdı.
   * Bayrağı `true` yazıp geçmek de yanlış olurdu: doğrulanmamış bir şeyi
   * doğrulanmış diye kaydetmek, denetim zincirine yalan yazmaktır. Bu yüzden
   * bayrak DÜRÜST kalıyor ve ayrım `membershipCheck` üzerinden yapılıyor.
   *
   * Diğer her kontrol (`wrong_step`, `wrong_group`, four-eyes) bu dalda da
   * aynen uygulanıyor — atlanan tek şey ölçülecek grubun olmadığı ölçüm.
   */
  if (!decision.sodVerified && decision.membershipCheck !== "unconfigured") {
    return { ok: false, reason: "not_verified" };
  }

  /**
   * Four-eyes (M32/M92) yalnız ONAYA uygulanır, geri göndermeye değil.
   *
   * Kuralın söylediği şey "aynı imza iki kapıyı GEÇİREMEZ". 4'ü onaylayan
   * kişinin 5'te "eksik var, bir daha bak" demesi bu kuralın ihlali değil, tam
   * tersi: kimse hiçbir şeyi geçirmiyor, iş geri gönderiliyor. Burayı four-eyes'a
   * tabi tutmak, tek başına çalışan bir inceleyicinin analizi ne onaylayıp ne
   * geri gönderebildiği bir kilitlenme üretirdi.
   *
   * Grup kontrolü (`wrong_group`) ve `sodVerified` YUKARIDA kaldı ve geri
   * göndermeye de uygulanıyor: karar verecek grubun üyesi olmayan biri analizi
   * yeniden yazdıramaz.
   */
  if (!selfApproveAllowed && decision.decision === "approve") {
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
