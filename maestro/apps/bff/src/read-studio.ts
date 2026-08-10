import type { LlmRole } from "@maestro/contracts";

/**
 * The read side for the last eight Studio screens (M7).
 *
 * A separate file from `read-models.ts` for one reason: the twelve read models
 * there are injected as ONE `ReadModels` bag that every route already shares,
 * and growing that bag breaks `unbridgedReadModels`, `liveReadModels` and every
 * test fixture at once. These four are optional, model-by-model, so a
 * deployment that has variant data but no golden-ticket table can wire the one
 * and refuse the other — which is exactly the situation this repo is in.
 *
 * `undefined` is NOT "empty". A composition root that leaves one of these out
 * gets a 503 with a named reason from the route; it never gets an empty list,
 * because an empty variant catalogue and an unwired variant store render
 * identically on screen and only one of them is true.
 */

// ── variants (M38) ────────────────────────────────────────────────────────────

/** One row of the variant catalogue. Numbers are counts, never prose. */
export interface VariantSummary {
  readonly variantId: string;
  readonly role: LlmRole;
  /** The variant's platform overlay: `web`, `mobile-ios`, `desktop`… (M38). */
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly knowledgeFiles: number;
  /**
   * The active version's eval score, or `null` for "never evaluated".
   *
   * `null` and `0` are different facts and the screen renders them
   * differently: a variant nobody has scored is not a variant that scored
   * zero, and collapsing the two would let an unevaluated prompt look failed
   * (or, worse, let a failed one look merely unmeasured).
   */
  readonly evalScore: number | null;
}

export interface VariantVersionRecord {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly note: string;
  readonly evalScore: number | null;
}

/** A knowledge file the variant's prompt is built from (M18/M63). */
export interface VariantKnowledgeLink {
  readonly docId: string;
  readonly fileName: string;
  readonly category: string;
  readonly version: number;
}

export interface VariantDetail extends Omit<VariantSummary, "knowledgeFiles" | "evalScore"> {
  readonly persona: string;
  readonly knowledge: readonly VariantKnowledgeLink[];
  readonly versions: readonly VariantVersionRecord[];
}

export interface VariantCatalog {
  list(): Promise<readonly VariantSummary[]>;
  /** `null` when no such variant — the route answers 404, never a blank detail. */
  get(variantId: string): Promise<VariantDetail | null>;
}

// ── PII masking (M20/M63) ─────────────────────────────────────────────────────

/**
 * One masking rule and how often it fired.
 *
 * SECURITY: `matcher` is a FIELD NAME or a PATTERN — never a value, and never a
 * sample of one. The v1 audit finding was a "second copy" of the masked value
 * kept for display, so this interface has no field that could carry one, and
 * the store that fills it reads counts out of the audit trail rather than
 * anything that ever held plaintext.
 */
export interface PiiRuleStat {
  readonly ruleId: string;
  /** `field` | `regex` — what the rule matches ON. */
  readonly kind: string;
  /** The field name or the detector's pattern name. NOT a value. */
  readonly matcher: string;
  /** `hash` | `redact` | `partial` */
  readonly strategy: string;
  /** How many times the rule fired in the window. A count, never a value. */
  readonly hits: number;
}

export interface PiiSummaryStat {
  readonly maskedCalls: number;
  readonly totalCalls: number;
  readonly maskedFields: number;
  /** Variants exempted from masking; an exemption is a risk, so it is shown. */
  readonly exemptVariants: readonly string[];
  /** Calls that went to an on-prem model unmasked because they never leave. */
  readonly onPremCalls: number;
  /** Whether the archive stores the masked form (must be true). */
  readonly archiveMasked: boolean;
}

export interface PiiReader {
  stats(): Promise<{ summary: PiiSummaryStat; rules: readonly PiiRuleStat[] }>;
}

// ── decision ledger (M33 audit) ───────────────────────────────────────────────

/**
 * A decision as the "sorunlar" screen reads it.
 *
 * `basis` is what makes the row auditable rather than merely displayed: it
 * names the audit sequence numbers the row was derived from, so an operator
 * can go and read the same chain. A ledger that says "verified" without saying
 * verified-against-what is a claim, not evidence.
 */
export interface DecisionRecord {
  readonly decisionId: string;
  /** Masterplan reference, or the audit action when the row carries no `ref`. */
  readonly ref: string;
  readonly question: string;
  readonly decision: string;
  readonly severity: string;
  readonly status: string;
  readonly decidedAt: string;
  /** The audit rows this was read from, and whether the chain still verifies. */
  readonly basis: {
    readonly auditSeq: number;
    readonly chainVerified: boolean;
  };
}

export interface DecisionReader {
  list(request: { limit: number; cursor: string | null }): Promise<{
    readonly items: readonly DecisionRecord[];
    readonly nextCursor: string | null;
  }>;
}

/**
 * The optional read models the last eight screens need; see the file docblock.
 *
 * There is deliberately NO `workspaces` model here. `/cache` needs a runner id,
 * a size on disk and a session state per workspace, and this platform has no
 * `runner` in its schema and no size probe on `RunnerPort` — so an interface
 * for it would be one a composition root could only fill by inventing the
 * numbers. The route refuses by name instead (`routes/unwired.ts`), which is
 * the same treatment `runners` and `scans` already get.
 */
export interface StudioReadModels {
  variants?: VariantCatalog;
  pii?: PiiReader;
  decisions?: DecisionReader;
}
