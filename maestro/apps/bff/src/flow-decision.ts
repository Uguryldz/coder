import type { FlowType, ListeningRuleRecord, MatchKind } from "./listening-store.js";

/**
 * Per-ticket flow selection: which of Maestro's flows a single ticket runs.
 *
 * Until this existed the flow was a DEPLOYMENT-level fact (`MAESTRO_PROFILE` /
 * `MAESTRO_FLOW`, `apps/deploy/src/bin/bff.ts` `flowOf`). One install meant one
 * flow, so a bank running one Jira project could not have "analyse this" and
 * "fix this bug" tickets side by side — the whole deployment had to be one or
 * the other. The rule rows have been able to express the finer answer since the
 * `ListeningRule` table landed; nothing read them on the platform side.
 *
 * Ported from `apps/pilot/src/listening.ts` `ruleFor` (retired pilot, proven on
 * real tickets) rather than reinvented. It lives HERE, in `apps/bff`, because of
 * M44: the decision must be made by the composition-root side that may talk to
 * a database, and `packages/workflows` may not — a workflow that asked Postgres
 * "which flow am I?" would replay differently after any rule edit. The BFF picks
 * the flow BEFORE `signalWithStart` and passes it in the run input, exactly as
 * `openGate` resolves a directory group before handing it to `canCloseGate`
 * (HANDOFF item 2). The rule TYPES also already live in `apps/bff`
 * (`listening-store.ts`), not in the frozen `@maestro/contracts`, so importing
 * them here crosses no frozen boundary.
 */

/** The ticket fields a rule can match on. `null` means "the payload did not say". */
export interface ClassifiableTicket {
  /** The ticket's own project key, so a rule only ever matches its project. */
  projectKey: string;
  status: string | null;
  issueType: string | null;
  /**
   * Who the ticket is assigned to. A rule with a non-empty `assigneeAccountId`
   * only matches when the ticket is assigned to that account — that is how "the
   * Maestro Bot was given this ticket" is expressed. `null` is "unassigned".
   */
  assignee: string | null;
}

/** Why a ticket ended up on the flow it did — the operator-facing answer. */
export type FlowDecisionReason =
  /** A listening rule matched; `ruleId` names it. */
  | "rule"
  /** Rules matched but disagreed; the narrowest flow was taken (fail-closed). */
  | "rule_conflict"
  /** No rule matched, so the deployment default applied. */
  | "default"
  /** No rule matched and the deployment names no default: the full pipeline. */
  | "none";

export interface FlowDecision {
  /** The flow to run, or `null` for "unset — the engine's full-pipeline default". */
  flow: FlowType | null;
  reason: FlowDecisionReason;
  /** The rule that decided, when one did. */
  ruleId?: string;
  /**
   * Every rule that matched, when more than one did. Present only for
   * `rule_conflict`, so the audit entry can name the rules an admin must fix.
   */
  conflictingRuleIds?: readonly string[];
}

/**
 * How narrow each flow is — the fail-closed ordering.
 *
 * Lower is narrower. `analiz` writes no code at all: it produces a document a
 * human reads. `duzeltme` and `gelistirme` both put an agent on a branch. So
 * when rules disagree about a ticket the analysis flow is the safe answer,
 * because the cost of being wrong is a document nobody needed rather than a
 * change nobody asked for.
 *
 * This ordering is consulted ONLY to break a tie between rules that both
 * matched. It is not a default: a ticket no rule matched is not "ambiguous",
 * it is "unclassified", and that case falls through to the deployment default
 * instead (see `flowDecisionFor`).
 */
const NARROWNESS: Readonly<Record<FlowType, number>> = {
  analiz: 0,
  duzeltme: 1,
  gelistirme: 2,
};

