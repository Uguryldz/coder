import { describe, expect, it } from "vitest";
import { PageQuery } from "../src/routes/paging.js";
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
