import type { TicketKey, WorkflowRunState } from "@maestro/contracts";
import { ClarificationAnswerSignal } from "@maestro/contracts";
import { resolveBotIdentity } from "./bot-identity.js";
import type { ResolvedDeps, WorkEvent } from "./deps.js";
import { workflowIdFor } from "./gateway.js";
import { SIGNALS } from "./signal-names.js";

/**
 * Jira'dan netleştirmeye YENİDEN GİRİŞ: 2b'de bekleyen bir koşuyu, kullanıcı
 * ticket'ı düzeltip bot'a geri attığında uyandırmak.
 *
 * ── Neden bir yola ihtiyaç vardı ──────────────────────────────────────────
 * `ticket-workflow.ts` intake eksik çıkınca reporter'a soru soruyor ve
 * `condition(() => inbox.clarified)` ile SÜRESİZ bekliyor (M61: otomatik
 * reddetme yok, zaman aşımı yok). O koşulu açan tek şey
 * `clarificationAnswered` sinyali, ve o sinyali gönderen tek yer Studio'nun
 * `POST /runs/:ticket/signals/clarificationAnswered` ucuydu. Yani: Jira'dan
 * gelen hiçbir şey koşuyu uyandıramıyordu. Kullanıcı ticket'ı düzeltip geri
 * atıyor, Jira webhook'u geliyor, `runIntake` mevcut koşuya KATILIYOR
 * (`started: false`) ve hiçbir sinyal taşımıyor — koşu sonsuza dek 2b'de
 * park kalıyordu. Bankada bunun görünen hâli: "ticket'ı düzelttim, Maestro
 * hâlâ bekliyor."
 *
 * ── Neden tetik ATAMA, statü değil ────────────────────────────────────────
 * Statü tetiği tehlikeli, çünkü workflow 2b'ye girerken SIRAYLA şunları
 * yapıyor: `moveStatus("need_info")` → `askClarification` → beklemeye geç.
 * O durum taşımasının kendi yankısı Jira'dan bir `jira:issue_updated` olarak
 * geri geliyor ve korumanın açık olduğu pencereye düşüyor: Maestro kendi
 * sorusunu kendisi cevaplardı.
 *
 * Atamanın böyle bir zayıflığı yok: Maestro kendini hiçbir yerde bot'a
 * atamıyor. `reassignOnNeedInfo` ticket'ı REPORTER'a atıyor — bot'tan UZAĞA.
 * Yani "ticket bot'a atanmış" durumu, tanımı gereği bir insanın yaptığı bir
 * hareket. Doğal yankı-bağışıklık budur.
 *
 * ── Yankı önlemenin üç katmanı ────────────────────────────────────────────
 * Hiçbiri tek başına yeterli değil; üçü birden geçmeden sinyal gitmez.
 *
 *  1. **Kimlik (`actor !== bot`)** — olayı bot'un kendisi ittiyse bu bir
 *     cevap değil, kendi sesidir. `actor` yoksa (teslimat kimseyi
 *     adlandırmadı) tetiklemiyoruz: bilinmeyen bir kimlik "bot değil" demek
 *     değildir, ve yanlış tarafta hata yapmanın bedeli koşunun kendi kendini
 *     cevaplaması olur.
 *  2. **Yön (`assignee === bot`)** — ticket bot'a DÖNMÜŞ olmalı. Reporter'da
 *     duran, ya da üçüncü birine atanmış bir ticket'ın düzenlenmesi
 *     "cevabım hazır" demek değildir.
 *  3. **Zaman (`awaitingClarificationSince`)** — olay, sorunun sorulduğu
 *     ANDAN sonra alınmış olmalı. Bu, 1 ve 2'nin birlikte bile yakalayamadığı
 *     dar bir pencereyi kapatıyor: soru sorulmadan hemen önce ticket zaten
 *     bot'ta olabilir ve `reassignOnNeedInfo` kapalıysa öyle kalır — o
 *     durumda soruyla eş zamanlı herhangi bir düzenleme yankısı 1 ve 2'yi
 *     geçerdi. Damga `askClarification`'dan SONRA atılıyor, dolayısıyla
 *     Maestro'nun kendi hazırlık hareketleri hep eşiğin gerisinde kalır.
 *
 * ── Neden `not_intake` erken dönüşünden ÖNCE ──────────────────────────────
 * Webhook yolu, bir issue olayını `runIntake`'e verip orada durdurur; 2b'de
 * bekleyen bir koşu için `runIntake` yalnızca "katıldım" der. Kontrol o
 * yoldan SONRA yapılsaydı, düzeltme olayı zaten cevapsız yutulmuş olurdu.
 */

/** Yeniden girişin ne yaptığı — çağıranın loglayabileceği kadarı, fazlası değil. */
export type ClarifyReentry =
  | { kind: "signalled"; workflowId: string; ticket: TicketKey }
  /** Uygun değildi. `reason` neden reddedildiğini söyler; hiçbiri bir hata değil. */
  | { kind: "skipped"; reason: ClarifySkipReason }
  /** Koşu 2b'deydi ve uygundu, ama sinyal teslim edilemedi (koşu kapanmış). */
  | { kind: "no_run" };

