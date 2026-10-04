import type { JournalEntry } from "@maestro/contracts";
import type { RunDetail } from "../shared/runs.ts";
import type { RunFailure } from "./run-state.ts";

/**
 * BU KOŞUNUN tanı raporu — tek dosyalık HTML, tarayıcıda üretilir.
 *
 * ── NEDEN VAR ───────────────────────────────────────────────────────────────
 * `apps/deploy/src/tani.ts` KURULUMU teşhis eder: sürücüler, bağlantılar, kayıp
 * koşular. Operatörün prod'daki cümlesi ise bundan başkadır — "ODEME-142
 * takıldı, neden?". O sorunun cevabı kurulumun tamamında değil, TEK BİR koşunun
 * defterinde durur; ve bugüne dek o defteri paylaşmanın yolu ekran görüntüsü
 * almaktı. Bu dosya, detay ekranında ZATEN yüklü olan cevabı paylaşılabilir bir
 * belgeye çevirir.
 *
 * ── YENİ VERİ TOPLAMAZ, VE BU BİLEREK ───────────────────────────────────────
 * Girdisi ekranın kendi sorgu sonuçlarıdır (`useRunDetail`, `useJournal`,
 * `/cost`). İkinci bir toplayıcı yazmak, raporun ekrandan başka bir şey
 * söyleyebilmesi demekti — ve iki kaynak ayrıştığı gün hangisine inanılacağını
 * kimse bilemezdi. Ekranda olmayan bir gerçek raporda da yoktur; rapor bunu
 * yazar ("bu ekranda yüklü değil"), uydurmaz.
 *
 * ── SAF FONKSİYON ───────────────────────────────────────────────────────────
 * DOM'a, `window`'a, `fetch`'e dokunmaz: girdi veri + çevirmen, çıktı string.
 * İndirme kabuğu `Detail.tsx`te durur, testler bu fonksiyonu doğrudan çağırır.
 */

/** `t` ile aynı imza — bileşenin `useT()`si buraya olduğu gibi geçer. */
export type Translate = (key: string, params?: Record<string, string>) => string;

/** Ekrandaki `/cost` cevabının rapora giren kadarı (`CostTab.tsx`). */
export interface RaporMaliyet {
  readonly items: readonly {
    readonly at: string;
    readonly role: string;
    readonly model: string;
    readonly driver: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly usd: number | null;
  }[];
  readonly totals: {
    readonly usd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly calls: number;
  };
}

export interface RaporGirdisi {
  readonly detail: RunDetail;
  /** Koşunun kendi hata satırları, yeniden okunmaz — `recentErrorsOf(detail)`. */
  readonly errors: readonly RunFailure[];
  /** Defterin ilk sayfası; ekran ikinciyi de çekmiyor, rapor da çekmez. */
  readonly journal: readonly JournalEntry[] | undefined;
  /** Tüketim sekmesinin cevabı; sekme açılmadıysa `undefined` olabilir. */
  readonly cost: RaporMaliyet | undefined;
  readonly t: Translate;
  /** Tarih/saat biçimi için — ekranın `useI18n().locale` değeri. */
  readonly locale: string;
  readonly now: Date;
}

