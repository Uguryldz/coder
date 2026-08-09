/**
 * Wire shapes for the self-service onboarding wizard (M93/M102). Split from
 * `admin-api.ts` only to keep each file inside the 300-line budget; both are
 * endpoint requests, neither is implemented in the BFF yet.
 */

/** GET /onboarding/options — the lists the wizard's selects are built from. */
export interface OnboardingOptions {
  readonly jiraProjects: readonly string[];
  readonly adoRepos: readonly string[];
  readonly platforms: readonly string[];
}

/**
 * POST /onboarding/dry-run — where the last N tickets WOULD land under the
 * proposed rules (M102). The three buckets are separate because they call for
 * different actions: tier 1 is settled, tier 2 needs a human to confirm the
 * AI's guess, and tier 3 has no home at all and must be resolved before the
 * project is activated.
 */
export interface DryRunResult {
  /** Ticket keys resolved by an explicit rule (tier 1). */
  readonly byRule: readonly string[];
  /** Resolved by AI suggestion needing human confirmation (tier 2). */
  readonly bySuggestion: readonly string[];
  /** Unresolved — needs a manual assignment (tier 3). */
  readonly unresolved: readonly string[];
}
