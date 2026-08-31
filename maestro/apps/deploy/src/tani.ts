/**
 * Tanı paketi — operatörün TEK KOMUTLA üretip gönderdiği tek HTML dosyası.
 *
 * ── NEDEN VAR ───────────────────────────────────────────────────────────────
 * Bir şey çalışmadığında bugüne dek yapılan şey şuydu: operatör `docker compose
 * logs` çıktısını parça parça terminalden kopyalayıp gönderiyordu. O çıktının
 * içinde teşhis için gereken satır GERÇEKTEN vardı, ama yanında postgres'in
 * checkpoint satırları, temporal'ın matching-engine yaşam döngüsü satırları ve
 * nginx'in 200 dönen erişim satırları da vardı — binlercesi. Teşhis, gürültünün
 * altında kaldı. Aynı olay iki kez yaşandı.
 *
 * Bu dosya o çıktının YERİNE geçen tek sayfayı üretir: önce yapılandırmanın
 * teşhisi (asıl cevap orada), sonra akış durumu, sonra Jira'ya canlı deneme,
 * en sonda log'lar — ve log'lar da gürültüsü ayıklanmış, hata satırları öne
 * çıkarılmış hâlde.
 *
 * ── NEDEN SAF (ve neden ayrı dosya) ─────────────────────────────────────────
 * Burada ne veritabanı ne fetch ne docker var: girdi bir veri yapısı, çıktı bir
 * metin. `bin/tani.ts` gerçekleri TOPLAR, bu dosya onları BİÇİMLENDİRİR. Ayrımın
 * sebebi test edilebilirlik: "sır sızmıyor mu", "gürültü doğru ayıklanıyor mu",
 * "kritik bulgu en üste çıkıyor mu" — üçü de bu ürünün sessizce yanlış
 * yapabileceği şeyler ve üçü de ancak saf bir fonksiyonda sürülebilir.
 *
 * ── SIR POLİTİKASI (bu dosyanın en önemli kuralı) ───────────────────────────
 * Bu sayfa TASARIM GEREĞİ birine gönderilir. Yani buradan çıkan her karakter,
 * kurumun dışına çıkacak bir karakterdir. Bu yüzden:
 *
 *  · Hiçbir jeton/parola/anahtar DEĞERİ yazılmaz — yalnızca "tanımlı"/"tanımsız".
 *  · URL'lerdeki userinfo (`//kullanıcı:parola@host`) maskelenir, ve maskeleme
 *    `@maestro/bff`'in `maskEndpointCredentials`'ı ile yapılır — bu depoda o iş
 *    için yazılmış, `URL` ile YAPISAL ayrıştıran (regex değil) tek fonksiyon.
 *    İkinci bir maskeleyici yazmak, ikisinden birinin eksik kalması demekti.
 *  · Log satırları da maskeden geçer: bir `Authorization: Bearer …` başlığı ya
 *    da bir DSN, en çok log'un içinden sızar.
 */

/** Bir kontrolün sonucu — sayfadaki renk bundan gelir. */
export type BulguSeviye = "iyi" | "uyari" | "kritik" | "bilinmiyor";

export interface Bulgu {
  /** Ne kontrol edildi. Operatörün sorusunun karşılığı. */
  readonly baslik: string;
  readonly seviye: BulguSeviye;
  /** Sonuç — tek cümle. Sır TAŞIMAZ. */
  readonly sonuc: string;
  /**
   * Sorunluysa NE YAPILACAĞI. `iyi` bulgularda genelde yok.
   *
   * Bir bulgunun çözümsüz olması, sayfayı okuyan operatör için bulgunun hiç
   * olmamasıyla aynı şeydir — bu yüzden `kritik` bulgular için render aşaması
   * bunun boş olmasını görünür kılar.
   */
  readonly cozum?: string;
}

/** 1. bölüm: yapılandırma teşhisi. */
export interface YapilandirmaBolumu {
  readonly bulgular: readonly Bulgu[];
}

/** Bir koşunun tanı için gereken kadarı. */
export interface KosuSatiri {
  readonly id: string;
  readonly ticketKey: string;
  readonly step: string;
  readonly status: string;
  readonly updatedAt: string;
}

