import type { JiraTicket } from "@orkestra/contracts";
import { getDb, type AgentRoleType, type WorkMode } from "@orkestra/db";

export interface ResolvedVariant {
  variantId: string;
  variantName: string;
  role: AgentRoleType;
  workMode: WorkMode;
}

/**
 * Resolve a variant for a given role and ticket using routing rules.
 * Priority is numeric (lower = higher priority). Falls back to the
 * first active default-named variant for that role.
 */
export async function resolveVariant(
  role: AgentRoleType,
  ticket: JiraTicket,
): Promise<ResolvedVariant | null> {
  const db = getDb();

  const rules = await db.routingRule.findMany({
    where: { active: true, variant: { role, active: true } },
    orderBy: { priority: "asc" },
    include: { variant: true },
  });

  for (const rule of rules) {
    if (matchRule(rule, ticket)) {
      return {
        variantId: rule.variant.id,
        variantName: rule.variant.name,
        role: rule.variant.role,
        workMode: rule.workMode,
      };
    }
  }

  // Fallback: first active variant for this role
  const fallback = await db.agentVariant.findFirst({
    where: { role, active: true },
    orderBy: { createdAt: "asc" },
  });
  if (fallback) {
    return {
      variantId: fallback.id,
      variantName: fallback.name,
      role: fallback.role,
      workMode: "full_auto",
    };
  }
  return null;
}

function matchRule(
  rule: {
    matchLabel: string | null;
    matchComponent: string | null;
    matchProject: string | null;
    matchWorkType: string | null;
  },
  ticket: JiraTicket,
): boolean {
  const labels = ticket.labels.map((l) => l.toLowerCase());
  const components = ticket.components.map((c) => c.toLowerCase());

  if (rule.matchLabel && !labels.includes(rule.matchLabel.toLowerCase())) return false;
  if (
    rule.matchComponent &&
    !components.some((c) => c.includes(rule.matchComponent!.toLowerCase()))
  )
    return false;
  if (rule.matchProject && ticket.projectKey.toLowerCase() !== rule.matchProject.toLowerCase())
    return false;
  if (rule.matchWorkType && ticket.issueType.toLowerCase() !== rule.matchWorkType.toLowerCase())
    return false;
  return true;
}

/**
 * Detect work mode from ticket labels. Falls back to routing rule's default.
 */
export function detectWorkMode(ticket: JiraTicket, fallback: WorkMode = "full_auto"): WorkMode {
  for (const label of ticket.labels) {
    const l = label.toLowerCase();
    if (l === "mode:full-auto" || l === "ai:full-auto") return "full_auto";
    if (l === "mode:ai-assist" || l === "ai:assist") return "ai_assist";
    if (l === "mode:human-lead" || l === "ai:review-only") return "human_lead";
    if (l === "mode:human-only" || l === "ai:off") return "human_only";
  }
  return fallback;
}
