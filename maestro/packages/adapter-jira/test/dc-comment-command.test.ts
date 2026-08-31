import { describe, expect, it } from "vitest";
import {
  JiraArgumentError,
  JiraDcConfig,
  JiraDcWorkPort,
  JiraResponseError,
  parseDcCommandFromComment,
} from "../src/index.js";
import { fixture, stubFetch, type FetchStub } from "./helpers.js";

/**
 * Reading `/approve` off a Data Center ticket WITHOUT a webhook.
 *
 * The signed webhook stays this driver's primary command path. It is not the
 * only one that has to work: a Data Center behind a corporate firewall
 * frequently has no outbound route to Maestro, and then the documented way to
 * pass a gate — writing `/approve` on the ticket — reaches nothing. The gate
 * waits forever and nobody can say why.
 */

const config = JiraDcConfig.parse({
  baseUrl: "https://jira.internal.bank",
  tokenRef: "kv/jira/pat",
  webhookSecretRef: "kv/jira/webhook",
});

function port(stub: FetchStub): JiraDcWorkPort {
  return new JiraDcWorkPort({
    config,
    token: () => "pat-123",
    webhookSecret: () => "webhook-shared-secret",
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
  });
}

function comments(): unknown[] {
  return (fixture("comments-list") as { comments: unknown[] }).comments;
}

/** One recorded v2 comment, optionally overridden field by field. */
function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(comments()[1] as Record<string, unknown>), ...overrides };
}

describe("JiraDcWorkPort.listComments", () => {
  it("reads a thread off REST v2 and returns the comments untouched", async () => {
    const stub = stubFetch([{ body: fixture("comments-list") }]);
    const list = await port(stub).listComments("UGURPAY-501");

    expect(stub.calls[0]!.method).toBe("GET");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/comment");
    expect(list).toHaveLength(3);
    expect((list[1] as { id: string }).id).toBe("45201");
  });

  it("refuses a malformed issue key before touching the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).listComments("not-a-key")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  /**
   * The failure this method exists to end is "the gate waits and nobody knows
   * why" — so an unreadable response must NOT look like "nobody has approved
   * yet". A named error, never a silent empty list.
   */
  it("raises a named error on a response that carries no comments array", async () => {
    for (const body of [{ startAt: 0, total: 0 }, { comments: "nope" }, [], "not json at all"]) {
      const stub = stubFetch([{ body }]);
      await expect(port(stub).listComments("UGURPAY-501")).rejects.toBeInstanceOf(JiraResponseError);
    }
  });
});

describe("parseDcCommandFromComment", () => {
  it("turns a plain wiki-markup /approve into a command envelope", () => {
    const result = parseDcCommandFromComment("UGURPAY-501", comment());

    expect(result.invalid).toBeNull();
    expect(result.envelope).toEqual({
      ticketKey: "UGURPAY-501",
      // DC identity, NOT accountId: the Cloud parser reads `accountId` only and
      // threw "no identifiable author" on every real Data Center thread.
      author: "mert.demir",
      at: "2026-08-08T13:12:33.000+03:00",
      command: { name: "approve" },
    });
  });

  it("reads the DC identity even when the account has no e-mail address", () => {
    const noEmail = comment({ author: { name: "ayse.kaya", key: "JIRAUSER10444", displayName: "Ayşe Kaya" } });
    expect(parseDcCommandFromComment("UGURPAY-501", noEmail).envelope?.author).toBe("ayse.kaya");
  });

  it("is silent on a comment that is not a command", () => {
    expect(parseDcCommandFromComment("UGURPAY-501", comments()[0])).toEqual({ envelope: null, invalid: null });
  });

  it("keeps a malformed command as invalid instead of swallowing it", () => {
    // Turkish negation trails the verb: "/approve etmiyorum" is a REFUSAL.
    const result = parseDcCommandFromComment("UGURPAY-501", comment({ body: "/approve etmiyorum" }));
    expect(result.envelope).toBeNull();
    expect(result.invalid?.command).toBe("approve");
  });

  it("carries the argument of a command that takes one", () => {
    const result = parseDcCommandFromComment("UGURPAY-501", comment({ body: "/reject kapsam belirsiz" }));
    expect(result.envelope?.command).toEqual({ name: "reject", reason: "kapsam belirsiz" });
  });

  /**
   * K-2, the rule the whole fallback path rests on.
   *
   * In Jira DC "Edit All Comments" is a routine project-lead permission. An
   * edited comment keeps the original `author` while a DIFFERENT `updateAuthor`
   * supplied the text — honouring it would let anyone holding that permission
   * approve a gate AS SOMEONE ELSE and walk straight past the SoD matrix. The
   * webhook path refuses this (`commandFromWebhook`); the poller must not be
   * the way around it.
   */
  it("refuses a command from an EDITED comment — the SoD bypass", () => {
    const edited = comments()[2];
    expect((edited as { body: string }).body).toBe("/approve");
    expect((edited as { author: { name: string } }).author.name).not.toBe(
      (edited as { updateAuthor: { name: string } }).updateAuthor.name,
    );

    expect(parseDcCommandFromComment("UGURPAY-501", edited)).toEqual({ envelope: null, invalid: null });
  });

  /**
   * Polling has no created/updated EVENT to distinguish — the timestamps are
   * the only evidence. A comment that cannot PROVE it was never edited must
   * not open a gate, so a stripped payload is a loud error, not an assumption.
   */
  it("raises rather than assuming unedited when a timestamp is missing", () => {
    const { updated: _updated, ...noUpdated } = comment();
    expect(() => parseDcCommandFromComment("UGURPAY-501", noUpdated)).toThrowError(JiraResponseError);
    expect(() => parseDcCommandFromComment("UGURPAY-501", noUpdated)).toThrowError(/updated/);

    const { created: _created, ...noCreated } = comment();
    expect(() => parseDcCommandFromComment("UGURPAY-501", noCreated)).toThrowError(JiraResponseError);
  });

  it("raises on a command comment with no identifiable author", () => {
    const anonymous = comment({ author: { displayName: "" } });
    expect(() => parseDcCommandFromComment("UGURPAY-501", anonymous)).toThrowError(JiraResponseError);
  });

  /**
   * `renderedBody` is HTML the server produced; the grammar is defined over
   * what the person TYPED. Reading the rendered form would make a linkified or
   * templated "/approve" indistinguishable from a typed one.
   */
  it("ignores renderedBody and a non-string body entirely", () => {
    expect(
      parseDcCommandFromComment("UGURPAY-501", comment({ body: null, renderedBody: "<p>/approve</p>" })),
    ).toEqual({ envelope: null, invalid: null });
  });

  it("refuses payloads it cannot reason about", () => {
    expect(() => parseDcCommandFromComment("not-a-key", comment())).toThrowError(JiraArgumentError);
    expect(() => parseDcCommandFromComment("UGURPAY-501", "nope")).toThrowError(JiraResponseError);
  });

  it("is reachable on the driver itself, the way the poller reaches it", () => {
    const stub = stubFetch([]);
    expect(port(stub).parseCommandFromComment("UGURPAY-501", comment()).envelope?.command).toEqual({
      name: "approve",
    });
  });
});
