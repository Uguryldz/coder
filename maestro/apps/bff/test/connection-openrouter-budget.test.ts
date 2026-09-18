import { describe, expect, it } from "vitest";
import { runConnectionTest } from "../src/connection-service.js";
import type { ConnectionRecord } from "../src/connection-store.js";

/**
 * OpenRouter can say how much of a key's budget is left (`/auth/key`). A key
 * with nothing left passes `/models` and then every real call answers 403
 * "Key limit exceeded" — the pilot ran a week on exactly that, reading it as
 * a platform fault. The connection test now measures it.
 */
const record = (): ConnectionRecord => ({
  id: "conn-1",
  kind: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  authKind: "bearer",
  config: {},
  secretRef: "connector:conn-1:abc",
  secretMask: "sk-4",
  enabled: true,
  onPrem: false,
  isDefault: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestNote: null,
});

const fetchWith = (auth: unknown, authStatus = 200) => {
  const calls: string[] = [];
  const fetchImpl = (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith("/auth/key")) return Promise.resolve(new Response(JSON.stringify(auth), { status: authStatus }));
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o-mini" }] }), { status: 200 }));
  };
  return { fetchImpl, calls };
};

describe("OpenRouter connection test measures the key budget", () => {
  it("an exhausted limit FAILS the test with usage and limit in the message", async () => {
    const { fetchImpl, calls } = fetchWith({ data: { limit: 2, limit_remaining: 0, usage: 2.089 } });
    const out = await runConnectionTest(record(), "sk-or-x", fetchImpl as never, "", { measureBudget: true });
    expect(out).toEqual({
      ok: false,
      messageKey: "connections.test.openrouter_limit_exhausted",
      messageParams: { usage: "2.09", limit: "2.00" },
    });
    expect(calls.some((u) => u.endsWith("/auth/key"))).toBe(true);
  });

  it("budget left → ok with the remaining amount", async () => {
    const { fetchImpl } = fetchWith({ data: { limit: 10, limit_remaining: 7.5, usage: 2.5 } });
    const out = await runConnectionTest(record(), "sk-or-x", fetchImpl as never, "", { measureBudget: true });
    expect(out).toEqual({
      ok: true,
      messageKey: "connections.test.openrouter_limit_ok",
      messageParams: { remaining: "7.50", limit: "10.00" },
    });
  });

  it("no limit on the key, or /auth/key unavailable → the old 'quota unknown' note", async () => {
    const unlimited = await runConnectionTest(record(), "sk-or-x", fetchWith({ data: { limit: null, limit_remaining: null, usage: 1 } }).fetchImpl as never, "", { measureBudget: true });
    expect(unlimited).toEqual({ ok: true, messageKey: "connections.test.key_ok_quota_unknown" });
    const down = await runConnectionTest(record(), "sk-or-x", fetchWith({}, 500).fetchImpl as never, "", { measureBudget: true });
    expect(down).toEqual({ ok: true, messageKey: "connections.test.key_ok_quota_unknown" });
  });
});

describe("the periodic health probe never measures the budget", () => {
  it("stays one request per connection", async () => {
    const { fetchImpl, calls } = fetchWith({ data: { limit: 2, limit_remaining: 0, usage: 2 } });
    const out = await runConnectionTest(record(), "sk-or-x", fetchImpl as never);
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