/** Whether one rule matches one ticket. */
function matches(rule: ListeningRuleRecord, ticket: ClassifiableTicket): boolean {
  if (!rule.enabled) return false;
  // A rule belongs to its project; it never classifies another project's ticket.
  if (rule.projectKey !== ticket.projectKey) return false;

  // An empty `assigneeAccountId` means "whoever it is assigned to". A non-empty
  // one must equal the ticket's assignee — a ticket assigned to a human is not
  // Maestro's to run just because its status matches.
  const wanted = rule.assigneeAccountId.trim();
  if (wanted !== "" && wanted !== (ticket.assignee ?? "").trim()) return false;

  const field = fieldOf(rule.matchKind, ticket);
  // A field the payload did not carry matches NOTHING. Treating a missing
  // status as an empty string would let a rule with an empty `matchValue`
  // classify every ticket whose status simply was not delivered.
  return field !== null && field === rule.matchValue;
}

function fieldOf(kind: MatchKind, ticket: ClassifiableTicket): string | null {
  return kind === "status" ? ticket.status : ticket.issueType;
}

/**
 * Every rule that matches this ticket, most important first.
 *
 * Ordered by `priority` (lower wins, as the pilot and the Studio screen both
 * present it), then by `ruleId` so two rules sharing a priority still order
 * DETERMINISTICALLY — the same rule set must always produce the same decision,
 * whatever order the store handed the rows over in.
 */
export function rulesFor(
  rules: readonly ListeningRuleRecord[],
  ticket: ClassifiableTicket,
): readonly ListeningRuleRecord[] {
  return rules
    .filter((rule) => matches(rule, ticket))
    .sort((a, b) => a.priority - b.priority || a.ruleId.localeCompare(b.ruleId));
}

/**
 * The single rule that classifies a ticket, or `null` when none does.
 *
 * The pilot's `ruleFor`, preserved: highest-priority match wins. The whole rule
 * is returned, not just its flow, so a caller can also read the agent-variant
 * mapping (`analystVariantId` / `engineerVariantId`) the rule carries.
 */
export function ruleFor(
  rules: readonly ListeningRuleRecord[],
  ticket: ClassifiableTicket,
): ListeningRuleRecord | null {
  const matched = rulesFor(rules, ticket);
  return matched.length === 0 ? null : { ...matched[0]! };
}

/**
 * Decide a ticket's flow, and say WHY.
 *
 * The reason is returned rather than logged here because the answer has to
 * reach an operator who asks "why did OPS-41 write code?" months later. The
 * caller writes it into the audit chain alongside the run; a decision that only
 * existed in a log line would be gone by then.
 *
 * Precedence, highest first:
 *  1. A single matching rule decides.
 *  2. Several rules matching with DIFFERENT flows is a misconfiguration. It is
 *     resolved fail-closed — the narrowest flow of the matching set — and
 *     reported as `rule_conflict` so an admin can fix the rules. It is not
 *     refused: refusing would strand the ticket, and the narrow flow is safe.
 *     (The unique index on (projectKey, assigneeAccountId, matchKind,
 *     matchValue) stops the COMMON case at the database, but two rules can
 *     still match one ticket through different `matchKind`s — a status rule and
 *     an issuetype rule — which no index can prevent.)
 *  3. No rule matched: the deployment default (`flowOf(env)`) still applies, so
 *     an install that has no rules yet behaves exactly as it did before.
 */
export function flowDecisionFor(
  rules: readonly ListeningRuleRecord[],
  ticket: ClassifiableTicket,
  defaultFlow: FlowType | null | undefined,
): FlowDecision {
  const matched = rulesFor(rules, ticket);

  if (matched.length === 0) {
    return defaultFlow === undefined || defaultFlow === null
      ? { flow: null, reason: "none" }
      : { flow: defaultFlow, reason: "default" };
  }

  const flows = new Set(matched.map((rule) => rule.flowType));
  if (flows.size === 1) {
    const winner = matched[0]!;
    return { flow: winner.flowType, reason: "rule", ruleId: winner.ruleId };
  }

  // Disagreement: take the narrowest flow any matching rule asked for, and name
  // every rule involved so the misconfiguration is fixable.
  const narrowest = [...matched].sort(
    (a, b) => NARROWNESS[a.flowType] - NARROWNESS[b.flowType] || a.priority - b.priority || a.ruleId.localeCompare(b.ruleId),
  )[0]!;
  return {
    flow: narrowest.flowType,
    reason: "rule_conflict",
    ruleId: narrowest.ruleId,
    conflictingRuleIds: matched.map((rule) => rule.ruleId),
  };
}
