import { TicketKey } from "@maestro/contracts";
import { classifyNetworkFailure } from "@maestro/llm-gateway";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authGuard, requireAnyRole } from "../auth/guard.js";
import type { PilotFetch, ResolvedDeps } from "../deps.js";
import { badRequest, unavailable } from "../errors.js";

/**
 * Studio's face for the pilot's real-Jira flow (Dalga D).
 *
 * THE HONEST ARCHITECTURE. This is a THIN CONTROL SURFACE, not a port of the
 * pilot's engine. The pilot process (apps/pilot) stays the flow engine — it
 * polls Jira, runs the workspace, writes git, generates the docs — and Studio
 * becomes its face by PROXYING to the pilot's existing HTTP API:
 *
 *   GET  /studio/pilot/state      -> GET  {pilot}/api/state
 *   POST /studio/pilot/start      -> POST {pilot}/api/start   { ticketKey }
 *   GET  /studio/pilot/events     -> GET  {pilot}/api/events  (SSE passthrough)
 *   GET  /studio/pilot/settings   -> GET  {pilot}/api/settings
 *   POST /studio/pilot/settings   -> POST {pilot}/api/settings
 *   GET  /studio/pilot/doc/:kind  -> GET  {pilot}/api/doc/:kind (pdf|docx)
 *
 * The full Temporal-backed, Studio-native flow (the pilot's poll/run/git/docs
 * moved into the platform) is a later, larger effort. This wave unifies the
 * operator's UI without pretending to have done that.
 *
 * FOUR SECURITY PROPERTIES, each enforced HERE regardless of what the pilot does:
 *
 *  (a) the Studio session token is NEVER forwarded. `pilotInit` builds the
 *      upstream request from scratch — it copies no header off the incoming
 *      request — so an internal service call cannot carry a user's 8-hour
 *      bearer to a second process. The pilot has its own auth model (a single
 *      operator page); handing it a Studio token would be a credential leak.
 *
 *  (b) start and settings-write are role-gated at the BFF (`PILOT_WRITE_ROLES`).
 *      A viewer gets 403 before the proxy is ever reached, whatever the pilot
 *      would have allowed — the pilot trusts whoever can open its page, so the
 *      gate has to live on this side.
 *
 *  (c) when the pilot is unreachable the proxy answers 503 `pilot_unreachable`
 *      rather than fabricating a state. An empty/synthetic run view is exactly
 *      the silent-wrong-answer this codebase refuses (see routes/unwired.ts).
 *
 *  (d) it is NOT an open SSRF: the upstream base URL is CONFIG
 *      (`deps.config.pilotBaseUrl`, from `PILOT_BASE_URL`), never a request
 *      param. `:kind` is the only path segment a caller influences and it is
 *      constrained to `pdf|docx` before it reaches the URL.
 */

/**
 * Who may START a run or CHANGE settings through the proxy. `admin` and
 * `tech-lead` are this platform's operator roles (the same pair `OPS_ROLES`
 * gates the fleet/quota surface with); `viewer`, the role everyone gets, is not
 * among them. Reading state and watching events needs only a session.
 */
export const PILOT_WRITE_ROLES = ["admin", "tech-lead"] as const;

const StartBody = z.object({ ticketKey: TicketKey });

/** The pilot only knows two document kinds; anything else never reaches its URL. */
const DOC_KINDS = new Set(["pdf", "docx"]);

