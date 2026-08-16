import { describe, expect, it } from "vitest";
import { PageQuery } from "../src/routes/paging.js";
import { reconciledState } from "../src/routes/studio-runs.js";
import { auth } from "./helpers.js";
import {
  AT,
  CALL,
  JOURNAL_AI,
  JOURNAL_HUMAN,
  OTHER_RUN,
  RUN,
  RUN_ID,
  TICKET,
  adminToken,
  memberToken,
  outsiderToken,
  studioHarness,
} from "./studio-fixtures.js";

/**
 * Studio's run surface. Three questions per endpoint, in the order they
 * actually matter: does it refuse a caller who should not be there, does it
 * return the real rows to one who should, and does it refuse input it cannot
 * make sense of instead of guessing.
 */
/**
 * The source-selection rule on its own, away from HTTP: every combination of
 * "what the record says" and "what the engine says", so a change to the rule
 * has to face each case rather than only the one the route test happens to
 * exercise.
 */
describe("reconciledState: which source tells the truth", () => {
  const ENGINE = {
    runId: RUN_ID,
    ticketKey: TICKET,
    step: "7",
    status: "running",
    startedAt: AT,
    updatedAt: AT,
  } as const;

  it("lets a terminal record overrule a live engine answer", () => {
    for (const status of ["fail", "done", "cancelled"] as const) {
      expect(reconciledState({ ...RUN, status }, ENGINE)?.status).toBe(status);
    }
  });

  it("keeps the engine's answer when the record is not terminal", () => {
    for (const status of ["running", "gate", "queued", "handover"] as const) {
      // The engine says `running`; a live record must not override it, whatever
      // live status the row happens to hold.
      expect(reconciledState({ ...RUN, status }, ENGINE)?.status).toBe("running");
    }
  });

  it("does not invent a state when neither source can supply one", () => {
    expect(reconciledState({ ...RUN, status: null }, null)).toBeNull();
  });

  /**
   * A terminal record with no engine answer stays `null` rather than becoming a
   * synthesised state: `WorkflowRunState` requires a `runId` and a `step`, and
   * the catalog holds neither. Inventing them would attribute a made-up step to
   * a real run — and the row lists fine without one.
   */
  it("does not synthesise a state a terminal record cannot fill", () => {
    expect(reconciledState({ ...RUN, status: "fail" }, null)).toBeNull();
  });

  /**
   * The two halves of the system must agree on what "over" means. The database
   * side enforces its own set (`TERMINAL_STATUSES`, apps/deploy run-context.ts)
   * to decide which run a ticket's live slot belongs to; this route decides
   * which source wins. If they drifted — say `fail` counted as terminal here
   * but live there — a failed run would render as finished while still holding
   * the ticket's only live slot, and the next `/ai-start` would die on the
   * unique index with no visible reason.
   *
   * Asserted by behaviour rather than by importing the constant: the BFF does
   * not depend on `apps/deploy`, and an import would invert that direction.
   */
  it("agrees with the database on which statuses mean the run is over", () => {
    const terminal = (["fail", "done", "cancelled"] as const).filter(
      (status) => reconciledState({ ...RUN, status }, ENGINE)?.status === status,
    );
    expect(terminal).toEqual(["fail", "done", "cancelled"]);

    const live = (["running", "gate", "queued", "handover"] as const).filter(
      (status) => reconciledState({ ...RUN, status }, ENGINE)?.status === "running",
    );
    expect(live).toEqual(["running", "gate", "queued", "handover"]);
  });

  it("preserves everything except the verdict", () => {
    const result = reconciledState({ ...RUN, status: "fail" }, ENGINE);
    expect(result?.runId).toBe(ENGINE.runId);
    expect(result?.step).toBe(ENGINE.step);
    expect(result?.startedAt).toBe(ENGINE.startedAt);
  });
});