/** 2. bölüm: akış durumu. */
export interface AkisBolumu {
  readonly toplam: number;
  /** Adım → koşu sayısı. */
  readonly adimDagilimi: readonly (readonly [string, number])[];
  /** 2b'de bekleyenler — netleştirme cevabı beklenen koşular. */
  readonly netlestirmeBekleyen: readonly KosuSatiri[];
  readonly sonKosular: readonly KosuSatiri[];
  /** Temporal'daki açık workflow sayısı; okunamadıysa `null`. */
  readonly temporalAcik: number | null;
  /** Temporal okunamadıysa sebebi. */
  readonly temporalHata?: string;
}

/** 3. bölüm: Jira'ya yapılan tek bir canlı deneme. */
export interface JiraDeneme {
  /** `getTicket`, `listComments`, `searchIssues`, `transitions` … */
  readonly ad: string;
  readonly durum: "basarili" | "basarisiz" | "atlandi" | "sunulmuyor";
  /** HTTP kodu okunabildiyse. */
  readonly httpKodu?: number;
  /** Tek cümlelik sonuç ya da hata sebebi. Maskeden geçirilir. */
  readonly aciklama: string;
}

export interface JiraBolumu {
  /** `--jira-yok` verildiyse ya da sürücü yoksa neden atlandığı. */
  readonly atlandiSebep?: string;
  readonly denemeler: readonly JiraDeneme[];
}

/** 4. bölüm: tek bir servisin log'u. */
export interface ServisLogu {
  readonly servis: string;
  /** Gürültüsü ayıklanmış satırlar. */
  readonly satirlar: readonly string[];
  /** Kaç satır gürültü sayılıp gizlendi. */
  readonly gizlenen: number;
  /** Log hiç alınamadıysa sebebi (konteyner yok, yetki yok…). */
  readonly hata?: string;
}

/** Öne çıkarılan tek bir hata/uyarı satırı. */
export interface DikkatSatiri {
  readonly servis: string;
  readonly satir: string;
}

export interface LogBolumu {
  readonly servisler: readonly ServisLogu[];
  readonly dikkat: readonly DikkatSatiri[];
}

/** Sayfanın üstündeki künye. */
export interface TaniKunye {
  readonly uretimZamani: string;
  readonly hostAdi: string;
  readonly imajSurumu: string;
  /** Log kuyruğu uzunluğu — `--satir`. */
  readonly satirSayisi: number;
}

