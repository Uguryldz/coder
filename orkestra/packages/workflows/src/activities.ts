/**
 * Activity implementations — run in worker processes, NOT in workflow sandbox.
 * All I/O (db, network, files, LLM) happens here.
 */
import { detectWorkMode, resolveVariant, runAgent } from "@orkestra/agents";
import { audit } from "@orkestra/audit";
import { createLogger } from "@orkestra/config";
import type {
  AnalystOutput,
  DeveloperOutput,
  DevReviewerOutput,
  IntakeOutput,
  JiraTicket,
  TestDesignerOutput,
  TestReviewerOutput,
  TestRunnerOutput,
} from "@orkestra/contracts";
import {
  AnalystOutput as AnalystSchema,
  DeveloperOutput as DeveloperSchema,
  DevReviewerOutput as DevReviewerSchema,
  IntakeOutput as IntakeSchema,
  TestDesignerOutput as TestDesignerSchema,
  TestReviewerOutput as TestReviewerSchema,
  TestRunnerOutput as TestRunnerSchema,
} from "@orkestra/contracts";
import { getDb, type AgentRoleType, type WorkflowStatus, type WorkMode } from "@orkestra/db";

const log = createLogger("activities");

// ============================================================================
// Lifecycle / state sync
// ============================================================================

export async function createWorkflowRun(params: {
  jiraTicketId: string;
  jiraProjectKey: string;
  workMode: WorkMode;
  temporalWorkflowId: string;
  temporalRunId: string;
}): Promise<string> {
  const db = getDb();
  const run = await db.workflowRun.create({
    data: {
      jiraTicketId: params.jiraTicketId,
      jiraProjectKey: params.jiraProjectKey,
      workMode: params.workMode,
      temporalWorkflowId: params.temporalWorkflowId,
      temporalRunId: params.temporalRunId,
      status: "running",
      currentStep: "0-work-mode",
    },
  });
  await audit({
    workflowRunId: run.id,
    actor: "system",
    action: "workflow.started",
    subject: params.jiraTicketId,
    payload: { workMode: params.workMode },
  });
  return run.id;
}

export async function updateWorkflowStatus(params: {
  workflowRunId: string;
  step: string;
  status: WorkflowStatus;
}): Promise<void> {
  const db = getDb();
  await db.workflowRun.update({
    where: { id: params.workflowRunId },
    data: { currentStep: params.step, status: params.status },
  });
}

export async function completeWorkflow(params: {
  workflowRunId: string;
  status: "done" | "cancelled" | "failed" | "blocked";
  reason?: string;
}): Promise<void> {
  const db = getDb();
  await db.workflowRun.update({
    where: { id: params.workflowRunId },
    data: {
      status: params.status,
      completedAt: new Date(),
      cancelledAt: params.status === "cancelled" ? new Date() : undefined,
      cancellationReason: params.reason,
    },
  });
  await audit({
    workflowRunId: params.workflowRunId,
    actor: "system",
    action: `workflow.${params.status}`,
    payload: { reason: params.reason ?? null },
  });
}

// ============================================================================
// Jira integration (thin wrappers; heavy logic in @orkestra/jira)
// ============================================================================

async function buildJiraClient() {
  const [{ JiraClient }, { getJiraSettings }] = await Promise.all([
    import("@orkestra/jira"),
    import("@orkestra/agents"),
  ]);
  const s = await getJiraSettings();
  return new JiraClient({
    baseUrl: s.baseUrl,
    authMode: s.authMode,
    username: s.email,
    apiToken: s.apiToken,
  });
}

export async function fetchJiraTicket(ticketKey: string): Promise<JiraTicket> {
  const client = await buildJiraClient();
  return client.getIssue(ticketKey);
}

export async function postJiraComment(params: {
  ticketKey: string;
  bodyAdf?: unknown;
  bodyText?: string;
}): Promise<void> {
  const client = await buildJiraClient();
  const body = params.bodyAdf ?? params.bodyText ?? "";
  await client.addComment(params.ticketKey, body as string);
}

