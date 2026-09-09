import type { TicketKey, TicketSnapshot } from "@maestro/contracts";
import type { ActivityDeps, PriorWork } from "./deps.js";

/**
 * Ticket'ın İNSAN yorumlarını okuyup intake'in göreceği hâle getirmek.
 *
 * ── NEDEN VAR ───────────────────────────────────────────────────────────────
 * Intake `getTicket` snapshot'ını okuyor: özet, açıklama, tip. Reporter'ın
 * netleştirme sorusuna yazdığı CEVAP orada değil — bir yorum olarak duruyor.
 * Sonuç, re-entry köprüsü açıldıktan sonra ölümcül: koşu uyanıyor, intake yine
 * aynı ince ticket'ı okuyor, yine "eksik" diyor. Cevap yazılmış, kimse görmüyor;
 * reporter'ın gördüğü tek şey botun kendi sorusunu tekrar etmesi. Bu dosya, o
 * cevabı modelin okuduğu metne sokan yer.
 *
 * ── PİLOTLA AYNI KURALLAR ───────────────────────────────────────────────────
 * `apps/pilot/src/run.ts`'teki `readHumanComments` ile bilerek birebir: bot'un
 * kendi notları elenir, `/` ile başlayan komut zarfları elenir (`/approve` bir
 * kapı komutu, bağlam değil), son 10 yorum kalır ve her biri 2000 karakterde
 * kırpılır. Aynı ajanı pilotla deneyip worker'a alan bir operatör iki farklı
 * davranış görmemeli — ve sınırlar keyfi değil: geveze bir ticket'ın promptu
 * şişirip modeli asıl talepten uzaklaştırmasını engelliyorlar.
 */

/** Kaç yorum modele gider. Son N, yani en TAZE olanlar. */
export const MAX_COMMENTS = 10;
/** Tek bir yorumun prompta girecek en uzun hâli. */
export const MAX_COMMENT_TEXT = 2_000;

