import { JournalActor, TicketKey } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { workflowIdFor } from "../gateway.js";
import { assertProjectAccess } from "./access.js";
import { pageBody, pageOf, visibleProjects } from "./paging.js";

/**
 * The run-shaped half of Studio's read surface: the ticket list, the detail
 * header, and the three sub-resources a detail screen opens (journal, summary,
 * evidence). Every one of them authenticates and every one is scoped to the
 * projects the caller belongs to (M86) — a session is not a licence to read a
 * stranger's ticket, and the filtering happens in the STORE rather than after,
 * so the page size a caller asked for is a page of rows they may actually see.
 */
export async function studioRunRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  /**
   * The ticket list (Studio's `tickets` screen). Joins the workflow's own state
   * — step, status, risk — onto the platform record, because a list that showed
   * one without the other would make a caller open every row to find the gate.
   */
  app.get("/studio/runs", { preHandler }, async (request, reply) => {
    const filters = ListQuery.safeParse(request.query);
    if (!filters.success) throw badRequest("invalid_query");
    const page = pageOf(request.query);
    const session = sessionOf(request);

    const records = await deps.read.runs.list({
      ...page,
      appId: filters.data.appId ?? null,
      projectKeys: visibleProjects(session),
    });

    const rows = [];
    for (const record of records.items) {
      // A query that FAILS is not a run with no state — it is one whose state
      // could not be read, and the two must not share a fate. The engine
      // answers per workflow: a single execution left behind by an older build
      // ("no such function is exported by the workflow bundle"), or a worker
      // that is momentarily down, made this loop throw and took the WHOLE list
      // with it. Studio then rendered "no workflows yet" over a catalog holding
      // twenty-two of them — the exact failure `read-models.ts` exists to
      // prevent, arriving through the engine instead of the store.
      //
      // So the row survives with `state: null`, which the client already
      // renders as "not started". `request.log.warn` keeps the reason where an
      // operator can find it; it must not reach the response, where it would
      // leak engine internals to a browser.
      let state = null;
      try {
        state = await deps.runs.queryRunState(workflowIdFor(record.ticketKey));
      } catch (error) {
        request.log.warn(
          { err: error, ticket: record.ticketKey },
          "run state unreadable; listing the row without it",
        );
      }
      // A platform record with no execution is a run that has not started yet;
      // it is still the caller's ticket, so it is listed with a null state
      // rather than hidden — hiding it would make the queue look empty.
      //
      // The status filter runs here rather than in the store because status
      // lives in the workflow engine, not in the catalog. That makes a filtered
      // page a SUBSET of a full one: `nextCursor` still advances by the rows the
      // store returned, so paging keeps making progress instead of stalling on
      // a page whose every row was filtered out.
      if (filters.data.status !== undefined && state?.status !== filters.data.status) continue;
      rows.push({ ...record, state });
    }

    return reply.code(200).send(pageBody({ items: rows, nextCursor: records.nextCursor }));
  });

  /**
   * The detail header. Returns the platform record and the live workflow state
   * together: Studio's detail screen renders both, and two round trips would
   * let it paint a step from one moment beside a status from another.
   */
  app.get("/studio/runs/:ticket", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const record = await deps.read.runs.get(ticket);
    if (record === null) throw notFound("no_run", { ticket });
    const state = await deps.runs.queryRunState(workflowIdFor(ticket));
    const app_ = record.appId === null ? null : await deps.read.apps.get(record.appId);

    return reply.code(200).send({ run: record, state, application: app_ });
  });

  /**
   * The ticket journal (M30). Append-only upstream and read-only here: there is
   * no route that writes an entry, because an entry Studio could author would
   * be an entry the evidence package cannot vouch for.
   */
  app.get("/studio/runs/:ticket/journal", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const filter = JournalQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");

    const runId = await runIdOf(deps, ticket);
    const page = await deps.read.journal.list(runId, {
      ...pageOf(request.query),
      actor: filter.data.actor ?? null,
    });
    return reply.code(200).send(pageBody(page));
  });

  /** The living summary (M30) — derived from the journal, never authored here. */
  app.get("/studio/runs/:ticket/summary", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const runId = await runIdOf(deps, ticket);
    const text = await deps.read.journal.summary(runId);
    // `null` is an answer, not a 404: the run exists and has simply not
    // produced a summary yet, and a 404 would make Studio show "no such run".
    return reply.code(200).send({ ticketKey: ticket, runId, summary: text });
  });

  /**
   * The evidence package manifest (M56). The manifest only — the files
   * themselves live behind the storage port and are fetched with their own
   * signed URLs, so this route never becomes a way to stream an archive
   * through the API process.
   */
  app.get("/studio/runs/:ticket/evidence", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const runId = await runIdOf(deps, ticket);
    const manifest = await deps.read.evidence.get(runId);
    if (manifest === null) throw notFound("no_evidence", { ticket });
    return reply.code(200).send(manifest);
  });

  /**
   * Per-run consumption (M16/M55). Rows come from the gateway call log, so the
   * totals are a sum of records that exist rather than a number this route
   * invented — `usd` is null on subscription drivers and stays null here.
   */
  app.get("/studio/runs/:ticket/cost", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const runId = await runIdOf(deps, ticket);
    const page = await deps.read.cost.calls({ ...pageOf(request.query), runId });
    return reply.code(200).send({ ...pageBody(page), totals: totalsOf(page.items) });
  });
}

const ListQuery = z.object({
  appId: z.string().trim().min(1).max(64).optional(),
  status: z
    .enum(["running", "gate", "queued", "fail", "handover", "done", "cancelled"])
    .optional(),
});

const JournalQuery = z.object({ actor: JournalActor.optional() });

/** Sum of the rows on THIS page; a running total would need the whole log. */
function totalsOf(
  calls: readonly { usd: number | null; tokensIn: number; tokensOut: number }[],
): { usd: number; tokensIn: number; tokensOut: number; calls: number } {
  return {
    usd: calls.reduce((sum, call) => sum + (call.usd ?? 0), 0),
    tokensIn: calls.reduce((sum, call) => sum + call.tokensIn, 0),
    tokensOut: calls.reduce((sum, call) => sum + call.tokensOut, 0),
    calls: calls.length,
  };
}

/**
 * The run id the journal and the evidence package are keyed by. Resolved from
 * the live execution rather than derived from the ticket: a ticket that was
 * retried has more than one run id in its history, and guessing would serve
 * one run's journal under another's name.
 */
async function runIdOf(deps: ResolvedDeps, ticket: string): Promise<string> {
  const state = await deps.runs.queryRunState(workflowIdFor(ticket));
  if (state === null) throw notFound("no_run", { ticket });
  return state.runId;
}

function ticketParam(params: unknown): string {
  const parsed = z.object({ ticket: TicketKey }).safeParse(params);
  if (!parsed.success) throw badRequest("invalid_ticket_key");
  return parsed.data.ticket;
}