export interface TaniRaporu {
  readonly kunye: TaniKunye;
  readonly yapilandirma: YapilandirmaBolumu;
  readonly akis: AkisBolumu;
  readonly jira: JiraBolumu;
  readonly log: LogBolumu;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sır maskeleme
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log satırlarında sır gibi görünen ne varsa örtülür.
 *
 * ── Neden ayrı bir maskeleyici, `maskEndpointCredentials` dururken ──────────
 * O fonksiyon bir DSN'i BÜTÜN olarak alır (`new URL(dsn)`); bir log satırı ise
 * içinde URL GEÇEN serbest metindir. İkisi farklı problem: birinde girdi zaten
 * bir URL'dir, diğerinde URL'i metnin içinden BULMAK gerekir. Bu yüzden burada
 * URL'ler önce bulunur, sonra bulunan her biri o fonksiyona verilir — yani
 * maskeleme kararı yine tek yerde, `maskEndpointCredentials`'ta kalır.
 *
 * Kalıplar bilerek DAR: "içinde uzun bir onaltılık dizi olan her şey sırdır"
 * gibi bir sezgi, teşhis için gereken commit hash'lerini ve konteyner id'lerini
 * de siler — ve okunamayan bir tanı raporu, hiç gönderilmemiş bir tanı raporuna
 * eşdeğerdir. Bu yüzden yalnız ADI SÖYLENMİŞ sırlar örtülür: `Authorization`
 * başlığı, `token=`/`password=`/`secret=`/`apikey=` biçimindeki alanlar, ve
 * userinfo taşıyan URL'ler.
 */
export function maskeleSatir(satir: string, maskUrl: (dsn: string) => string): string {
  let sonuc = satir;

  // 1) URL'ler: userinfo taşıyanlar maskelenir, taşımayanlar aynen kalır.
  sonuc = sonuc.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;)\]}]+/gi, (url) => maskUrl(url));

  // 2) `Authorization: Bearer <jeton>` / `Basic <jeton>` — başlığın kendisi kalır,
  //    değeri gider. Başlığın VARLIĞI teşhis için anlamlı (kimlik gönderildi mi),
  //    değeri asla değil.
  sonuc = sonuc.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***");

  // 3) `anahtar=değer` ve `"anahtar": "değer"` biçimindeki ADI SÖYLENMİŞ sırlar.
  //
  // Ad, SONEK olarak aranıyor (`[A-Za-z0-9_]*` öneki): gerçek değişkenler
  // `JIRA_WEBHOOK_SECRET`, `LLM_API_KEY`, `POSTGRES_PASSWORD` diye yazılıyor ve
  // `_` bir kelime karakteri olduğu için `\bsecret` bunların hiçbirini
  // yakalamıyordu — yani en çok sızması muhtemel adlar tam da kaçanlardı.
  //
  // Değer ZATEN maskelenmişse dokunulmuyor. Bu kural (2)'den SONRA çalışıyor,
  // yani `Authorization: Bearer <jeton>` satırı buraya `Authorization: Bearer
  // ***` olarak geliyor — ve o hâlde ikinci kez maskelenirse `Authorization:
  // ***` olur, yani hangi kimlik ŞEMASININ kullanıldığı da silinir. Şema sır
  // değil, teşhisin kendisidir: `Bearer` bir Data Center PAT'ı, `Basic` bir
  // Cloud e-posta:jeton çifti demektir, ve yanlış şema tam olarak 401'in
  // sebebidir.
  const sirAdlari = "token|password|passwd|pwd|secret|apikey|api_key|authorization|credential";
  const zatenMaskeli = /^(?:\*\*\*|(?:Bearer|Basic)\s+\*\*\*)/i;
  sonuc = sonuc.replace(
    new RegExp(
      String.raw`\b([A-Za-z0-9_]*(?:${sirAdlari}))(["']?\s*[:=]\s*["']?)((?:Bearer|Basic)\s+\*\*\*|[^\s"',;)\]}]{4,})`,
      "gi",
    ),
    (all: string, ad: string, ayirac: string, deger: string) =>
      zatenMaskeli.test(deger) ? all : `${ad}${ayirac}***`,
  );

  return sonuc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Log gürültüsü
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sayfayı boğan, teşhis değeri OLMAYAN satırlar.
 *
 * Liste, gerçekten yaşanmış bir olaydan çıktı: operatörün gönderdiği log'da
 * 1200'den fazla satır bu üç kalıptandı ve asıl hata onların arasında görünmez
 * hâldeydi. Her kalıp, "sağlıklı bir sistemde de sürekli üretilen" olmasıyla
 * seçildi — yani varlığı bir şey söylemiyor, yokluğu bir şey söylemiyor.
 *
 * ÖNEMLİ: gürültü SİLİNMEZ, SAYILIR. Sayfada "1240 gürültü satırı gizlendi"
 * yazar. Sessizce atılan bir satır, bir gün aranan satır olur; kaç tane
 * atıldığını söylemek, aramanın nereye bakacağını bilmesini sağlar.
 */
const GURULTU_KALIPLARI: readonly RegExp[] = [
  // postgres: checkpoint / restartpoint — sağlıklı bir veritabanının nabzı.
  /\b(checkpoint starting|checkpoint complete|restartpoint (starting|complete))\b/i,
  // temporal: matching engine yaşam döngüsü — her task queue için sürekli akar.
  /"logging-call-at":"matching(TaskQueueManager|Engine)/i,
  /\bmatching-engine\b.*\blifecycle\b/i,
  // nginx erişim log'u, 200/204/304 dönenler. Hata dönenler (4xx/5xx) KALIR.
  /"\s(200|204|301|302|304)\s\d+\s/,
  // temporal history/visibility'nin rutin "scavenger"/"tasklist" turları.
  /\bscavenger\b.*\b(started|completed|skipped)\b/i,
];