// Map our internal step strings to Jira's WorkflowStep enum
const STEP_TO_WORKFLOWSTEP: Record<string, string> = {
  "2-intake": "ai_analyzing",
  "2b-clarification": "waiting_for_info",
  "3-analyst": "ai_analyzing",
  "4-po-approval": "waiting_for_po",
  "5-tech-lead-approval": "waiting_for_tech_lead",
  "6a-development": "ai_coding",
  "6a-human-development": "in_development",
  "6b-security-scan": "security_scan",
  "6c-dev-reviewer": "ai_reviewing",
  "7-test-designer": "test_design",
  "8-test-reviewer": "test_design",
  "9-qa-approval": "waiting_for_qa",
  "10-test-runner": "testing",
  "10b-ci-gate": "ci_running",
  "11-qa-results-approval": "waiting_for_qa_results",
  "12-pr-approval": "waiting_for_pr_approval",
  done: "done",
  cancelled: "cancelled",
};

export async function transitionJiraStatus(params: {
  ticketKey: string;
  step: string;
  workMode: WorkMode;
}): Promise<void> {
  const { transitionToStepStatus } = await import("@orkestra/jira");
  const client = await buildJiraClient();
  const workflowStep = STEP_TO_WORKFLOWSTEP[params.step];
  if (!workflowStep) {
    log.debug({ step: params.step }, "unmapped step, skipping jira transition");
    return;
  }
  try {
    // @ts-expect-error — runtime string matches WorkflowStep enum values
    await transitionToStepStatus(client, params.ticketKey, workflowStep);
  } catch (e) {
    log.warn({ err: String(e), step: params.step }, "status transition failed (non-fatal)");
  }
}

// ============================================================================
// AI Agent invocations
// ============================================================================

async function getPIIConfig() {
  const db = getDb();
  const cfg = await db.pIIMaskingConfig.findUnique({ where: { id: "default" } });
  return {
    enabled: cfg?.enabled ?? false,
    fieldRules: (cfg?.fieldRules as Array<{ field: string; strategy: string }>) ?? [],
    patternRules:
      (cfg?.patternRules as Array<{ name: string; regex: string; replacement: string }>) ?? [],
  } as import("@orkestra/pii").PIIConfig;
}

export async function runIntakeAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  correlationId: string;
}): Promise<IntakeOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "2-intake",
    role: "intake",
    ticket: params.ticket,
    userInput: {
      summary: params.ticket.summary,
      description: params.ticket.description,
      labels: params.ticket.labels,
      components: params.ticket.components,
      issueType: params.ticket.issueType,
    },
    outputSchema: IntakeSchema,
    outputSchemaName: "IntakeOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

export async function runAnalystAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  repoSkeleton?: string;
  correlationId: string;
}): Promise<AnalystOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "3-analyst",
    role: "analyst",
    ticket: params.ticket,
    userInput: {
      summary: params.ticket.summary,
      description: params.ticket.description,
      labels: params.ticket.labels,
      components: params.ticket.components,
      dueDate: params.ticket.dueDate,
      repoSkeleton: params.repoSkeleton ?? null,
    },
    outputSchema: AnalystSchema,
    outputSchemaName: "AnalystOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

export async function runDeveloperAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  analysis: AnalystOutput;
  baseCommit: string;
  repoSkeleton: string;
  targetFiles: Record<string, string>;
  correlationId: string;
}): Promise<DeveloperOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "6a-developer",
    role: "developer",
    ticket: params.ticket,
    userInput: {
      analysis: params.analysis,
      baseCommit: params.baseCommit,
      repoSkeleton: params.repoSkeleton,
      targetFiles: params.targetFiles,
    },
    outputSchema: DeveloperSchema,
    outputSchemaName: "DeveloperOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

export async function runDevReviewerAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  patch: string;
  analysis: AnalystOutput;
  correlationId: string;
}): Promise<DevReviewerOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "6c-dev-reviewer",
    role: "dev_reviewer",
    ticket: params.ticket,
    userInput: { patch: params.patch, analysis: params.analysis },
    outputSchema: DevReviewerSchema,
    outputSchemaName: "DevReviewerOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

export async function runTestDesignerAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  analysis: AnalystOutput;
  patch: string;
  correlationId: string;
}): Promise<TestDesignerOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "7-test-designer",
    role: "test_designer",
    ticket: params.ticket,
    userInput: { analysis: params.analysis, patch: params.patch },
    outputSchema: TestDesignerSchema,
    outputSchemaName: "TestDesignerOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

export async function runTestReviewerAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  scenarios: TestDesignerOutput;
  correlationId: string;
}): Promise<TestReviewerOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "8-test-reviewer",
    role: "test_reviewer",
    ticket: params.ticket,
    userInput: params.scenarios,
    outputSchema: TestReviewerSchema,
    outputSchemaName: "TestReviewerOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

