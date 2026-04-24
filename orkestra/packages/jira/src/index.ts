/**
 * @orkestra/jira — Jira DC/Cloud integration.
 *
 * - `JiraClient`  : thin axios wrapper around the REST API.
 * - `webhook.ts`  : HMAC verification + normalization of incoming payloads.
 * - `commands.ts` : slash-command parser for workflow signals.
 * - `adf.ts`      : Atlassian Document Format helpers for rich comments.
 * - `status.ts`   : workflow step -> Jira status transitions.
 */
export { JiraClient } from "./client.js";
export type { JiraAuthMode, JiraClientOptions, JiraTransition } from "./client.js";

export { parseJiraWebhook, verifyJiraWebhook } from "./webhook.js";
export type {
  JiraWebhookCommentEvent,
  JiraWebhookEvent,
  JiraWebhookIssueEvent,
} from "./webhook.js";

export { JIRA_COMMAND_NAMES, parseJiraCommand } from "./commands.js";
export type { ParsedJiraCommand } from "./commands.js";

export * as adf from "./adf.js";
export type { AdfDoc, AdfNode } from "./adf.js";

export {
  DEFAULT_STEP_STATUS_MAP,
  WorkflowStep,
  stepToJiraStatus,
  transitionToStepStatus,
} from "./status.js";
export type { StepStatusMap } from "./status.js";
