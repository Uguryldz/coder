import type { TicketKey } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { classifyingFields, runIntake, type IntakeOutcome } from "./jira-intake.js";

/**
 * ÖLÜ BİR KOŞUYU YENİDEN AKIŞA ALMANIN TEK YOLU — elle de, tarama da buradan
 * geçer.
 *
 * ── Neden ayrı bir dosya ──────────────────────────────────────────────────
 * Bu iş `POST /studio/runs/:ticket/restart` rotasının içinde yazılmıştı ve
 * orada doğruydu: operatörün elle bastığı düğme. Sonra operatörün asıl
 * beklentisi ölçüldü — "robotun havuzunda düşen bir koşu varsa OTOMATİK
 * yeniden başlamalı" — ve aynı işin ikinci bir çağıranı doğdu (tarama turu,
 * `jira-discovery.ts`).
 *
 * İkinci bir kopya yazmak, alımın ikinci ve zayıf bir sürümünü üretmek
 * olurdu: emekliye ayırma sırası, denetim kaydının ŞEKLİ, ve `runIntake`in
 * hangi alanlarla çağrıldığı üç ayrı yerde birbirinden kayardı. Kayan da
 * sessizce kayardı — bir denetçinin "bu ticket neden iki kez başladı"
 * sorusunun cevabı, hangi kapıdan girdiğine bağlı iki farklı hikâye olurdu.
 *
 * ── Ne YAPMIYOR: ölülüğü ÖLÇMÜYOR ─────────────────────────────────────────
 * "Koşu ölü mü" sorusu bilerek ÇAĞIRANDA. İki çağıranın o soruyu sorma yolu
 * farklı, ve farklı olması gerekiyor:
 *
 *  · Elle yol TEK bir ticket için `queryRunState` sorar ve sorgunun HATASINI
 *    çağırana ulaştırır — okunamayan bir motoru "ölmüş" saymak, kapıda bekleyen
 *    canlı bir koşuyu bir ağ hıçkırığı yüzünden yeniden başlatmak olurdu.
 *  · Tarama turu ticket BAŞINA sorgu yapamaz (havuzda yüz ticket varsa yüz
 *    gRPC çağrısı, her turda). TEK bir toplu `list()` ile motorun tuttuğu
 *    execution'ları okur — `reconcileRunStatuses`in aynı deseni — ve o
 *    listede olmayan satırı ölü sayar.
 *
 * Bu fonksiyon yalnız KARARIN uygulanmasıdır, kararın kendisi değil.
 */
export interface RestartRequest {
  readonly ticket: TicketKey;
  /**
   * DENETİM zincirine yazılacak aktör. Elle yolda `sessionActor` (bir AI aracı
   * ödünç aldığı insanı kayıtta TUTAR — M101), taramada `maestro-worker`.
   */
  readonly auditActor: string;
  /**
   * ALIMIN aktörü — `runIntake`in denetim satırına ve karar dökümüne yazdığı ad.
   *
   * `auditActor`tan AYRI, çünkü ikisi farklı sözlükler: denetim zinciri
   * `ai-via:` önekini taşıyabilirken alım oturumun düz kullanıcı kimliğini
   * bekler. Elle rota bugüne kadar da bu ikisini ayrı geçiyordu; ortak yola
   * taşınırken birleştirmek, sessiz bir davranış değişikliği olurdu.
   */
  readonly intakeActor: string;
  /** Yeniden başlatmayı KİM istedi: operatör mü, tarama turu mu. */
  readonly source: "operator" | "sweep";
  /** Emekliye ayrılmadan önceki koşunun durumu — denetim kaydına yazılır. */
  readonly previousStatus?: string;
  /** Emekliye ayrılmadan önceki koşunun adımı — denetim kaydına yazılır. */
  readonly previousStep?: string;
  /** Ticket anlık görüntüsü okunamazsa çağıranın günlüğüne yazması için. */
  readonly onSnapshotError?: (error: unknown) => void;
}

