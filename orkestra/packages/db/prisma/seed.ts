/**
 * Seed default data: 7 role + base variants + admin user + default settings.
 * Idempotent — can be re-run safely.
 */
import { AdminRole, AgentRoleType, PrismaClient, WorkMode } from "@prisma/client";
import crypto from "node:crypto";

const db = new PrismaClient();

const ROLES: AgentRoleType[] = [
  "intake",
  "analyst",
  "developer",
  "dev_reviewer",
  "test_designer",
  "test_reviewer",
  "test_runner",
];

const DOMAIN_VARIANTS = ["mobile", "web", "backend"];

const DEFAULT_PROMPTS: Record<AgentRoleType, string> = {
  intake: `You are an intake analyst. Given a Jira ticket, determine if it is complete enough to begin work.
Return JSON matching the schema: {complete, missingFields[], questions[], workMode}.`,
  analyst: `You are a senior business+technical analyst. Produce:
- analysisDoc: functional analysis in markdown
- technicalDesign: files to change, approach, risks
- acceptanceCriteria: bullet list
Follow the attached rules and conventions strictly.`,
  developer: `You are a senior developer. Given the analysis and technical design, produce a unified diff patch
against the provided base commit. Also return: filesChanged[], explanation, prDescription.
Follow coding standards and test pyramid.`,
  dev_reviewer: `You are a senior code reviewer. Given a patch and analysis, return:
verdict (approve/changes_requested), comments[] with file:line, breaking (bool), severity.`,
  test_designer: `You design test scenarios. For each scenario return: title, gherkin, code (Cypress/Jest),
type (unit|integration|e2e), negative (bool). Ensure test pyramid: >=1 unit, >=1 integration, >=1 e2e, >=1 negative.`,
  test_reviewer: `You review test scenarios. Check: pyramid satisfied, coverage gates met, negative tests present.
Return verdict, missing[], and coverage assessment.`,
  test_runner: `You execute tests in the sandbox. Run provided scenarios and return: results[], coveragePct, flaky[].`,
};

const ROLE_MODEL: Record<AgentRoleType, string> = {
  intake: "claude-haiku-4-5-20251001",
  analyst: "claude-opus-4-7",
  developer: "claude-opus-4-7",
  dev_reviewer: "claude-opus-4-7",
  test_designer: "claude-opus-4-7",
  test_reviewer: "claude-sonnet-4-6",
  test_runner: "claude-sonnet-4-6",
};

async function seedVariants() {
  for (const role of ROLES) {
    const variantNames =
      role === "intake" || role === "test_reviewer"
        ? ["default"]
        : DOMAIN_VARIANTS.map((d) => `${d}-${role.replace("_", "-")}`);

    for (const name of variantNames) {
      const variant = await db.agentVariant.upsert({
        where: { role_name: { role, name } },
        update: {},
        create: {
          role,
          name,
          displayName: name,
          description: `Default ${role} variant: ${name}`,
          active: true,
        },
      });

      const existing = await db.promptVersion.findFirst({
        where: { variantId: variant.id },
        orderBy: { version: "desc" },
      });

      if (!existing) {
        const knowledgeHash = crypto
          .createHash("sha256")
          .update(`${role}:${name}:empty`)
          .digest("hex");
        const version = await db.promptVersion.create({
          data: {
            variantId: variant.id,
            version: 1,
            systemPrompt: DEFAULT_PROMPTS[role],
            model: ROLE_MODEL[role],
            temperature: 0.2,
            maxTokens: 4096,
            knowledgeHash,
            createdBy: "seed",
            notes: "initial seeded prompt",
          },
        });
        await db.agentVariant.update({
          where: { id: variant.id },
          data: { activeVersionId: version.id },
        });
      }
    }
  }
}

async function seedAdmin() {
  await db.user.upsert({
    where: { email: "admin@orkestra.local" },
    update: {},
    create: {
      email: "admin@orkestra.local",
      name: "Default Admin",
      role: AdminRole.admin,
      // password: "orkestra-admin" (bcrypt hash, 10 rounds). İlk girişten sonra değiştir.
      passwordHash: "$2a$10$Dqrnxp119Xuy9TFpXMNlyerftxIGA.jB89ZVmfGdkv42ZRIOUzSO.",
      active: true,
    },
  });
}

async function seedRoutingRules() {
  const count = await db.routingRule.count();
  if (count > 0) return;

  const mobileAnalyst = await db.agentVariant.findUnique({
    where: { role_name: { role: "analyst", name: "mobile-analyst" } },
  });
  const webAnalyst = await db.agentVariant.findUnique({
    where: { role_name: { role: "analyst", name: "web-analyst" } },
  });
  const backendAnalyst = await db.agentVariant.findUnique({
    where: { role_name: { role: "analyst", name: "backend-analyst" } },
  });

  if (mobileAnalyst) {
    await db.routingRule.create({
      data: {
        name: "mobile tickets",
        priority: 10,
        matchComponent: "mobile",
        variantId: mobileAnalyst.id,
        workMode: WorkMode.full_auto,
      },
    });
  }
  if (webAnalyst) {
    await db.routingRule.create({
      data: {
        name: "web tickets",
        priority: 10,
        matchComponent: "web",
        variantId: webAnalyst.id,
        workMode: WorkMode.full_auto,
      },
    });
  }
  if (backendAnalyst) {
    await db.routingRule.create({
      data: {
        name: "backend tickets",
        priority: 10,
        matchComponent: "backend",
        variantId: backendAnalyst.id,
        workMode: WorkMode.full_auto,
      },
    });
  }
}

async function seedSettings() {
  await db.setting.upsert({
    where: { key: "sla.default_hours" },
    update: {},
    create: { key: "sla.default_hours", value: { approval: 48, clarification: 72, urgent: 24 } },
  });
  await db.setting.upsert({
    where: { key: "cost.budget_usd_cents" },
    update: {},
    create: { key: "cost.budget_usd_cents", value: 500 },
  });
  await db.setting.upsert({
    where: { key: "coverage.threshold_pct" },
    update: {},
    create: { key: "coverage.threshold_pct", value: 70 },
  });

  await db.pIIMaskingConfig.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      enabled: true,
      fieldRules: [
        { field: "customer_email", strategy: "hash" },
        { field: "customer_name", strategy: "redact" },
        { field: "phone", strategy: "partial" },
      ],
      patternRules: [
        { name: "tc_kimlik", regex: "\\b[1-9][0-9]{10}\\b", replacement: "[TC]" },
        { name: "credit_card", regex: "\\b(?:\\d[ -]*?){13,16}\\b", replacement: "[CC]" },
        { name: "email", regex: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+", replacement: "[EMAIL]" },
      ],
    },
  });
}

async function main() {
  console.log("[seed] variants…");
  await seedVariants();
  console.log("[seed] admin…");
  await seedAdmin();
  console.log("[seed] routing…");
  await seedRoutingRules();
  console.log("[seed] settings…");
  await seedSettings();
  console.log("[seed] done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
