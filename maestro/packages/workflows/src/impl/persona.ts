import type { ActivityDeps, RunContext } from "./deps.js";
import { engineerVariantOf } from "./deps.js";

/**
 * Bir run'ın ajan personasını okuyup, prompta konacak hâle getiren yardımcı.
 *
 * ── NEDEN VAR ───────────────────────────────────────────────────────────────
 * `PersonaReader` (deps.ts) ham bir port: "şu varyantın persona metni ne?".
 * Çağrı yerlerinin ihtiyacı ondan biraz fazlası ve her seferinde aynısı —
 * hangi varyant (analist mi mühendis mi), boş/`null` hâlleri, ve okuma
 * patlarsa ne olacağı. Üç ayrı adımda üç kez elle yazılan bu üçlü, üçüncü
 * kopyada birbirinden ayrılır. Burada bir kez yazılıyor.
 *
 * ── ATMAZ ───────────────────────────────────────────────────────────────────
 * Persona bir ÜST KATMAN (overlay), akışın koşulu değil. Postgres'e erişilemiyor
 * diye onaylanmayı bekleyen bir analizi düşürmek orantısız olurdu; pilot da
 * (`readRunPersona`) tam olarak bunu yapıyor. Ama düşüş SESSİZ DEĞİL: hata
 * `deps.audit`'e değil, uyarı satırına gider — bir persona okuması denetim
 * zincirine yazılacak bir olay değil, operatörün görmesi gereken bir arıza.
 */

/** Uyarının gittiği yer; enjekte edilebilir olması testin onu okumasını sağlar. */
export type PersonaWarn = (message: string) => void;

/**
 * Personayı analize/koda verilen bilgi notunun BAŞLIĞI.
 *
 * Pilotla birebir aynı metin (`apps/pilot/src/run.ts`, "Ajan talimatı (persona)").
 * İki yolun aynı promptu üretmesi tesadüfe bırakılamaz: aynı ajanı pilotla
 * deneyip worker'a alan bir operatör, iki farklı çıktı görmemeli.
 */
export const PERSONA_NOTE_TITLE = "Ajan talimatı (persona)";

/**
 * Bu run'ın ANALİST/intake ajanının personası, yoksa `undefined`.
 *
 * `run.variantId` — yani `activeAnalystVariantId`'nin iğnelediği varyant —
 * kullanılır; analiz yarısının ajanı odur.
 */
export function analystPersona(
  deps: ActivityDeps,
  run: RunContext,
  warn?: PersonaWarn,
): Promise<string | undefined> {
  return personaOf(deps, run.variantId, warn);
}

/**
 * Bu run'ın MÜHENDİS ajanının personası, yoksa `undefined`.
 *
 * `engineerVariantOf` üzerinden okunur: ayrı bir mühendis ajanı iğnelenmemiş
 * bir run'da (0022 öncesi açılmış olanlar dahil) analistin personası döner —
 * yani tek ajanlı kurulumun doğru cevabı.
 */
export function engineerPersona(
  deps: ActivityDeps,
  run: RunContext,
  warn?: PersonaWarn,
): Promise<string | undefined> {
  return personaOf(deps, engineerVariantOf(run), warn);
}

/**
 * Personayı bir bilgi notu listesinin BAŞINA ekler.
 *
 * Başa, sonuna değil: rol talimatı, uygulanacağı kuralların önünde okunmalı.
 * Pilotun analiz adımı da personayı listenin ilk elemanı yapıyor.
 *
 * Persona yoksa liste OLDUĞU GİBİ döner — yeni bir dizi bile üretilmez, yani
 * "persona bağlı değil" hâli çağıran için tam anlamıyla değişiklik yok demek.
 */
export function withPersona<T extends { title: string; content: string }>(
  notes: readonly T[],
  persona: string | undefined,
): readonly (T | { title: string; content: string })[] {
  if (persona === undefined) return notes;
  return [{ title: PERSONA_NOTE_TITLE, content: persona }, ...notes];
}

/** Ortak gövde: oku, kırp, boşu `undefined` yap, hatayı yut ama duyur. */
async function personaOf(
  deps: ActivityDeps,
  variantId: string,
  warn: PersonaWarn = (message) => console.warn(message),
): Promise<string | undefined> {
  const reader = deps.persona;
  if (reader === undefined) return undefined;
  const id = variantId.trim();
  if (id === "") return undefined;

  try {
    const persona = await reader.activePersona(id);
    const trimmed = persona?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
  } catch (error) {
    warn(
      `[maestro] persona: '${id}' ajanının Studio personası okunamadı (${String(error)}) — ` +
        "adım kurumun varsayılan rol promptuyla devam ediyor.",
    );
    return undefined;
  }
}
