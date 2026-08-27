import { describe, expect, it } from "vitest";
import type { PilotFetch } from "../src/deps.js";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The pilot proxy (Dalga D). Every test here is OFFLINE: the pilot is a stub
 * `PilotFetch` injected through `deps`, so nothing touches a socket. What is
 * asserted is the four security properties the verifier checks — the token is
 * never forwarded, start/settings are role-gated, a dead pilot is a named 503,
 * and the base URL is config rather than a request param — plus that state,
 * start and the SSE handshake are relayed with the right shape.
 */

/** A recording pilot stub. `respond` shapes each answer; `calls` captures what reached it. */
function pilotStub(respond: (url: string, init?: RequestInit) => Response): {
  fetch: PilotFetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: PilotFetch = (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return Promise.resolve(respond(url, init));
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A harness whose pilot is the given stub, plus an admin and a viewer login. */
async function pilotHarness(fetch: PilotFetch): Promise<{
  h: Harness;
  adminToken: string;
  viewerToken: string;
}> {
  const h = await harness({ deps: { pilotFetch: fetch } });
  await h.addUser({ username: "ops.admin", roles: ["admin"] });
  await h.addUser({ username: "read.only", roles: ["viewer"] });
  return {
    h,
    adminToken: await h.login("ops.admin"),
    viewerToken: await h.login("read.only"),
  };
}

const SAMPLE_STATE = {
  running: false,
  discovered: [{ key: "OPS-12", summary: "Bir şey", status: "To Do", createdAt: null }],
  steps: [],
};

describe("GET /studio/pilot/state", () => {
  it("relays the pilot's state to any authenticated caller", async () => {
    const pilot = pilotStub(() => json(SAMPLE_STATE));
    const { h, viewerToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/state",
      headers: auth(viewerToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SAMPLE_STATE);
    expect(pilot.calls[0]?.url).toBe("http://127.0.0.1:7020/api/state");
  });

  it("refuses an unauthenticated caller", async () => {
    const pilot = pilotStub(() => json(SAMPLE_STATE));
    const { h } = await pilotHarness(pilot.fetch);
    const res = await h.app.inject({ method: "GET", url: "/studio/pilot/state" });
    expect(res.statusCode).toBe(401);
    // The pilot was never called for an unauthenticated request.
    expect(pilot.calls).toHaveLength(0);
  });

  it("NEVER forwards the Studio session token to the pilot", async () => {
    const pilot = pilotStub(() => json(SAMPLE_STATE));
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    await h.app.inject({
      method: "GET",
      url: "/studio/pilot/state",
      headers: auth(adminToken),
    });

    const headers = new Headers(pilot.calls[0]?.init?.headers ?? {});
    expect(headers.has("authorization")).toBe(false);
    // Belt and braces: the token string must not appear anywhere in the init.
    expect(JSON.stringify(pilot.calls[0]?.init ?? {})).not.toContain(adminToken);
  });

  it("answers 503 pilot_unreachable when the pilot is down — no fabricated state", async () => {
    const pilot: PilotFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const { h, adminToken } = await pilotHarness(pilot);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/state",
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("pilot_unreachable");
  });
});

describe("POST /studio/pilot/start", () => {
  it("forwards the ticketKey and relays the pilot's 202", async () => {
    const pilot = pilotStub(() => json({ ok: true }, 202));
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/start",
      headers: auth(adminToken),
      payload: { ticketKey: "OPS-12" },
    });

    expect(res.statusCode).toBe(202);
    expect(pilot.calls[0]?.url).toBe("http://127.0.0.1:7020/api/start");
    expect(pilot.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(pilot.calls[0]?.init?.body))).toEqual({ ticketKey: "OPS-12" });
  });

  it("is role-gated: a viewer gets 403 and the pilot is never called", async () => {
    const pilot = pilotStub(() => json({ ok: true }, 202));
    const { h, viewerToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/start",
      headers: auth(viewerToken),
      payload: { ticketKey: "OPS-12" },
    });

    expect(res.statusCode).toBe(403);
    expect(pilot.calls).toHaveLength(0);
  });

  it("rejects a bad ticket key before reaching the pilot", async () => {
    const pilot = pilotStub(() => json({ ok: true }, 202));
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/start",
      headers: auth(adminToken),
      payload: { ticketKey: "not a key" },
    });

    expect(res.statusCode).toBe(400);
    expect(pilot.calls).toHaveLength(0);
  });

  it("relays the pilot's 409 when a run is already in progress", async () => {
    const pilot = pilotStub(() => json({ error: "akış zaten çalışıyor" }, 409));
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/start",
      headers: auth(adminToken),
      payload: { ticketKey: "OPS-12" },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("settings", () => {
  it("lets any session read settings", async () => {
    const pilot = pilotStub(() => json({ model: "opus", approverGroup: "leads" }));
    const { h, viewerToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/settings",
      headers: auth(viewerToken),
    });

    expect(res.statusCode).toBe(200);
    expect(pilot.calls[0]?.url).toBe("http://127.0.0.1:7020/api/settings");
  });

  it("role-gates a settings write: a viewer gets 403", async () => {
    const pilot = pilotStub(() => json({ ok: true }));
    const { h, viewerToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/settings",
      headers: auth(viewerToken),
      payload: { model: "opus" },
    });

    expect(res.statusCode).toBe(403);
    expect(pilot.calls).toHaveLength(0);
  });
});

