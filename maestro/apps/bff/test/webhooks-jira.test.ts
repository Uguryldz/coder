import { describe, expect, it } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/server.js";
import { FakeWorkPort, WEBHOOK_SECRET } from "./fakes.js";
import { auth, harness, UGURPAY_BINDING } from "./helpers.js";
import { commentEvent, issueEvent, signed } from "./payloads.js";

describe("POST /webhooks/jira", () => {
  it("refuses a delivery with no signature (M15 fail-closed)", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(issueEvent({ ticket: "UGURPAY-1" })),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "webhook_unauthenticated" });
    expect(h.runs.started).toHaveLength(0);
  });

  it("refuses a delivery whose signature belongs to another secret", async () => {
    const h = await harness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-1" }), "someone-elses-secret");
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(401);
    expect(h.runs.started).toHaveLength(0);
  });

  it("refuses a body that was re-serialised after signing", async () => {
    const h = await harness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-1" }));

    // Same JSON value, different bytes: key order and spacing changed. This is
    // exactly what a framework that parses before verifying would hand on, and
    // it must not verify.
    const reserialized = JSON.stringify(JSON.parse(delivery.payload), null, 2);
    expect(reserialized).not.toBe(delivery.payload);

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: reserialized,
    });

    expect(response.statusCode).toBe(401);
    expect(h.runs.started).toHaveLength(0);
  });

  it("answers 401, not 400, when an unsigned body is also malformed", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });

    expect(response.statusCode).toBe(401);
  });

  it("starts a run for a signed issue event on a bound project", async () => {
    const h = await harness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-42" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, started: true });
    expect(h.runs.started).toHaveLength(1);
    expect(h.runs.started[0]).toMatchObject({ ticket: "UGURPAY-42", appId: "ugurpay" });

    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("RUN_STARTED");
  });

  it("does not start a second run when the same ticket is delivered twice", async () => {
    const h = await harness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-42" }));
    const send = () =>
      h.app.inject({
        method: "POST",
        url: "/webhooks/jira",
        headers: delivery.headers,
        payload: delivery.payload,
      });

    await send();
    const second = await send();

    expect(second.json()).toMatchObject({ accepted: true, started: false });
    const events = await h.auditStore.read();
    expect(events.filter((event) => event.action === "RUN_STARTED")).toHaveLength(1);
  });

  it("drops a project that was never bound, silently but counted (M102)", async () => {
    const h = await harness({ bindings: [] });
    const delivery = signed(issueEvent({ ticket: "UGURWEB-9" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "unbound" });
    expect(h.app.maestro.counters.droppedUnbound).toBe(1);
    expect(h.work.comments).toHaveLength(0);
  });

  it("ignores an unlabelled ticket in an opt-in project (M48a)", async () => {
    const h = await harness({
      bindings: [{ ...UGURPAY_BINDING, triggerMode: "opt_in" }],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-7" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "not_opted_in" });
    expect(h.runs.started).toHaveLength(0);
  });

  it("takes a labelled ticket in an opt-in project", async () => {
    const h = await harness({
      bindings: [{ ...UGURPAY_BINDING, triggerMode: "opt_in" }],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-7", labels: ["maestro"] }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toMatchObject({ accepted: true });
  });

  it("sends a ticket with no application to the assignment queue (M99 tier 3)", async () => {
    const h = await harness({ bindings: [{ ...UGURPAY_BINDING, appId: null }] });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-8" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "no_application" });
    expect(h.runs.started).toHaveLength(0);
    expect(h.work.lastComment("UGURPAY-8")).toContain("UGURPAY-8");
  });

  it("counts but cannot explain an invalid command when the driver offers no diagnosis", async () => {
    const work = new FakeWorkPort();
    // A WorkPort that implements only the frozen interface: no
    // `parseCommandDetailed`, so the BFF has nothing to say back.
    Object.defineProperty(work, "parseCommandDetailed", { value: undefined });
    const h = await harness({ deps: { work } });

    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-3", author: "mert.demir", body: "/onayla" }),
    );
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(h.app.maestro.diagnostics).toBeNull();
    expect(response.json()).toEqual({ accepted: false, reason: "not_intake" });
    expect(work.comments).toHaveLength(0);
  });

  it("ignores a comment that is not a command", async () => {
    const h = await harness();
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-3", author: "mert.demir", body: "bir bakayım" }),
    );

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "not_intake" });
    expect(h.work.comments).toHaveLength(0);
  });
});

