import { z } from "zod";
import { Locale, NonEmpty, RiskTier } from "./common.js";

/** One row of the impact matrix. Cross-app impact is judged from repo cards (M100). */
/**
 * Where an impact claim comes from. `primary_repo_discovery` and `repo_card`
 * are repo-backed. `ticket` is the honest third answer for an analysis-only
 * run (no repository, no application registry): the ticket names a system —
 * "BOA", "kredi tahsis" — and the analyst can say it is touched without
 * pretending a repository was read. Fan-out (M100) opens child tickets only
 * for repo-backed cells; a `ticket` cell is a statement in the document, not
 * a work item.
 */
export const ImpactSource = z.enum(["primary_repo_discovery", "repo_card", "ticket"]);
export type ImpactSource = z.infer<typeof ImpactSource>;

export const ImpactCell = z.object({
  /**
   * A registry id for a repo-backed cell (`AppId` shape); for a `ticket`
   * cell, the system's short name as the ticket writes it. The shape is
   * checked where it matters — `fanOutChildren` refuses anything that is
   * not an `AppId` — not at the schema gate, where a Turkish system name
   * would otherwise fail the whole document five times over.
   */
  appId: z.string().trim().min(1).max(64),
  impacted: z.boolean(),
  summary: NonEmpty.max(500),
  source: ImpactSource,
});
export type ImpactCell = z.infer<typeof ImpactCell>;

/**
 * ── Müşteri sözleşmesi: analiz ajanının ek çıktıları ─────────────────────────
 *
 * The bank's analysis-agent brief asks for more than the seven template
 * sections: the requirement list verbatim, where each one lives in the code
 * (file:line), what is MISSING, scale risks traced end to end, scope decisions
 * left as options with trade-offs (never chosen by the agent), the open
 * questions a developer must not start without, the business rules a verifier
 * later checks one by one, and — when a repository is bound — the
 * implementation plan (files, endpoint contract, DTO fields) the developer
 * agent follows. Every one of these DEFAULTS to empty so a document written
 * before this contract still parses, and an analysis-only run (no repo) can
 * honestly leave the code-bound ones empty.
 */

/** One requirement and where the code base answers it today. */
export const CodeMapping = z.object({
  requirement: NonEmpty.max(500),
  /** `path:line` (or `path`) as seen in discovery; "yok" when nothing answers it. */
  location: NonEmpty.max(300),
  status: z.enum(["karsilar", "kismen", "yok"]),
  note: z.string().max(800).default(""),
});
export type CodeMapping = z.infer<typeof CodeMapping>;

/**
 * A number, limit, volume or concurrency in the requirement, traced through
 * the code path. Three verdicts on purpose: "the endpoint exists" and "it
 * works at this volume" are different claims, and "belirsiz" (must be tested)
 * is an honest third answer that becomes an open question.
 */
export const ScaleRisk = z.object({
  claim: NonEmpty.max(300),
  verdict: z.enum(["karsilar", "karsilamaz", "belirsiz"]),
  /** What was checked: N+1 calls, sync transaction, timeouts/pools/payload limits, prior volume tests. */
  evidence: z.string().max(1500).default(""),
  reason: NonEmpty.max(800),
});
export type ScaleRisk = z.infer<typeof ScaleRisk>;

/** A scope decision the agent must NOT make: the options and their trade-offs. */
export const ScopeOption = z.object({
  decision: NonEmpty.max(300),
  options: z
    .array(z.object({ option: NonEmpty.max(300), tradeoff: NonEmpty.max(800) }))
    .min(2)
    .max(6),
});
export type ScopeOption = z.infer<typeof ScopeOption>;

/**
 * The developer's input: which files change, the endpoint contract, the DTO
 * fields, and the conventions to copy from neighbouring files. Written by a
 * SEPARATE planner call after the analysis, from the discovery findings;
 * null when the run has no repository or the planner could not produce one.
 */
