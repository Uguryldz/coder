import { createLogger } from "@orkestra/config";
import type { WorkMode } from "@orkestra/contracts";
import type { JiraClient } from "./client.js";

const log = createLogger("jira.status");

/**
 * Canonical workflow steps. These are *not* Jira statuses; they're the
 * internal state-machine nodes we map onto a customer's Jira workflow.
 */
export const WorkflowStep = {
  AIAnalyzing: "ai_analyzing",
  WaitingForPO: "waiting_for_po",
  WaitingForTechLead: "waiting_for_tech_lead",
  AICoding: "ai_coding",
  InDevelopment: "in_development",
  SecurityScan: "security_scan",
  AIReviewing: "ai_reviewing",
  TestDesign: "test_design",
  WaitingForQA: "waiting_for_qa",
  Testing: "testing",
  CIRunning: "ci_running",
  WaitingForQAResults: "waiting_for_qa_results",
  WaitingForPRApproval: "waiting_for_pr_approval",
  Done: "done",
  Cancelled: "cancelled",
  WaitingForInfo: "waiting_for_info",
} as const;

export type WorkflowStep = (typeof WorkflowStep)[keyof typeof WorkflowStep];

export type StepStatusMap = Record<WorkflowStep, string>;

/** Default mapping from workflow step to Jira status *name*. */
export const DEFAULT_STEP_STATUS_MAP: StepStatusMap = {
  [WorkflowStep.AIAnalyzing]: "AI Analyzing",
  [WorkflowStep.WaitingForPO]: "Waiting for PO",
  [WorkflowStep.WaitingForTechLead]: "Waiting for Tech Lead",
  [WorkflowStep.AICoding]: "AI Coding",
  [WorkflowStep.InDevelopment]: "In Development",
  [WorkflowStep.SecurityScan]: "Security Scan",
  [WorkflowStep.AIReviewing]: "AI Reviewing",
  [WorkflowStep.TestDesign]: "Test Design",
  [WorkflowStep.WaitingForQA]: "Waiting for QA",
  [WorkflowStep.Testing]: "Testing",
  [WorkflowStep.CIRunning]: "CI Running",
  [WorkflowStep.WaitingForQAResults]: "Waiting for QA (Results)",
  [WorkflowStep.WaitingForPRApproval]: "Waiting for PR Approval",
  [WorkflowStep.Done]: "Done",
  [WorkflowStep.Cancelled]: "Cancelled",
  [WorkflowStep.WaitingForInfo]: "Waiting for Info",
};

export function stepToJiraStatus(
  step: WorkflowStep,
  map: StepStatusMap = DEFAULT_STEP_STATUS_MAP,
): string {
  return map[step];
}

/**
 * Best-effort transition to the Jira status representing the given workflow
 * step. Never throws — if the transition doesn't exist in the customer's
 * workflow, we log a warning and keep going. Workflow correctness lives in
 * Temporal; Jira is a view.
 */
export async function transitionToStepStatus(
  client: JiraClient,
  key: string,
  step: WorkflowStep,
  workMode?: WorkMode,
  map: StepStatusMap = DEFAULT_STEP_STATUS_MAP,
): Promise<{ ok: boolean; status: string; error?: string }> {
  const status = stepToJiraStatus(step, map);
  try {
    await client.transitionIssue(key, status);
    log.info({ key, step, status, workMode }, "jira.transition.ok");
    return { ok: true, status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ key, step, status, workMode, err: msg }, "jira.transition.skipped");
    return { ok: false, status, error: msg };
  }
}
