import {
  APPROVAL_GATE_STEPS,
  GateDecision,
  type StepId,
  type TicketKey,
} from "@maestro/contracts";
import type { GateOwner, ResolvedDeps } from "./deps.js";
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
  /**
   * KOŞU VARDI, MOTORDA YOK — `no_run`dan ayrı, çünkü ayrı iki durum.
   *
   * ── Neden ayrıldı ─────────────────────────────────────────────────────────
   * `no_run` iki bambaşka şeyi tek cümleye topluyordu: "bu ticket hiç akışa
   * girmemiş" ve "koşu VARDI, motor artık onu hatırlamıyor". Operatörün sahada
   * gördüğü ikincisiydi ve mesaj onu yanıltıyordu: panel adımları gösteriyor
   * (katalogdan okuyor), kapıda "onayla/reddet" yazıyor, basınca "bu ticket
   * için çalışan bir akış yok" diyordu. Operatör bundan "sistem ticket'ımı
   * düşürdü" sonucunu çıkardı — doğru sonuç ise "koşu öldü, yeniden alınması
   * gerekiyor" idi, ve o cümle hiçbir yerde yazmıyordu.
   *
   * Ayrımı yapabilen tek şey KATALOG: motor `null` derken `WorkflowRun` satırı
   * duruyorsa koşu gerçekten vardı. Aynı ayrımı `studio-runs.ts` `stateSource`
   * ile detay ekranında zaten yapıyor; bu, onun karar yolundaki karşılığı.
   *
   * ── Neden `no_open_gate` DEĞİL ────────────────────────────────────────────
   * `no_open_gate` "koşu yaşıyor ama şu an bir kapıda değil" demek ve
   * operatörün yapacağı şey beklemek. Burada koşu yaşamıyor ve beklemek hiçbir
   * şeyi değiştirmeyecek — yapılacak şey ticket'ı yeniden akışa almak. İki
   * farklı eylem, iki farklı ad.
   */
  | "run_gone"
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

/**
 * Kapının sahipliği, `ownerOf` varsa ondan; yoksa eski `ownerGroup`tan.
 *
 * Geri düşme dalı bilerek KATI: `ownerOf` uygulamayan bir dizin için "grup
 * yok" ile "kapı değil" ayrımı yoktur, ve bilinmeyeni gevşek yorumlamak bu
 * dosyanın koruduğu şeyi sessizce delerdi. Yani yeni davranış yalnız ayrımı
 * gerçekten yapabilen bir dizinle açılır.
 */
async function resolveOwner(
  deps: ResolvedDeps,
  step: StepId,
  projectKey: string,
): Promise<GateOwner> {
  if (deps.gates.ownerOf !== undefined) return deps.gates.ownerOf(step, projectKey);
  const group = await deps.gates.ownerGroup(step, projectKey);
  return group === null ? { kind: "not_a_gate" } : { kind: "group", group };
}

