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
  })
  .strict();
export type AnalysisDoc = z.infer<typeof AnalysisDoc>;