export const ImplementationPlan = z.object({
  files: z.array(z.object({ path: NonEmpty.max(300), change: NonEmpty.max(800) })).max(80),
  endpoints: z
    .array(z.object({ method: NonEmpty.max(16), path: NonEmpty.max(300), contract: NonEmpty.max(1500) }))
    .max(40)
    .default([]),
  dtos: z
    .array(z.object({ name: NonEmpty.max(200), fields: z.array(NonEmpty.max(300)).max(60) }))
    .max(40)
    .default([]),
  /** Files/patterns the developer mimics ("look at X in the same directory"). */
  conventions: z.array(NonEmpty.max(500)).max(30).default([]),
  notes: z.string().max(3000).default(""),
});
export type ImplementationPlan = z.infer<typeof ImplementationPlan>;

/**
 * Analysis document (M43): seven mandatory sections, validated fail-closed —
 * a missing section never reaches a human gate. Template version is pinned
 * per run (M83); language follows project parameter (M59/M104).
 */
export const AnalysisDoc = z
  .object({
    templateVersion: NonEmpty,
    language: Locale,
    purpose: NonEmpty, // 1. amaç / iş değeri
    scope: z.object({
      included: z.array(NonEmpty).min(1),
      excluded: z.array(NonEmpty).default([]),
    }), // 2. kapsam
    // 3. etki analizi. May be EMPTY: an analysis-only run with no
    // repository has nothing repo-backed to list, and `.min(1)` here made
    // every such document fail the schema (five attempts, then hand-over).
    // A repo-backed run still requires a row — enforced in `assertDocument`
    // (packages/workflows), which knows whether the run has an application.
    impactMatrix: z.array(ImpactCell),
    acceptanceCriteria: z.array(NonEmpty).min(1), // 4. kabul kriterleri
    uiApiChanges: NonEmpty, // 5. ekran / API değişiklikleri
    testApproach: NonEmpty, // 6. test yaklaşımı
    riskAndRollback: z.object({
      risk: NonEmpty,
      mitigation: NonEmpty,
      rollback: NonEmpty,
    }), // 7. risk ve geri dönüş planı
    riskTier: RiskTier,
    riskReason: NonEmpty,
    clarificationsUsed: z.array(NonEmpty).default([]),
    // ── the analysis-agent brief (see the section comment above) ──────────
    /** 8. Requirements, verbatim from the ticket / documents. */
    requirements: z.array(NonEmpty.max(800)).max(100).default([]),
    /** 9. Business rules the verifier checks one by one (PASS/FAIL per rule). */
    businessRules: z.array(NonEmpty.max(800)).max(100).default([]),
    /** 10. Where each requirement lives in the code base today. */
    codeMapping: z.array(CodeMapping).max(100).default([]),
    /** 11. What is missing — no endpoint/component answers it. */
    gaps: z.array(NonEmpty.max(800)).max(100).default([]),
    /** 12. Scale risks traced end to end. */
    scaleRisks: z.array(ScaleRisk).max(40).default([]),
    /** 13. Scope decisions left to humans: options + trade-offs. */
    scopeOptions: z.array(ScopeOption).max(40).default([]),
    /** 14. Questions that block hand-over to a developer until answered. */
    openQuestions: z.array(NonEmpty.max(800)).max(100).default([]),
    /** 15. The implementation plan (repo-bound runs), by the planner call. */
    plan: ImplementationPlan.nullable().default(null),
  })
  .strict();
export type AnalysisDoc = z.infer<typeof AnalysisDoc>;

/**
 * The brief sections at their defaults — what a document written before this
 * contract carries after `AnalysisDoc.parse`. For fixtures and adapters that
 * build a document literal: spread it, then the seven sections.
 */
export const EMPTY_ANALYSIS_BRIEF = {
  requirements: [] as string[],
  businessRules: [] as string[],
  codeMapping: [] as CodeMapping[],
  gaps: [] as string[],
  scaleRisks: [] as ScaleRisk[],
  scopeOptions: [] as ScopeOption[],
  openQuestions: [] as string[],
  plan: null as ImplementationPlan | null,
};