/** Bir satır gürültü mü? */
export function gurultuMu(satir: string): boolean {
  return GURULTU_KALIPLARI.some((kalip) => kalip.test(satir));
}

/**
 * Öne çıkarılacak satırın kalıpları.
 *
 * Hem yapılandırılmış log'un (`pino`: `"level":50`) hem düz metin log'un
 * (postgres `ERROR:`, nginx `[error]`) biçimleri var; bu yığında ikisi de akıyor
 * ve tek bir kalıba indirgemek ikisinden birini kaçırmak demekti.
 *
 * `refused`/`failed`/`timeout` ve HTTP 401/403/503 ayrıca burada, çünkü bu
 * kurulumda arızanın en sık hâli bir istisna değil bir REDDEDİLMEDİR: Jira 401
 * döner, model sunucusuna bağlantı reddedilir, ve bunların hiçbiri `Error:`
 * kelimesini içermez.
 */
const DIKKAT_KALIPLARI: readonly RegExp[] = [
  /"level":\s*(50|60)/,
  /"level":\s*40/,
  /\b(ERROR|FATAL|PANIC)\b/,
  /\b(WARN|WARNING)\b/,
  /\bError:/,
  /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN)\b/,
  /\b(connection )?refused\b/i,
  /\bfailed\b/i,
  /\btimed? ?out\b/i,
  /\bUYARI\b/,
  /\bHTTP\/\d\.\d"?\s(4\d\d|5\d\d)\b/,
  /\b(401|403|404|500|502|503|504)\b.*\b(unauthorized|forbidden|not found|internal|bad gateway|unavailable|timeout)\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
];

export function dikkatMi(satir: string): boolean {
  return DIKKAT_KALIPLARI.some((kalip) => kalip.test(satir));
}

/**
 * Ham log kuyruğunu, sayfaya girecek hâline indirger.
 *
 * Sıra önemli: önce gürültü ayıklanır, SONRA dikkat çekenler seçilir. Tersi
 * olsaydı, nginx'in 200 dönen bir satırındaki `failed` kelimesi (bir yol adının
 * içinde bile olabilir) dikkat listesine girerdi.
 */
export function logAyikla(
  servis: string,
  ham: readonly string[],
  maskele: (satir: string) => string,
): { readonly log: ServisLogu; readonly dikkat: readonly DikkatSatiri[] } {
  const satirlar: string[] = [];
  const dikkat: DikkatSatiri[] = [];
  let gizlenen = 0;

  for (const hamSatir of ham) {
    if (hamSatir.trim() === "") continue;
    if (gurultuMu(hamSatir)) {
      gizlenen += 1;
      continue;
    }
    const temiz = maskele(hamSatir);
    satirlar.push(temiz);
    if (dikkatMi(temiz)) dikkat.push({ servis, satir: temiz });
  }

  return { log: { servis, satirlar, gizlenen }, dikkat };
}

// ─────────────────────────────────────────────────────────────────────────────
// Özet
// ─────────────────────────────────────────────────────────────────────────────

export interface TaniOzet {
  readonly kritik: number;
  readonly uyari: number;
  readonly bilinmiyor: number;
  readonly iyi: number;
  /**
   * Sistemin çalışır sayılıp sayılmadığı.
   *
   * Ölçüt SADECE yapılandırma bulguları: bir kritik bulgu, "bu kurulumda o iş
   * hiç olmuyor" demektir. Log'daki hata satırları buraya GİRMEZ — geçmişte bir
   * kez 503 dönmüş olmak, sistemin şu an çalışmadığı anlamına gelmez, ve bu iki
   * soruyu karıştırmak raporu her kurulumda kırmızı gösterirdi.
   */
  readonly calisir: boolean;
}