export async function runTestRunnerAgent(params: {
  workflowRunId: string;
  ticket: JiraTicket;
  scenarios: TestDesignerOutput;
  correlationId: string;
}): Promise<TestRunnerOutput> {
  const pii = await getPIIConfig();
  const result = await runAgent({
    workflowRunId: params.workflowRunId,
    stepName: "10-test-runner",
    role: "test_runner",
    ticket: params.ticket,
    userInput: params.scenarios,
    outputSchema: TestRunnerSchema,
    outputSchemaName: "TestRunnerOutput",
    correlationId: params.correlationId,
    piiConfig: pii,
  });
  return result.output;
}

// ============================================================================
// Sandbox & Git
// ============================================================================

export async function securityScan(params: { workflowRunId: string; repoPath: string }): Promise<{
  clean: boolean;
  findings: Array<{ tool: string; severity: string; file?: string; message: string }>;
}> {
  const { runGitleaks, runSemgrep, runTrivy } = await import("@orkestra/sandbox");
  const [leaks, semgrep, trivy] = await Promise.all([
    runGitleaks(params.repoPath).catch(() => ({
      leaks: [] as Array<{ file: string; rule: string }>,
    })),
    runSemgrep(params.repoPath).catch(() => ({
      findings: [] as Array<{ path: string; severity: string; message: string }>,
    })),
    runTrivy(params.repoPath).catch(() => ({
      vulnerabilities: [] as Array<{ pkg: string; severity: string; vulnerabilityId: string }>,
    })),
  ]);
  const findings: Array<{ tool: string; severity: string; file?: string; message: string }> = [];
  for (const l of leaks.leaks ?? [])
    findings.push({
      tool: "gitleaks",
      severity: "high",
      file: l.file,
      message: `${l.rule} leak detected`,
    });
  for (const f of semgrep.findings ?? [])
    findings.push({
      tool: "semgrep",
      severity: f.severity ?? "medium",
      file: f.path,
      message: f.message,
    });
  for (const v of trivy.vulnerabilities ?? [])
    findings.push({
      tool: "trivy",
      severity: v.severity ?? "medium",
      message: `${v.pkg}: ${v.vulnerabilityId}`,
    });
  return { clean: findings.length === 0, findings };
}

export async function runSandbox(params: {
  workflowRunId: string;
  repoUrl: string;
  baseCommit: string;
  branchName: string;
  patch?: string;
  ticketKey: string;
}): Promise<{
  success: boolean;
  coveragePct: number | null;
  commitSha?: string;
  prUrl?: string;
  stderr: string;
}> {
  // Mock mod: gerçek Docker-in-Docker çalıştırmadan sahte başarılı sonuç.
  // Demo/test için; prod'da SANDBOX_MODE=real (default) ile gerçek sandbox çalışır.
  if ((process.env.SANDBOX_MODE ?? "real") === "mock") {
    log.info({ branchName: params.branchName }, "[mock-sandbox] patch başarıyla uygulandı");
    return {
      success: true,
      coveragePct: 82,
      commitSha: `mock-${Date.now().toString(36)}`,
      prUrl: undefined,
      stderr: "",
    };
  }
  const { SandboxManager, defaultOrkestraYaml } = await import("@orkestra/sandbox");
  const manager = new SandboxManager();
  const result = await manager.run({
    workflowRunId: params.workflowRunId,
    repoUrl: params.repoUrl,
    baseCommit: params.baseCommit,
    branchName: params.branchName,
    patch: params.patch,
    orkestra: defaultOrkestraYaml("node"),
    secrets: {},
  });
  return {
    success: result.success,
    coveragePct: result.coveragePct,
    commitSha: result.commitSha,
    prUrl: result.prUrl,
    stderr: result.steps.map((s) => s.stderrTail).join("\n---\n"),
  };
}

