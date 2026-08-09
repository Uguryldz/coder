import { McpDefinitionError } from "./errors.js";
import type { ServerDefinition } from "./tool.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TOOLS THAT ARE ABSENT ON PURPOSE  (M32 SoD · M101)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  approve_gate · reject_gate · merge_pr
 *
 * These are not "unimplemented yet" and they are not gated behind an
 * admin scope. They do not exist, and this file exists to keep them from
 * coming into existence by accident.
 *
 * Why: M32 says the party that PRODUCES work may not be the party that
 * APPROVES it. Every gate in the flow (steps 4, 5, 9, 11, 12) is closed by a
 * signature that an auditor must be able to trace to a person, verified
 * against AD/Jira group membership. The AI produced the analysis, the diff and
 * the tests; if the same session could also call `approve_gate`, then "üreten ≠
 * onaylayan" is a sentence in a policy document and nothing more.
 *
 * What maestro-mcp may do instead: LIST pending gates, SUMMARISE why one is
 * stuck, and REMIND its owner. Deciding is a human channel — a Jira comment
 * (M46/M105) or Studio — and the decision carries `GateDecision.source`, which
 * only those two channels can set.
 *
 * The same logic removes `merge_pr`: the merge is the moment work becomes
 * production, ADO requires at least one human reviewer on the PR (M12), and a
 * tool that merges would let the producing identity close its own loop.
 *
 * A future maintainer who needs one of these names has found a design problem,
 * not a missing feature. `assertNoGateDecisionTools` runs for EVERY server this
 * package builds, so adding one fails at construction — not in a review.
 */
export const FORBIDDEN_TOOL_NAMES: readonly string[] = ["approve_gate", "reject_gate", "merge_pr"];

/**
 * Also refused: any spelling that would obviously be the same power under
 * another name. Matching is on the normalised tool name, so `approveGate`,
 * `gate-approve` and `pr_merge` are caught too. Over-matching here costs a
 * rename; under-matching costs the separation of duties.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^(approve|reject|decide|sign)_?gate$/,
  /^gate_?(approve|reject|decide|sign)$/,
  /^(merge|complete|close)_?(pr|pullrequest)$/,
  /^(pr|pullrequest)_?(merge|complete)$/,
];

/** Lower-cased, separators dropped to a single `_`, so casing/dashes cannot dodge the rule. */
export function normaliseToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isGateDecisionToolName(name: string): boolean {
  const normalised = normaliseToolName(name);
  if (FORBIDDEN_TOOL_NAMES.includes(normalised)) return true;
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Fail-closed guard, called from the server runtime for every server. Throws
 * `McpDefinitionError` — a definition problem, discovered at boot, never at
 * the moment somebody's approval is forged.
 */
export function assertNoGateDecisionTools(definition: ServerDefinition): void {
  const offenders = definition.tools.filter((tool) => isGateDecisionToolName(tool.name));
  if (offenders.length > 0) {
    throw new McpDefinitionError(
      `${definition.name}: gate decisions are a human channel (M32/M101); refusing tools: ` +
        offenders.map((tool) => tool.name).join(", "),
    );
  }
}
