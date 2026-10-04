/**
 * ÖLÜ AYARIN DİRİLTİLMESİ — `gates.risk_tiers` artık GERÇEKTEN okunuyor.
 *
 * ── Ne ölçüldü ──────────────────────────────────────────────────────────────
 * `gates.risk_tiers` M51'den beri `params-defaults.ts`te tanımlı, panelde
 * görünüyor, 4-göz korumalı ("guarded"), sürümleniyor ve denetleniyor. Ve
 * HİÇBİR KOD OKUMUYORDU. Değerleri `GATES_BY_RISK` sabitiyle
 * (`packages/contracts/src/workflow.ts`) birebir aynı; yani panelde gördüğü
 * sayılar doğruydu, ama operatör onları DEĞİŞTİRDİĞİNDE hiçbir şey olmuyordu.
 *
 * Bu, boş bir ayardan daha kötü: operatör kapı setini daralttığını sanıp
 * beklemediği bir kapıda bekliyordu, ve panel ona kendi yazdığı değeri geri
 * gösteriyordu. Bugün yaşadığı üç sorundan biri buydu.
 *
 * ── İki seçenek vardı, ikincisi seçildi ─────────────────────────────────────
 *  (a) Ayarı PANELDEN KALDIR. Dürüst, ama operatörün elinden global bir kolu
 *      alır: kural bazlı seçim gelmeden önce her kural için tek tek aynı diziyi
 *      seçmek gerekirdi, ve kurulumda tek bir yerden "bu sahada kapılar şöyle
 *      işler" demenin yolu kalmazdı.
 *  (b) SEÇİLEN: ayarı OKU, ve kural bazlı seçimin ARKASINA koy. Üç katman:
 *
 *        1. kuralın `gateSteps` seçimi        → varsa o, başka hiçbir şeye
 *                                                bakılmaz
 *        2. `gates.risk_tiers` parametresi     → kuralda seçim yoksa, ve
 *                                                parametre `GATES_BY_RISK`ten
 *                                                FARKLIYSA
 *        3. `GATES_BY_RISK`                    → ikisi de yoksa; bugüne kadarki
 *                                                tek cevap
 *
 * ── Neden 2. katman "FARKLIYSA" ─────────────────────────────────────────────
 * Parametre varsayılan değeriyle duruyorsa (kurulumların ezici çoğunluğu) onu
 * koşuya YAZMIYORUZ, `undefined` bırakıyoruz. İkisi aynı cevabı verir, ama
 * yazmamak iki şeyi korur:
 *
 *  · Koşunun başlangıç girdisi bugünküyle BİT BİT AYNI kalır. Girdiye her
 *    koşuda bir dizi eklemek, "bu alanın varlığı bir seçimi gösterir"
 *    okumasını bozar ve denetim satırında her koşu "operatör kapı seçti" gibi
 *    görünür.
 *  · Ürünün varsayılanı ilerlediğinde (M92 gibi) dokunulmamış kurulumlar
 *    ilerlemeyi ALIR. Değeri her koşuya kopyalasaydık, hiç düzenlenmemiş bir
 *    parametre eski varsayılanı sonsuza dek dondururdu.
 *
 * ── Neden BURADA (BFF), workflow'da değil ───────────────────────────────────
 * `packages/workflows` veritabanı okuyamaz (M44) ve okumamalı: bir parametreyi
 * workflow içinden sormak, replay'de başka bir cevap almak demektir. Cevap
 * girişte bir kez okunur ve koşunun başlangıç girdisine ÇİVİLENİR — `statusMap`,
 * `flow` ve ajan iğneleriyle tam olarak aynı gerekçe.
 */

import { z } from "zod";
import { APPROVAL_GATE_STEPS, GATES_BY_RISK, type RiskTier } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import type { GateSteps } from "./listening-store.js";

/** `gates.risk_tiers` parametresinin şekli — üç katman, her biri adım listesi. */
export const RiskTiersSchema = z
  .object({
    dusuk: z.array(z.enum(APPROVAL_GATE_STEPS)),
    orta: z.array(z.enum(APPROVAL_GATE_STEPS)),
    kritik: z.array(z.enum(APPROVAL_GATE_STEPS)),
  })
  .strict();

export type RiskTiers = z.infer<typeof RiskTiersSchema>;

