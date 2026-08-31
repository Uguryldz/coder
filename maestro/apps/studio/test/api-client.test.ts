import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, NetworkError, UnauthenticatedError } from "../src/api/client.ts";
import { errorMessageKey, knownErrorCodes, sweepReasonOf } from "../src/api/errors.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch, onSessionLost?: () => void) {
  return new ApiClient({
    getToken: () => "tok-123",
    fetchImpl,
    ...(onSessionLost ? { onSessionLost } : {}),
  });
}

describe("ApiClient", () => {
  it("sends the bearer token and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { level: "off" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const body = await client.get<{ level: string }>("/killswitch");

    expect(body).toEqual({ level: "off" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/killswitch");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when signed out", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = new ApiClient({
      getToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.get("/anything");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("builds a query string, skipping undefined values", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { runs: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.get("/runs", { query: { limit: 50, cursor: undefined } });

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/api/runs?limit=50");
  });

  it("returns undefined for 204, so logout does not try to parse a body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.post("/auth/logout")).resolves.toBeUndefined();
  });

  describe("401 handling", () => {
    it("drops the session and throws UnauthenticatedError", async () => {
      const onSessionLost = vi.fn();
      const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "session_expired" }));
      const client = makeClient(fetchImpl as unknown as typeof fetch, onSessionLost);

      const error = await client.get("/runs").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthenticatedError);
      expect((error as ApiError).code).toBe("session_expired");
      expect((error as ApiError).messageKey).toBe("error.session_expired");
      expect(onSessionLost).toHaveBeenCalledOnce();
    });

    it("also drops the session for a plain unauthenticated code", async () => {
      const onSessionLost = vi.fn();
      const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthenticated" }));
      const client = makeClient(fetchImpl as unknown as typeof fetch, onSessionLost);

      await client.get("/runs").catch(() => undefined);

      expect(onSessionLost).toHaveBeenCalledOnce();
    });

    it("does not drop the session on a 403", async () => {
      const onSessionLost = vi.fn();
      const fetchImpl = vi.fn(async () =>
        jsonResponse(403, { error: "role_required", details: { role: "admin" } }),
      );
      const client = makeClient(fetchImpl as unknown as typeof fetch, onSessionLost);

      const error = await client.get("/params").catch((e: unknown) => e);

      expect(onSessionLost).not.toHaveBeenCalled();
      expect((error as ApiError).status).toBe(403);
      expect((error as ApiError).details).toEqual({ role: "admin" });
    });
  });

  it("maps every known BFF code to a catalog key, never to raw text", () => {
    for (const code of knownErrorCodes()) {
      expect(errorMessageKey(code)).toMatch(/^error\./);
    }
    expect(errorMessageKey("something_the_bff_invented")).toBe("error.unexpected");
  });

  /**
   * Every code the BFF can THROW has an entry — read from the BFF's source.
   *
   * The test above cannot catch a missing code: `knownErrorCodes()` returns the
   * keys of the very table it checks, so it iterates the table to test the
   * table and passes no matter what the server does. That tautology is how
   * `project_already_bound` reached a bank operator as "Beklenmeyen bir hata
   * oluştu" while the BFF was answering with the project key and its state.
   *
   * This one greps the actual `throw` sites, so a new code added to the BFF
   * without a catalog entry fails HERE rather than in front of an operator.
   */
  it("covers every error code the BFF actually throws", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const bffSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bff", "src");

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(bffSrc);
    // Guard the guard: a wrong path would make this test pass by finding
    // nothing at all, which is the failure mode of every grep-based check.
    expect(files.length).toBeGreaterThan(20);

    // `badRequest("code")`, `conflict("code")`, `notFound("code")`, … — the
    // helpers in apps/bff/src/errors.ts. Only literal first arguments are
    // matched; a computed code cannot be enumerated statically and none exist.
    const thrower = /\b(?:badRequest|conflict|notFound|forbidden|unauthenticated|unavailable)\(\s*"([a-z0-9_]+)"/g;

    const thrown = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(thrower)) {
        if (match[1] !== undefined) thrown.add(match[1]);
      }
    }
    expect(thrown.size).toBeGreaterThan(20);

    const known = new Set(knownErrorCodes());
    const uncovered = [...thrown].filter((code) => !known.has(code)).sort();

    expect(uncovered, `BFF codes with no Studio catalog entry: ${uncovered.join(", ")}`).toEqual([]);
  });

  /**
   * The codes a route HAND-ROLLS, which the grep above cannot see.
   *
   * `sweep_not_configured` reached a bank operator as "Beklenmeyen bir hata
   * oluştu" while the test above was green: that grep only matches the helpers
   * in `apps/bff/src/errors.ts`, and `/studio/listening-sweep` answers with a
   * literal `reply.code(503).send({ error: "..." })` instead. Same failure the
   * test above was written to stop, reached by the road it does not watch.
   */
  it("covers error codes routes send directly via reply.code(...).send(...)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const bffSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bff", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(bffSrc);
    expect(files.length).toBeGreaterThan(20);

    // `reply.code(4xx|5xx).send({ ... error: "code" ... })`, the literal form.
    const sender = /reply\s*\.code\(\s*(?:4\d\d|5\d\d)\s*\)\s*\.send\(\s*\{([\s\S]{0,400}?)\}\s*\)/g;
    const sent = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(sender)) {
        for (const found of (match[1] ?? "").matchAll(/error:\s*"([a-z0-9_]+)"/g)) {
          if (found[1] !== undefined) sent.add(found[1]);
        }
      }
    }
    // Guard the guard: the sweep route is the reason this test exists.
    expect(sent).toContain("sweep_not_configured");

    const known = new Set(knownErrorCodes());
    const uncovered = [...sent].filter((code) => !known.has(code)).sort();
    expect(uncovered, `hand-rolled BFF codes with no catalog entry: ${uncovered.join(", ")}`).toEqual([]);
  });

  /**
   * The sweep 503 keeps its sentence, and nothing else does.
   *
   * The operator complaint this fixes was "ticket tarama çalışmıyor, server
   * responded with status 503" — a raw status with no reason, because the
   * client dropped the one field that said whether the interval was unset or
   * the driver simply cannot search.
   */
  describe("sweep_not_configured", () => {
    it("carries the server's reason through to the screen", async () => {
      const reason =
        "Bu kurulumun iş sürücüsü ticket araması sunmuyor, bu yüzden tarama çalışamaz.";
      const fetchImpl = vi.fn(async () =>
        jsonResponse(503, { error: "sweep_not_configured", message: reason }),
      );
      const client = makeClient(fetchImpl as unknown as typeof fetch);

      const error = await client.post("/studio/listening-sweep", {}).catch((e: unknown) => e);

      expect((error as ApiError).code).toBe("sweep_not_configured");
      expect((error as ApiError).messageKey).toBe("error.sweep_not_configured");
      expect(sweepReasonOf(error)).toBe(reason);
    });

    it("falls back to the catalog key when the server sends no message", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "sweep_not_configured" }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);

      const error = await client.post("/studio/listening-sweep", {}).catch((e: unknown) => e);

      expect(sweepReasonOf(error)).toBeNull();
      expect((error as ApiError).messageKey).toBe("error.sweep_not_configured");
    });

    it("does not carry prose for any OTHER code", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(503, { error: "capability_not_wired", message: "leak me" }),
      );
      const client = makeClient(fetchImpl as unknown as typeof fetch);

      const error = await client.get("/eval").catch((e: unknown) => e);

      expect(sweepReasonOf(error)).toBeNull();
      expect(JSON.stringify((error as ApiError).details ?? "")).not.toContain("leak me");
    });
  });

  it("never leaks a server body as prose", async () => {
    // A proxy error page, not JSON: must become a code, not HTML on screen.
    const fetchImpl = vi.fn(
      async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const error = (await client.get("/runs").catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("internal_error");
    expect(error.messageKey).toBe("error.internal_error");
    expect(JSON.stringify(error.details ?? "")).not.toContain("Bad Gateway");
  });

  it("wraps a transport failure as NetworkError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const error = await client.get("/runs").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).messageKey).toBe("error.network");
  });

  it("propagates an abort as an abort, not as a network error", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const error = await client
      .get("/runs", { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).not.toBeInstanceOf(NetworkError);
  });

  it("passes the abort signal through to fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.get("/runs", { signal: controller.signal });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});
