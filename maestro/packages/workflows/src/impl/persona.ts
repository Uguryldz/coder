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

/**
 * ── Ajan eğitimleri ─────────────────────────────────────────────────────────
 * The customer's four agent briefs live in Studio as the persona of the
 * role's agent definition (seeded by `variant-defaults`), so the operator
 * reads and edits what each agent is told. The engine asks for the agent's
 * persona first and falls back to the shipped training (locale catalogue)
 * only when the installation has no persona for that role — never to
 * nothing, because a doing-role session without its brief is the old,
 * one-line task.
 */
export const TRAINING_KEY: Readonly<Record<string, string>> = {
  analyst: "agent.training.analysis",
  planner: "agent.training.planner",
  engineer: "agent.training.developer",
  dev_reviewer: "agent.training.verifier",
};

/** The persona of the agent serving `role` on this run, or undefined. */
export async function rolePersona(
  deps: ActivityDeps,
  run: RunContext,
  role: string,
  warn: PersonaWarn = (message) => console.warn(message),
): Promise<string | undefined> {
  if (role === "analyst") return personaOf(deps, run.variantId, warn);
  if (role === "engineer") return personaOf(deps, engineerVariantOf(run), warn);
  const reader = deps.persona;
  if (reader?.activePersonaForRole === undefined) return undefined;
  try {
    const persona = await reader.activePersonaForRole(role);
    const trimmed = persona?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
  } catch (error) {
    warn(`[maestro] persona: '${role}' rolünün ajanı okunamadı (${String(error)}) — varsayılan eğitimle devam ediyor.`);
    return undefined;
  }
}

/**
 * The agent definition that serves `role` on this run: the analyst and the
 * engineer are pinned per run; the planner and the verifier are the
 * installation's agent for that role, and — when none is defined — fall back
 * to the analyst (planner) or the engineer (verifier) so the call still runs
 * on a model the operator chose.
 */
export async function roleVariantId(deps: ActivityDeps, run: RunContext, role: string): Promise<string> {
  if (role === "analyst") return run.variantId;
  if (role === "engineer") return engineerVariantOf(run);
  const fallback = role === "dev_reviewer" ? engineerVariantOf(run) : run.variantId;
  const reader = deps.persona;
  if (reader?.activeVariantIdForRole === undefined) return fallback;
  try {
    const id = (await reader.activeVariantIdForRole(role))?.trim() ?? "";
    return id === "" ? fallback : id;
  } catch {
    return fallback;
  }
}

/** The agent's training: its Studio persona, else the shipped text for the role. */
export async function trainingFor(deps: ActivityDeps, run: RunContext, role: string): Promise<string> {
  const persona = await rolePersona(deps, run, role);
  if (persona !== undefined) return persona;
  const key = TRAINING_KEY[role];
  return key === undefined ? "" : deps.translate(run.locale, key);
}
