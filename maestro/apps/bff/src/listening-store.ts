/**
 * The listening-rule store seam ("dinleme kuralları" surface).
 *
 * A `ListeningRule` says: in project `projectKey`, a ticket assigned to
 * `assigneeAccountId` (the Maestro Bot) whose `matchKind` field equals
 * `matchValue` should be picked up and run as `flowType`. It turns Maestro's
 * hard-coded, single-project, type-blind discovery (`apps/pilot/src/config.ts`
 * `discoveryJql`) into rows an admin edits from Studio — the "tüm ayarlar UI'dan"
 * posture.
 *
 * Structural, like every other store the composition root supplies (M44): no
 * file under `src/routes` imports Prisma, and every test drives an in-memory
 * fake. The rule types live HERE, not in `@maestro/contracts`: the frozen
 * `RuleCondition` only knows always|component|label, and `flowType`/`matchKind`
 * are a presentation vocabulary, so they are new types in the BFF rather than an
 * edit to the frozen schema (matching how the Jira-workflow read model was put
 * outside contracts for the same reason).
 */

/** The three flows Maestro can run a ticket through. Mirrors the DB CHECK. */
export type FlowType = "analiz" | "duzeltme" | "gelistirme";

/** Which ticket field a rule matches on. Mirrors the DB CHECK. */
export type MatchKind = "status" | "issuetype";

export const FLOW_TYPES: readonly FlowType[] = ["analiz", "duzeltme", "gelistirme"];
export const MATCH_KINDS: readonly MatchKind[] = ["status", "issuetype"];

/** One listening rule as stored. */
export interface ListeningRuleRecord {
  ruleId: string;
  projectKey: string;
  /** The account a ticket must be assigned to (the Maestro Bot accountId). */
  assigneeAccountId: string;
  matchKind: MatchKind;
  /** The status name or issue-type name that triggers this rule. */
  matchValue: string;
  flowType: FlowType;
  priority: number;
  enabled: boolean;
  /**
   * Which agent variant runs the ANALYSIS side of this flow (Faz 3). `null` (or
   * absent, for rows written before the column existed) means "the default
   * agent" — the pilot picks its own. Optional so the Prisma delegate in
   * `apps/deploy` compiles before its column mapping lands.
   */
  analystVariantId?: string | null;
  /** Same as `analystVariantId`, for the ENGINEERING (coding) side. */
  engineerVariantId?: string | null;
}

/**
 * The fields a caller supplies to create/replace a rule. `ruleId` is assigned by
 * the service on create; on update it is the path param, not the body.
 */
export type ListeningRuleWrite = Omit<ListeningRuleRecord, "ruleId">;

export interface ListeningStore {
  /** Every rule, ordered by (projectKey, priority) for a stable screen. */
  list(): Promise<readonly ListeningRuleRecord[]>;
  /** One rule, or null when it does not exist. */
  get(ruleId: string): Promise<ListeningRuleRecord | null>;
  /**
   * Create or replace a rule by id. The unique (projectKey, assigneeAccountId,
   * matchKind, matchValue) index means a duplicate trigger is rejected by the
   * database — the service maps that to a 409.
   */
  put(record: ListeningRuleRecord): Promise<void>;
  /** Remove a rule. Returns false when it did not exist. */
  remove(ruleId: string): Promise<boolean>;
}
