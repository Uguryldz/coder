import type { ActivityDeps, AnalysisTemplateSectionText, RunContext } from "./deps.js";

/**
 * The analysis document's content fields, in the order the Studio template's
 * sections are matched to them. The designer's default (`packages/db`
 * template-defaults) lists its sections in this order on purpose; an operator
 * who renames section 3 renames the impact analysis. Sections past the seventh
 * have no field on `AnalysisDoc` and are reported, not invented.
 */
export const ANALYSIS_FIELDS = [
  "purpose",
  "scope",
  "impactMatrix",
  "acceptanceCriteria",
  "uiApiChanges",
  "testApproach",
  "riskAndRollback",
] as const;
export type AnalysisField = (typeof ANALYSIS_FIELDS)[number];

export interface SectionInstruction {
  readonly field: AnalysisField;
  readonly title: string;
  readonly instruction: string;
}

export type TemplateWarn = (message: string) => void;

/**
 * The published template's sections, mapped to the fields the model fills.
 * `null` when there is no reader, the version is unknown, or the read fails —
 * the analyst then works from the schema alone, the way it did before, and
 * the warning says so.
 */
export async function analysisInstructions(
  deps: ActivityDeps,
  run: RunContext,
  warn: TemplateWarn = (message) => console.warn(message),
): Promise<readonly SectionInstruction[] | null> {
  const reader = deps.analysisTemplate;
  if (reader === undefined) return null;
  let sections: readonly AnalysisTemplateSectionText[] | null;
  try {
    sections = await reader.sections(run.templateVersion);
  } catch (error) {
    warn(`[maestro] template: analiz şablonu v${run.templateVersion} okunamadı (${String(error)}) — analist yalnız şemayla çalışıyor.`);
    return null;
  }
  if (sections === null || sections.length === 0) {
    warn(`[maestro] template: analiz şablonu v${run.templateVersion} bulunamadı — analist yalnız şemayla çalışıyor.`);
    return null;
  }
  const mapped = sections.slice(0, ANALYSIS_FIELDS.length).map((section, index) => ({
    field: ANALYSIS_FIELDS[index]!,
    title: section.title.trim(),
    instruction: section.aiInstruction.trim(),
  }));
  if (sections.length > ANALYSIS_FIELDS.length) {
    const extra = sections.slice(ANALYSIS_FIELDS.length).map((section) => section.title).join(", ");
    warn(`[maestro] template: belgenin ${String(ANALYSIS_FIELDS.length)} alanı var; şablondaki fazla bölümler uygulanmadı: ${extra}`);
  }
  return mapped;
}

/** Belge başlıkları için: alan → şablondaki başlık. */
export function sectionTitlesOf(
  instructions: readonly SectionInstruction[] | null,
): Partial<Record<AnalysisField, string>> {
  const out: Partial<Record<AnalysisField, string>> = {};
  for (const one of instructions ?? []) if (one.title !== "") out[one.field] = one.title;
  return out;
}

/**
 * The ground rules the analyst reads before the sections — what the schema
 * cannot say. Turkish, because the analyst answers in the project's language
 * and these are document content rules, not UI chrome (M104).
 */
export function analysisRules(run: RunContext): readonly string[] {
  return [
    `Cevabın dili '${run.locale}'; 'language' alanına birebir '${run.locale}' yaz.`,
    `'templateVersion' alanına birebir '${run.templateVersion}' yaz.`,
    "Uydurma yasak: bağlamda (ticket, yorumlar, ekler, notlar) olmayan bir olguyu yazma; bilmiyorsan 'belirtilmemiş' de.",
    run.app === null
      ? "Bu koşuda kod deposu YOK. 'impactMatrix' için: ticket'ta ya da eklerde adı geçen sistemler/uygulamalar için satır aç, 'source' alanına 'ticket' yaz, 'appId' alanına sistemin kısa adını (küçük harf, boşluk yerine tire) yaz. Hiçbir sistem anılmıyorsa listeyi boş bırak ([]); depo okunmuş gibi 'primary_repo_discovery' ya da 'repo_card' YAZMA."
      : "'impactMatrix' için en az bir satır zorunlu: birincil uygulama için 'primary_repo_discovery', diğer uygulama kartları için 'repo_card' kaynağını kullan; 'appId' alanına kayıtlı uygulama kimliğini yaz.",
    "'riskTier' alanı 'dusuk' | 'orta' | 'yuksek' | 'kritik' değerlerinden biri; 'riskReason' tek cümle gerekçe.",
    "Serbest metin alanlarında (uiApiChanges, testApproach) markdown kullanabilirsin; alt başlık için '###'.",
  ];
}