export type ClarifySkipReason =
  /** Issue olayı değil, ya da ticket anahtarı yok. */
  | "not_issue_event"
  /** Koşu yok, ya da 2b'de beklemiyor. */
  | "not_waiting"
  /** Ticket bot'a atanmamış — düzeltme geri verilmemiş. */
  | "not_assigned_to_bot"
  /** Olayı bot'un kendisi itti: kendi hareketinin yankısı. */
  | "bot_echo"
  /** Teslimat kimin ittiğini söylemedi; yankı olmadığını kanıtlayamıyoruz. */
  | "actor_unknown"
  /** Olay, soru sorulmadan önce alınmış — hazırlık hareketlerinin yankısı. */
  | "before_question"
  /** Bu kurulumda bot hesabı yapılandırılmamış; kimlik karşılaştırması yapılamaz. */
  | "bot_account_unconfigured";

/**
 * 2b'de bekleyen bir koşuyu, uygunsa uyandır.
 *
 * Hiçbir yolda FIRLATMAZ. Webhook rotası Jira'ya 202 dönmek zorunda: 5xx'i
 * Jira yeniden gönderir, ve tek bir okunamayan teslimat sonsuz bir yeniden
 * gönderme fırtınasına dönüşür (M14).
 */
export async function tryClarifyReentry(
  deps: ResolvedDeps,
  event: WorkEvent,
  receivedAt: Date,
): Promise<ClarifyReentry> {
  if (event.kind !== "issue" || event.ticketKey === undefined) {
    return { kind: "skipped", reason: "not_issue_event" };
  }

  // Bot kimliği ÖNCE: yapılandırılmamışsa 1. ve 2. katman ölçülemez, ve
  // ölçülemeyen bir korumayla ilerlemek korumasız ilerlemektir.
  //
  // Kaynak `MAESTRO_BOT_ACCOUNT_ID`, o boşsa bağlantı testinin öğrendiği
  // kimlik — düşüşün neden yalnız boşken güvenli olduğu `bot-identity.ts`'te.
  // Kısaca: kurulum sırası kimliği bağlantı testinden SONRA öğreniyor, ve
  // yalnız .env okumak bu kanalı yeşil görünen her kurulumda kapalı bırakıyordu.
  const identity = await resolveBotIdentity(deps.config.engineBotAccountId, deps.connections);
  if (identity === null) return { kind: "skipped", reason: "bot_account_unconfigured" };
  const bot = identity.accountId;

  const workflowId = workflowIdFor(event.ticketKey);
  let state: WorkflowRunState | null;
  try {
    state = await deps.runs.queryRunState(workflowId);
  } catch {
    // Motor cevap vermiyor. Bu bir "uygun değil" değil, bir bilinmezlik —
    // ama webhook yolunda ikisinin de cevabı aynı: sessizce geç, Jira'ya 202.
    return { kind: "skipped", reason: "not_waiting" };
  }
  if (state === null || state.step !== "2b") {
    return { kind: "skipped", reason: "not_waiting" };
  }

  // ── katman 2: yön ────────────────────────────────────────────────────────
  if (!sameAccount(event.assignee, bot)) {
    return { kind: "skipped", reason: "not_assigned_to_bot" };
  }

  // ── katman 1: kimlik ─────────────────────────────────────────────────────
  if (event.actor === undefined || event.actor.trim() === "") {
    return { kind: "skipped", reason: "actor_unknown" };
  }
  if (sameAccount(event.actor, bot)) return { kind: "skipped", reason: "bot_echo" };

  // ── katman 3: zaman ──────────────────────────────────────────────────────
  //
  // Eşik yoksa geçmiyoruz. Koşu 2b'de görünüyor ama damgayı vermiyorsa, ya
  // eski bir sürüm çalışıyor ya da soru henüz sorulmadı; ikisinde de bir
  // yankıyı cevaptan ayırmanın yolu yok.
  const since = state.awaitingClarificationSince;
  if (since === undefined) return { kind: "skipped", reason: "before_question" };
  const threshold = Date.parse(since);
  if (!Number.isFinite(threshold) || receivedAt.getTime() < threshold) {
    return { kind: "skipped", reason: "before_question" };
  }

  const at = receivedAt.toISOString();
  const signal = ClarificationAnswerSignal.parse({
    ticketKey: event.ticketKey,
    answeredBy: event.actor.trim(),
    // Metin YOK, ve bu bilerek: kullanıcı cevabını ticket ALANLARINA yazdı,
    // bir yoruma değil. Buraya uydurma bir özet koymak, koşunun analizinin
    // dayanacağı metni kirletirdi — workflow zaten ticket'ı yeniden okuyor.
    // Cümle, koşunun neyle uyandığını günlüğe düşürecek kadarı.
    text: "Ticket Jira'da güncellendi ve Maestro'ya geri atandı.",
    at,
  });

  const delivered = await deps.runs.signal(workflowId, SIGNALS.clarificationAnswered, signal);
  if (delivered !== "delivered") return { kind: "no_run" };
  return { kind: "signalled", workflowId, ticket: event.ticketKey };
}

/**
 * İki Jira kimliği aynı hesabı mı gösteriyor?
 *
 * Büyük/küçük harf duyarsız: DC kullanıcı adları `name` alanında geldiği gibi
 * gelir, ve aynı hesap bir yerde `Maestro.Bot`, başka yerde `maestro.bot`
 * yazılabilir. Boşluk kırpılır. Bunun ötesinde bir normalleştirme YOK — iki
 * farklı hesabı aynı saymak, yankı korumasının delinmesi demek olurdu.
 */
function sameAccount(candidate: string | undefined, bot: string): boolean {
  if (candidate === undefined) return false;
  const left = candidate.trim().toLowerCase();
  return left !== "" && left === bot.trim().toLowerCase();
}