describe("POST /studio/pilot/listening (mirror DB rules into the pilot)", () => {
  it("forwards the CURRENT DB rule set to the pilot's /api/listening", async () => {
    const pilot = pilotStub(() => json({ ok: true }));
    const h = await harness({
      deps: { pilotFetch: pilot.fetch },
      listeningRules: [
        {
          ruleId: "lr_1",
          projectKey: "OPS",
          assigneeAccountId: "712020:bot",
          matchKind: "issuetype",
          matchValue: "Hata",
          flowType: "duzeltme",
          priority: 100,
          enabled: true,
          analystVariantId: "analyst-node-v2",
          engineerVariantId: null,
        },
      ],
    });
    await h.addUser({ username: "ops.admin", roles: ["admin"] });
    const adminToken = await h.login("ops.admin");

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/listening",
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(200);
    expect(pilot.calls[0]?.url).toBe("http://127.0.0.1:7020/api/listening");
    // The DB rule was forwarded — the pilot receives the full list, not a flag.
    const body = JSON.parse(pilot.calls[0]?.init?.body as string) as {
      rules: { analystVariantId?: string | null; engineerVariantId?: string | null }[];
    };
    expect(body.rules).toHaveLength(1);
    // The agent-variant choice (Faz 3) rides the same payload: the mirror
    // forwards whatever the store returns, new columns included.
    expect(body.rules[0]!.analystVariantId).toBe("analyst-node-v2");
    expect(body.rules[0]!.engineerVariantId).toBeNull();
  });

  it("role-gates the mirror: a viewer gets 403 and the pilot is never called", async () => {
    const pilot = pilotStub(() => json({ ok: true }));
    const { h, viewerToken } = await pilotHarness(pilot.fetch);
    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/listening",
      headers: auth(viewerToken),
    });
    expect(res.statusCode).toBe(403);
    expect(pilot.calls).toHaveLength(0);
  });
});

describe("GET /studio/pilot/doc/:kind", () => {
  it("constrains :kind to pdf|docx — no arbitrary segment reaches the pilot URL", async () => {
    const pilot = pilotStub(() => json({}, 404));
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/doc/..%2fapi%2fstate",
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(400);
    expect(pilot.calls).toHaveLength(0);
  });

  it("streams the pilot's document with its content-type", async () => {
    const pilot = pilotStub(
      () =>
        new Response(Buffer.from("PDFDATA"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="analiz.pdf"',
          },
        }),
    );
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/doc/pdf",
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(pilot.calls[0]?.url).toBe("http://127.0.0.1:7020/api/doc/pdf");
  });
});

