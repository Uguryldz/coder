import type { TicketKey } from "@maestro/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SYSTEM_ACTOR } from "../actor.js";
import type { ResolvedDeps, WorkEvent } from "../deps.js";
import { badRequest, WebhookRejected } from "../errors.js";
import { workflowIdFor } from "../gateway.js";
import { handleCommand } from "../jira-commands.js";
import { projectKeyOf, runIntake } from "../jira-intake.js";
import { SIGNALS } from "../signal-names.js";

/**
 * The two doors into the platform. Both are authenticated by the delivery
 * itself — an HMAC over the raw bytes for Jira, a shared secret header for ADO
 * Service Hooks — and both are fail-closed: verification runs BEFORE the body
 * is parsed, so a forged payload that is also malformed is refused as forged
 * (401), never reported as a syntax error (M15/M35).
 *
 * The raw body survives because this plugin drops the inherited JSON parser
 * inside its own encapsulation context. Re-serialising the payload would
 * change whitespace and key order, and the signature is over bytes: a body
 * that has been through `JSON.parse`/`JSON.stringify` can never verify again.
 */
export async function webhookRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/jira", async (request, reply) => {
    const raw = rawBody(request);
    const headers = flatHeaders(request);

    try {
      await deps.work.verifyWebhook(raw, headers);
    } catch (cause) {
      // The 401 body is deliberately bare (an attacker learns nothing), so the
      // WHY has to live here, where only the operator reads it. Without this
      // line a misconfigured webhook secret was indistinguishable from no
      // deliveries at all — the log said NOTHING while Jira retried into a
      // wall. The verifier's message names the failure, never the secret.
      request.log.warn({ webhook: "jira", reason: rejectionReason(cause) }, "webhook signature rejected");
      throw new WebhookRejected("jira", cause);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      // Only reachable for a delivery that DID verify, so this really is a
      // Jira-side malformation rather than an attack.
      request.log.warn({ webhook: "jira" }, "webhook payload malformed");
      throw badRequest("malformed_payload");
    }

    /**
     * A VERIFIED delivery, said out loud — the line this route was missing.
     *
     * Only refusals were logged, so "Jira never called us" and "Jira called us
     * and we handled it" produced the SAME log: nothing. That is precisely the
     * distinction an operator whose `/approve` did nothing has to make first,
     * and the two answers send them to two different places (a firewall rule
     * versus a gate that was already closed). Logged AFTER verification, never
     * before: an unverified delivery is an unauthenticated stranger and must
     * not get to write a chosen event name into the log.
     *
     * The event name and the ticket key only. Never the body: a Jira comment
     * payload carries the comment TEXT, which in a bank routinely names a
     * person, an account or an amount.
     */
    const delivery = describeDelivery(deps, payload);
    request.log.warn(
      {
        webhook: "jira",
        event: delivery.event,
        ...(delivery.ticket === null ? {} : { ticket: delivery.ticket }),
      },
      "webhook delivery verified",
    );

    // A VERIFIED delivery whose contents the driver cannot make sense of — an
    // author with no identifiable account, a shape this version does not know —
    // is Jira's problem, not a reason to fail. Jira retries a 5xx, so throwing
    // here turns one malformed comment into an endless redelivery storm, and
    // the 500-vs-202 difference tells whoever posted it what the parser choked
    // on. Unreadable is simply "nothing to do" (M14).
    let envelope: Awaited<ReturnType<typeof deps.work.parseCommand>>;
    try {
      envelope = await deps.work.parseCommand(payload);
    } catch {
      return reply.code(202).send({ accepted: false, reason: "unreadable_event" });
    }

    if (envelope !== null) {
      const outcome = await handleCommand(deps, envelope);
      /**
       * The command, and what became of it.
       *
       * `no_open_gate` is the case this line exists for. It is not a refusal an
       * operator did anything wrong to earn — the gate was already closed, or
       * the poller answered the same comment a moment earlier — but until it
       * was logged it looked exactly like a delivery that never arrived. The
       * command NAME and the verdict are logged; a `/reject` reason is not,
       * because it is free text on a bank's ticket and belongs in the audit
       * chain rather than in a log aggregator.
       */
      request.log.warn(
        {
          webhook: "jira",
          ticket: envelope.ticketKey,
          command: envelope.command.name,
          author: maskAuthor(envelope.author),
          accepted: outcome.accepted,
          ...("reason" in outcome && typeof outcome.reason === "string"
            ? { reason: outcome.reason }
            : {}),
        },
        "webhook command handled",
      );
      return reply.code(202).send(outcome);
    }

    /**
     * A comment that carried NO command — including the one refused because it
     * was EDITED.
     *
     * The edit refusal is a security decision (K-2/M32/M51): in Jira DC "Edit
     * All Comments" is a routine project-lead permission, so an edited comment
     * names the original author while somebody else supplied the text, and
     * honouring it would let its holder approve a gate AS SOMEONE ELSE. The
     * parser answers "no command" for it, which made the refusal completely
     * silent — the approver saw their `/approve` ignored with nothing anywhere
     * naming the rule that ignored it. Warned by name here.
     *
     * An ordinary comment that is simply not a command is the common case and
     * stays quiet: a thread of normal conversation must not fill the log.
     */
    if (delivery.kind === "comment" && delivery.edited) {
      request.log.warn(
        {
          webhook: "jira",
          ticket: delivery.ticket,
          event: delivery.event,
          reason: "edited_comment",
        },
        "webhook comment refused: an edited comment carries no command (SoD protection)",
      );
    }

    let refusal: { accepted: false; reason: string } | null;
    let event: WorkEvent;
    try {
      refusal = await answerInvalidCommand(deps, payload);
      event = deps.workEvents.read(payload);
    } catch {
      return reply.code(202).send({ accepted: false, reason: "unreadable_event" });
    }
    if (refusal !== null) {
      // "It looked like a command and was not one" — a typo, a `/reject` with
      // no reason. The author already gets a reply on the ticket (M14/M105);
      // this is the operator's copy, so a wave of them is visible without
      // reading every ticket.
      request.log.warn(
        { webhook: "jira", ticket: delivery.ticket, reason: refusal.reason },
        "webhook invalid command",
      );
      return reply.code(202).send(refusal);
    }

    if (event.kind !== "issue" || event.ticketKey === undefined) {
      return reply.code(202).send({ accepted: false, reason: "not_intake" });
    }

    const outcome = await runIntake(deps, {
      ticket: event.ticketKey,
      ...(event.labels !== undefined ? { labels: event.labels } : {}),
      // Passed through so a per-ticket listening rule can pick the FLOW. The
      // delivery is the only place the status is available — the frozen
      // `TicketSnapshot` has no such field.
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.issueType !== undefined ? { issueType: event.issueType } : {}),
      ...(event.assignee !== undefined ? { assignee: event.assignee } : {}),
      actor: SYSTEM_ACTOR,
    });
    // A DROPPED intake answers 202 on purpose (M102: an unbound project must
    // not learn it is being watched) — which used to make the drop perfectly
    // silent on this side too: the in-memory counter dies with the process,
    // and the operator asking "why did my ticket do nothing?" had no trace to
    // find. The trace belongs in the log, where Jira cannot see it.
    if (!outcome.accepted && (outcome.reason === "unbound" || outcome.reason === "not_opted_in")) {
      request.log.warn(
        { webhook: "jira", ticket: event.ticketKey, reason: outcome.reason },
        "webhook intake dropped",
      );
    } else {
      // The other half of the same pair: an intake that was TAKEN. Without it
      // the log said something only when a ticket was dropped, so a working
      // install produced the same silence as a broken one.
      request.log.warn(
        {
          webhook: "jira",
          ticket: event.ticketKey,
          accepted: outcome.accepted,
          ...(!outcome.accepted && typeof outcome.reason === "string"
            ? { reason: outcome.reason }
            : {}),
        },
        "webhook intake handled",
      );
    }
    return reply.code(202).send(outcome);
  });

  app.post("/webhooks/ado", async (request, reply) => {
    const raw = rawBody(request);
    const headers = flatHeaders(request);

    // Parsed when it parses, raw string when it does not: the driver
    // authenticates from the headers first, so a broken body still gets a 401
    // rather than a 400 that would tell an attacker their secret was accepted.
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = raw.toString("utf8");
    }

    let signal;
    try {
      signal = await deps.ci.parseBuildEvent({ headers, body });
    } catch (cause) {
      // Same trace discipline as the Jira route: the bare 401 gets a
      // server-side WHY (a wrong Service Hook secret, a shape the parser
      // refused) — codes and driver prose only, never a credential.
      request.log.warn({ webhook: "ado", reason: rejectionReason(cause) }, "webhook signature rejected");
      throw new WebhookRejected("ado", cause);
    }

    // Not a branch-policy validation build for a Maestro ticket (M12/M106).
    if (signal === null) return reply.code(202).send({ accepted: false, reason: "ignored" });

    const workflowId = workflowIdFor(signal.ticketKey);
    const delivered = await deps.runs.signal(workflowId, SIGNALS.ciResult, signal);
    await deps.audit.append({
      actor: SYSTEM_ACTOR,
      action: "CI_RESULT",
      subject: signal.ticketKey,
      at: deps.clock.now(),
      meta: {
        buildId: signal.buildId,
        prId: signal.prId,
        status: signal.status,
        adoProject: signal.adoProject ?? null,
        adoRepo: signal.adoRepo ?? null,
        delivered,
      },
    });

    return reply.code(202).send({
      accepted: delivered === "delivered",
      ...(delivered === "delivered" ? { workflowId } : { reason: "no_run" }),
    });
  });
}