/**
 * The body limit is a deliberate number, not whatever the framework happens to
 * default to. Jira tickets carry long Turkish descriptions and pasted logs, and
 * a real delivery that silently exceeds an accidental 1 MB would look like an
 * outage nobody configured.
 */
describe("request body limit", () => {
  /** A signed delivery whose comment body is `size` bytes of filler. */
  function bulkyDelivery(size: number) {
    return signed(
      commentEvent({ ticket: "UGURPAY-4", author: "mert.demir", body: "a".repeat(size) }),
    );
  }

  it("accepts a delivery larger than Fastify's 1 MB default", async () => {
    const h = await harness();
    const delivery = bulkyDelivery(2 * 1024 * 1024);

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
  });

  it("refuses a delivery past the configured limit, and does not 500", async () => {
    const h = await harness();
    const delivery = bulkyDelivery(BODY_LIMIT_BYTES + 1024);

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(413);
  });

  it("applies the same limit to the REST surface", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "PUT",
      url: "/params/reminder.channel",
      headers: { ...auth(token), "content-type": "application/json" },
      payload: JSON.stringify({ value: "a".repeat(BODY_LIMIT_BYTES + 1024) }),
    });

    expect(response.statusCode).toBe(413);
  });

  it("is an explicit number rather than an inherited default", () => {
    expect(BODY_LIMIT_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe("silent webhook outcomes leave a server-side trace (denetim B5)", () => {
  /** A harness whose fastify logger writes into an assertable buffer. */
  async function loggedHarness(options: Parameters<typeof harness>[0] = {}) {
    const raw: string[] = [];
    const h = await harness({
      ...options,
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
    const lines = (msg: string): Array<Record<string, unknown>> =>
      raw
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((entry) => entry["msg"] === msg);
    return { h, lines };
  }

  it("a signature rejection answers a bare 401 but WARNS with the verifier's reason", async () => {
    const { h, lines } = await loggedHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(issueEvent({ ticket: "UGURPAY-1" })),
    });

    // The response stays deliberately bare — an attacker learns nothing new.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "webhook_unauthenticated" });

    // The operator's side now says WHY. Before this line a wrong webhook
    // secret looked exactly like "Jira never delivers": zero log output while
    // every delivery bounced.
    const warns = lines("webhook signature rejected");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ webhook: "jira" });
    expect(String(warns[0]?.["reason"] ?? "")).not.toBe("");
    // The verifier's reason names the failure, never the shared secret.
    expect(JSON.stringify(warns)).not.toContain(WEBHOOK_SECRET);
  });

  it("an unbound-project drop still answers 202 (M102) but WARNS with ticket and reason", async () => {
    const { h, lines } = await loggedHarness({ bindings: [] });
    const delivery = signed(issueEvent({ ticket: "UGURWEB-9" }));
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    // Jira's side is unchanged: a 202 that leaks nothing about being watched.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: false, reason: "unbound" });

    // The in-memory counter dies with the process; the log line survives it.
    const warns = lines("webhook intake dropped");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ ticket: "UGURWEB-9", reason: "unbound" });
  });

  /**
   * The distinction the operator actually needs.
   *
   * Only REFUSALS were logged, so a working webhook and a webhook that never
   * arrived produced identical evidence: nothing. Those two send an operator to
   * two different places — a firewall rule versus a gate that was already
   * closed — and they had no way to tell which they were in.
   */
  it("a VERIFIED delivery is logged, so 'never arrived' and 'arrived and handled' differ", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-42" }));
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    const verified = lines("webhook delivery verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      webhook: "jira",
      event: "jira:issue_created",
      ticket: "UGURPAY-42",
    });

    // And the outcome, so a taken intake is as visible as a dropped one.
    expect(lines("webhook intake handled")[0]).toMatchObject({
      ticket: "UGURPAY-42",
      accepted: true,
    });
  });

  /**
   * The verified line is written AFTER verification, never before.
   *
   * An unverified delivery is an unauthenticated stranger: letting it write a
   * `webhookEvent` name of its choosing into the operator's log would make the
   * log itself an injection surface.
   */
  it("does not log a delivery that failed verification as verified", async () => {
    const { h, lines } = await loggedHarness();
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(issueEvent({ ticket: "UGURPAY-1" })),
    });

    expect(lines("webhook delivery verified")).toHaveLength(0);
    expect(lines("webhook signature rejected")).toHaveLength(1);
  });

  /**
   * The SECURITY refusal that used to be perfectly silent.
   *
   * An edited comment carries no command (K-2/M32/M51): in Jira DC "Edit All
   * Comments" is a routine project-lead permission, so honouring one would let
   * its holder approve a gate AS SOMEONE ELSE. The parser answers "no command"
   * — which meant the approver saw their `/approve` ignored with nothing
   * anywhere naming the rule that ignored it.
   */
  it("WARNS by name when an edited comment is refused (SoD protection)", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(
      commentEvent({
        ticket: "UGURPAY-42",
        author: "mert.demir",
        body: "/approve",
        created: "2026-08-09T09:05:00.000+0300",
        updated: "2026-08-09T09:07:00.000+0300",
      }),
    );
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    const warns = lines(
      "webhook comment refused: an edited comment carries no command (SoD protection)",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      webhook: "jira",
      ticket: "UGURPAY-42",
      reason: "edited_comment",
    });
    // And no command was honoured.
    expect(lines("webhook command handled")).toHaveLength(0);
  });

  /**
   * A command that WAS honoured — including the legitimate non-acceptance.
   *
   * `no_open_gate` is not an operator error; it is the gate already being
   * closed, or the poller having answered the same comment a moment earlier.
   * Until it was logged it looked exactly like a delivery that never arrived.
   */
  it("logs a handled command with its verdict, and the reason when refused", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-42", author: "mert.demir", body: "/approve" }),
    );
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    const handled = lines("webhook command handled");
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      webhook: "jira",
      ticket: "UGURPAY-42",
      command: "approve",
      author: "mert.demir",
    });
    // The verdict is there whichever way it went — that IS the diagnostic.
    expect(handled[0]).toHaveProperty("accepted");
  });

  /**
   * An author that is an e-mail address is masked.
   *
   * A Data Center identity falls back to `emailAddress` when the user carries
   * neither `name` nor `key` (`adapter-jira/src/mapping.ts` → `userIdOf`), and
   * an e-mail address in a bank's log aggregator is personal data the platform
   * masks everywhere else (`packages/pii`).
   */
  it("masks an author that is an e-mail address", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-42", author: "mert.demir@banka.com.tr", body: "/approve" }),
    );
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    const handled = lines("webhook command handled");
    expect(handled).toHaveLength(1);
    expect(handled[0]?.["author"]).toBe("m*********@banka.com.tr");
    expect(JSON.stringify(handled)).not.toContain("mert.demir@banka.com.tr");
  });

  /**
   * The property that makes every line above safe to ask an operator for.
   *
   * These lines are what a bank pastes into a ticket when listening does not
   * work. Not one of them may carry the webhook secret, and none may carry the
   * comment BODY — a Jira comment in a bank routinely names a person, an
   * account or an amount.
   */
  it("leaks neither the webhook secret nor the comment body into ANY line", async () => {
    const { h, lines: _lines } = await loggedHarness();
    const captured: string[] = [];
    // Re-drive with the raw buffer so every line is inspected, not just the
    // ones a message filter selected.
    const raw: string[] = [];
    const logged = await harness({
      fastify: {
        logger: { level: "warn", stream: { write: (line: string) => void raw.push(line) } },
      },
    });
    const secretBody = "/reject IBAN TR33 0006 1005 1978 6457 8413 26 yanlış";
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-42", author: "mert.demir", body: secretBody }),
    );
    await logged.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });
    captured.push(...raw);

    const all = captured.join("\n");
    expect(all).not.toContain(WEBHOOK_SECRET);
    expect(all).not.toContain("TR33 0006 1005 1978 6457 8413 26");
    expect(all).not.toContain("x-hub-signature");
    // The ticket key and the command name are business data and DO appear —
    // otherwise the line would be useless to the operator it is written for.
    expect(all).toContain("UGURPAY-42");
    void h;
  });
});