export type RestartResult =
  /** Ticket'ın satırı iki çağrı arasında gitti — çağıran 404 der. */
  | { readonly ok: false; readonly reason: "no_run" }
  | {
      readonly ok: true;
      /** Emekliye ayrılan satırın yeni kimliği. */
      readonly retiredRunId: string;
      /** Ticket'ın KAÇINCI yeniden başlatılması olduğu, bu dahil. */
      readonly attempt: number;
      readonly outcome: IntakeOutcome;
    };

/**
 * Emekliye ayır, denetime yaz, yeniden akışa al — bu sırayla.
 *
 * ── Neden bu SIRA ─────────────────────────────────────────────────────────
 * Denetim kaydı `runIntake`ten ÖNCE yazılır ve emekliye ayrılan satırın YENİ
 * kimliğini adıyla taşır: bir denetçi "bu ticket'ın önceki koşusu nerede" diye
 * sorduğunda cevabın kendisi zincirde durur. Alım reddedilse bile (kill-switch,
 * bağlantısı duraklatılmış proje) kayıt yerinde kalır — çünkü emekliye ayırma
 * GERÇEKTEN olmuştur ve zincirin olmamış gibi davranması, zincirin yalan
 * söylemesi olurdu.
 *
 * ── BAĞLAM NASIL KORUNUYOR ────────────────────────────────────────────────
 * `retire` satırı SİLMEZ, kimliğini değiştirir. Şemadaki dört kardeş tablo da
 * `onUpdate: Cascade` taşıyor: defter (`JournalEntry`), adım olayları
 * (`StepEvent`), kanıt kalemleri (`EvidenceItem`) ve kapı kayıtları (`Gate`)
 * yeni kimliğe birlikte taşınır. Tek satır kaybolmaz; eski koşunun defteri,
 * bir denetçinin "orada ne oldu" sorusunun cevabı olarak yerinde kalır.
 *
 * Yeni koşu ise ticket'ın KENDİSİNDEN besleniyor: `runIntake` yorumları ve
 * anlık görüntüyü okuyor, yani operatörün ve önceki koşunun ticket'a YAZDIĞI
 * her şey yeni koşuya geliyor. Eski koşunun İÇ durumunu (yarım kalmış adım
 * durumu, kapı kararları) yeni koşuya taşımak bilinçli olarak YAPILMIYOR: o
 * durum ölmüş bir execution'ın belleğidir, ve yarıda kalmış bir analizden
 * devam etmek, hangi kısmının tamamlandığını BİLMEDEN devam etmek olurdu.
 * Yeniden başlamak, yanlış bir yerden devam etmekten güvenlidir — ve
 * ticket'taki yazılı bağlam zaten kaybolmuyor.
 */
export async function restartDeadRun(
  deps: ResolvedDeps,
  request: RestartRequest,
): Promise<RestartResult> {
  const at = deps.clock.now();
  const retired = await deps.read.runs.retire(request.ticket, at);
  if (retired === null) return { ok: false, reason: "no_run" };

  await deps.audit.append({
    actor: request.auditActor,
    action: "PARAM_CHANGED",
    subject: `run:${request.ticket}`,
    at,
    meta: {
      surface: "runs",
      verb: "restarted",
      // Elle mi, tarama mı — bir denetçinin ilk sorusu.
      source: request.source,
      // Kaçıncı yeniden başlatma. Otomatik yolda bu sayı aynı zamanda frenin
      // ölçtüğü değer, ve zincirde durması "robot bu ticket'ta kaç kez
      // denedi" sorusunun kalıcı cevabı.
      attempt: retired.count,
      // Eski koşunun defteri nerede — zincirde adıyla.
      retiredRunId: retired.id,
      previousStatus: request.previousStatus ?? "",
      previousStep: request.previousStep ?? "",
    },
  });

  const outcome = await runIntake(deps, {
    ticket: request.ticket,
    actor: request.intakeActor,
    explicit: true,
    ...(await classifyingFields(deps, request.ticket, (error) => {
      request.onSnapshotError?.(error);
    })),
  });

  return { ok: true, retiredRunId: retired.id, attempt: retired.count, outcome };
}
