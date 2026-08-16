import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import type { ConnectorFetch } from "../src/connection-service.js";
import { auth, harness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * The connector-management surface: outbound connections made admin-editable,
 * their tokens stored enciphered and read back only as a mask.
 *
 * The behaviours under test are the security properties a leak would breach: a
 * GET never carries a token; a POST stores the reference, not the raw value;
 * the live test uses the STORED credential and reports its HONEST result; and
 * every write/test/delete is admin-only.
 */

const TOKEN = "ghp_supersecrettokenvalue1234";

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

async function techLead(h: Harness): Promise<string> {
  await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
  return h.login("mehmet.demir");
}

async function viewer(h: Harness): Promise<string> {
  await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
  return h.login("can.yilmaz");
}

function get(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url, headers: auth(token) });
}
function post(h: Harness, url: string, token: string, payload?: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "POST", url, headers: auth(token), ...(payload ? { payload } : {}) });
}
function put(h: Harness, url: string, token: string, payload: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "PUT", url, headers: auth(token), payload });
}
function del(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "DELETE", url, headers: auth(token) });
}

const GITHUB = {
  id: "github",
  kind: "github",
  displayName: "GitHub",
  baseUrl: "https://api.github.com",
  authKind: "bearer",
} as const;

async function createGithub(h: Harness, token: string, over: Record<string, unknown> = {}): Promise<LightMyRequestResponse> {
  return post(h, "/studio/connections", token, { ...GITHUB, token: TOKEN, ...over });
}

describe("POST /studio/connections", () => {
  it("stores the token ENCIPHERED — the raw token is never in the connection row", async () => {
    const h = await harness();
    const admToken = await admin(h);

    const response = await createGithub(h, admToken);
    expect(response.statusCode).toBe(201);

    // The stored connection row carries only a reference + a mask, never the token.
    const record = await h.connections.get("github");
    expect(record?.secretRef).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(record?.secretMask).toBe("1234");

    // The token lives ONLY in the secret store, under the reference.
    expect(h.connectorSecrets.has(record!.secretRef!)).toBe(true);
    expect(await h.connectorSecrets.get(record!.secretRef!)).toBe(TOKEN);
  });

  it("never returns the token in the create RESPONSE — only a mask + set flag", async () => {
    const h = await harness();
    const admToken = await admin(h);

    const response = await createGithub(h, admToken);
    expect(response.body).not.toContain(TOKEN);
    const body = response.json() as { connection: { secretMask: string; secretSet: boolean; token?: string } };
    expect(body.connection.secretMask).toBe("1234");
    expect(body.connection.secretSet).toBe(true);
    expect(body.connection.token).toBeUndefined();
  });

  it("refuses a tech lead and a viewer — writing a connector is admin-only (M86)", async () => {
    const h = await harness();
    expect((await createGithub(h, await techLead(h))).statusCode).toBe(403);
    expect((await createGithub(h, await viewer(h))).statusCode).toBe(403);
  });

  it("refuses the write while the kill switch is on (M58)", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await h.killSwitch.set({ level: "all", actor: "ayse.kaya@ugurbank.local", reason: "olay", at: "2026-08-09T10:00:00.000Z" });
    expect((await createGithub(h, admToken)).statusCode).toBe(409);
  });

  it("rejects an invalid body (a non-URL base)", async () => {
    const h = await harness();
    const admToken = await admin(h);
    const response = await createGithub(h, admToken, { baseUrl: "not-a-url" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/connections", () => {
  it("lists connections masked — no token in the body, ever", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const response = await get(h, "/studio/connections", admToken);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(TOKEN);
    const body = response.json() as { connections: { id: string; secretMask: string; secretSet: boolean }[] };
    expect(body.connections[0]?.id).toBe("github");
    expect(body.connections[0]?.secretMask).toBe("1234");
    expect(body.connections[0]?.secretSet).toBe(true);
  });

  it("is readable by a tech lead but not a viewer", async () => {
    const h = await harness();
    expect((await get(h, "/studio/connections", await techLead(h))).statusCode).toBe(200);
    expect((await get(h, "/studio/connections", await viewer(h))).statusCode).toBe(403);
  });
});

describe("PUT /studio/connections/:id", () => {
  it("keeps the stored token when the update omits one (a config-only edit)", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    const before = await h.connections.get("github");

    const response = await put(h, "/studio/connections/github", admToken, {
      ...GITHUB,
      displayName: "GitHub (prod)",
    });
    expect(response.statusCode).toBe(200);

    const after = await h.connections.get("github");
    expect(after?.displayName).toBe("GitHub (prod)");
    // Same secret ref — the token was untouched.
    expect(after?.secretRef).toBe(before?.secretRef);
    expect(await h.connectorSecrets.get(after!.secretRef!)).toBe(TOKEN);
  });

  it("replaces the token (and its ref) when a new one is supplied", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    const before = await h.connections.get("github");

    await put(h, "/studio/connections/github", admToken, { ...GITHUB, token: "ghp_rotated5678" });
    const after = await h.connections.get("github");
    expect(after?.secretRef).not.toBe(before?.secretRef);
    expect(after?.secretMask).toBe("5678");
    expect(await h.connectorSecrets.get(after!.secretRef!)).toBe("ghp_rotated5678");
  });
});

