import { AppId, ParamKey, RunId, TicketKey, WorkflowRunStatus, WorkMode } from "@maestro/contracts";
import { z } from "zod";
import { ToolPolicyError } from "../errors.js";
import { defineServer, defineTool, type ServerDefinition } from "../tool.js";
import type { MaestroPlatform } from "./maestro-platform.js";

export interface MaestroMcpDeps {
  readonly platform: MaestroPlatform;
}

const MAX_RUNS = 100;
const MAX_JOURNAL = 200;
const MAX_HITS = 50;
const MAX_REASON = 500;

/**
 * `maestro-mcp` — the platform managing itself (M101).
 *
 * The other three servers face INTO a sandbox; this one faces a person's IDE.
 * Identity is the caller's personal token, the platform applies that person's
 * RBAC, and every call lands in the audit chain as `ai-via:<user>`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHAT IS NOT HERE, AND WHY:  approve_gate · reject_gate · merge_pr
 * ───────────────────────────────────────────────────────────────────────────
 * This server can tell you a run has been sitting on the PO gate for sixteen
 * days, who owns it, and what the analysis says. It cannot close it. A gate
 * decision carries a signature traced to a person and verified against group
 * membership (M32), and it may only arrive through a channel a person
 * controls: a Jira comment (M105) or Studio. `GateDecision.source` has exactly
 * those two values, and no third is coming.
 *
 * The rule is enforced, not documented: `src/forbidden-tools.ts` refuses these
 * names — and near-spellings of them — for every server built here, at
 * construction time. See `test/no-gate-tools.test.ts`.
 *
 * `propose_param_change` is the shape everything write-adjacent takes on this
 * server: it files a proposal into the four-eyes queue and returns the
 * proposal, never an applied change. If a platform implementation ever returns
 * anything else, the tool refuses the result rather than reporting it.
 */
export function maestroMcpServer(deps: MaestroMcpDeps): ServerDefinition {
  const platform = deps.platform;

  return defineServer({
    name: "maestro-mcp",
    version: "0.1.0",
    description: "Operate and inspect Maestro itself, with the calling user's own permissions.",
    tools: [
      defineTool({
        name: "list_runs",
        description: "Workflow runs, optionally filtered by status, ticket or application.",
        scope: "read",
        input: z.object({
          status: WorkflowRunStatus.optional(),
          ticketKey: TicketKey.optional(),
          appId: AppId.optional(),
          limit: z.number().int().positive().max(MAX_RUNS).default(25),
        }),
        subject: (args) => args.ticketKey ?? args.appId ?? "(all runs)",
        handler: async (args, ctx) =>
          platform.listRuns(ctx.caller.user, {
            status: args.status,
            ticketKey: args.ticketKey,
            appId: args.appId,
            limit: args.limit,
          }),
      }),
      defineTool({
        name: "get_run",
        description: "One run: current step, status, risk tier, work mode and the gate it is waiting on.",
        scope: "read",
        input: z.object({ runId: RunId }),
        subject: (args) => args.runId,
        handler: async (args, ctx) => platform.getRun(ctx.caller.user, args.runId),
      }),
      defineTool({
        name: "get_journal",
        description: "Ticket journal entries for a run, in sequence order (M30).",
        scope: "read",
        input: z.object({
          runId: RunId,
          fromSeq: z.number().int().nonnegative().default(0),
          limit: z.number().int().positive().max(MAX_JOURNAL).default(50),
        }),
        subject: (args) => args.runId,
        handler: async (args, ctx) =>
          platform.getJournal(ctx.caller.user, args.runId, { fromSeq: args.fromSeq, limit: args.limit }),
      }),
      defineTool({
        name: "get_params",
        description: "Operational parameters and their current values, by scope (M71).",
        scope: "read",
        input: z.object({
          scope: z.enum(["global", "project", "application"]).optional(),
          scopeRef: z.string().trim().min(1).max(120).optional(),
        }),
        subject: (args) => args.scopeRef ?? args.scope ?? "(all scopes)",
        handler: async (args, ctx) =>
          platform.getParams(ctx.caller.user, { scope: args.scope, scopeRef: args.scopeRef }),
      }),
      defineTool({
        name: "get_repo_card",
        description: "Repo card of an application: module map and summaries used for cross-app impact (M100).",
        scope: "read",
        input: z.object({ appId: AppId }),
        subject: (args) => args.appId,
        handler: async (args, ctx) => platform.getRepoCard(ctx.caller.user, args.appId),
      }),
      defineTool({
        name: "search_knowledge",
        description: "Search the knowledge base: repo cards, past analyses, decision records.",
        scope: "read",
        input: z.object({
          text: z.string().trim().min(2).max(400),
          appId: AppId.optional(),
          limit: z.number().int().positive().max(MAX_HITS).default(10),
        }),
        subject: (args) => args.appId ?? "(knowledge)",
        handler: async (args, ctx) =>
          platform.searchKnowledge(ctx.caller.user, { text: args.text, appId: args.appId, limit: args.limit }),
      }),
      defineTool({
        name: "start_workflow",
        description: "Start the delivery flow for a ticket in an opted-in project.",
        scope: "operate",
        auditAction: "RUN_STARTED",
        input: z.object({ ticketKey: TicketKey, mode: WorkMode.optional() }),
        subject: (args) => args.ticketKey,
        handler: async (args, ctx) =>
          platform.startWorkflow(ctx.caller.user, { ticketKey: args.ticketKey, mode: args.mode }),
      }),
      defineTool({
        name: "assign_app",
        description: "Assign a ticket to an application — the human tier of matching (M99 tier ③).",
        scope: "operate",
        auditAction: "ASSIGN_APP",
        input: z.object({ ticketKey: TicketKey, appId: AppId }),
        subject: (args) => `${args.ticketKey}→${args.appId}`,
        handler: async (args, ctx) =>
          platform.assignApp(ctx.caller.user, { ticketKey: args.ticketKey, appId: args.appId }),
      }),
      defineTool({
        name: "propose_param_change",
        description:
          "File a parameter change into the four-eyes queue. The change is NOT applied; a second person approves it in Studio.",
        scope: "admin-proposal",
        // Deliberately NOT `PARAM_CHANGED`: nothing changed. An audit row
        // claiming a change for a proposal is the most misleading line the
        // chain could carry — see src/audit.ts.
        input: z.object({
          key: ParamKey,
          scopeRef: z.string().trim().min(1).max(120).nullable().default(null),
          value: z.unknown(),
          reason: z.string().trim().min(1).max(MAX_REASON),
        }),
        subject: (args) => args.key,
        handler: async (args, ctx) => {
          const proposal = await platform.proposeParamChange(ctx.caller.user, {
            key: args.key,
            scopeRef: args.scopeRef,
            value: args.value,
            reason: args.reason,
          });
          // Fail-closed on the platform's own answer: a proposal that came
          // back as anything but "pending" means the four-eyes queue was
          // bypassed somewhere below, and reporting it as success would hide
          // exactly the event this guard exists to catch.
          if (proposal.status !== "pending_four_eyes") {
            throw new ToolPolicyError(
              "propose_param_change",
              "four_eyes_bypassed",
              `parameter "${args.key}" was not queued for approval; MCP may propose, never apply (M71/M101)`,
            );
          }
          return proposal;
        },
      }),
    ],
  });
}
