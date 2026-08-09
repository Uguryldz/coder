import { ProjectKey, type TicketKey } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { badRequest } from "./errors.js";
import { BFF_MESSAGE_KEYS } from "./messages.js";
import { workflowIdFor } from "./gateway.js";

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

  const outcome = await deps.runs.signalWithStart({
    ticket: request.ticket,
    appId,
    mode: binding.mode,
    dataClass: binding.dataClass,
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
      },
    });
  }

  return { accepted: true, workflowId: outcome.workflowId ?? workflowIdFor(request.ticket), started: outcome.started };
}