export async function decideGate(deps: ResolvedDeps, request: GateRequest): Promise<GateResult> {
  const workflowId = workflowIdFor(request.ticket);
  const state = await deps.runs.queryRunState(workflowId);
  if (state === null) {
    /**
     * MOTOR SUSUYOR — ama bu iki ayrı cevabın hangisi?
     *
     * Katalogda satır varsa koşu VARDI: saklama süresi dolmuş ya da koşu
     * düşmüş. Karar yine verilemez (verilecek bir kapı yok, gidecek bir sinyal
     * yok), ama operatöre söylenecek cümle ve önerilecek EYLEM bambaşka —
     * "yeniden akışa alın", "böyle bir ticket yok" değil.
     *
     * Katalog okuması FAIL-SOFT: patlarsa eski davranışa (`no_run`) düşülür.
     * Bir teşhis uğruna kapı kararını 500'e çevirmek, düzeltmeye çalıştığı
     * şeyden daha kötü olurdu — ve `no_run` zaten bugüne kadarki cevap.
     */
    const record = await deps.read.runs.get(request.ticket).catch(() => null);
    return { ok: false, reason: record === null ? "no_run" : "run_gone" };
  }

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

  const owner = await resolveOwner(deps, state.step, projectKeyOf(request.ticket));
  if (owner.kind === "not_a_gate") return { ok: false, reason: "no_open_gate", step: state.step };

  /**
   * ÜYELİK — grup TANIMLIYSA sorulur, tanımlı değilse sorulacak bir şey yoktur.
   *
   * ── Eşlenmiş grup (`kind: "group"`) ───────────────────────────────────────
   * M32/M35: grup üyeliği kapı kararının bütün yetkisidir ve hiçbir şey
   * kaydedilmeden, hiçbir sinyal gitmeden ÖNCE ölçülür. Ölçülemeyen bir üyelik
   * port'tan fırlar — fail-closed, asla "evet varsay". Bu dal değişmedi.
   *
   * ── Eşlenmemiş grup (`kind: "unconfigured"`) ──────────────────────────────
   * `GATE_GROUPS`/`GATE_GROUP_DEFAULT` hiç eşlenmemiş. Eskiden burada rol adı
   * (`product-owners`) bir grup adıymış gibi dizine soruluyordu; Jira böyle bir
   * grup tanımadığı için 404 dönüyor ve HER kapı kararı — `/approve` de, statü
   * taşıması da — sessizce düşüyordu. Kapı hiç kapanmıyordu.
   *
   * Bu bir yapılandırma boşluğu değil, bazı kurulumların KALICI gerçeği:
   * onay grubu diye bir şey yok, kararlar Jira statüsüyle veriliyor. Orada
   * yetkiyi koruyan şey başka: bir ticket'ı o statüye taşıyabilmek zaten
   * Jira'nın kendi izin şemasından geçmeyi gerektirir. Görevler ayrımı (M32)
   * da ayakta: analizi Maestro yazar, ONAYLAYAN İNSANDIR ve kimliği denetime
   * adıyla yazılır. Kaybedilen tek şey "hangi grup" sorusunun cevabıdır — ve
   * cevabın olmadığı yerde onu uydurmamak, uydurup 404 yemekten iyidir.
   *
   * Sessizce geçmiyoruz: `membershipCheck: "unconfigured"` hem denetim
   * kaydına hem karar imzasına yazılıyor, yani bir denetçi bu kararların
   * üyeliğinin ÖLÇÜLMEDİĞİNİ görebiliyor.
   */
  const group = owner.kind === "group" ? owner.group : owner.role;
  const membershipCheck = owner.kind === "group" ? "verified" : "unconfigured";
  if (owner.kind === "group") {
    const member = await deps.work.verifyMembership(request.membershipId, owner.group);
    if (!member) return { ok: false, reason: "not_member", step: state.step, group };
  }

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
      /**
       * Denetim kaydının kendisi söylesin: üyelik ölçüldü mü, ölçülmedi mi.
       * Bir denetçinin "bu onayı kim, hangi yetkiyle verdi" sorusunun cevabı
       * bu satırda; bayrak olmadan `unconfigured` bir karar, üyeliği ölçülmüş
       * bir karardan ayırt edilemezdi.
       */
      membershipCheck,
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    },
  });

  const decision = GateDecision.parse({
    step: state.step,
    decision: request.decision,
    actorUserId: request.actor,
    actorGroup: group,
    /**
     * DÜRÜST BAYRAK: yalnız üyelik gerçekten ölçüldüyse `true`.
     *
     * `unconfigured` dalında `true` yazmak kolay olurdu ve her kontrolü
     * sessizce geçerdi — ama bu, doğrulanmamış bir şeyi doğrulanmış diye
     * denetim zincirine yazmak demektir. Kararın geçmesini sağlayan şey bu
     * bayrağın yalanı değil, `membershipCheck`in gerçeği olmalı.
     */
    sodVerified: membershipCheck === "verified",
    // Aynı bayrak imzanın üstünde de: `canCloseGate` ve `recordGateDecision`
    // bunu okuyup ikinci bir üyelik sorusunu atlar. Sinyalde taşınmasaydı
    // worker aynı 404'e yeniden düşer ve BFF'in geçirdiği kararı reddederdi.
    membershipCheck,
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