describe("GET /studio/runs", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    const response = await h.app.inject({ method: "GET", url: "/studio/runs" });
    expect(response.statusCode).toBe(401);
  });

  it("does not list a project the caller does not belong to", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("returns the stored record joined to the live workflow state", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { ticketKey: string; title: string; costUsd: number; state: { step: string; status: string } }[] };
    expect(body.items).toHaveLength(1);
    // Every field comes from the fixture, so a route returning a constant fails.
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.title).toBe(RUN.title);
    expect(body.items[0]?.costUsd).toBe(RUN.costUsd);
    expect(body.items[0]?.state.step).toBe("5");
    expect(body.items[0]?.state.status).toBe("gate");
  });

  /**
   * The measured bug, as a test.
   *
   * On the live board the database held eleven `fail` rows and Studio rendered
   * twelve "running" and three "gate". The engine was not malfunctioning: a
   * workflow that dies inside an activity never reaches the code that would
   * record how it ended, so Temporal keeps answering with the last step the
   * workflow wrote — `running`, indefinitely. The list consulted only that
   * answer, so eleven dead runs read as live work.
   */
  it("shows a failed run as failed even while the engine still reports it running", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    // The engine's stale answer, exactly as Temporal gives it for a run that
    // died mid-activity: still `running`, still on the step it died on.
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: RUN_ID,
      ticketKey: TICKET,
      step: "7",
      status: "running",
      startedAt: AT,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    const body = response.json() as { items: { state: { status: string; step: string } | null }[] };
    expect(body.items[0]?.state?.status).toBe("fail");
    // The step is the engine's to know and is NOT overwritten: the record
    // corrects the verdict, not the history.
    expect(body.items[0]?.state?.step).toBe("7");
  });

  /**
   * The other direction, which is why the rule is not simply "the database
   * wins". Step progress happens in the engine and reaches the row afterwards,
   * so for a run that is genuinely alive the engine holds the fresher answer —
   * and a gate rendered as "running" is an approval nobody can see is waiting.
   */
  it("prefers the engine's answer while the record says the run is still live", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "running" });
    // The harness already parked this ticket at a gate (step 5).
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    const body = response.json() as { items: { state: { status: string } | null }[] };
    expect(body.items[0]?.state?.status).toBe("gate");
  });

  /** `done` and `cancelled` are terminal for the same reason `fail` is. */
  it("treats every terminal status as terminal, not just fail", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const h = await studioHarness();
      h.read.runs.put({ ...RUN, status });
      const token = await memberToken(h);

      const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

      const body = response.json() as { items: { state: { status: string } | null }[] };
      expect(body.items[0]?.state?.status).toBe(status);
    }
  });

  /**
   * The `state: null` contract, which predates this change and must survive it.
   * A row whose execution the engine cannot answer for is still the caller's
   * ticket; dropping it made Studio render "no workflows yet" over a catalog of
   * twenty-two runs.
   */
  it("still lists a row when the engine cannot answer for it", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    // No execution at all — the engine has nothing to say about this ticket.
    h.runs.states.delete(`maestro-${TICKET}`);
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { ticketKey: string; state: unknown }[] };
    // Listed, with a null state — NOT hidden, and NOT given a step nobody knows.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.state).toBeNull();
  });

  /**
   * The detail route reads the same two sources and must reach the same
   * verdict. A row listed as `fail` that turned back into `running` on click
   * would be the same lie, one screen deeper.
   */
  it("gives the detail header the same verdict the list gave", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: RUN_ID,
      ticketKey: TICKET,
      step: "7",
      status: "running",
      startedAt: AT,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });

    const body = response.json() as { state: { status: string } | null };
    expect(body.state?.status).toBe("fail");
  });

  /**
   * The status filter reads the reconciled verdict, not the raw engine answer.
   * An operator filtering for `fail` to find dead work would otherwise get an
   * empty page while eleven failed runs sat in the unfiltered list.
   */
  it("filters on the reconciled status rather than the engine's stale one", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: RUN_ID,
      ticketKey: TICKET,
      step: "7",
      status: "running",
      startedAt: AT,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const failed = await h.app.inject({
      method: "GET",
      url: "/studio/runs?status=fail",
      headers: auth(token),
    });
    const running = await h.app.inject({
      method: "GET",
      url: "/studio/runs?status=running",
      headers: auth(token),
    });

    expect((failed.json() as { items: unknown[] }).items).toHaveLength(1);
    // And it does NOT answer the query the engine's stale word would match.
    expect((running.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("shows an admin the runs of a project they are not a member of", async () => {
    const h = await studioHarness();
    h.read.runs.put(OTHER_RUN);
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    const keys = (response.json() as { items: { ticketKey: string }[] }).items.map((r) => r.ticketKey);
    expect(keys).toContain(OTHER_RUN.ticketKey);
  });

  it("refuses a page size above the ceiling instead of serving it", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?limit=5000",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_page" });
  });

  /**
   * A browser building the first page sends `?cursor=` for an unset value, and
   * `.min(1)` used to answer 400 to every one of them: the live Studio could
   * not list a single run, while the same URL without the parameter worked.
   * Blank means absent — the guard that matters is on a NON-empty cursor.
   */
  it("treats a blank cursor as no cursor, the way a browser sends it", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, ticketKey: "UGURPAY-700" });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?limit=50&cursor=",
      headers: auth(token),
    });

    // The point is the status code: a blank cursor used to be a 400. The body
    // is asserted only far enough to prove a real page came back.
    expect(response.statusCode).toBe(200);
    const keys = (response.json() as { items: { ticketKey: string }[] }).items.map((r) => r.ticketKey);
    expect(keys).toContain("UGURPAY-700");
  });

  it("still refuses a cursor that is present but unusable", () => {
    // Whitespace is blank, not a value — but an over-long one is a real cursor
    // and must still be rejected.
    expect(PageQuery.safeParse({ cursor: "   " }).success).toBe(true);
    expect(PageQuery.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
  });

  it("pages with a cursor rather than returning everything", async () => {
    const h = await studioHarness();
    for (let index = 0; index < 5; index += 1) {
      h.read.runs.put({ ...RUN, ticketKey: `UGURPAY-60${index}`, updatedAt: `2026-08-0${index + 1}T09:00:00.000Z` });
    }
    const token = await memberToken(h);

    const first = await h.app.inject({ method: "GET", url: "/studio/runs?limit=2", headers: auth(token) });
    const firstBody = first.json() as { items: { ticketKey: string }[]; nextCursor: string | null };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await h.app.inject({
      method: "GET",
      url: `/studio/runs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      headers: auth(token),
    });
    const secondBody = second.json() as { items: { ticketKey: string }[] };
    // A second page that repeated the first would be an infinite scroll that
    // never advances — the bug a cursor exists to prevent.
    expect(secondBody.items.map((r) => r.ticketKey)).not.toEqual(
      firstBody.items.map((r) => r.ticketKey),
    );
  });
});

describe("GET /studio/runs/:ticket", () => {
  it("refuses a stranger's ticket", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns the run, its state and its application together", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      run: { reporter: string; prId: number };
      state: { status: string };
      application: { adoRepo: string } | null;
    };
    expect(body.run.reporter).toBe(RUN.reporter);
    expect(body.run.prId).toBe(RUN.prId);
    expect(body.state.status).toBe("gate");
    expect(body.application?.adoRepo).toBe("ugurpay");
  });

  it("rejects a malformed ticket key", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/not-a-ticket",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/runs/:ticket/journal", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns the stored entries", async () => {
    const h = await studioHarness();
    h.read.journal.append(JOURNAL_AI);
    h.read.journal.append(JOURNAL_HUMAN);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal`,
      headers: auth(token),
    });

    const body = response.json() as { items: { title: string; cost?: { usd: number } }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.title).toBe(JOURNAL_AI.title);
    expect(body.items[0]?.cost?.usd).toBe(2.41);
  });

  it("filters by actor for the chips Studio renders", async () => {
    const h = await studioHarness();
    h.read.journal.append(JOURNAL_AI);
    h.read.journal.append(JOURNAL_HUMAN);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal?actor=human`,
      headers: auth(token),
    });

    const body = response.json() as { items: { actor: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.actor).toBe("human");
  });

  it("rejects an actor that is not one of the three", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal?actor=robot`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/runs/:ticket/summary", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/summary`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns the stored summary", async () => {
    const h = await studioHarness();
    h.read.journal.putSummary(RUN_ID, "Kredi limiti akışı 5. kapıda bekliyor.");
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/summary`,
      headers: auth(token),
    });

    expect(response.json()).toMatchObject({ summary: "Kredi limiti akışı 5. kapıda bekliyor." });
  });

  /** A run with no summary is a state, not a missing route. */
  it("answers null rather than 404 when none was generated", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/summary`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { summary: string | null }).summary).toBeNull();
  });
});

