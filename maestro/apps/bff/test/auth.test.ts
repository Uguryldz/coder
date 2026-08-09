import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "../src/auth/sessions.js";
import { auth, harness, TEST_PASSWORD } from "./helpers.js";

/** Every REST route, so a new one cannot quietly ship without a guard (M7). */
const GUARDED_ROUTES: ReadonlyArray<{ method: "GET" | "POST" | "PUT"; url: string }> = [
  { method: "GET", url: "/runs" },
  { method: "GET", url: "/runs/UGURPAY-1" },
  { method: "POST", url: "/runs/UGURPAY-1/signals/gateDecision" },
  { method: "GET", url: "/params" },
  { method: "PUT", url: "/params/reminder.channel" },
  { method: "GET", url: "/killswitch" },
  { method: "POST", url: "/killswitch" },
  { method: "POST", url: "/auth/logout" },
  { method: "GET", url: "/auth/session" },
];

describe("identity and sessions (M8)", () => {
  it("issues an eight-hour session for valid credentials", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayse.kaya", password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; expiresAt: string; user: { userId: string } };
    expect(body.user.userId).toBe("ayse.kaya@ugurbank.local");
    expect(Date.parse(body.expiresAt) - h.clock.now().getTime()).toBe(SESSION_TTL_MS);
  });

  it("rejects a wrong password without saying which half was wrong", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });

    const wrongPassword = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayse.kaya", password: "Definitely-Not-It-1!" },
    });
    const unknownUser = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "hayalet", password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });

  it("refuses a deactivated account", async () => {
    const h = await harness();
    await h.addUser({ username: "ayrilan.kisi" });
    const record = await h.users.find("ayrilan.kisi");
    await h.users.upsert({ ...record!, active: false });

    const response = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ayrilan.kisi", password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it("stops accepting a session once its eight hours are up", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    const token = await h.login("ayse.kaya");

    const before = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });
    expect(before.statusCode).toBe(200);

    h.clock.advance(SESSION_TTL_MS + 1);

    const after = await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "session_expired" });
    // The expired record is dropped, not merely refused.
    expect(await h.sessions.get(token)).toBeNull();
  });

  it("ends the session on logout", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya" });
    const token = await h.login("ayse.kaya");

    expect((await h.app.inject({ method: "POST", url: "/auth/logout", headers: auth(token) })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "GET", url: "/runs", headers: auth(token) })).statusCode).toBe(401);
  });

  it.each(GUARDED_ROUTES)("refuses $method $url without a token", async (route) => {
    const h = await harness();
    const response = await h.app.inject({ method: route.method, url: route.url, payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it.each(GUARDED_ROUTES)("refuses $method $url with a made-up token", async (route) => {
    const h = await harness();
    const response = await h.app.inject({
      method: route.method,
      url: route.url,
      headers: auth("not-a-real-token"),
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("leaves the health probes open", async () => {
    const h = await harness();
    expect((await h.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("reports the session behind the token", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"], groups: ["tech-leads"] });
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({ method: "GET", url: "/auth/session", headers: auth(token) });

    expect(response.json()).toMatchObject({
      userId: "ayse.kaya@ugurbank.local",
      roles: ["admin"],
      groups: ["tech-leads"],
      delegated: false,
    });
  });
});
