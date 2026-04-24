/**
 * Inter-agent contracts. Every AI agent call has a strict Zod output schema.
 * Schema violations are automatically retried (bounded).
 */
import { z } from "zod";

// ============================================================================
// Workflow primitives
// ============================================================================

export const WorkMode = z.enum(["full_auto", "ai_assist", "human_lead", "human_only"]);
export type WorkMode = z.infer<typeof WorkMode>;

export const AgentRole = z.enum([
  "intake",
  "analyst",
  "developer",
  "dev_reviewer",
  "test_designer",
  "test_reviewer",
  "test_runner",
]);
export type AgentRole = z.infer<typeof AgentRole>;

// ============================================================================
// Jira ticket (normalized input to workflow)
// ============================================================================

export const JiraUser = z.object({
  accountId: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
});
export type JiraUser = z.infer<typeof JiraUser>;

export const JiraTicket = z.object({
  id: z.string(),
  key: z.string(),
  projectKey: z.string(),
  summary: z.string(),
  description: z.string().default(""),
  issueType: z.string().default("Task"),
  status: z.string().default("Open"),
  priority: z.string().optional(),
  labels: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
  reporter: JiraUser.optional(),
  assignee: JiraUser.optional(),
  dueDate: z.string().optional(),
  customFields: z.record(z.unknown()).default({}),
  rawContent: z.unknown().optional(),
});
export type JiraTicket = z.infer<typeof JiraTicket>;

// ============================================================================
// Agent I/O schemas
// ============================================================================

export const IntakeOutput = z.object({
  complete: z.boolean(),
  missingFields: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  workMode: WorkMode.optional(),
  reasoning: z.string().default(""),
});
export type IntakeOutput = z.infer<typeof IntakeOutput>;

export const AnalysisRisk = z.object({
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
  mitigation: z.string().optional(),
});

export const TechnicalDesign = z.object({
  approach: z.string(),
  filesToChange: z.array(
    z.object({
      path: z.string(),
      action: z.enum(["create", "modify", "delete", "rename"]),
      rationale: z.string().default(""),
    }),
  ),
  alternatives: z.array(z.string()).default([]),
  migrations: z.array(z.string()).default([]),
  infraChanges: z.array(z.string()).default([]),
});

export const AnalystOutput = z.object({
  analysisDoc: z.string(),
  technicalDesign: TechnicalDesign,
  acceptanceCriteria: z.array(z.string()),
  risks: z.array(AnalysisRisk).default([]),
  estimationHours: z.number().optional(),
});
export type AnalystOutput = z.infer<typeof AnalystOutput>;

export const DeveloperOutput = z.object({
  patch: z.string(), // unified diff
  filesChanged: z.array(z.string()),
  explanation: z.string(),
  prDescription: z.string(),
  baseCommit: z.string(),
  newDependencies: z.array(z.string()).default([]),
});
export type DeveloperOutput = z.infer<typeof DeveloperOutput>;

export const ReviewComment = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  severity: z.enum(["nit", "minor", "major", "blocking"]),
  message: z.string(),
  suggestion: z.string().optional(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const DevReviewerOutput = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  comments: z.array(ReviewComment).default([]),
  breaking: z.boolean().default(false),
  severity: z.enum(["low", "medium", "high"]).default("low"),
  summary: z.string(),
});
export type DevReviewerOutput = z.infer<typeof DevReviewerOutput>;

export const TestScenario = z.object({
  title: z.string(),
  gherkin: z.string(),
  code: z.string(),
  codeLanguage: z.string().default("typescript"),
  framework: z.enum(["jest", "vitest", "playwright", "cypress", "xcui", "espresso", "other"]),
  type: z.enum(["unit", "integration", "e2e"]),
  negative: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});
export type TestScenario = z.infer<typeof TestScenario>;

export const TestDesignerOutput = z.object({
  scenarios: z.array(TestScenario).min(1),
});
export type TestDesignerOutput = z.infer<typeof TestDesignerOutput>;

export const TestReviewerOutput = z.object({
  verdict: z.enum(["approve", "needs_more"]),
  coverage: z.object({
    pyramidSatisfied: z.boolean(),
    hasNegative: z.boolean(),
    hasUnit: z.boolean(),
    hasIntegration: z.boolean(),
    hasE2e: z.boolean(),
    gaps: z.array(z.string()).default([]),
  }),
  comments: z.array(z.string()).default([]),
});
export type TestReviewerOutput = z.infer<typeof TestReviewerOutput>;

