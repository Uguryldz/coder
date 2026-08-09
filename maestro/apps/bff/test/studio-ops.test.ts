import { describe, expect, it } from "vitest";
import { auth } from "./helpers.js";
import {
  AT,
  GATE,
  RUNNER,
  TICKET,
  adminToken,
  memberToken,
  outsiderToken,
  studioHarness,
} from "./studio-fixtures.js";

/**
 * The operator surface. The fleet, the quota and the trail describe the
 * PLATFORM rather than the caller's work, so they are role-gated (M86); the
 * gate board is a work list and is scoped per project like the runs it names.
 */
describe("GET /studio/gates", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/studio/gates" })).statusCode).toBe(401);
  });

  it("does not show a stranger the gates of a project they cannot see", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/gates", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("returns the open gate with a waiting time computed from the clock", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/gates", headers: auth(token) });

    const body = response.json() as { items: { ticketKey: string; step: string; ownerGroup: string; waitingDays: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.ownerGroup).toBe("tech-leads");
    // Opened four days before the harness clock — a stored duration would be
    // stale, so the endpoint must be doing the arithmetic.
    expect(body.items[0]?.waitingDays).toBe(4);
  });

  it("filters by owner group", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    h.read.gates.open({ ...GATE, step: "4", ownerGroup: "product-owners" });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/gates?ownerGroup=product-owners",
      headers: auth(token),
    });

    const body = response.json() as { items: { step: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.step).toBe("4");
  });

  it("rejects an over-long owner group instead of querying with it", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/gates?ownerGroup=${"x".repeat(200)}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });

  /** M32/M101: the board reports gates; it never offers a way to close one. */
  it("exposes no route that decides a gate", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    const token = await adminToken(h);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await h.app.inject({
        method,
        url: "/studio/gates",
        headers: auth(token),
        payload: { decision: "approve" },
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("GET /studio/runners", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runners", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns the fleet and its per-pool capacity to an admin", async () => {
    const h = await studioHarness();
    h.read.runners.put(RUNNER);
    h.read.runners.put({ ...RUNNER, runnerId: "lnx-02", activeSandboxes: 1, state: "idle" });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runners", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { runnerId: string }[];
      pools: { pool: string; capacity: number; busy: number; machines: number }[];
    };
    expect(body.items).toHaveLength(2);
    // Summed from the two fixtures, not a stored aggregate.
    expect(body.pools[0]).toMatchObject({ pool: "docker-linux", capacity: 8, busy: 3, machines: 2 });
  });

  it("counts an unreachable runner as unhealthy", async () => {
    const h = await studioHarness();
    h.read.runners.put({ ...RUNNER, state: "unreachable", note: "Xcode güncellemesi bekliyor" });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runners", headers: auth(token) });

    const body = response.json() as { items: { note: string | null }[]; pools: { unhealthy: number }[] };
    expect(body.pools[0]?.unhealthy).toBe(1);
    expect(body.items[0]?.note).toBe("Xcode güncellemesi bekliyor");
  });
});

describe("GET /studio/sandboxes", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/sandboxes", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  it("lists the workspaces an admin can see", async () => {
    const h = await studioHarness();
    h.read.runners.putSandbox({
      ticketKey: TICKET,
      runnerId: "lnx-01",
      state: "resumable",
      sizeBytes: 1_100_000_000,
      lastAccessAt: AT,
    });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/sandboxes", headers: auth(token) });

    const body = response.json() as { items: { ticketKey: string; sizeBytes: number; state: string }[] };
    expect(body.items[0]).toMatchObject({ ticketKey: TICKET, sizeBytes: 1_100_000_000, state: "resumable" });
  });
});

describe("GET /studio/quota", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/quota", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  /**
   * M55: the pool is what queues work. One exhausted account beside a ready one
   * is not a platform at 100%, and reporting an average would say it was.
   */
  it("reports the pool as having capacity while one account is ready", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/quota", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accounts: { accountId: string }[];
      pool: { ready: number; exhausted: number; hasCapacity: boolean };
    };
    expect(body.accounts).toHaveLength(2);
    expect(body.pool).toMatchObject({ ready: 1, exhausted: 1, hasCapacity: true });
  });
});

describe("GET /studio/health", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/health", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  it("reports the worst service state as the overall one", async () => {
    const h = await studioHarness({
      services: [
        { service: "bff", state: "healthy", version: "0.1.0", checkedAt: AT, note: null },
        { service: "temporal", state: "degraded", version: "1.0.0", checkedAt: AT, note: "3 replika" },
      ],
    });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/health", headers: auth(token) });

    const body = response.json() as { state: string; services: { service: string }[] };
    expect(body.state).toBe("degraded");
    expect(body.services).toHaveLength(2);
  });
});

describe("GET /studio/audit", () => {
  it("refuses an operator who is not an auditor", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "lider", roles: ["tech-lead"], groups: [] });
    const token = await h.login("lider");

    const response = await h.app.inject({ method: "GET", url: "/studio/audit", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns the appended records newest first", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    await h.chain.append({ actor: "maestro-worker", action: "GATE_OPEN", subject: TICKET, at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/audit", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { action: string; seq: number; hash: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.action).toBe("GATE_OPEN");
    expect(body.items[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("filters by subject", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURWEB-1", at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/audit?subject=${TICKET}`,
      headers: auth(token),
    });

    const body = response.json() as { items: { subject: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.subject).toBe(TICKET);
  });
});

describe("GET /studio/audit/verification", () => {
  it("refuses a non-auditor", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/audit/verification", headers: auth(token) }))
        .statusCode,
    ).toBe(403);
  });

  it("verifies a real chain", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/audit/verification",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, checked: 1, brokenAtSeq: null });
  });

  /**
   * M33: an emptied table must never report `ok`. A verification that called
   * "nothing to check" a pass would give a wiped trail a clean bill of health.
   */
  it("refuses to call an empty chain verified", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/audit/verification",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { ok: boolean }).ok).toBe(false);
  });
});