describe("GET /studio/pilot/events (SSE)", () => {
  it("opens the passthrough with an event-stream accept and no token", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(SAMPLE_STATE)}\n\n`));
        controller.close();
      },
    });
    const pilot = pilotStub(
      () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/events",
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("data: ");
    // The upstream call asked for the stream and carried no Studio token.
    const headers = new Headers(pilot.calls[0]?.init?.headers ?? {});
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.has("authorization")).toBe(false);
    expect(pilot.calls[0]?.url).toBe("http://127.0.0.1:7020/api/events");
  });

  it("answers 503 when the pilot is unreachable rather than an empty stream", async () => {
    const pilot: PilotFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const { h, adminToken } = await pilotHarness(pilot);

    const res = await h.app.inject({
      method: "GET",
      url: "/studio/pilot/events",
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("pilot_unreachable");
  });
});

describe("failed pilot calls are logged and bounded (the panel's red alert has a server-side trace)", () => {
  /** A harness whose fastify logger writes into an assertable buffer. */
  async function loggedPilotHarness(fetch: PilotFetch): Promise<{
    h: Harness;
    adminToken: string;
    warns: () => Array<Record<string, unknown>>;
  }> {
    const raw: string[] = [];
    const h = await harness({
      deps: { pilotFetch: fetch },
      fastify: {
        logger: {
          level: "warn",
          stream: {
            write: (line: string) => {
              raw.push(line);
            },
          },
        },
      },
    });
    await h.addUser({ username: "ops.admin", roles: ["admin"] });
    return {
      h,
      adminToken: await h.login("ops.admin"),
      warns: () =>
        raw
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return {};
            }
          })
          .filter((entry) => entry["msg"] === "pilot call failed"),
    };
  }

  it("a refused dial leaves ONE warn line naming target, cause chain and the returned code", async () => {
    // The shape undici really throws: a generic wrapper, the code in `cause`.
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:7020"),
      { code: "ECONNREFUSED" },
    );
    const { h, adminToken, warns } = await loggedPilotHarness(() => Promise.reject(refused));

    const res = await h.app.inject({ method: "GET", url: "/studio/pilot/state", headers: auth(adminToken) });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("pilot_unreachable");

    // Before this line existed, the operator's "hiçbir ticket işlenmez" alert
    // had NOTHING behind it in the BFF log — nothing to grep, nothing to read.
    const lines = warns();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      target: "127.0.0.1:7020",
      kind: "refused",
      note: "pilot_unreachable",
    });
    expect(lines[0]?.["causes"]).toContain("ECONNREFUSED");
  });

  it("every poll carries an abort signal, and its firing is logged as a TIMEOUT", async () => {
    // The stub stands in for a pilot that ACCEPTED and hung: it rejects with
    // exactly what `AbortSignal.timeout` produces, after proving the route
    // actually attached a signal — the wiring that ends the request-piling
    // hang, without making the suite wait the real five seconds.
    const signals: unknown[] = [];
    const hanging: PilotFetch = (_url, init) => {
      signals.push(init?.signal);
      return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    };
    const { h, adminToken, warns } = await loggedPilotHarness(hanging);

    const res = await h.app.inject({ method: "GET", url: "/studio/pilot/runs", headers: auth(adminToken) });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("pilot_unreachable");
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    const lines = warns();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "timeout", note: "pilot_unreachable" });
    expect(lines[0]?.["causes"]).toContain("TimeoutError");
  });

  it("the SSE dial stays UNBOUNDED — an event stream must not be killed by a poll budget", async () => {
    // The events proxy passes no timeout signal of its own; asserted here so a
    // future "add the signal everywhere" cleanup cannot quietly break the one
    // open-ended route. (`callPilot` is not on this path at all.)
    const signals: unknown[] = [];
    const dead: PilotFetch = (_url, init) => {
      signals.push(init?.signal);
      return Promise.reject(new Error("down"));
    };
    const { h, adminToken, warns } = await loggedPilotHarness(dead);

    const res = await h.app.inject({ method: "GET", url: "/studio/pilot/events", headers: auth(adminToken) });
    expect(res.statusCode).toBe(503);
    expect(signals[0]).toBeUndefined();
    // The failure still leaves its warn line, cause chain and all.
    expect(warns()).toHaveLength(1);
  });
});

describe("base URL is config, not request-supplied (no SSRF)", () => {
  it("uses PILOT_BASE_URL from config for the upstream call", async () => {
    const pilot = pilotStub(() => json(SAMPLE_STATE));
    const h = await harness({
      deps: { pilotFetch: pilot.fetch, config: { pilotBaseUrl: "http://pilot.internal:9999" } },
    });
    await h.addUser({ username: "ops.admin", roles: ["admin"] });
    const token = await h.login("ops.admin");

    await h.app.inject({ method: "GET", url: "/studio/pilot/state", headers: auth(token) });

    expect(pilot.calls[0]?.url).toBe("http://pilot.internal:9999/api/state");
  });
});

describe("POST /studio/pilot/guidance — the mirror payload", () => {
  it("forwards each enabled note WITH its variantId (null = global) to the pilot", async () => {
    const pilot = pilotStub(() => json({ ok: true }));
    const { h, adminToken } = await pilotHarness(pilot.fetch);

    // One global note, one targeted at a single agent variant, one disabled.
    await h.guidance.create({ title: "genel", content: "herkese", enabled: true });
    await h.guidance.create({
      title: "web-özel",
      content: "yalnız web ajanına",
      enabled: true,
      variantId: "analyst-web",
    });
    await h.guidance.create({ title: "kapalı", content: "gitmez", enabled: false });

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/pilot/guidance",
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);

    const call = pilot.calls.find((c) => c.url.endsWith("/api/guidance"));
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.init?.body)) as {
      notes: { title: string; content: string; variantId: string | null }[];
    };
    // Only the ENABLED notes travel, and every one carries its scope.
    expect(body.notes).toHaveLength(2);
    expect(body.notes).toContainEqual({ title: "genel", content: "herkese", variantId: null });
    expect(body.notes).toContainEqual({
      title: "web-özel",
      content: "yalnız web ajanına",
      variantId: "analyst-web",
    });
  });
});