export const TestRunResult = z.object({
  scenarioTitle: z.string(),
  passed: z.boolean(),
  durationMs: z.number(),
  output: z.string().default(""),
  errorMessage: z.string().optional(),
});
export type TestRunResult = z.infer<typeof TestRunResult>;

export const TestRunnerOutput = z.object({
  results: z.array(TestRunResult),
  coveragePct: z.number().min(0).max(100),
  flaky: z.array(z.string()).default([]),
  overallPassed: z.boolean(),
});
export type TestRunnerOutput = z.infer<typeof TestRunnerOutput>;

// ============================================================================
// Knowledge Pack
// ============================================================================

export const KnowledgeCategory = z.enum(["rules", "conventions", "domain", "examples", "glossary"]);

export const KnowledgeFileRef = z.object({
  id: z.string(),
  filename: z.string(),
  category: KnowledgeCategory,
  content: z.string(),
  scope: z.enum(["variant", "shared"]),
  version: z.number(),
});

export const KnowledgePack = z.object({
  variantId: z.string(),
  variantName: z.string(),
  role: AgentRole,
  files: z.array(KnowledgeFileRef),
});
export type KnowledgePack = z.infer<typeof KnowledgePack>;

// ============================================================================
// Agent call envelope
// ============================================================================

export const AgentCallInput = z.object({
  role: AgentRole,
  variantId: z.string(),
  variantName: z.string(),
  promptVersionId: z.string(),
  systemPrompt: z.string(),
  model: z.string(),
  temperature: z.number().default(0.2),
  maxTokens: z.number().default(4096),
  knowledgePack: KnowledgePack.nullable().optional(),
  userInput: z.string(),
  outputSchemaName: z.string(),
  correlationId: z.string(),
  workflowRunId: z.string(),
});
export type AgentCallInput = z.infer<typeof AgentCallInput>;

export const AgentCallResult = z.object({
  parsedOutput: z.unknown(),
  rawText: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cacheHits: z.number().default(0),
  model: z.string(),
  stopReason: z.string(),
  costUsdCents: z.number(),
  attempt: z.number(),
});
export type AgentCallResult = z.infer<typeof AgentCallResult>;

// ============================================================================
// Jira signals
// ============================================================================

export const JiraCommand = z.enum([
  "approve",
  "reject",
  "cancel",
  "ai-analyze",
  "ai-write-test",
  "ai-explain",
  "ai-takeover",
  "ai-handoff",
  "mode-change",
  "retry",
  "status",
]);
export type JiraCommand = z.infer<typeof JiraCommand>;

export const JiraCommentSignal = z.object({
  workflowRunId: z.string(),
  ticketKey: z.string(),
  command: JiraCommand,
  args: z.string().optional(),
  user: JiraUser,
  commentId: z.string(),
  at: z.string(), // ISO timestamp
});
export type JiraCommentSignal = z.infer<typeof JiraCommentSignal>;

// ============================================================================
// Sandbox contracts
// ============================================================================

export const OrkestraYamlConfig = z.object({
  language: z.string(),
  sandbox_image: z.string(),
  clone_depth: z.number().default(50),
  commands: z.object({
    install: z.string(),
    lint: z.string().optional(),
    build: z.string(),
    test_unit: z.string(),
    test_integration: z.string().optional(),
    coverage: z.string().optional(),
  }),
  test_dependencies: z.array(z.string()).default([]),
  cache_paths: z.array(z.string()).default([]),
  env_secrets: z.array(z.string()).default([]),
  coverage_threshold: z.number().default(70),
});
export type OrkestraYamlConfig = z.infer<typeof OrkestraYamlConfig>;

export const SandboxRunRequest = z.object({
  workflowRunId: z.string(),
  repoUrl: z.string(),
  baseCommit: z.string(),
  branchName: z.string(),
  patch: z.string().optional(),
  orkestra: OrkestraYamlConfig,
  secrets: z.record(z.string()).default({}),
});
export type SandboxRunRequest = z.infer<typeof SandboxRunRequest>;

export const SandboxRunResult = z.object({
  success: z.boolean(),
  steps: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      exitCode: z.number(),
      durationMs: z.number(),
      stdoutTail: z.string(),
      stderrTail: z.string(),
    }),
  ),
  coveragePct: z.number().nullable(),
  commitSha: z.string().optional(),
  prUrl: z.string().optional(),
});
export type SandboxRunResult = z.infer<typeof SandboxRunResult>;