describe("GET /studio/runs/:ticket/cost", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/cost`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it("totals the call log rather than reporting a stored number", async () => {
    const h = await studioHarness();
    h.read.cost.put(CALL);
    h.read.cost.put({ ...CALL, usd: 0.58, tokensIn: 1_000, tokensOut: 200, at: "2026-08-09T10:00:00.000Z" });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/cost`,
      headers: auth(token),
    });

    const body = response.json() as { items: unknown[]; totals: { usd: number; tokensIn: number; calls: number } };
    expect(body.items).toHaveLength(2);
    expect(body.totals.calls).toBe(2);
    expect(body.totals.usd).toBeCloseTo(1.0, 5);
    expect(body.totals.tokensIn).toBe(49_200);
  });

  /** Subscription drivers report no dollar cost (M55); the total must not invent one. */
  it("treats a null usd as zero rather than as a missing field", async () => {
    const h = await studioHarness();
    h.read.cost.put({ ...CALL, usd: null, driver: "claude-sub" });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/cost`,
      headers: auth(token),
    });

    const body = response.json() as { items: { usd: number | null }[]; totals: { usd: number } };
    expect(body.items[0]?.usd).toBeNull();
    expect(body.totals.usd).toBe(0);
  });
});

describe("GET /studio/runs/:ticket/evidence", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/evidence`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns the manifest once the package exists", async () => {
    const h = await studioHarness();
    h.read.evidence.put({
      runId: RUN_ID,
      ticketKey: TICKET,
      createdAt: AT,
      templateVersion: "v3",
      files: [
        { name: "01-analiz.md", sha256: "a".repeat(64), bytes: 28_000, contentType: "text/markdown" },
      ],
      approvals: [],
      retentionYears: 10,
      objectLock: false,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/evidence`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { files: { name: string }[]; templateVersion: string };
    expect(body.templateVersion).toBe("v3");
    expect(body.files[0]?.name).toBe("01-analiz.md");
  });

  it("404s before the package is built rather than returning an empty one", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/evidence`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });
});