/** İki dizi AYNI kapı kümesini mi anlatıyor — sıradan ve yinelenenlerden bağımsız. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort().join(",");
  const right = [...new Set(b)].sort().join(",");
  return left === right;
}

/**
 * Parametre, ürünle gelen varsayılanın AYNISI mı — üç katmanın üçü de.
 *
 * Tek bir katman bile ayrılmışsa parametre "düzenlenmiş" sayılır ve tamamı
 * kullanılır. Katman katman karışık kullanmak (biri parametreden, diğeri
 * sabitten) bir üçüncü yapılandırma uydurmak olurdu, ve hangi cevabın nereden
 * geldiğini kimse söyleyemezdi.
 */
export function isProductDefault(tiers: {
  readonly dusuk: readonly string[];
  readonly orta: readonly string[];
  readonly kritik: readonly string[];
}): boolean {
  return (Object.keys(GATES_BY_RISK) as RiskTier[]).every((tier) =>
    sameSet(tiers[tier], GATES_BY_RISK[tier]),
  );
}

/**
 * Bir koşu için kapı seçimi: kural → parametre → sabit.
 *
 * Dönen değer doğrudan `StartRunInput.gateSteps`e geçer. `null` = "seçim yok",
 * yani workflow `GATES_BY_RISK`e düşer.
 *
 * ── FAIL-SOFT, ve neden ─────────────────────────────────────────────────────
 * Parametre okunamazsa (tablo yok, satır yok, değer bozuk) `null` dönülür:
 * risk katmanı varsayılanı, yani bugüne kadarki davranış. Fırlatmak, bir
 * teşhis satırı uğruna çalışan bir ticket alımını reddetmek olurdu — ve
 * yanlış yönde: sessizce DAHA ÇOK onay beklemek, sessizce daha az beklemekten
 * her zaman iyidir.
 *
 * `risk` bilerek SORULMUYOR. Kapı dizisi risk katmanına göre seçilir, ama o
 * katmanı analiz belirler (adım 3) ve alım anında henüz YOKTUR. Bu yüzden
 * parametrenin üç katmanı da koşuya geçmez; geçen şey ya kuralın açık seçimi
 * ya da hiçbir şeydir, ve workflow riski öğrendikten sonra kendi tablosuna
 * bakar. Parametrenin buradaki rolü, o tabloyu DEĞİŞTİRMEK değil, kuralda
 * seçim yokken operatörün global kararını uygulamak.
 */
export async function resolveGateSteps(
  deps: ResolvedDeps,
  ruleChoice: GateSteps | null | undefined,
  risk: RiskTier,
): Promise<GateSteps | null> {
  // 1. Kuralın seçimi her şeyi bitirir — boş dizi dahil ("kapı istemiyorum").
  if (ruleChoice !== undefined && ruleChoice !== null) return ruleChoice;

  // 2. Global parametre, yalnız ürünün varsayılanından FARKLIYSA.
  const tiers = await readRiskTiers(deps);
  if (tiers === null || isProductDefault(tiers)) return null;

  // Parametre bir kapı dizisi seçmiyor, bir TABLO veriyor; koşuya geçen ise
  // tek bir dizi. Alım anında risk henüz bilinmediği için `orta` katmanı
  // kullanılmaz — kullanılan, analizin bulacağı katmanın karşılığı. Bu yüzden
  // çağıran riski verir (yeniden başlatmalarda bilinir) ve ilk alımda
  // varsayılan `orta`dır, tıpkı `initialRunState`in yaptığı gibi.
  return { steps: [...tiers[risk]] };
}

/**
 * `gates.risk_tiers` parametresini okur — YOKSA ya da BOZUKSA `null`.
 *
 * `notify-service.ts`in `readOptionalParam`ının kardeşi, bir farkla: orada
 * bozuk bir değer FIRLATIYOR, çünkü bir bildirim merdiveni sessizce
 * çalışmadığında kimse fark etmez. Burada bozuk bir değer `null`'a düşer,
 * çünkü buradaki `null` bugüne kadarki davranışın ta kendisi — fırlatmak,
 * elle düzenlenmiş tek bir JSON yüzünden ticket alımını tamamen durdururdu.
 */
async function readRiskTiers(deps: ResolvedDeps): Promise<RiskTiers | null> {
  let values: Awaited<ReturnType<ResolvedDeps["params"]["values"]>>;
  try {
    values = await deps.params.values();
  } catch {
    return null;
  }
  const rows = values.filter((value) => value.key === "gates.risk_tiers" && value.scopeRef === null);
  const newest = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (best === null || row.version > best.version ? row : best),
    null,
  );
  if (newest === null) return null;
  const parsed = RiskTiersSchema.safeParse(newest.value);
  return parsed.success ? parsed.data : null;
}
