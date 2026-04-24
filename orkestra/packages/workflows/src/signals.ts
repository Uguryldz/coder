import type { JiraCommentSignal } from "@orkestra/contracts";
import { defineQuery, defineSignal } from "@temporalio/workflow";

/**
 * Signals the workflow accepts (from Jira webhook, Bitbucket webhook, admin panel).
 */

export const approveSignal = defineSignal<[JiraCommentSignal]>("approve");
export const rejectSignal = defineSignal<[JiraCommentSignal]>("reject");
export const cancelSignal = defineSignal<[JiraCommentSignal]>("cancel");
export const retrySignal = defineSignal<[JiraCommentSignal]>("retry");

export const aiTakeoverSignal = defineSignal<[JiraCommentSignal]>("ai-takeover");
export const aiHandoffSignal = defineSignal<[JiraCommentSignal]>("ai-handoff");
export const aiAnalyzeSignal = defineSignal<[JiraCommentSignal]>("ai-analyze");
export const aiWriteTestSignal = defineSignal<[JiraCommentSignal]>("ai-write-test");
export const aiExplainSignal = defineSignal<[JiraCommentSignal]>("ai-explain");
export const modeChangeSignal = defineSignal<[JiraCommentSignal]>("mode-change");

export const clarificationAnsweredSignal =
  defineSignal<[{ commentBody: string; user: { accountId: string; name?: string } }]>(
    "clarification-answered",
  );
export const prReviewChangesSignal =
  defineSignal<[{ prId: string; commentBody: string; author: string }]>("pr-review-changes");
export const prApprovedSignal = defineSignal<[{ prId: string; author: string }]>("pr-approved");
export const ciResultSignal =
  defineSignal<[{ success: boolean; url: string; reason?: string }]>("ci-result");

/**
 * Queries exposed by the workflow for UI / monitor.
 */
export const getStatusQuery = defineQuery<{
  step: string;
  workMode: string;
  waitingFor?: string;
  costUsdCents: number;
}>("get-status");
