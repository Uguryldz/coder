import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, NetworkError, UnauthenticatedError } from "../src/api/client.ts";
import { errorMessageKey, knownErrorCodes } from "../src/api/errors.ts";

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