describe("POST /studio/connections/:id/test", () => {
  it("calls the right URL for the kind with the STORED token and reports ok", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const connectorFetch: ConnectorFetch = (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      return Promise.resolve(new Response(JSON.stringify({ login: "ugurbank-bot" }), { status: 200 }));
    };
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const response = await post(h, "/studio/connections/github/test", admToken);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; messageKey: string; messageParams?: { who: string } };
    expect(body.ok).toBe(true);
    // GitHub's identity probe is /user, and the token is the STORED one — proving
    // the test does not take a caller-supplied credential.
    expect(calls[0]?.url).toBe("https://api.github.com/user");
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(body.messageParams?.who).toBe("ugurbank-bot");

    // The honest result — and its secret-free note — are recorded on the row.
    const record = await h.connections.get("github");
    expect(record?.lastTestOk).toBe(true);
    expect(record?.lastTestedAt).not.toBeNull();
    // The note is the outcome's catalog KEY, never raw text or a token.
    expect(record?.lastTestNote).toBe("connections.test.ok_as");
  });

  it("reports a failure honestly and never fakes green", async () => {
    const connectorFetch: ConnectorFetch = () => Promise.resolve(new Response("nope", { status: 401 }));
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const body = (await post(h, "/studio/connections/github/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.http_error");
    const failed = await h.connections.get("github");
    expect(failed?.lastTestOk).toBe(false);
    // The failure note is the catalog key — it explains WHY without leaking the
    // token, the URL's credentials, or a raw driver message.
    expect(failed?.lastTestNote).toBe("connections.test.http_error");
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
  });

  it("never leaks the token, even when the transport throws", async () => {
    const connectorFetch: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const response = await post(h, "/studio/connections/github/test", admToken);
    expect(response.body).not.toContain(TOKEN);
    const body = response.json() as { ok: boolean; messageKey: string };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.unreachable");
  });

  it("refuses a viewer — a crafted test must not be a token-exfiltration path", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    expect((await post(h, "/studio/connections/github/test", await viewer(h))).statusCode).toBe(403);
  });
});

/**
 * The bot-identity check.
 *
 * A Jira connection carries `config.botAccountId` — the account Maestro acts as.
 * It used to be free text, so an operator could store their OWN account id and
 * nothing would ever contradict them: comments, transitions and four-eyes
 * exemptions would then be attributed to a person instead of the bot. The live
 * test knows better, because `/rest/api/3/myself` names the token's real owner.
 *
 * No network here — `connectorFetch` is a fixture returning a canned `/myself`.
 */