export async function studioPilotRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);
  const writeHandler = [preHandler, requireAnyRole(...PILOT_WRITE_ROLES)];
  const base = deps.config.pilotBaseUrl.replace(/\/+$/, "");

  /** The pilot's live state (discovered tickets, steps, open gate, docsReady). */
  app.get("/studio/pilot/state", { preHandler }, async (request, reply) => {
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/state`, request.log);
    return relayJson(upstream, reply);
  });

  /** The pilot's finished runs, newest first — the "geçmiş işler" history. */
  app.get("/studio/pilot/runs", { preHandler }, async (request, reply) => {
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/runs`, request.log);
    return relayJson(upstream, reply);
  });

  /** Start the flow for a discovered ticket. Operator-gated; body carries the key. */
  app.post("/studio/pilot/start", { preHandler: writeHandler }, async (request, reply) => {
    const parsed = StartBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_ticket_key");
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/start`, request.log, {
      method: "POST",
      // A fresh header set: the Studio token is deliberately absent here.
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ticketKey: parsed.data.ticketKey }),
    });
    return relayJson(upstream, reply);
  });

  /** Runtime settings the pilot's ⚙ panel reads. Any session may read them. */
  app.get("/studio/pilot/settings", { preHandler }, async (request, reply) => {
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/settings`, request.log);
    return relayJson(upstream, reply);
  });

  /** Change settings. Operator-gated at the BFF; the body is forwarded verbatim. */
  app.post("/studio/pilot/settings", { preHandler: writeHandler }, async (request, reply) => {
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/settings`, request.log, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request.body ?? {}),
    });
    return relayJson(upstream, reply);
  });

  /**
   * Mirror the DB listening rules into the running pilot (Faz 3).
   *
   * The pilot cannot read Postgres, so after Studio edits a rule it calls this;
   * the BFF reads the CURRENT rule set from its own store (the DB — the source
   * of truth) and forwards the full list to the pilot's `/api/listening`. Studio
   * therefore never has to send the rules itself, and the pilot always converges
   * on what the DB holds. Operator-gated. When no ListeningStore is wired the
   * mirror is a no-op success (the pilot keeps its empty set), not a 503 — the DB
   * write the admin saw succeed must not be undone by a mirror hiccup.
   */
  app.post("/studio/pilot/listening", { preHandler: writeHandler }, async (request, reply) => {
    const rules = deps.listening === undefined ? [] : await deps.listening.list();
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/listening`, request.log, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ rules }),
    });
    return relayJson(upstream, reply);
  });

  /**
   * Mirror the ENABLED analysis-guidance notes into the running pilot, so the
   * analyst "learns" from them on the next analysis. Same pattern as the
   * listening mirror: the BFF reads its own store (the DB source of truth) and
   * forwards the enabled notes to the pilot's `/api/guidance`. A missing store
   * mirrors an empty set (no-op success), never a 503.
   *
   * Each note carries its `variantId` (null = global, every agent) so the pilot
   * can scope a targeted note to that one agent's context; a pilot that predates
   * the field simply ignores it.
   */
  app.post("/studio/pilot/guidance", { preHandler: writeHandler }, async (request, reply) => {
    const notes = deps.guidance === undefined ? [] : await deps.guidance.listEnabled();
    const upstream = await callPilot(deps.pilotFetch, `${base}/api/guidance`, request.log, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        notes: notes.map((n) => ({
          title: n.title,
          content: n.content,
          variantId: n.variantId ?? null,
        })),
      }),
    });
    return relayJson(upstream, reply);
  });

  /**
   * The generated analysis document. `:kind` is constrained to `pdf|docx`
   * before it touches the URL — the one caller-influenced path segment, and the
   * reason this route is not an SSRF hole.
   */
  app.get("/studio/pilot/doc/:kind", { preHandler }, async (request, reply) => {
    const kind = docKind(request.params);
    // Document generation is real work; it gets a budget the polls must not.
    const upstream = await callPilot(
      deps.pilotFetch,
      `${base}/api/doc/${kind}`,
      request.log,
      undefined,
      PILOT_DOC_TIMEOUT_MS,
    );
    if (!upstream.ok) return relayJson(upstream, reply);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const disposition = upstream.headers.get("content-disposition");
    void reply.header("content-type", contentType);
    if (disposition !== null) void reply.header("content-disposition", disposition);
    void reply.header("cache-control", "no-store");
    return reply.code(200).send(buffer);
  });

  /**
   * SSE passthrough. The pilot broadcasts the whole state on every change; this
   * relays those frames byte-for-byte to Studio. `reply.hijack()` hands the
   * socket to us so Fastify does not try to serialise a body — an SSE stream is
   * open-ended and has no JSON to send.
   */
  app.get("/studio/pilot/events", { preHandler }, async (request, reply) => {
    let upstream: Response;
    try {
      upstream = await deps.pilotFetch(`${base}/api/events`, {
        headers: { accept: "text/event-stream" },
      });
    } catch (error) {
      // Same honesty as callPilot: a dead pilot is a named 503, not an empty
      // stream that would render as "connected, nothing happening" — and the
      // same warn line, so the server side names the cause too. No timeout on
      // this dial: an event stream is open-ended by design.
      logPilotFailure(request.log, `${base}/api/events`, error);
      return reply.code(503).send({ error: "pilot_unreachable" });
    }
    if (!upstream.ok || upstream.body === null) {
      return reply.code(503).send({ error: "pilot_unreachable" });
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.hijack();

    const reader = upstream.body.getReader();
    const stop = (): void => {
      void reader.cancel().catch(() => {});
    };
    request.raw.on("close", stop);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) reply.raw.write(Buffer.from(value));
      }
    } catch {
      // Upstream dropped; close our side too. The client reconnects on its own.
    } finally {
      request.raw.off("close", stop);
      reply.raw.end();
    }
  });
}

