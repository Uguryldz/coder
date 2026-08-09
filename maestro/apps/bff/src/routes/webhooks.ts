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
      throw new WebhookRejected("jira", cause);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      // Only reachable for a delivery that DID verify, so this really is a
      // Jira-side malformation rather than an attack.
      throw badRequest("malformed_payload");
    }

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
      return reply.code(202).send(outcome);
    }

    let refusal: { accepted: false; reason: string } | null;
    let event: WorkEvent;
    try {
      refusal = await answerInvalidCommand(deps, payload);
      event = deps.workEvents.read(payload);
    } catch {
      return reply.code(202).send({ accepted: false, reason: "unreadable_event" });
    }
    if (refusal !== null) return reply.code(202).send(refusal);

    if (event.kind !== "issue" || event.ticketKey === undefined) {
      return reply.code(202).send({ accepted: false, reason: "not_intake" });
    }

    const outcome = await runIntake(deps, {
      ticket: event.ticketKey,
      ...(event.labels !== undefined ? { labels: event.labels } : {}),
      actor: SYSTEM_ACTOR,
    });
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
