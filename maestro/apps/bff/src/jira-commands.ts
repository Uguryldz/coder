import type { CommandEnvelope, CommandName, TicketKey, WorkMode } from "@maestro/contracts";
import { toActor } from "./actor.js";
import type { ResolvedDeps } from "./deps.js";
import { decideGate, type GateResult } from "./gate-decision.js";
import { workflowIdFor } from "./gateway.js";
import { runIntake, type IntakeOutcome } from "./jira-intake.js";
import { BFF_MESSAGE_KEYS, stepTitleKey } from "./messages.js";
import { SIGNALS } from "./signal-names.js";

/**
 * Jira comment commands (M46/M105). Two rules shape everything below:
 *
 *  · the grammar is the driver's business — by the time a `CommandEnvelope`
 *    reaches here, "/approve etmiyorum" has already been refused as a command
 *    with trailing text, and an edited comment has already been discarded;
 *  · nothing fails quietly. Every refusal is written back to the ticket with a
 *    catalog key, because a comment that vanishes is indistinguishable from a
 *    platform that is down (M14).
 */

export type CommandOutcome =
  | { accepted: true; command: CommandName; workflowId?: string }
  | { accepted: false; command: CommandName; reason: string };

async function reply(
  deps: ResolvedDeps,
  ticket: TicketKey,
  key: string,
  params: Record<string, string> = {},
): Promise<void> {
  await deps.work.addComment(ticket, deps.messages.t(deps.config.locale, key, params));
}

export async function handleCommand(
  deps: ResolvedDeps,
  envelope: CommandEnvelope,
): Promise<CommandOutcome> {
  const { ticketKey: ticket, author, at, command } = envelope;
  const actor = toActor(author, deps.config.actorDomain);

  switch (command.name) {
    case "approve":
    case "reject":
      return gateCommand(deps, {
        ticket,
        name: command.name,
        actor,
        membershipId: author,
        at,
        ...(command.name === "reject" ? { reason: command.reason } : {}),
      });

    case "status":
      return statusCommand(deps, ticket);

    case "mode-change":
      return modeCommand(deps, { ticket, mode: command.mode, actor, at, command: "mode-change" });

    // M46: the human takes the keyboard. There is no dedicated signal — the
    // work mode IS the takeover, and `human_lead` is what it means.
    case "ai-takeover":
      return modeCommand(deps, {
        ticket,
        mode: "human_lead",
        actor,
        at,
        command: "ai-takeover",
      });

    case "ai-start": {
      const outcome = await runIntake(deps, { ticket, explicit: true, actor });
      return intakeCommand(deps, "ai-start", outcome, ticket);
    }

    case "ai-assign": {
      const outcome = await runIntake(deps, {
        ticket,
        explicit: true,
        appId: command.appId,
        actor,
      });
      if (outcome.accepted) {
        await deps.audit.append({
          actor,
          action: "ASSIGN_APP",
          subject: ticket,
          at,
          meta: { appId: command.appId, source: "jira" },
        });
      }
      return intakeCommand(deps, "ai-assign", outcome, ticket);
    }

    // No workflow signal exists for an explanation request yet (see RAPOR).
    // Saying so is the honest answer; pretending to accept it is not.
    case "ai-explain":
      await reply(deps, ticket, BFF_MESSAGE_KEYS.commandUnsupported, { command: "/ai-explain" });
      return { accepted: false, command: command.name, reason: "unsupported" };
  }
}

interface GateCommandInput {
  ticket: TicketKey;
  name: "approve" | "reject";
  actor: string;
  membershipId: string;
  at: string;
  reason?: string;
}

async function gateCommand(deps: ResolvedDeps, input: GateCommandInput): Promise<CommandOutcome> {
  const result: GateResult = await decideGate(deps, {
    ticket: input.ticket,
    decision: input.name,
    actor: input.actor,
    membershipId: input.membershipId,
    source: "jira",
    at: input.at,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  if (!result.ok) {
    await replyGateFailure(deps, input.ticket, result);
    return { accepted: false, command: input.name, reason: result.reason };
  }

  if (input.name === "approve") {
    await reply(deps, input.ticket, BFF_MESSAGE_KEYS.gateApproved, {
      gate: deps.messages.t(deps.config.locale, stepTitleKey(result.step)),
      actor: input.actor,
      seq: String(result.signatureSeq),
    });
  } else {
    await reply(deps, input.ticket, BFF_MESSAGE_KEYS.gateRejected, {
      gate: deps.messages.t(deps.config.locale, stepTitleKey(result.step)),
    });
  }
  return { accepted: true, command: input.name, workflowId: workflowIdFor(input.ticket) };
}

async function replyGateFailure(
  deps: ResolvedDeps,
  ticket: TicketKey,
  result: Extract<GateResult, { ok: false }>,
): Promise<void> {
  if (result.reason === "not_member") {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.gateMembershipFailed, { group: result.group ?? "" });
    return;
  }
  if (result.reason === "no_run" || result.reason === "not_delivered") {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoRun, { ticket });
    return;
  }
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoOpenGate, { ticket });
}

async function statusCommand(deps: ResolvedDeps, ticket: TicketKey): Promise<CommandOutcome> {
  const state = await deps.runs.queryRunState(workflowIdFor(ticket));
  if (state === null) {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoRun, { ticket });
    return { accepted: false, command: "status", reason: "no_run" };
  }
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandRunStatus, {
    ticket,
    step: deps.messages.t(deps.config.locale, stepTitleKey(state.step)),
    status: state.status,
  });
  return { accepted: true, command: "status" };
}

interface ModeCommandInput {
  ticket: TicketKey;
  mode: WorkMode;
  actor: string;
  at: string;
  command: CommandName;
}

async function modeCommand(deps: ResolvedDeps, input: ModeCommandInput): Promise<CommandOutcome> {
  const { ticket, mode, actor, at, command } = input;
  const workflowId = workflowIdFor(ticket);
  const delivered = await deps.runs.signal(workflowId, SIGNALS.modeChange, { mode, actor });
  if (delivered === "no_run") {
    await reply(deps, ticket, BFF_MESSAGE_KEYS.commandNoRun, { ticket });
    return { accepted: false, command, reason: "no_run" };
  }
  await deps.audit.append({
    actor,
    action: "MODE_CHANGED",
    subject: ticket,
    at,
    meta: { mode, command, source: "jira" },
  });
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandAccepted, { command: `/${command}` });
  return { accepted: true, command, workflowId };
}

async function intakeCommand(
  deps: ResolvedDeps,
  command: CommandName,
  outcome: IntakeOutcome,
  ticket: TicketKey,
): Promise<CommandOutcome> {
  if (!outcome.accepted) return { accepted: false, command, reason: outcome.reason };
  await reply(deps, ticket, BFF_MESSAGE_KEYS.commandAccepted, { command: `/${command}` });
  return { accepted: true, command, workflowId: outcome.workflowId };
}
