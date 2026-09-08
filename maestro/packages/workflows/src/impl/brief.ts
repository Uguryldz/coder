import { AnalysisDoc } from "@maestro/contracts";
import type { ActivityDeps, RunContext } from "./deps.js";

/**
 * The hand-offs between the bank's four agents — analysis agent, planner,
 * developer, verifier — as the customer's briefs describe them.
 *
 * ── NEDEN BU DOSYA VAR ────────────────────────────────────────────────────────
 * Müşterinin ajan tanımları bir zincir: analiz ajanı gereksinim → kod
 * eşlemesini çıkarır; plan (dosya listesi, endpoint sözleşmesi, DTO alanları)
 * onaylanır; geliştirici planı uygular ve plan dışına çıktığını LOGLAR;
 * doğrulayıcı her iş kuralını TEK TEK PASS/FAIL raporlar. Bu zincirin her
 * halkası bir öncekinin ÇIKTISINI okumak zorunda — ve Temporal yolunda
 * aktiviteler birbirinin belleğini görmez. Buradaki iki köprü bunu sağlar:
 *
 *   · Keşif notları DEFTERE yazılır (`discoveryNotes`), analist ve plancı
 *     oradan okur. Yeni bir aktivite, yeni bir kolon, yeni bir workflow adımı
 *     gerekmez — replay güvenliği bozulmaz.
 *   · Analiz belgesi JSON olarak depoya konur (`storeAnalysis`), geliştirici
 *     ve doğrulayıcı aktiviteleri `loadAnalysis` ile geri okur. Depo
 *     okunamazsa her tüketici bugünkü davranışına düşer (fail-soft): plan
 *     olmadan kabul kriterleri, kural listesi olmadan düz inceleme.
 */

/** Where the run's latest analysis document lives, as JSON. */
export function analysisObjectKey(runId: string): string {
  return `${runId}/analysis/analysis.json`;
}

/** Persist the document for the doing-role activities; never throws. */
export async function storeAnalysis(deps: ActivityDeps, run: RunContext, doc: AnalysisDoc): Promise<boolean> {
  try {
    await deps.storage.put(analysisObjectKey(run.runId), new TextEncoder().encode(JSON.stringify(doc)), {
      contentType: "application/json",
    });
    return true;
  } catch (error) {
    console.warn(`[maestro] brief: analiz belgesi depoya yazılamadı (${String(error)}) — geliştirici plansız çalışır.`);
    return false;
  }
}

/** The stored document, or null when there is none / it cannot be read. */
export async function loadAnalysis(deps: ActivityDeps, run: RunContext): Promise<AnalysisDoc | null> {
  try {
    const bytes = await deps.storage.get(analysisObjectKey(run.runId));
    return AnalysisDoc.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/**
 * The read-only discovery agent's findings, as the analyst and the planner
 * read them: the LAST `discovery` journal entry's detail. The first line is
 * the count summary the entry always carried; the rest is the agent's
 * requirement→code notes (see `DiscoveryDigest.notes`). Null when the run
 * never discovered anything (analysis-only) or the notes are empty.
 */
export async function discoveryNotes(deps: ActivityDeps, run: RunContext): Promise<string | null> {
  try {
    const entries = await deps.memory.store.list(run.runId);
    const last = [...entries].reverse().find((entry) => entry.kind === "discovery");
    if (last === undefined) return null;
    const detail = (last.detail ?? "").trim();
    const body = detail.split("\n").slice(1).join("\n").trim();
    return body === "" ? null : body;
  } catch {
    return null;
  }
}

function numbered(prefix: string, items: readonly string[]): string {
  return items.map((item, index) => `${prefix}${String(index + 1)}. ${item}`).join("\n");
}

/**
 * What the developer agent reads before its first turn: the approved plan and
 * the rules it will be verified against. Plain text, in the document's own
 * language — it is pasted under the task, not rendered as a document.
 */
export function developerBrief(doc: AnalysisDoc): string {
  const parts: string[] = [];
  if (doc.businessRules.length > 0) parts.push(`### İş kuralları (doğrulayıcı tek tek kontrol edecek)\n${numbered("K", doc.businessRules)}`);
  parts.push(`### Kabul kriterleri\n${numbered("A", doc.acceptanceCriteria)}`);
  if (doc.requirements.length > 0) parts.push(`### Gereksinimler (belgeden birebir)\n${numbered("G", doc.requirements)}`);
  if (doc.plan !== null) {
    const plan = doc.plan;
    const files = plan.files.map((f) => `- ${f.path} — ${f.change}`).join("\n");
    const endpoints = plan.endpoints.map((e) => `- ${e.method} ${e.path} — ${e.contract}`).join("\n");
    const dtos = plan.dtos.map((d) => `- ${d.name}: ${d.fields.join(", ")}`).join("\n");
    const conventions = plan.conventions.map((c) => `- ${c}`).join("\n");
    parts.push(
      [
        "### ONAYLI PLAN",
        `Dosya listesi:\n${files || "- (plan dosya saymadı)"}`,
        `Endpoint sözleşmesi:\n${endpoints || "- (yok)"}`,
        `DTO alanları:\n${dtos || "- (yok)"}`,
        `Örnek alınacak konvansiyonlar:\n${conventions || "- aynı dizindeki benzer dosyayı örnek al"}`,
        plan.notes === "" ? "" : `Notlar:\n${plan.notes}`,
      ]
        .filter((line) => line !== "")
        .join("\n\n"),
    );
  }
  if (doc.gaps.length > 0) parts.push(`### Analizde eksik bulunanlar (bunları SEN yazacaksın)\n${numbered("E", doc.gaps)}`);
  if (doc.openQuestions.length > 0) {
    parts.push(
      `### Açık sorular (kapıda cevaplanmış olmalı; cevap ticket yorumlarında)\n${numbered("S", doc.openQuestions)}`,
    );
  }
  return parts.join("\n\n");
}

/** The verifier's checklist: every business rule, numbered the way the developer saw it. */
export function ruleChecklist(doc: AnalysisDoc): readonly string[] {
  const rules = doc.businessRules.length > 0 ? doc.businessRules : doc.acceptanceCriteria;
  return rules.map((rule, index) => `${doc.businessRules.length > 0 ? "K" : "A"}${String(index + 1)}. ${rule}`);
}

/** "PLAN SAPMASI: …" lines the developer agent wrote, one per deviation. */
export function planDeviations(finalText: string): readonly string[] {
  return finalText
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    // Turkish dotless ı: a case-insensitive /I/ does not match "sapması".
    .filter((line) => /^PLAN SAPMAS[Iı](?=\s|[:\-–]|$)/i.test(line))
    .map((line) => line.replace(/^PLAN SAPMAS[Iı]\s*[:\-–]?\s*/i, "").trim())
    .filter((line) => line !== "");
}
