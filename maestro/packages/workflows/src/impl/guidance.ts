import type { ActivityDeps, GuidanceNote, RunContext } from "./deps.js";

/**
 * Bir run'ın analist ajanının göreceği öğrenme notlarını okuyan yardımcı —
 * `persona.ts` ile aynı kalıp, aynı gerekçe.
 *
 * ── ATMAZ ───────────────────────────────────────────────────────────────────
 * Notlar bir üst katman, akışın koşulu değil. Postgres'e erişilemiyor diye
 * onaylanmayı bekleyen bir analizi düşürmek orantısız olurdu; ama düşüş sessiz
 * değil — uyarı satırı hangi ajanın notsuz koştuğunu söyler.
 *
 * ── TEMİZLER ────────────────────────────────────────────────────────────────
 * Başlığı ya da içeriği boş bir not prompta konmaz: modele "başlıksız boş bir
 * kural" tarif etmek, hiçbir şey dememekten kötüdür. Pilotun `GuidanceStore.set`
 * süzgeciyle aynı.
 */

/** Uyarının gittiği yer; enjekte edilebilir olması testin onu okumasını sağlar. */
export type GuidanceWarn = (message: string) => void;

/** Bu run'ın ANALİST ajanının etkin notları; bağlı değilse ya da yoksa `[]`. */
export async function analystGuidance(
  deps: ActivityDeps,
  run: RunContext,
  warn: GuidanceWarn = (message) => console.warn(message),
): Promise<readonly GuidanceNote[]> {
  const reader = deps.guidance;
  if (reader === undefined) return [];
  const id = run.variantId.trim();
  if (id === "") return [];

  try {
    const notes = await reader.activeGuidance(id);
    return notes
      .map((note) => ({ title: note.title.trim(), content: note.content.trim() }))
      .filter((note) => note.title !== "" && note.content !== "");
  } catch (error) {
    warn(
      `[maestro] guidance: '${id}' ajanının öğrenme notları okunamadı (${String(error)}) — ` +
        "analiz notsuz devam ediyor.",
    );
    return [];
  }
}