export function ozetle(rapor: TaniRaporu): TaniOzet {
  let kritik = 0;
  let uyari = 0;
  let bilinmiyor = 0;
  let iyi = 0;
  for (const bulgu of rapor.yapilandirma.bulgular) {
    if (bulgu.seviye === "kritik") kritik += 1;
    else if (bulgu.seviye === "uyari") uyari += 1;
    else if (bulgu.seviye === "bilinmiyor") bilinmiyor += 1;
    else iyi += 1;
  }
  return { kritik, uyari, bilinmiyor, iyi, calisir: kritik === 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTML kaçışı — bu dosyada gerçekten güvenlik sınırıdır.
 *
 * Sayfaya giren metnin büyük kısmı KONTROL EDİLMEYEN kaynaklardan geliyor: log
 * satırları, Jira hata gövdeleri, ticket başlıkları. Bir log satırında geçen
 * `<script>` dizisi, tarayıcıda açılan bu sayfada gerçekten çalışırdı — ve bu
 * sayfa tasarımı gereği başkasının makinesinde açılıyor.
 *
 * `&` ilk sırada: sonraya bırakılsaydı kendi ürettiği `&lt;` dizilerini yeniden
 * kaçırırdı.
 */
export function html(metin: string): string {
  return metin
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Gömülü stil — harici kaynak YOK, ve bu bir tercih değil bir zorunluluk.
 *
 * Bu sayfa internetsiz bir bankada üretilir ve çoğu zaman orada açılır. Bir CDN
 * bağlantısı orada sessizce başarısız olur: sayfa açılır, biçimsizdir, ve
 * operatör aracın bozuk olduğunu düşünür. Yazı tipi de sistem yığınından
 * seçiliyor, aynı sebeple.
 *
 * `prefers-color-scheme` var çünkü bu dosya bir tarayıcıda açılıyor ve koyu
 * temada beyaz bir sayfa okunmaz hâle geliyor. Renkler değişkenlerle tanımlı,
 * yani iki tema tek yerden yönetiliyor.
 */
const STIL = `
:root {
  color-scheme: light dark;
  --zemin: #ffffff; --kart: #f7f7f8; --cizgi: #d8d8dc; --metin: #16161a;
  --sonuk: #5a5a66; --kritik: #b3261e; --kritik-zemin: #fdecea;
  --uyari: #8a6100; --uyari-zemin: #fff5e0; --iyi: #10633c; --iyi-zemin: #e8f5ee;
  --bilinmiyor: #5a5a66; --bilinmiyor-zemin: #f0f0f3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --zemin: #16161a; --kart: #1e1e24; --cizgi: #34343c; --metin: #ececf0;
    --sonuk: #a0a0ae; --kritik: #ff8a80; --kritik-zemin: #3a1d1a;
    --uyari: #ffcf70; --uyari-zemin: #3a2f14; --iyi: #79dfae; --iyi-zemin: #143026;
    --bilinmiyor: #a0a0ae; --bilinmiyor-zemin: #26262e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 20px 64px; background: var(--zemin); color: var(--metin);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--cizgi); }
h3 { font-size: 15px; margin: 20px 0 8px; }
.kunye { color: var(--sonuk); font-size: 13px; margin: 0 0 20px; }
.kunye span { margin-right: 14px; white-space: nowrap; }
.ozet { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 8px; }
.rozet {
  border: 1px solid var(--cizgi); border-radius: 8px; padding: 10px 14px;
  min-width: 116px; background: var(--kart);
}
.rozet b { display: block; font-size: 26px; line-height: 1.1; }
.rozet small { color: var(--sonuk); font-size: 12px; }
.rozet.kritik { background: var(--kritik-zemin); border-color: var(--kritik); }
.rozet.kritik b { color: var(--kritik); }
.rozet.uyari { background: var(--uyari-zemin); border-color: var(--uyari); }
.rozet.uyari b { color: var(--uyari); }
.rozet.iyi { background: var(--iyi-zemin); border-color: var(--iyi); }
.rozet.iyi b { color: var(--iyi); }
.hukum { font-size: 16px; font-weight: 600; margin: 4px 0 8px; }
.hukum.kritik { color: var(--kritik); }
.hukum.iyi { color: var(--iyi); }
.bulgu {
  border: 1px solid var(--cizgi); border-left-width: 5px; border-radius: 6px;
  padding: 10px 14px; margin: 0 0 8px; background: var(--kart);
}
.bulgu.kritik { border-left-color: var(--kritik); background: var(--kritik-zemin); }
.bulgu.uyari { border-left-color: var(--uyari); background: var(--uyari-zemin); }
.bulgu.iyi { border-left-color: var(--iyi); background: var(--iyi-zemin); }
.bulgu.bilinmiyor { border-left-color: var(--bilinmiyor); background: var(--bilinmiyor-zemin); }
.bulgu .baslik { font-weight: 600; }
.bulgu .sonuc { margin-top: 2px; }
.bulgu .cozum {
  margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--cizgi);
  font-size: 14px; color: var(--sonuk);
}
.bulgu .cozum b { color: var(--metin); }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 0 0 10px; }
th, td { border: 1px solid var(--cizgi); padding: 6px 9px; text-align: left; vertical-align: top; }
th { background: var(--kart); font-weight: 600; }
td.mono, th.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.bos { color: var(--sonuk); font-style: italic; margin: 0 0 10px; }
details { border: 1px solid var(--cizgi); border-radius: 6px; margin: 0 0 8px; background: var(--kart); }
details > summary {
  cursor: pointer; padding: 9px 13px; font-weight: 600; list-style: revert;
}
details > summary .sayac { font-weight: 400; color: var(--sonuk); font-size: 13px; }
details > div { padding: 0 13px 12px; }
pre.log {
  background: var(--zemin); border: 1px solid var(--cizgi); border-radius: 5px;
  padding: 10px 12px; margin: 0; max-height: 620px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; line-height: 1.45;
  /* Uzun satır TAŞMASIN: bu sayfanın tek işi okunmak. */
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
pre.log .dikkat { background: var(--kritik-zemin); color: var(--kritik); display: block; }
.gizlenen { color: var(--sonuk); font-size: 12.5px; margin: 6px 0 0; }
.durum-basarili { color: var(--iyi); font-weight: 600; }
.durum-basarisiz { color: var(--kritik); font-weight: 600; }
.durum-atlandi, .durum-sunulmuyor { color: var(--sonuk); font-weight: 600; }
/* Yazdırma: operatör bunu PDF'e basıp gönderebilmeli, ve katlanmış bir
   bölüm PDF'te BOŞ görünür — o yüzden baskıda hepsi açılır. */
@media print {
  body { padding: 0; }
  details { break-inside: avoid; }
  details > div { display: block !important; }
  pre.log { max-height: none; overflow: visible; }
  .rozet { break-inside: avoid; }
}
`;

function bulguHtml(bulgu: Bulgu): string {
  const cozum =
    bulgu.cozum === undefined || bulgu.cozum.trim() === ""
      ? ""
      : `<div class="cozum"><b>Ne yapılacak:</b> ${html(bulgu.cozum)}</div>`;
  return (
    `<div class="bulgu ${bulgu.seviye}">` +
    `<div class="baslik">${html(bulgu.baslik)}</div>` +
    `<div class="sonuc">${html(bulgu.sonuc)}</div>` +
    cozum +
    `</div>`
  );
}

function kosuTablosu(satirlar: readonly KosuSatiri[]): string {
  if (satirlar.length === 0) return `<p class="bos">Kayıt yok.</p>`;
  const govde = satirlar
    .map(
      (kosu) =>
        `<tr><td class="mono">${html(kosu.ticketKey)}</td><td class="mono">${html(kosu.step)}</td>` +
        `<td>${html(kosu.status)}</td><td class="mono">${html(kosu.updatedAt)}</td>` +
        `<td class="mono">${html(kosu.id)}</td></tr>`,
    )
    .join("");
  return (
    `<table><thead><tr><th>Ticket</th><th>Adım</th><th>Durum</th><th>Güncelleme</th><th>Koşu no</th></tr></thead>` +
    `<tbody>${govde}</tbody></table>`
  );
}

function logHtml(log: ServisLogu): string {
  if (log.hata !== undefined) {
    return (
      `<details><summary>${html(log.servis)} <span class="sayac">— log alınamadı</span></summary>` +
      `<div><p class="bos">${html(log.hata)}</p></div></details>`
    );
  }
  const govde =
    log.satirlar.length === 0
      ? `<p class="bos">Bu servis hiç satır üretmedi (ya da hepsi gürültü sayıldı).</p>`
      : `<pre class="log">${log.satirlar
          .map((satir) => (dikkatMi(satir) ? `<span class="dikkat">${html(satir)}</span>` : html(satir)))
          .join("\n")}</pre>`;
  const gizlenen =
    log.gizlenen === 0
      ? ""
      : `<p class="gizlenen">${String(log.gizlenen)} gürültü satırı gizlendi ` +
        `(postgres checkpoint, temporal yaşam döngüsü, nginx 2xx erişim satırları).</p>`;
  return (
    `<details><summary>${html(log.servis)} ` +
    `<span class="sayac">— ${String(log.satirlar.length)} satır</span></summary>` +
    `<div>${govde}${gizlenen}</div></details>`
  );
}

/**
 * Raporun tamamı, tek bir HTML metni olarak.
 *
 * Bölüm sırası bilinçli ve tartışmaya kapalı: ÖZET, sonra YAPILANDIRMA. Bir
 * arızanın cevabı bu kurulumda neredeyse her zaman yapılandırmada; log'lar
 * cevabı DOĞRULAR ama nadiren verir. Log'ları öne koymak, operatörü tam da bu
 * aracın kurtarmaya çalıştığı yere geri gönderirdi.
 *
 * Hata özeti (`dikkat`) AÇIK gelir, servis log'ları KATLI gelir. Katlı bir
 * bölüm bu sayfada bir gizleme değil bir sıralamadır: 4×200 satır, üstteki
 * teşhisi ekrandan iter.
 */
export function taniHtml(rapor: TaniRaporu): string {
  const ozet = ozetle(rapor);
  const kunye = rapor.kunye;

  const hukum = ozet.calisir
    ? `<p class="hukum iyi">Yapılandırmada engelleyici sorun YOK.` +
      (ozet.uyari + ozet.bilinmiyor > 0 ? " Aşağıdaki uyarılara yine de bakın." : "") +
      `</p>`
    : `<p class="hukum kritik">${String(ozet.kritik)} KRİTİK sorun var — bu kurulumda ` +
      `en az bir iş sessizce HİÇ çalışmıyor. Çözümleri aşağıda.</p>`;

  const kritikler = rapor.yapilandirma.bulgular.filter((bulgu) => bulgu.seviye === "kritik");
  const digerler = rapor.yapilandirma.bulgular.filter((bulgu) => bulgu.seviye !== "kritik");

  const jiraBolum =
    rapor.jira.atlandiSebep !== undefined
      ? `<p class="bos">${html(rapor.jira.atlandiSebep)}</p>`
      : rapor.jira.denemeler.length === 0
        ? `<p class="bos">Deneme yapılmadı.</p>`
        : `<table><thead><tr><th>Çağrı</th><th>Sonuç</th><th>HTTP</th><th>Açıklama</th></tr></thead><tbody>` +
          rapor.jira.denemeler
            .map(
              (deneme) =>
                `<tr><td class="mono">${html(deneme.ad)}</td>` +
                `<td class="durum-${deneme.durum}">${html(durumEtiketi(deneme.durum))}</td>` +
                `<td class="mono">${deneme.httpKodu === undefined ? "—" : String(deneme.httpKodu)}</td>` +
                `<td>${html(deneme.aciklama)}</td></tr>`,
            )
            .join("") +
          `</tbody></table>`;

  const dikkatBolum =
    rapor.log.dikkat.length === 0
      ? `<p class="bos">Toplanan log'larda hata/uyarı kalıbı eşleşmedi.</p>`
      : `<pre class="log">${rapor.log.dikkat
          .map((satir) => `<span class="dikkat">[${html(satir.servis)}] ${html(satir.satir)}</span>`)
          .join("\n")}</pre>`;

  const adimlar =
    rapor.akis.adimDagilimi.length === 0
      ? `<p class="bos">Hiç koşu yok.</p>`
      : `<table><thead><tr><th>Adım</th><th>Koşu sayısı</th></tr></thead><tbody>` +
        rapor.akis.adimDagilimi
          .map(([adim, sayi]) => `<tr><td class="mono">${html(adim)}</td><td>${String(sayi)}</td></tr>`)
          .join("") +
        `</tbody></table>`;

  const temporal =
    rapor.akis.temporalAcik === null
      ? `<p class="bos">Temporal okunamadı${
          rapor.akis.temporalHata === undefined ? "" : `: ${html(rapor.akis.temporalHata)}`
        }</p>`
      : `<p>Temporal'da <b>${String(rapor.akis.temporalAcik)}</b> açık workflow var.</p>`;

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maestro tanı raporu — ${html(kunye.uretimZamani)}</title>
<style>${STIL}</style>
</head>
<body>
<main>
<h1>Maestro tanı raporu</h1>
<p class="kunye">
  <span>Üretim: <b>${html(kunye.uretimZamani)}</b></span>
  <span>Sunucu: <b>${html(kunye.hostAdi)}</b></span>
  <span>İmaj: <b>${html(kunye.imajSurumu)}</b></span>
  <span>Log kuyruğu: <b>${String(kunye.satirSayisi)}</b> satır/servis</span>
</p>

<div class="ozet">
  <div class="rozet ${ozet.kritik > 0 ? "kritik" : "iyi"}"><b>${String(ozet.kritik)}</b><small>kritik sorun</small></div>
  <div class="rozet ${ozet.uyari > 0 ? "uyari" : ""}"><b>${String(ozet.uyari)}</b><small>uyarı</small></div>
  <div class="rozet"><b>${String(ozet.bilinmiyor)}</b><small>bilinmiyor</small></div>
  <div class="rozet iyi"><b>${String(ozet.iyi)}</b><small>doğrulandı</small></div>
  <div class="rozet"><b>${String(rapor.log.dikkat.length)}</b><small>log hata satırı</small></div>
</div>
${hukum}

<h2>1 · Yapılandırma teşhisi</h2>
${kritikler.length === 0 ? "" : kritikler.map(bulguHtml).join("")}
${digerler.map(bulguHtml).join("")}

<h2>2 · Akış durumu</h2>
<p>Toplam <b>${String(rapor.akis.toplam)}</b> koşu.</p>
${adimlar}
<h3>2b'de bekleyen koşular — netleştirme cevabı bekliyor</h3>
${
  rapor.akis.netlestirmeBekleyen.length === 0
    ? `<p class="bos">2b'de bekleyen koşu yok.</p>`
    : `<p>Bu koşular Maestro'nun ticket'ta sorduğu soruya cevap bekliyor. Cevap verildiği hâlde ` +
      `koşu uyanmıyorsa sebep neredeyse her zaman yukarıdaki "netleştirme dönüşü" bulgusudur.</p>` +
      kosuTablosu(rapor.akis.netlestirmeBekleyen)
}
<h3>Son koşular</h3>
${kosuTablosu(rapor.akis.sonKosular)}
${temporal}

<h2>3 · Jira bağlantı testi (canlı)</h2>
<p class="kunye">Bu bölüm Jira'ya GERÇEKTEN gitti. Yalnızca OKUMA çağrıları yapıldı —
hiçbir ticket'a yorum yazılmadı, hiçbir statü geçişi UYGULANMADI (geçişler yalnızca listelendi).</p>
${jiraBolum}

<h2>4 · Servis log'ları</h2>
<h3>Hata ve uyarı satırları</h3>
${dikkatBolum}
<h3>Servis bazında tam log</h3>
${rapor.log.servisler.map(logHtml).join("")}
</main>
</body>
</html>
`;
}

function durumEtiketi(durum: JiraDeneme["durum"]): string {
  if (durum === "basarili") return "BAŞARILI";
  if (durum === "basarisiz") return "BAŞARISIZ";
  if (durum === "atlandi") return "atlandı";
  return "sunulmuyor";
}
