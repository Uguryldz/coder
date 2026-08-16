import { ProjectKey, type TicketKey } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { badRequest } from "./errors.js";
import { BFF_MESSAGE_KEYS } from "./messages.js";
import { workflowIdFor } from "./gateway.js";
import { flowDecisionFor, type FlowDecision } from "./flow-decision.js";

/**
 * Intake: the decision to put a ticket on the workflow engine, and every
 * reason not to. Nothing here guesses — an unmatched ticket goes to the human
 * assignment queue rather than to a default application (M14/M99).
 */

export interface IntakeRequest {
  ticket: TicketKey;
  labels?: readonly string[];
  /**
   * A person asked for this run by name (`/ai-start`, `/ai-assign`), so the
   * opt-in label rule has already been satisfied by the command itself (M48a).
   */
  explicit?: boolean;
  /** `/ai-assign <app>` — overrides the RoutingRule outcome (M99 tier ③). */
  appId?: string;
  /** Audit actor: the requesting human, or `maestro-worker` for a webhook. */
  actor: string;
  /**
   * The ticket's current status name, when the caller knows it. Together with
   * `issueType` and `assignee` it decides which FLOW this ticket runs
   * (`flow-decision.ts`). Absent means "not known here", which matches no rule
   * and falls back to the deployment default — so a caller that cannot supply
   * these (an operator pressing Start in Studio) behaves exactly as before.
   */
  status?: string;
  /** The ticket's issue-type name, when the caller knows it. */
  issueType?: string;
  /** The account the ticket is assigned to, when the caller knows it. */
  assignee?: string;
}

export type IntakeRefusal = "unbound" | "not_opted_in" | "kill_switch" | "no_application";

export type IntakeOutcome =
  | { accepted: true; workflowId: string; started: boolean }
  | { accepted: false; reason: IntakeRefusal };

export function projectKeyOf(ticket: TicketKey): string {
  const parsed = ProjectKey.safeParse(ticket.split("-")[0]);
  if (!parsed.success) throw badRequest("ticket_key", { ticket });
  return parsed.data;
}

export async function runIntake(deps: ResolvedDeps, request: IntakeRequest): Promise<IntakeOutcome> {
  const projectKey = projectKeyOf(request.ticket);

  // M102: one global webhook delivers every project's traffic; a project that
  // was never bound, or was paused, is dropped without a trace in Jira — the
  // counter is the trace. Answering an unbound project would leak that Maestro
  // is watching it.
  const binding = await deps.bindings.resolve(projectKey);
  if (binding === null || !binding.active) {
    deps.counters.droppedUnbound += 1;
    return { accepted: false, reason: "unbound" };
  }

  if (
    request.explicit !== true &&
    binding.triggerMode === "opt_in" &&
    !(request.labels ?? []).includes(deps.config.optInLabel)
  ) {
    return { accepted: false, reason: "not_opted_in" };
  }

  // M58: both levels stop new work. `all` also stops running work, but that is
  // the workflow's job — here the only question is whether to take the ticket.
  const killSwitch = await deps.killSwitch.get();
  if (killSwitch.level !== "off") {
    deps.counters.droppedKillSwitch += 1;
    await deps.work.addComment(
      request.ticket,
      deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.killSwitch, {
        level: killSwitch.level,
        reason: killSwitch.reason,
      }),
    );
    return { accepted: false, reason: "kill_switch" };
  }

  const appId = request.appId ?? binding.appId;
  if (appId === null || appId === undefined) {
    // Tier ③ of M99: no rule matched and no human said which application. The
    // ticket waits for a person; it does not start against a guess.
    await deps.work.addComment(
      request.ticket,
      deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.pendingAssignment, {
        ticket: request.ticket,
      }),
    );
    return { accepted: false, reason: "no_application" };
  }

  // WHICH FLOW — decided here, before the run exists, and passed IN.
  //
  // It cannot be decided inside the workflow: `packages/workflows` may not read
  // a database (M44), and a workflow that re-read the rules on replay would
  // take a different path the moment an admin edited a rule. So the rules are
  // read once, on the way in, and the answer travels in the start input — the
  // same shape `openGate` uses to hand a resolved directory group to
  // `canCloseGate` (HANDOFF item 2).
  const flowDecision = await decideFlow(deps, request, projectKey);

  const outcome = await deps.runs.signalWithStart({
    ticket: request.ticket,
    appId,
    mode: binding.mode,
    dataClass: binding.dataClass,
    ...(flowDecision.flow === null ? {} : { flow: flowDecision.flow }),
  });

  if (outcome.started) {
    await deps.audit.append({
      actor: request.actor,
      action: "RUN_STARTED",
      subject: request.ticket,
      at: deps.clock.now(),
      meta: {
        workflowId: outcome.workflowId,
        projectKey,
        appId,
        mode: binding.mode,
        dataClass: binding.dataClass,
        assigned: request.appId !== undefined,
        // WHY this ticket runs the flow it does. An operator asking months
        // later "why did OPS-41 write code?" reads it off the audit chain; a
        // log line would be long gone, and the run row records only the flow,
        // not the reason for it.
        flow: flowDecision.flow ?? "varsayilan",
        flowReason: flowDecision.reason,
        ...(flowDecision.ruleId === undefined ? {} : { flowRuleId: flowDecision.ruleId }),
        ...(flowDecision.conflictingRuleIds === undefined
          ? {}
          : { flowConflictingRuleIds: flowDecision.conflictingRuleIds.join(",") }),
      },
    });
  }

  return { accepted: true, workflowId: outcome.workflowId ?? workflowIdFor(request.ticket), started: outcome.started };
}

/**
 * Which flow this ticket runs, and why.
 *
 * The rule set is read from the listening store — the rows an admin edits in
 * Studio — and matched against the ticket the caller described. Two things make
 * this SAFE to fall back rather than refuse:
 *
 *  - A deployment with no `ListeningStore` wired (the store is optional, like
 *    every other capability the composition root may omit) has no rules to
 *    read, so every ticket takes the deployment default. That is exactly the
 *    behaviour before this existed.
 *  - A store that FAILS to answer is treated the same way. A database blip must
 *    not stop a ticket that would otherwise run: the deployment default is a
 *    deliberate operator choice, not a guess, so falling back to it is safer
 *    than refusing the intake or inventing a flow.
 */
async function decideFlow(
  deps: ResolvedDeps,
  request: IntakeRequest,
  projectKey: string,
): Promise<FlowDecision> {
  const fallback = (): FlowDecision =>
    deps.config.defaultFlow === undefined || deps.config.defaultFlow === null
      ? { flow: null, reason: "none" }
      : { flow: deps.config.defaultFlow, reason: "default" };

  if (deps.listening === undefined) return fallback();

  let rules;
  try {
    rules = await deps.listening.list();
  } catch {
    return fallback();
  }

  return flowDecisionFor(
    rules,
    {
      projectKey,
      status: request.status ?? null,
      issueType: request.issueType ?? null,
      assignee: request.assignee ?? null,
    },
    deps.config.defaultFlow,
  );
}