/** Bu dosyanın tek kaçış noktası; her serbest metin buradan geçer. */
export function kacir(metin: string): string {
  return metin
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Dosya adı: `maestro-<TICKET>-tani.html`. Ticket anahtarı zaten dosya-güvenli. */
export function raporDosyaAdi(ticketKey: string): string {
  return `maestro-${ticketKey.replace(/[^A-Za-z0-9_-]/g, "_")}-tani.html`;
}

function zaman(iso: string | null | undefined, locale: string): string {
  if (iso === null || iso === undefined) return "";
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(value);
}

function para(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(usd);
}

/**
 * Bir anahtarı çevir, katalogda yoksa ham değeri göster.
 *
 * `t()` bilinmeyen anahtarda FIRLATIR — ekranda doğru davranış, burada değil:
 * bu build'in tanımadığı bir adım kimliği ya da rol, raporun TAMAMINI
 * üretilemez hâle getirirdi. Rapor, operatörün elinde kalan son belge; bir
 * bilinmeyen sözcük yüzünden hiç üretilmemesi, eksik üretilmesinden kötüdür.
 */
function cevirVeyaHam(t: Translate, key: string, ham: string): string {
  try {
    return t(key);
  } catch {
    return ham;
  }
}

/**
 * Çalışma alanına dair defterin söylediği — `packages/workflows`'un
 * `discovery:no-workspace` satırı.
 *
 * NEDEN DEFTERDEN: `WorkflowRun.workspacePath` veritabanında var ama
 * `GET /studio/runs/:ticket` onu GÖNDERMİYOR, ve bu tur yeni uç açmıyor. Yani
 * "klon açıldı mı" sorusunun bu ekranda yüklü tek cevabı, keşif turunun kendi
 * yazdığı satırdır. Satır yoksa rapor "klon açılmadı" DEMEZ — bilmediğini
 * söyler; keşif hiç çalışmamış bir koşuyu "klonsuz" ilan etmek, ölçülmemiş bir
 * şeyi teşhis diye sunmak olurdu.
 */
export type CalismaAlani = "yok" | "var" | "bilinmiyor";

const KLONSUZ = /çalışma alanı yok|klon açılmam|workspace/i;

export function calismaAlaniDurumu(
  journal: readonly JournalEntry[] | undefined,
): CalismaAlani {
  if (journal === undefined) return "bilinmiyor";
  const kesif = journal.filter((entry) => entry.kind === "discovery");
  if (kesif.length === 0) return "bilinmiyor";
  const klonsuz = kesif.some(
    (entry) => KLONSUZ.test(entry.title) || KLONSUZ.test(entry.detail),
  );
  return klonsuz ? "yok" : "var";
}

/**
 * Bulgulardan çıkan öneriler — "ne yapmalı" bölümünün satırları.
 *
 * Kural: her öneri ÖLÇÜLMÜŞ bir bulguya bağlıdır. Ölçüm yoksa öneri de yok;
 * "şuna da bakın" listesi, gerçek bulguyu içinde kaybeder.
 */
export function oneriler(girdi: RaporGirdisi): readonly string[] {
  const { t, errors, journal } = girdi;
  const cikti: string[] = [];

  if (calismaAlaniDurumu(journal) === "yok") cikti.push(t("detail.rapor.oneri.workspace"));

  const metin = errors.map((e) => `${e.title} ${e.detail}`).join(" ").toLowerCase();
  // 403/401: ajanın anahtarı reddedildi — sağlayıcı tarafı, kurulum değil.
  if (/\b(401|403)\b|unauthor|forbidden|invalid[_ ]api[_ ]key/.test(metin)) {
    cikti.push(t("detail.rapor.oneri.auth"));
  }
  if (/\b429\b|rate[_ ]?limit|quota|insufficient[_ ]quota|kota/.test(metin)) {
    cikti.push(t("detail.rapor.oneri.quota"));
  }
  if (/timeout|zaman aşımı|etimedout|econnrefused|enotfound|network/.test(metin)) {
    cikti.push(t("detail.rapor.oneri.network"));
  }
  if (/şema|schema|parse|json/.test(metin)) cikti.push(t("detail.rapor.oneri.schema"));

  // Motor koşuyu kendisi kapatmış: defterde tek satır yok.
  if (girdi.detail.state?.status === "fail" && errors.length === 0) {
    cikti.push(t("detail.rapor.oneri.silent_fail"));
  }
  if (girdi.detail.stateSource === "record") cikti.push(t("detail.rapor.oneri.engine_forgot"));

  return cikti;
}

/**
 * Raporu üret.
 *
 * Bölüm sırası, operatörün okuma sırası: künye → HATA → adım geçmişi → model
 * çağrıları → ne yapmalı. Hata en üstte, çünkü raporu açan kişinin sorusu
 * "neden takıldı"dır ve cevabın üçüncü ekranda olması, orada olmamasıyla aynı
 * şeydir.
 *
 * VERİ YOKSA BÖLÜM ÇİZİLMEZ. Boş bir "Hata: yok" başlığı, sorulmamış bir soruya
 * cevap vermiş gibi olur — ve daha kötüsü, hiç ölçülmemiş bir şeyi temize
 * çıkarır (`documents.ts`teki koşullu bölüm deseni).
 */
export function raporHtml(girdi: RaporGirdisi): string {
  const { detail, t, locale, now } = girdi;
  const ticket = detail.run.ticketKey;

  const bolumler = [
    kunyeBolumu(girdi),
    hataBolumu(girdi),
    adimBolumu(girdi),
    maliyetBolumu(girdi),
    oneriBolumu(girdi),
  ]
    .filter((parca) => parca !== "")
    .join("\n");

  const baslik = t("detail.rapor.title", { ticket });

  return `<!doctype html>
<html lang="${locale === "en" ? "en" : "tr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${kacir(baslik)}</title>
<style>${STIL}</style>
</head>
<body>
<main>
<h1>${kacir(baslik)}</h1>
<p class="kunye">
  <span>${kacir(t("detail.rapor.generated", { at: zaman(now.toISOString(), locale) }))}</span>
  <span>${kacir(t("detail.rapor.source"))}</span>
</p>
${bolumler}
</main>
</body>
</html>
`;
}

/** Künye — koşunun kimliği. Her zaman çizilir: raporun neyin raporu olduğu. */
function kunyeBolumu(girdi: RaporGirdisi): string {
  const { detail, t, locale } = girdi;
  const state = detail.state;
  const record = detail.run;
  const app = detail.application;

  const satirlar: (readonly [string, string])[] = [
    [t("detail.field.status"), state === null ? "—" : cevirVeyaHam(t, `run.status.${state.status}`, state.status)],
    [
      t("detail.field.step"),
      state === null ? "—" : `${state.step} · ${cevirVeyaHam(t, `steps.${state.step}`, state.step)}`,
    ],
    [t("detail.field.mode"), cevirVeyaHam(t, `mode.${record.mode}`, record.mode)],
    [
      t("detail.field.risk"),
      cevirVeyaHam(t, `risk.${state?.risk ?? record.risk}`, state?.risk ?? record.risk),
    ],
    [
      t("detail.field.app"),
      app === null ? "—" : `${app.displayName} (${app.adoProject}/_git/${app.adoRepo})`,
    ],
    [t("detail.field.run_id"), state === null ? "—" : state.runId],
    [t("detail.field.started"), zaman(state?.startedAt ?? record.startedAt, locale)],
    [t("detail.field.updated"), zaman(state?.updatedAt ?? record.updatedAt, locale)],
    [t("detail.rapor.workspace"), calismaAlaniMetni(girdi)],
  ];

  return `<h2>${kacir(t("detail.rapor.section.kunye"))}</h2>
<p class="konu">${kacir(detail.run.title)}</p>
<table><tbody>${satirlar
    .map(([ad, deger]) => `<tr><th>${kacir(ad)}</th><td>${kacir(deger)}</td></tr>`)
    .join("")}</tbody></table>
${
  detail.stateSource === "record"
    ? `<p class="uyari-satir">${kacir(girdi.t("detail.steps.from_record"))}</p>`
    : ""
}`;
}

function calismaAlaniMetni(girdi: RaporGirdisi): string {
  const durum = calismaAlaniDurumu(girdi.journal);
  if (durum === "yok") return girdi.t("detail.rapor.workspace.none");
  if (durum === "var") return girdi.t("detail.rapor.workspace.ok");
  return girdi.t("detail.rapor.workspace.unknown");
}

/**
 * HATA — raporun en üst bölümü, ve YALNIZ gerçekten bir hata varsa.
 *
 * "Var" iki şeyden biri demek: koşu `fail` ile kapandı, ya da defterde koşunun
 * kendi hata satırları duruyor (`recentErrors`, BFF'in `isErrorEntry`
 * sınıflandırması). Hiçbiri yoksa bölüm ÇİZİLMEZ — "Hata: yok" satırı, hata
 * arayan gözün ilk takıldığı yerde yanlış bir rahatlama üretir.
 */
function hataBolumu(girdi: RaporGirdisi): string {
  const { detail, errors, t, locale } = girdi;
  const failed = detail.state?.status === "fail";
  if (!failed && errors.length === 0) return "";

  const govde =
    errors.length === 0
      ? `<p class="bulgu kritik">${kacir(t("detail.steps.failure_unknown"))}</p>`
      : errors
          .map(
            (hata) =>
              `<div class="bulgu kritik">` +
              `<div class="baslik">${kacir(hata.title)}</div>` +
              `<div class="sonuc">${kacir(
                t("detail.rapor.error.where", {
                  step: hata.step ?? detail.state?.step ?? "—",
                  at: zaman(hata.at, locale),
                }),
              )}</div>` +
              (hata.detail === "" ? "" : `<pre class="metin">${kacir(hata.detail)}</pre>`) +
              `</div>`,
          )
          .join("");

  return `<h2 class="kritik-baslik">${kacir(t("detail.rapor.section.hata"))}</h2>
${govde}`;
}

/** Adım geçmişi — defter satırları. Defter boşsa ya da yüklenmediyse çizilmez. */
function adimBolumu(girdi: RaporGirdisi): string {
  const { journal, t, locale } = girdi;
  if (journal === undefined || journal.length === 0) return "";

  const satirlar = journal
    .map(
      (entry) =>
        `<tr>` +
        `<td class="mono">${kacir(zaman(entry.at, locale))}</td>` +
        `<td class="mono">${kacir(entry.kind)}</td>` +
        `<td class="mono">${kacir(entry.actor)}</td>` +
        `<td><b>${kacir(entry.title)}</b>` +
        (entry.detail === "" ? "" : `<div class="metin">${kacir(entry.detail)}</div>`) +
        `</td></tr>`,
    )
    .join("");

  return `<h2>${kacir(t("detail.rapor.section.defter"))}</h2>
<table><thead><tr>` +
    `<th>${kacir(t("detail.rapor.col.at"))}</th>` +
    `<th>${kacir(t("detail.rapor.col.kind"))}</th>` +
    `<th>${kacir(t("detail.rapor.col.actor"))}</th>` +
    `<th>${kacir(t("detail.rapor.col.what"))}</th>` +
    `</tr></thead><tbody>${satirlar}</tbody></table>`;
}

/** Model çağrıları — tüketim sekmesi hiç açılmadıysa veri yoktur, bölüm de yok. */
function maliyetBolumu(girdi: RaporGirdisi): string {
  const { cost, t, locale } = girdi;
  if (cost === undefined || cost.items.length === 0) return "";

  const satirlar = cost.items
    .map(
      (row) =>
        `<tr>` +
        `<td class="mono">${kacir(zaman(row.at, locale))}</td>` +
        `<td>${kacir(cevirVeyaHam(t, `llm.role.${row.role}`, row.role))}</td>` +
        `<td class="mono">${kacir(row.model)} · ${kacir(row.driver)}</td>` +
        `<td class="mono">${String(row.tokensIn)} / ${String(row.tokensOut)}</td>` +
        `<td class="mono">${kacir(row.usd === null ? t("detail.cost.quota") : para(row.usd, locale))}</td>` +
        `</tr>`,
    )
    .join("");

  return `<h2>${kacir(t("detail.rapor.section.maliyet"))}</h2>
<p>${kacir(
    t("detail.cost.totals", {
      calls: String(cost.totals.calls),
      in: String(cost.totals.tokensIn),
      out: String(cost.totals.tokensOut),
      usd: para(cost.totals.usd, locale),
    }),
  )}</p>
<table><thead><tr>` +
    `<th>${kacir(t("detail.cost.col.at"))}</th>` +
    `<th>${kacir(t("detail.cost.col.role"))}</th>` +
    `<th>${kacir(t("detail.cost.col.model"))}</th>` +
    `<th>${kacir(t("detail.cost.col.tokens"))}</th>` +
    `<th>${kacir(t("detail.cost.col.usd"))}</th>` +
    `</tr></thead><tbody>${satirlar}</tbody></table>`;
}

/** Ne yapmalı — bulgu yoksa öneri de yok, bölüm de yok. */
function oneriBolumu(girdi: RaporGirdisi): string {
  const liste = oneriler(girdi);
  if (liste.length === 0) return "";
  return `<h2>${kacir(girdi.t("detail.rapor.section.oneri"))}</h2>
<ul class="oneri">${liste.map((satir) => `<li>${kacir(satir)}</li>`).join("")}</ul>`;
}

/**
 * Gömülü stil — harici kaynak YOK.
 *
 * Bu dosya Studio'nun DIŞINDA açılır: e-postaya eklenir, bir bankada internetsiz
 * bir makinede okunur. Bir CSS değişkeni ya da CDN bağlantısı orada boş bir
 * sayfa demektir. Renkler `tani.ts`in paletinden kopyalanmış literal değerler —
 * kaynak aynı olsun diye değil, DIŞARIDA da aynı görünsün diye.
 */
const STIL = `
:root {
  color-scheme: light dark;
  --zemin: #ffffff; --kart: #f7f7f8; --cizgi: #d8d8dc; --metin: #16161a;
  --sonuk: #5a5a66; --kritik: #b3261e; --kritik-zemin: #fdecea;
  --uyari: #8a6100; --uyari-zemin: #fff5e0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --zemin: #16161a; --kart: #1e1e24; --cizgi: #34343c; --metin: #ececf0;
    --sonuk: #a0a0ae; --kritik: #ff8a80; --kritik-zemin: #3a1d1a;
    --uyari: #ffcf70; --uyari-zemin: #3a2f14;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 20px 64px; background: var(--zemin); color: var(--metin);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 1000px; margin: 0 auto; }
h1 { font-size: 23px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--cizgi); }
h2.kritik-baslik { color: var(--kritik); border-bottom-color: var(--kritik); }
.kunye { color: var(--sonuk); font-size: 13px; margin: 0 0 18px; }
.kunye span { margin-right: 14px; }
.konu { font-size: 16px; margin: 0 0 10px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 0 0 10px; }
th, td { border: 1px solid var(--cizgi); padding: 6px 9px; text-align: left; vertical-align: top; }
th { background: var(--kart); font-weight: 600; }
tbody th { width: 190px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; white-space: nowrap; }
.bulgu {
  border: 1px solid var(--cizgi); border-left-width: 5px; border-radius: 6px;
  padding: 10px 14px; margin: 0 0 8px; background: var(--kart);
}
.bulgu.kritik { border-left-color: var(--kritik); background: var(--kritik-zemin); }
.bulgu .baslik { font-weight: 600; }
.bulgu .sonuc { color: var(--sonuk); font-size: 13px; margin-top: 2px; }
/* Hatanın metni KESİLMEZ: şema hatası dört yüz karakterlik bir ipucudur. */
.metin, pre.metin {
  margin: 6px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
td .metin { color: var(--sonuk); }
.uyari-satir {
  background: var(--uyari-zemin); color: var(--uyari); border-radius: 6px;
  padding: 8px 12px; margin: 0 0 10px; font-size: 14px;
}
ul.oneri { margin: 0; padding-left: 20px; }
ul.oneri li { margin: 0 0 6px; }
/* Yazdırma: rapor PDF'e basılıp paylaşılabilmeli. */
@media print {
  body { padding: 0; }
  tr { break-inside: avoid; }
}
`;