/**
 * What a verified delivery IS, for the log line — read structurally off the
 * raw payload rather than through the driver.
 *
 * Two reasons it does not use `deps.workEvents.read`. That reader THROWS on a
 * payload it cannot map (a comment with no identifiable author is exactly such
 * a payload), and a log line must never be the thing that turns a 202 into a
 * 500. And it is optional on `ResolvedDeps` shapes older than this route.
 * Everything below is read defensively and answers `null` rather than raising.
 *
 * Only three facts are extracted, and none of them is content: the event name
 * Jira chose, the issue key, and whether the comment was EDITED. The comment
 * body is deliberately never touched.
 */
interface DeliveryShape {
  readonly kind: "comment" | "issue" | "other";
  readonly event: string;
  readonly ticket: string | null;
  /** True for a `comment_updated`, or a `comment_created` whose timestamps disagree. */
  readonly edited: boolean;
}

function describeDelivery(_deps: ResolvedDeps, payload: unknown): DeliveryShape {
  const envelope = asRecord(payload);
  const event = typeof envelope?.["webhookEvent"] === "string" ? envelope["webhookEvent"] : "unknown";
  const issue = asRecord(envelope?.["issue"]);
  const ticket = typeof issue?.["key"] === "string" ? issue["key"] : null;
  const comment = asRecord(envelope?.["comment"]);

  if (comment !== null && (event === "comment_created" || event === "comment_updated")) {
    const created = comment["created"];
    const updated = comment["updated"];
    return {
      kind: "comment",
      event,
      ticket,
      // Same rule the driver enforces (`adapter-jira/src/webhook.ts` →
      // `isEdited`), restated here because this line must not depend on the
      // driver having agreed to parse the payload at all.
      edited:
        event === "comment_updated" ||
        (typeof created === "string" && typeof updated === "string" && created !== updated),
    };
  }

  return {
    kind: event.startsWith("jira:issue_") ? "issue" : "other",
    event,
    ticket,
    edited: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A comment author for the log.
 *
 * On Jira Cloud this is an opaque `accountId` and on Data Center a username —
 * both ordinary business data an operator needs in order to match a log line
 * to a person. But a Data Center identity falls back to `emailAddress` when a
 * user carries neither `name` nor `key`, and an e-mail address is personal
 * data this platform masks everywhere else (`packages/pii`). Masked only when
 * it looks like one, so the common case stays readable.
 */
export function maskAuthor(author: string): string {
  const at = author.indexOf("@");
  if (at <= 0) return author;
  const local = author.slice(0, at);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 1))}@${author.slice(at + 1)}`;
}

/**
 * What a signature-rejection warn line says about WHY — the verifier's own
 * error, named and capped. Driver verify errors describe the failure
 * ("signature mismatch", a missing header) and never contain the secret, and
 * the cap keeps a hostile oversized header out of the log line.
 */
function rejectionReason(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return text.slice(0, 200);
}

/**
 * Tell the author why their comment did nothing (M14/M105). Needs a driver
 * capability the port does not declare; without it the BFF can only count the
 * event, which is why the gap is written up in RAPOR rather than papered over.
 *
 * The correction is still bound by M102: a typo on a project Maestro was never
 * bound to gets no reply either. Otherwise "/aprove" becomes a probe for which
 * projects the platform is watching — the same leak the command path closes,
 * reached through the helpful-error-message door.
 */
async function answerInvalidCommand(
  deps: ResolvedDeps,
  payload: unknown,
): Promise<{ accepted: false; reason: string } | null> {
  if (deps.diagnostics === null) return null;
  const diagnosis = deps.diagnostics.parseCommandDetailed(payload);
  if (diagnosis.invalid === null) return null;

  deps.counters.invalidCommands += 1;
  const event = deps.workEvents.read(payload);
  if (event.ticketKey !== undefined && (await isBound(deps, event.ticketKey))) {
    await deps.work.addComment(
      event.ticketKey,
      deps.messages.t(deps.config.locale, diagnosis.invalid.messageKey, diagnosis.invalid.messageParams),
    );
  }
  return { accepted: false, reason: "invalid_command" };
}

/** True when the ticket's project is bound AND active (M102). */
async function isBound(deps: ResolvedDeps, ticket: TicketKey): Promise<boolean> {
  let projectKey: string;
  try {
    projectKey = projectKeyOf(ticket);
  } catch {
    // A ticket key the contract does not recognise belongs to no binding.
    return false;
  }
  const binding = await deps.bindings.resolve(projectKey);
  return binding !== null && binding.active;
}

function rawBody(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body)) throw badRequest("raw_body_missing");
  return body;
}

/** Node delivers repeated headers as arrays; the ports take a flat bag. */
function flatHeaders(request: FastifyRequest): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") flat[name] = value;
    else if (Array.isArray(value) && value[0] !== undefined) flat[name] = value[0];
  }
  return flat;
}
