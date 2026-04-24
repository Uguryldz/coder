/**
 * Whitelist of Prisma models exposed via `/api/resources/:resource`.
 * Keys are the resource slugs used by the Refine data provider;
 * values map to Prisma model delegate names on PrismaClient.
 */
export const RESOURCE_MAP = {
  "agent-variants": "agentVariant",
  "prompt-versions": "promptVersion",
  "knowledge-files": "knowledgeFile",
  "variant-knowledge-links": "variantKnowledgeLink",
  "routing-rules": "routingRule",
  "golden-tickets": "goldenTicket",
  evaluations: "evaluation",
  "evaluation-runs": "evaluationRun",
  "workflow-runs": "workflowRun",
  "step-executions": "stepExecution",
  "human-decisions": "humanDecision",
  artifacts: "artifact",
  "audit-logs": "auditLog",
  users: "user",
  settings: "setting",
  "pii-configs": "piIMaskingConfig",
  "knowledge-feedback": "knowledgeFeedback",
} as const;

export type ResourceSlug = keyof typeof RESOURCE_MAP;

export function resolveResource(slug: string): string | null {
  if (slug in RESOURCE_MAP) {
    return RESOURCE_MAP[slug as ResourceSlug];
  }
  return null;
}

/**
 * Non-default primary-key field name per resource. Defaults to "id".
 */
export const RESOURCE_PK: Partial<Record<ResourceSlug, string>> = {
  settings: "key",
};

export function resolvePk(slug: string): string {
  return RESOURCE_PK[slug as ResourceSlug] ?? "id";
}

/**
 * Resource-level read protection. Any value in this set requires
 * a signed-in user; write operations are always protected.
 */
export const RESOURCES_REQUIRE_AUTH = new Set(Object.keys(RESOURCE_MAP));