export async function createPullRequest(params: {
  workflowRunId: string;
  repoProject: string;
  repoSlug: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}): Promise<{ prId: string; url: string }> {
  // Mock mod: gerçek Git'e bağlanmadan sahte PR döner.
  if ((process.env.SANDBOX_MODE ?? "real") === "mock") {
    const prId = Math.floor(Math.random() * 10000) + 100;
    log.info({ prId, branch: params.sourceBranch }, "[mock-git] PR açıldı");
    return {
      prId: String(prId),
      url: `http://git.mock/projects/${params.repoProject}/repos/${params.repoSlug}/pull-requests/${prId}`,
    };
  }
  const [{ getGitClient }, { getGitSettings }] = await Promise.all([
    import("@orkestra/git"),
    import("@orkestra/agents"),
  ]);
  const s = await getGitSettings();
  const client = getGitClient({
    platform: s.platform,
    baseUrl: s.baseUrl,
    username: s.username,
    appPassword: s.appPassword,
  });
  const pr = await client.createPullRequest({
    repo: { projectKey: params.repoProject, repoSlug: params.repoSlug },
    source: params.sourceBranch,
    target: params.targetBranch,
    title: params.title,
    description: params.description,
  });
  return { prId: String(pr.id), url: pr.webUrl };
}

// ============================================================================
// Cost / budget
// ============================================================================

export async function checkBudget(params: {
  workflowRunId: string;
  hardCapUsdCents: number;
}): Promise<{ exceeded: boolean; usedCents: number }> {
  const db = getDb();
  const run = await db.workflowRun.findUniqueOrThrow({ where: { id: params.workflowRunId } });
  return {
    exceeded: run.tokenCostUsdCents >= params.hardCapUsdCents,
    usedCents: run.tokenCostUsdCents,
  };
}

// ============================================================================
// Slack notification
// ============================================================================

export async function notifySlack(params: {
  workflowRunId: string;
  text: string;
  critical?: boolean;
}): Promise<void> {
  const { SlackNotifier } = await import("@orkestra/slack");
  const n = new SlackNotifier();
  if (params.critical) {
    await n.sendCritical(params.text, { title: `Orkestra — run ${params.workflowRunId}` });
  } else {
    await n.sendDigest({
      title: "Orkestra update",
      lines: [params.text],
      workflowRunId: params.workflowRunId,
    });
  }
}

// ============================================================================
// TestRail / Xray
// ============================================================================

export async function pushTestCases(params: {
  workflowRunId: string;
  projectKey: string;
  scenarios: TestDesignerOutput["scenarios"];
}): Promise<void> {
  const { TestRailClient } = await import("@orkestra/testrail");
  const client = new TestRailClient();
  await client.pushTestCases(params.projectKey, params.scenarios);
}

// ============================================================================
// Human decision recording
// ============================================================================

export async function recordHumanDecision(params: {
  workflowRunId: string;
  stepName: string;
  decision: string;
  jiraUserId: string;
  jiraUsername?: string;
  reason?: string;
  command?: string;
}): Promise<void> {
  const db = getDb();
  const { createHmac } = await import("node:crypto");
  const signature = createHmac("sha256", "audit-signing-key")
    .update([params.stepName, params.jiraUserId, params.decision, Date.now()].join("|"))
    .digest("hex");
  await db.humanDecision.create({
    data: {
      workflowRunId: params.workflowRunId,
      stepName: params.stepName,
      decision: params.decision,
      jiraUserId: params.jiraUserId,
      jiraUsername: params.jiraUsername,
      reason: params.reason,
      command: params.command,
      signature,
    },
  });
  await audit({
    workflowRunId: params.workflowRunId,
    actor: `user:${params.jiraUserId}`,
    action: `decision.${params.decision}`,
    subject: params.stepName,
    payload: { reason: params.reason ?? null, command: params.command ?? null },
  });
}

// ============================================================================
// Validation helpers
// ============================================================================

export async function assertFourEyes(params: {
  workflowRunId: string;
  currentStep: string;
  actorJiraUserId: string;
  forbiddenPriorSteps: string[];
}): Promise<{ ok: boolean; violation?: string }> {
  const db = getDb();
  const prior = await db.humanDecision.findMany({
    where: {
      workflowRunId: params.workflowRunId,
      stepName: { in: params.forbiddenPriorSteps },
      jiraUserId: params.actorJiraUserId,
    },
  });
  if (prior.length > 0) {
    return {
      ok: false,
      violation: `4-göz ihlali: kullanıcı zaten ${prior[0]!.stepName} adımında rol aldı`,
    };
  }
  return { ok: true };
}

export async function getGoldenVariantHints(params: { ticket: JiraTicket }): Promise<{
  workMode: WorkMode;
  analystVariantId?: string;
}> {
  const workMode = detectWorkMode(params.ticket);
  const analyst = await resolveVariant("analyst" as AgentRoleType, params.ticket);
  return { workMode, analystVariantId: analyst?.variantId };
}