/**
 * How long a short poll (state/runs/settings/start/mirrors) waits before the
 * pilot is called gone. Without a bound, a pilot that ACCEPTS and then hangs
 * held the proxy request open indefinitely — Studio's 15s poll piled request
 * on request and the operator saw nothing at all, not even the 503.
 */
export const PILOT_POLL_TIMEOUT_MS = 5_000;

/**
 * The document route's budget. Generating the Word/PDF is real work on the
 * pilot's side, so it gets room the polls must not have. The SSE passthrough
 * gets NO timeout at all — an event stream is open-ended by design.
 */
export const PILOT_DOC_TIMEOUT_MS = 30_000;

/**
 * Call the pilot, turning a connection failure into a NAMED 503 rather than a
 * generic 500. `pilot_unreachable` is a fact an operator can act on ("the pilot
 * is not running"); a fabricated `{ discovered: [] }` would look like a healthy
 * pilot with no work, which is the lie routes/unwired.ts exists to prevent.
 *
 * The failure is also LOGGED before it is renamed — the same discipline the
 * connector test route follows, for the same reason: the response deliberately
 * carries only the catalog-safe code, and before this line the BFF log said
 * nothing at all about WHY the proxy refused. The warn carries the target
 * host:port (config-derived, never a caller's), the error's cause-code chain
 * (`ECONNREFUSED`, `TimeoutError`, …) and the code the client will see.
 */
async function callPilot(
  pilotFetch: PilotFetch,
  url: string,
  log: FastifyBaseLogger,
  init?: RequestInit,
  timeoutMs = PILOT_POLL_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await pilotFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    logPilotFailure(log, url, error);
    throw unavailable("pilot_unreachable");
  }
}

/** The one warn line a failed pilot call leaves — codes and target only. */
function logPilotFailure(log: FastifyBaseLogger, url: string, error: unknown): void {
  const failure = classifyNetworkFailure(error);
  let target = "?";
  try {
    const parsed = new URL(url);
    target = `${parsed.hostname}:${parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80"}`;
  } catch {
    /* a diagnostic helper must never itself throw */
  }
  log.warn(
    {
      target,
      kind: failure.kind ?? "unknown",
      causes: failure.codes,
      note: "pilot_unreachable",
    },
    "pilot call failed",
  );
}

/**
 * Relay the pilot's JSON response with its own status. The pilot already speaks
 * this project's `{ error: code }` shape (409 `akış zaten çalışıyor`, 400
 * `geçerli bir ticketKey gerekli`), so its refusals reach Studio intact instead
 * of being flattened into a 502.
 */
async function relayJson(upstream: Response, reply: FastifyReply): Promise<FastifyReply> {
  const text = await upstream.text();
  void reply.header("content-type", "application/json; charset=utf-8");
  const body: unknown = text === "" ? {} : safeParse(text);
  return reply.code(upstream.status).send(body);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The pilot answered non-JSON (a proxy error page, say). Do not leak it —
    // report the upstream as unreachable in spirit, with a machine code.
    return { error: "pilot_bad_response" };
  }
}

function docKind(params: unknown): "pdf" | "docx" {
  const parsed = z.object({ kind: z.string() }).safeParse(params);
  if (!parsed.success || !DOC_KINDS.has(parsed.data.kind)) throw badRequest("invalid_doc_kind");
  return parsed.data.kind as "pdf" | "docx";
}
