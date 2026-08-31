import { describe, expect, it } from "vitest";
import { JiraArgumentError, JiraDcConfig, JiraDcWorkPort, JiraResponseError } from "../src/index.js";
import { stubFetch, type FetchStub } from "./helpers.js";

/**
 * JQL search on Jira Data Center — the door a ticket comes through when no
 * webhook can be registered.
 *
 * These tests exist because the ABSENCE of this method was, on a closed-network
 * bank install, a total outage that reported itself as a healthy system. With
 * no webhook, no sweep, and a comment poller that only looks at tickets which
 * already have a run, nothing could enter the platform at all — panel up,
 * connection green, rules correct, zero runs, and no error anywhere.
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
    webhookSecret: () => "secret",
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
  });
}

/** A DC search body: classic `startAt`/`total` paging, which DC never left. */
function page(issues: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { startAt: 0, maxResults: 50, total: issues.length, issues, ...extra };
}

describe("JiraDcWorkPort.searchIssues", () => {
  it("asks REST v2's search endpoint with the JQL, the cap and the fields", async () => {
    const stub = stubFetch([{ body: page([{ key: "OPS-1" }, { key: "OPS-2" }]) }]);

    const result = await port(stub).searchIssues({
      jql: 'project = "OPS" AND assignee in (bot)',
      maxResults: 20,
      fields: ["key"],
    });

    const url = new URL(stub.calls[0]!.url);
    // The v2 path, not Cloud's v3 `/search/jql`: DC never had that endpoint.
    expect(url.pathname).toBe("/rest/api/2/search");
    expect(url.searchParams.get("jql")).toBe('project = "OPS" AND assignee in (bot)');
    expect(url.searchParams.get("maxResults")).toBe("20");
    expect(url.searchParams.get("fields")).toBe("key");
    expect(stub.calls[0]!.method).toBe("GET");
    expect(result.issues).toHaveLength(2);
  });

  /**
   * `isLast` is DERIVED here because DC does not send it. A caller should not
   * have to know which Jira product it is talking to in order to ask whether
   * there is another page.
   */
  it("derives isLast from startAt, page size and total", async () => {
    const stub = stubFetch([
      { body: page([{ key: "OPS-1" }], { startAt: 0, total: 5 }) },
      { body: page([{ key: "OPS-5" }], { startAt: 4, total: 5 }) },
    ]);
    const driver = port(stub);

    const first = await driver.searchIssues({ jql: "project = OPS", startAt: 0 });
    expect(first.isLast).toBe(false);
    expect(first.total).toBe(5);

    const last = await driver.searchIssues({ jql: "project = OPS", startAt: 4 });
    expect(last.isLast).toBe(true);
  });

  /**
   * UNBOUNDED JQL IS REFUSED BEFORE IT LEAVES THE PROCESS.
   *
   * DC's endpoint — unlike Cloud's — would happily ACCEPT a query with no
   * restriction and answer with every issue the service account can see. That
   * account is routinely a Jira ADMIN in a bank, so the blast radius of one
   * unbounded sweep is every project in the company, each matching ticket then
   * being handed to `runIntake`. The refusal is ours, not the server's.
   */
  it.each([
    ["an empty query", ""],
    ["whitespace only", "   "],
    ["a bare ORDER BY, which restricts nothing", "ORDER BY created DESC"],
  ])("refuses %s rather than sweeping every project", async (_label, jql) => {
    // No queued response: a request would fail the stub loudly, which is the
    // point — the refusal must happen before any call is made.
    const stub = stubFetch([]);

    await expect(port(stub).searchIssues({ jql })).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  /**
   * A response with no `issues` array raises instead of reading as "no
   * tickets". Silently returning an empty list is indistinguishable from a
   * healthy sweep that found nothing — the exact ambiguity that let the
   * original outage hide.
   */
  it("raises on a response that carries no issues array", async () => {
    const stub = stubFetch([{ body: { startAt: 0, total: 0 } }]);

    await expect(port(stub).searchIssues({ jql: "project = OPS" })).rejects.toBeInstanceOf(
      JiraResponseError,
    );
  });

  /**
   * A proxied or plugin-filtered DC has been seen to drop the counters. They
   * only answer "is there another page", so their absence degrades to "this is
   * the last page" rather than throwing away issues the caller came for.
   */
  it("still returns the issues when startAt and total are missing", async () => {
    const stub = stubFetch([{ body: { issues: [{ key: "OPS-9" }] } }]);

    const result = await port(stub).searchIssues({ jql: "project = OPS" });

    expect(result.issues).toHaveLength(1);
    expect(result.isLast).toBe(true);
  });
});