describe("POST /studio/connections/:id/test — the bot account it claims", () => {
  // The real shape of a Jira Cloud `/myself` answer, email included, so the PII
  // assertions below are testing against a body that genuinely contains one.
  const REAL_OWNER = "712020:b836c135-c9d3-499a-a665-aed43d362cfd";
  const OPERATORS_OWN = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
  const BOT_EMAIL = "uyildiz2054@gmail.com";

  function myselfFetch(over: Record<string, unknown> = {}): ConnectorFetch {
    return () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            accountId: REAL_OWNER,
            displayName: "maestro",
            emailAddress: BOT_EMAIL,
            ...over,
          }),
          { status: 200 },
        ),
      );
  }

  const JIRA = {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
  } as const;

  async function createJira(
    h: Harness,
    token: string,
    config: Record<string, string>,
  ): Promise<LightMyRequestResponse> {
    return post(h, "/studio/connections", token, { ...JIRA, config, token: TOKEN });
  }

  it("catches a botAccountId that is NOT the token's owner and corrects it", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    // The live bug: the operator's personal account id stored as the bot's.
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      messageParams?: Record<string, string>;
      botAccountCorrected?: { from: string; to: string };
    };

    // The connection genuinely works, so `ok` stays true — but it does NOT get
    // to say a plain "connection succeeded" over a wrong identity.
    expect(body.ok).toBe(true);
    expect(body.messageKey).toBe("connections.test.ok_bot_fixed");
    expect(body.messageParams?.["was"]).toBe(OPERATORS_OWN);
    expect(body.messageParams?.["now"]).toBe(REAL_OWNER);
    expect(body.botAccountCorrected).toEqual({ from: OPERATORS_OWN, to: REAL_OWNER });

    // And the stored config is actually repaired, so the next rule read is right.
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(REAL_OWNER);
  });

  it("accepts a matching botAccountId quietly — no false alarm", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: REAL_OWNER });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      botAccountCorrected?: unknown;
    };
    expect(body.ok).toBe(true);
    // The ordinary success key, and no correction claimed.
    expect(body.messageKey).toBe("connections.test.ok_as");
    expect(body.botAccountCorrected).toBeUndefined();
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(REAL_OWNER);
  });

  it("never says 'verified' when the identity could not be read — fail closed", async () => {
    // The network is down: nothing was learned, so nothing may be asserted.
    const h = await harness({ connectorFetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: OPERATORS_OWN });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      botAccountCorrected?: unknown;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.unreachable");
    expect(body.botAccountCorrected).toBeUndefined();

    // A failed reach must NOT overwrite the stored id — a wrong value is still
    // better than a value silently replaced on the strength of no evidence.
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(OPERATORS_OWN);
  });

  it("leaves the id alone when the probe answers 200 with no accountId", async () => {
    const h = await harness({ connectorFetch: myselfFetch({ accountId: undefined }) });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: OPERATORS_OWN });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      messageKey: string;
    };
    // Nothing to compare against, so no claim of a correction is made.
    expect(body.messageKey).toBe("connections.test.ok_as");
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(OPERATORS_OWN);
  });

  it("records the replacement in the audit trail, with both ids and no email", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });
    await post(h, "/studio/connections/jira/test", admToken);

    const entries = await h.auditStore.read();
    const corrected = entries.find(
      (entry) => (entry.meta as Record<string, unknown> | undefined)?.["verb"] === "test_ok_bot_corrected",
    );
    expect(corrected).toBeDefined();
    const meta = corrected?.meta as Record<string, unknown>;
    expect(meta["botAccountIdWas"]).toBe(OPERATORS_OWN);
    expect(meta["botAccountIdNow"]).toBe(REAL_OWNER);
    expect(JSON.stringify(entries)).not.toContain(BOT_EMAIL);
  });

  it("keeps the bot's EMAIL out of every output — it is PII, the accountId is not", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });

    const test = await post(h, "/studio/connections/jira/test", admToken);
    // The `/myself` body carried an email; neither the test response...
    expect(test.body).not.toContain(BOT_EMAIL);
    // ...nor the connection read that follows it may echo one.
    expect((await get(h, "/studio/connections", admToken)).body).not.toContain(BOT_EMAIL);
    // The stored note is a catalog key, never the probe's prose or its email.
    expect((await h.connections.get("jira"))?.lastTestNote).toBe("connections.test.ok_bot_fixed");
  });

  it("does not resurrect a wrong id when a later edit omits it", async () => {
    // How the bad value survived: the panel round-trips `config`, so a rename
    // after a correction would write the operator's id straight back.
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });
    await post(h, "/studio/connections/jira/test", admToken);

    // A config-only edit that carries no botAccountId at all.
    const edit = await put(h, "/studio/connections/jira", admToken, {
      ...JIRA,
      displayName: "Jira (production)",
      config: { email: "operator@ugurbank.local" },
      enabled: true,
    });
    expect(edit.statusCode).toBe(200);
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(REAL_OWNER);
  });
});

describe("DELETE /studio/connections/:id", () => {
  it("removes the connection and its secret", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    const record = await h.connections.get("github");

    const response = await del(h, "/studio/connections/github", admToken);
    expect(response.statusCode).toBe(204);
    expect(await h.connections.get("github")).toBeNull();
    expect(h.connectorSecrets.has(record!.secretRef!)).toBe(false);
  });

  it("refuses a viewer", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    expect((await del(h, "/studio/connections/github", await viewer(h))).statusCode).toBe(403);
  });

  it("404s on a connection that does not exist", async () => {
    const h = await harness();
    expect((await del(h, "/studio/connections/nope", await admin(h))).statusCode).toBe(404);
  });
});

describe("when the store is not wired", () => {
  it("refuses by name (503) rather than answering an empty list", async () => {
    // A deployment that injects no connection store: the route refuses.
    const opts: HarnessOptions = { deps: { connections: undefined, connectorSecrets: undefined } };
    const h = await harness(opts);
    const admToken = await admin(h);
    const response = await get(h, "/studio/connections", admToken);
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toBe("capability_not_wired");
  });
});
