import type { ConnectionStore } from "./connection-store.js";

/**
 * Motorun Jira kimliği: netleştirme yeniden girişinin yankı korumasının
 * ölçtüğü hesap.
 *
 * ── NEDEN İKİ KAYNAK VAR ────────────────────────────────────────────────────
 * Aynı gerçeğin iki yazılı hâli var ve ikisi de meşru:
 *
 *  1. `MAESTRO_BOT_ACCOUNT_ID` — operatörün .env'e yazdığı değer. Motorun
 *     hangi hesap olarak çalıştığını SÖYLER.
 *  2. Yönetilen Jira bağlantısının `config.botAccountId` alanı — panelde
 *     bağlantı testi `/myself` ile jetonun GERÇEK sahibini öğrenip yazar
 *     (`routes/connections.ts`, test sonucu `accountId`).
 *
 * Kurulum sırası (2) lehine kurulmuş: kimlik bağlantı testinden ÖNCE
 * bilinmiyor, ve `install.sh` bu yüzden (1)'i boş bırakmayı açıkça onaylıyor
 * ("kimlik panelden, bağlantı testinde öğrenilecek"). Ama yeniden giriş yalnız
 * (1)'i okuyordu: operatör kurulumu yeşil bitiriyor, bağlantıyı test ediyor,
 * her şey doğru görünüyor — ve netleştirme döngüsü hiç açılmıyordu. Kapatılmak
 * istenen hata sınıfının ta kendisi.
 *
 * ── NEDEN DÜŞÜŞ GÜVENLİ (ve tam olarak NEREDE) ──────────────────────────────
 * (2)'ye körlemesine düşmek güvenli DEĞİL: `engineIdentityWarning` tam olarak
 * ikisinin ayrışabileceğini uyarıyor, ve yanlış kimliğe düşmek yankı
 * korumasının 1. katmanını (`actor !== bot`) deler — Maestro kendi hareketini
 * insan cevabı sanardı.
 *
 * Bu yüzden düşüş KOŞULLU: yalnızca (1) BOŞKEN. O durumda ayrışma tanımı
 * gereği yok, üç bağımsız nedenle:
 *
 *  a. `engineIdentityWarning` boş motor kimliğinde `undefined` döner —
 *     "karşılaştıracak bir şey yok". Yani boşken bir ayrışma İDDİASI bile
 *     üretilemez; düşüşün çeliştiği bir uyarı mevcut değildir.
 *  b. Motor kimliği boşken keşif JQL'i `assignee = currentUser()`e düşüyor
 *     (`apps/pilot/src/config.ts:108`) — yani motor LİTERAL olarak jetonun
 *     sahibi olarak çalışır. Jetonun sahibi de (2)'nin ta kendisidir.
 *  c. Bankadaki gerçek yol dinleme kurallarından geçiyor ve kuralların
 *     `assigneeAccountId` değeri (2)'den tohumlanıyor
 *     (`listening-seed.ts:296`). Ticket 2b'ye zaten (2) kimliğine atandığı
 *     için girdi; yeniden girişi de aynı kimlikle ölçmek, ticket'ı içeri alan
 *     kimliğin kendisiyle ölçmektir.
 *
 * (1) DOLUYKEN düşüş HİÇ olmaz: yazılı değer kazanır, ayrışma durumu
 * dokunulmadan kalır ve panelin uyarısı tek doğru merci olmayı sürdürür.
 * Yani bu düşüş, yalnızca hiçbir cevabın olmadığı yerde bir cevap üretiyor;
 * var olan bir cevabı asla değiştirmiyor.
 */

/** Kimliğin nereden geldiği — operatöre ne söyleyeceğimizi belirler. */
export type BotIdentitySource = "env" | "connection";

export interface ResolvedBotIdentity {
  readonly accountId: string;
  readonly source: BotIdentitySource;
}

/**
 * Yapılandırılmış motor kimliği, ya da hiçbiri yoksa `null`.
 *
 * `envAccountId` ham .env değeri (`deps.config.engineBotAccountId`).
 * `connections` yoksa (kablolanmamış kurulum) yalnız .env okunur.
 */
export async function resolveBotIdentity(
  envAccountId: string,
  connections: ConnectionStore | undefined,
): Promise<ResolvedBotIdentity | null> {
  const configured = envAccountId.trim();
  if (configured !== "") return { accountId: configured, source: "env" };
  if (connections === undefined) return null;

  let learned: string | null;
  try {
    learned = await learnedBotAccountId(connections);
  } catch {
    // Bağlantı deposu okunamadı. Bu bir "kimlik yok" değil bir bilinmezlik,
    // ama çağıranların ikisinde de sonuç aynı: kanal bu teslimatta kapalı.
    // Fırlatmak webhook yolunda 5xx demek olurdu (M14: Jira yeniden gönderir).
    return null;
  }
  return learned === null ? null : { accountId: learned, source: "connection" };
}

/**
 * Bağlantı testinin öğrendiği bot kimliği — `listening-seed.ts`'in kural
 * tohumlarken seçtiği bağlantıyla AYNI seçim kuralı.
 *
 * Aynı olması şart: kuralların dinlediği kimlikle yeniden girişin beklediği
 * kimlik ayrışırsa, ticket bir kimlikle içeri girip başka bir kimlikle
 * uyandırılmayı beklerdi — sessizce hiç uyanmazdı.
 */
async function learnedBotAccountId(connections: ConnectionStore): Promise<string | null> {
  const jira = (await connections.list()).filter(
    (connection) =>
      connection.enabled && (connection.kind === "jira_cloud" || connection.kind === "jira_dc"),
  );
  for (const candidate of jira) {
    const learned = candidate.config["botAccountId"];
    if (typeof learned === "string" && learned.trim() !== "") return learned.trim();
  }
  return null;
}
