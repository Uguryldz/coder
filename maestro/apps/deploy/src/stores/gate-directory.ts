import type { StepId } from "@maestro/contracts";
import { GATE_OWNER, isApprovalGate } from "@maestro/workflows";
import type { GateOwner } from "@maestro/bff";
import type { DeployEnv } from "../env.js";

/**
 * Which directory group owns which approval gate.
 *
 * `@maestro/workflows`' `GATE_OWNER` names roles — `product-owners`,
 * `tech-leads`, `qa` — and those are the right names for a workflow to reason
 * about. They are not the names a directory answers to: a Jira site calls its
 * approvers something else, and `verifyMembership` on a group that does not
 * exist fails the decision with a 404. That is fail-closed and correct, but it
 * means the two vocabularies have to meet somewhere, and the composition root
 * is that place.
 *
 * `GATE_GROUPS` maps them, comma-separated:
 *
 *     GATE_GROUPS="product-owners=jira-users-uyildiz,tech-leads=jira-admins"
 *
 * `GATE_GROUP_DEFAULT` catches the roles no entry names, so a deployment with
 * one approver group can say so in one variable rather than five.
 *
 * A step that is not an approval gate answers `null` — never a group — because
 * a decision on a step nobody gates must be refused rather than accepted by
 * whoever happens to be in the fallback.
 */
/**
 * Role -> directory group, as one function.
 *
 * Split out of the class because BOTH sides of a gate decision need it and
 * they run in different processes: the BFF resolves the group it verifies
 * membership against, and the worker resolves the group it writes onto the
 * gate record and checks the decision's claim against. When only the BFF had
 * this mapping, a real approval was verified against `jira-users-uyildiz` in
 * one process and refused against `product-owners` in the other.
 */
/**
 * Rol → dizin grubu. `null` = "bu kurulumda eşlenmiş bir grup YOK".
 *
 * ── Neden `null`, neden rol adına düşmüyor ─────────────────────────────────
 * Eskiden son çare rolün KENDİ ADIYDI (`product-owners`). Bu, iki farklı
 * durumu tek cevaba indiriyordu: "grup eşlendi ama yanlış eşlendi" ile "hiç
 * eşlenmedi". İkisi de Jira'da olmayan bir grup adı üretiyor, ikisi de 404
 * veriyor, ve arayan taraf hangisiyle karşılaştığını bilemiyordu.
 *
 * Ayrım pahalıya patladı: `GATE_GROUPS` tanımlamamış bir kurulumda her kapı
 * kararı — `/approve` de, statü taşıması da — olmayan bir gruba üyelik
 * sorusunda sessizce düşüyordu. Operatör statüyü taşıyor, hiçbir şey olmuyor,
 * ekranda hiçbir sebep yazmıyordu.
 *
 * `null` ile arayan taraf artık şunu ayırt edebiliyor: eşlenmiş bir grup varsa
 * üyelik SORULUR ve üye olmayan REDDEDİLİR (davranış aynen korunur); grup hiç
 * eşlenmemişse sorulacak bir şey yoktur ve karar `membershipCheck:
 * "unconfigured"` olarak denetime yazılır.
 */
export type RoleResolver = (role: string) => string | null;

/**
 * Takes the raw environment rather than a `DeployEnv` so the WORKER can build
 * it too: the worker composes its stores before `bootPlatform` has produced a
 * `DeployEnv` (`bin/worker.ts` — `publish`'s deps force that ordering), and
 * both processes must resolve a role the same way or a gate opens against one
 * group and is checked against another.
 */
export function roleResolver(source: Record<string, string | undefined>): RoleResolver {
  const byRole = parseMapping(source["GATE_GROUPS"]);
  const raw = source["GATE_GROUP_DEFAULT"]?.trim();
  const fallback = raw === undefined || raw === "" ? undefined : raw;
  /**
   * Eşleme yoksa `null` — rolün kendi adına DÜŞMEZ.
   *
   * Rol adına düşmek "yapılandırılmamış"ı "yanlış yapılandırılmış" gibi
   * gösteriyordu; ikisi de 404 üretiyor ama biri kurulum gerçeği, diğeri
   * hata. Dizini bu adlarla kurmuş bir kurulum etkilenmez: `GATE_GROUPS`'a
   * `product-owners=product-owners` yazmak eşlemeyi AÇIKÇA kurar, ve açık
   * olan tahmin edilmiş olandan her zaman iyidir.
   */
  return (role: string): string | null => byRole.get(role) ?? fallback ?? null;
}

export class EnvGateDirectory {
  readonly #resolve: RoleResolver;

  constructor(env: DeployEnv) {
    this.#resolve = roleResolver(env.source);
  }

  /**
   * `null` = "bu adım bir onay kapısı değil" — kararın REDDEDİLECEĞİ hâl.
   *
   * Grup eşlemesinin yokluğu bununla KARIŞTIRILMAMALI ve bu yüzden ayrı bir
   * metotta duruyor (`ownerRole` + `groupOf`): birincisi "onaylanacak bir şey
   * yok", ikincisi "onaylanacak şey var ama grubu tanımlı değil".
   */
  async ownerGroup(step: StepId, projectKey: string): Promise<string | null> {
    const owner = await this.ownerOf(step, projectKey);
    return owner.kind === "group" ? owner.group : null;
  }

  /**
   * Aynı soru, ayrımı KAYBETMEDEN — `GateOwner`ın üç dalı.
   *
   * `ownerGroup` iki farklı yokluğu tek `null`a indiriyor; karar veren tarafın
   * bunları ayırması şart, çünkü biri REDDET, diğeri KAYDET VE GEÇİR demek.
   */
  ownerOf(step: StepId, _projectKey: string): Promise<GateOwner> {
    if (!isApprovalGate(step)) return Promise.resolve({ kind: "not_a_gate" });
    const role = GATE_OWNER[step as keyof typeof GATE_OWNER];
    if (role === undefined) return Promise.resolve({ kind: "not_a_gate" });
    const group = this.#resolve(role);
    return Promise.resolve(group === null ? { kind: "unconfigured", role } : { kind: "group", group });
  }
}

/** `role=group,role=group` → map. Malformed entries are dropped, not guessed. */
function parseMapping(raw: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined) return out;
  for (const entry of raw.split(",")) {
    const [role, group] = entry.split("=");
    if (role === undefined || group === undefined) continue;
    const key = role.trim();
    const value = group.trim();
    if (key !== "" && value !== "") out.set(key, value);
  }
  return out;
}