/** Modele giden bir insan yorumu: kim yazdı, ne yazdı. */
export interface HumanComment {
  readonly author: string;
  readonly text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Yorumun yazarı, İKİ Jira lehçesinde de.
 *
 * Cloud (REST v3) tek stabil kimlik olarak `accountId` taşır; Data Center (REST
 * v2) `accountId` diye bir şey bilmez, yerine `name`/`key`/`emailAddress`
 * taşır. Sırayla denenmesinin sebebi: bir alanı olmayan ürün onu hiç
 * göndermez, dolayısıyla ilk DOLU alan o sürücünün kimliğidir.
 *
 * `displayName` KİMLİK DEĞİL ve bilerek listede yok: iki farklı kullanıcı aynı
 * görünen ada sahip olabilir, ve bot'u elemek için kullanılan şey bu — yanlış
 * eşleşme, botun kendi sorusunu "reporter cevabı" diye modele vermek demektir.
 */
export function commentAuthorId(author: unknown): string {
  const record = asRecord(author);
  if (record === null) return "";
  for (const key of ["accountId", "name", "key", "emailAddress"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

/**
 * Yorum gövdesi → düz metin, iki lehçede de.
 *
 * Cloud bir ADF belgesi (`{type:"doc", content:[…]}`) gönderir, DC düz bir
 * string. ADF'yi burada elle dolaşmak yerine düğüm metinlerini toplayan
 * özyinelemeli bir tarama var: `@maestro/adapter-jira`'nın `adfToPlainText`'i
 * doğru araç ama bu paket hiçbir sürücüyü içe aktaramaz (M44) — ve burada
 * gereken şey komut dilbilgisi için gereken kesinlikte değil: modele okunabilir
 * bir metin lazım, boşluk/paragraf inceliği değil.
 */
export function commentText(body: unknown): string {
  if (typeof body === "string") return body;
  const record = asRecord(body);
  if (record === null) return "";
  const parts: string[] = [];
  collectText(record["content"], parts);
  return parts.join("\n");
}

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return;
  }
  const record = asRecord(node);
  if (record === null) return;
  const text = record["text"];
  if (typeof text === "string" && text.length > 0) out.push(text);
  collectText(record["content"], out);
}

/**
 * Ham yorum kaynaklarını modele gidecek insan yorumlarına indirger.
 *
 * `botUserId` verilmezse bot elemesi YAPILMAZ — ve bu, hiç yorum okumamaktan
 * iyi ama ideal değil: intake kendi sorduğu soruyu da bağlamda görür. Soru
 * zaten ticket'ta durduğu için zararsız; ama çağıran bunu bir uyarı satırıyla
 * duyurur (bkz. `readHumanComments`).
 */
export function humanCommentsOf(raw: readonly unknown[], botUserId?: string): HumanComment[] {
  const bot = (botUserId ?? "").trim();
  const out: HumanComment[] = [];
  for (const comment of raw) {
    const record = asRecord(comment);
    if (record === null) continue;
    const author = commentAuthorId(record["author"]);
    if (author.length === 0) continue;
    // Maestro'nun kendi notları: ilerleme yorumları, analiz özeti, netleştirme
    // sorusunun kendisi. Bunları bağlama koymak modele kendi çıktısını cevap
    // diye okutmak olur.
    if (bot.length > 0 && author === bot) continue;
    const trimmed = commentText(record["body"]).trim();
    if (trimmed.length === 0) continue;
    // Komut zarfı (`/approve`, `/reject`): kapıya verilmiş bir emir, talebin
    // içeriği değil. M105 komutun yorumun TAMAMI olmasını şart koştuğu için
    // ilk karaktere bakmak yeterli ayrım.
    if (trimmed.startsWith("/")) continue;
    out.push({
      author,
      text:
        trimmed.length > MAX_COMMENT_TEXT ? `${trimmed.slice(0, MAX_COMMENT_TEXT)}…` : trimmed,
    });
  }
  return out.slice(-MAX_COMMENTS);
}

/**
 * Bu ticket'ın insan yorumları, sürücüden okunmuş hâliyle.
 *
 * ASLA ATMAZ. Yorumlar bir ÜST KATMAN: okunamamaları intake'i bugünkü (yorumsuz)
 * davranışına düşürür, ama koşuyu düşürmez — bir Jira 5xx'i yüzünden analiz
 * bekleyen bir ticket'ı öldürmek orantısız olurdu. Düşüş SESSİZ değil: uyarı
 * satırı operatörün gördüğü yere gider (pilot da aynısını yapıyor).
 */
export async function readHumanComments(
  deps: ActivityDeps,
  ticket: TicketKey,
  warn: (message: string) => void = (message) => console.warn(message),
  /**
   * Uyarı satırındaki adımın adı. Bu yardımcıyı artık İKİ adım çağırıyor —
   * intake ve analizin yeniden yazımı — ve "intake" yazan bir uyarı, analiz
   * turunda operatörü yanlış adıma bakmaya gönderirdi.
   */
  step = "intake",
): Promise<HumanComment[]> {
  const reader = deps.comments;
  if (reader === undefined) return [];
  let raw: unknown[];
  try {
    raw = await reader.listComments(ticket);
  } catch (error) {
    warn(
      `[maestro] ${step}: ${ticket} yorumları okunamadı (${String(error)}) — ` +
        "adım yalnız ticket metniyle devam ediyor; netleştirme cevapları görünmeyebilir.",
    );
    return [];
  }
  if (reader.botUserId === undefined && raw.length > 0) {
    warn(
      `[maestro] ${step}: bot hesabının kimliği bilinmiyor, Maestro'nun kendi ` +
        "yorumları elenemedi — adım kendi yazdığı notları da bağlamda görecek.",
    );
  }
  return humanCommentsOf(raw, reader.botUserId);
}

/** Yorum bloğunun açıklamaya eklenirken kullandığı başlık. */
export const COMMENT_BLOCK_TITLE = "--- Yorumlar (ticket üzerindeki insan yanıtları) ---";

/**
 * Yorumları açıklamanın SONUNA ekleyerek snapshot'ın bir KOPYASINI üretir.
 *
 * Kopya, çünkü `TicketSnapshot` donmuş bir sözleşme — ama nesne kopyalamak
 * bedava. Yorumlar açıklamaya giriyor (ayrı bir prompt alanına değil) çünkü
 * `buildIntakePrompt` ticket bloğunu snapshot'tan kuruyor ve o blok zaten
 * VERİ çitinin (`<<<VERI … VERI>>>`) içinde: yorumlar da reporter'ın yazdığı
 * metin, yani aynı çitin içinde olmaları TAM OLARAK doğru yer — enjeksiyon
 * savunması onlara da uygulanır.
 *
 * Yorum yoksa snapshot AYNEN döner; yeni bir nesne bile üretilmez.
 */
export function withComments(
  snapshot: TicketSnapshot,
  comments: readonly HumanComment[],
): TicketSnapshot {
  if (comments.length === 0) return snapshot;
  const lines = comments.map((c) => `- ${c.author}: ${c.text}`);
  return {
    ...snapshot,
    description: `${snapshot.description}\n\n${COMMENT_BLOCK_TITLE}\n${lines.join("\n")}`,
  };
}

/**
 * Geliştiricinin gördüğü yorum bloğunun başlığı.
 *
 * `COMMENT_BLOCK_TITLE`den AYRI, çünkü okuyucu ayrı: intake yorumları ticket
 * metninin devamı olarak okur ("reporter ne dedi"); geliştirici onları BİR
 * CEVAP LİSTESİ olarak okumalı. `brief.ts` geliştiriciye "açık soruların cevabı
 * ticket yorumlarında" diye yazıyordu ve o yorumlar prompta HİÇ girmiyordu —
 * yani ajana var olmayan bir yere bakması söyleniyordu. Başlıktaki cümle o
 * boşluğun kapandığını söyleyen taraf.
 */
export const DEVELOPER_COMMENT_BLOCK_TITLE =
  "### Ticket yorumları (insan yanıtları — açık soruların cevabı buradaysa buradadır)";

/**
 * Yorumları TEK bir metin bloğuna çevirir, ya da `undefined`.
 *
 * Ayrı bir işlev, çünkü `withComments` bir `TicketSnapshot` üretiyor ve
 * geliştirici turunun elinde snapshot YOK: brifing düz metin olarak göreve
 * ekleniyor. Aynı satır biçimi (`- yazar: metin`) bilerek korunuyor — intake ve
 * analizin gördüğü yorumla geliştiricinin gördüğü aynı şekilde okunmalı.
 *
 * Kırpma/limit YOK, çünkü zaten yapılmış: `humanCommentsOf` son
 * `MAX_COMMENTS` yorumu bırakır ve her birini `MAX_COMMENT_TEXT` karakterde
 * keser. Burada ikinci bir sınır koymak, iki farklı tüketicinin farklı
 * yorumları görmesi demek olurdu.
 */
export function commentsBlock(comments: readonly HumanComment[]): string | undefined {
  if (comments.length === 0) return undefined;
  return [DEVELOPER_COMMENT_BLOCK_TITLE, ...comments.map((c) => `- ${c.author}: ${c.text}`)].join("\n");
}

/** Önceki koşuların özetinin açıklamaya eklenirken kullandığı başlık. */
export const PRIOR_WORK_BLOCK_TITLE =
  "--- ÖNCEKİ DENEMELER (bu ticket daha önce çalışıldı; aynı işi TEKRARLAMA) ---";

/**
 * ÖNCEKİ KOŞULARIN ÖZETİNİ modele gösterir — "AI eski yapılanları hatırlasın".
 *
 * ── Neden AÇIKLAMANIN İÇİNE ─────────────────────────────────────────────────
 * `withComments`'in gerekçesinin AYNISI, ve bilerek onun yanında duruyor:
 * `buildIntakePrompt` ticket bloğunu snapshot'tan kuruyor ve o blok zaten VERİ
 * çitinin (`<<<VERI … VERI>>>`) içinde. Bu metnin tamamı ya modelin kendi eski
 * çıktısı ya da bir insanın kapıda yazdığı gerekçe — yani VERİ, talimat değil.
 * Ayrı bir prompt alanı açmak, enjeksiyon çitinin dışında ikinci bir kanal
 * açmak olurdu.
 *
 * ── Neden ÖZET, ham defter değil ────────────────────────────────────────────
 * `impl/analysis.ts` `previousNote`in kurduğu disiplin: önceki analizin tamamı
 * değil, onu TANIMLAYAN kısa kimlik. "tamamını göndermek modele kopyalayacağı
 * bir şablon vermek olurdu; istenen yeniden DÜŞÜNMEK". Özetin kendisi mağazada
 * kırpılıyor (`PrismaRunContextStore.priorWork`: üç koşu, tür başına beş
 * satır, satır başına 300 karakter) — küçük modeller uzun bağlamda zorlanır ve
 * boğulmuş bir bağlam, hiç bağlam olmamasından kötüdür.
 *
 * ── Neden BAŞLIK bir TALİMAT cümlesi taşıyor ────────────────────────────────
 * "aynı işi TEKRARLAMA" başlıkta, çitin İÇİNDEKİ veride değil: veri bloğunun
 * içine yazılan bir emir tam olarak enjeksiyon çitinin engellediği şeydir.
 * Başlık ise prompt'un kendi metni, yani rolün sözü — ve söylenmesi gerekiyor,
 * çünkü geçmişi GÖRMEK ile ondan DEVAM ETMEK arasındaki farkı model kendi
 * başına kurmaz.
 *
 * Geçmiş yoksa (`null`, ya da her listesi boş) snapshot AYNEN döner: ilk koşu
 * bugünkü promptunu bit bit korur.
 */
export function withPriorWork(
  snapshot: TicketSnapshot,
  prior: PriorWork | null,
): TicketSnapshot {
  const note = priorWorkNote(prior);
  if (note === undefined) return snapshot;
  return { ...snapshot, description: `${snapshot.description}\n\n${note}` };
}

/**
 * Özeti TEK bir metin bloğuna çevirir, ya da `undefined`.
 *
 * Ayrı bir işlev, çünkü analiz tarafı (`impl/analysis.ts` `rewriteNote`) aynı
 * metni kendi bloğunun içine koyuyor: iki adımın modele gösterdiği geçmiş
 * BİREBİR aynı olmalı, yoksa intake'in gördüğü ile analizin gördüğü ayrışır ve
 * ikisi farklı hikâyelerden devam eder.
 */
export function priorWorkNote(prior: PriorWork | null): string | undefined {
  if (prior === null) return undefined;
  const parts: string[] = [];
  // Deneme sayısı HER ZAMAN yazılır (özet varsa): defterin dört türü de boş
  // olabilir — koşu daha ilk adımda ölmüş olabilir — ve o durumda bile modelin
  // bilmesi gereken bir şey var: "bu ilk denemen değil".
  parts.push(`Bu ticket daha önce ${prior.attempts} kez çalışıldı ve koşusu tamamlanamadı.`);
  const section = (title: string, lines: readonly string[]): void => {
    if (lines.length > 0) parts.push([title, ...lines.map((line) => `  - ${line}`)].join("\n"));
  };
  section("Önceki analizden:", prior.analysis);
  section("Daha önce sorulan netleştirme soruları ve cevapları:", prior.questions);
  section("Önceki kapı kararları (ret/geri gönderme ve sebepleri):", prior.decisions);
  return [PRIOR_WORK_BLOCK_TITLE, ...parts].join("\n");
}
