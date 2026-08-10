import { TicketSnapshot } from "@maestro/contracts";
import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  doc,
  heading,
  JiraArgumentError,
  JiraCloudConfig,
  JiraCloudWorkPort,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraResponseError,
  paragraph,
} from "../../src/index.js";
import { fixture, stubFetch, type FetchStub } from "../helpers.js";

const ACCOUNT_ID = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";

const config = JiraCloudConfig.parse({
  baseUrl: "https://uyildiz.atlassian.net",
  email: "pilot@bank.example",
  apiTokenRef: "kv/jira-cloud/token",
});

function port(stub: FetchStub): JiraCloudWorkPort {
  return new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: stub.fetchImpl });
}

describe("JiraCloudWorkPort", () => {
  it("reads a ticket over REST v3 and returns a contract-valid snapshot", async () => {
    const stub = stubFetch([{ body: fixture("cloud/issue-get") }]);
    const snapshot = await port(stub).getTicket("OPS-6");

    expect(TicketSnapshot.parse(snapshot).key).toBe("OPS-6");
    expect(snapshot.description).toContain("makbuz gönderen");
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6?fields=");
    expect(stub.calls[0]!.headers["authorization"]).toMatch(/^Basic /);
  });

  it("rejects a malformed issue key before touching the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).getTicket("not-a-key")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("posts a plain string comment wrapped in ADF (v3 speaks ADF natively)", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("cloud/comment-created-response") }]);
    const res = await port(stub).addComment("OPS-6", "durum: analiz hazır");

    expect(res.commentId).toBe("10000");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/comment");
    expect(stub.calls[0]!.body).toEqual({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "durum: analiz hazır" }] }] },
    });
  });

  it("posts an ADF document verbatim — no wiki-markup rendering", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("cloud/comment-created-response") }]);
    const document = doc(heading(2, "Analiz hazır"), paragraph("Kapsam uygun."));
    await port(stub).addComment("OPS-6", document);

    expect(stub.calls[0]!.body).toEqual({ body: document });
  });

  it("edits the progress comment in place with an ADF body (M75)", async () => {
    const stub = stubFetch([{ body: fixture("cloud/comment-created-response") }]);
    await port(stub).updateComment("OPS-6", "10000", "▶ Maestro durum: adım 6a");

    expect(stub.calls[0]!.method).toBe("PUT");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/comment/10000");
  });

  it("fails loudly when a comment write answers without an id", async () => {
    const stub = stubFetch([{ status: 201, body: { self: "https://x" } }]);
    await expect(port(stub).addComment("OPS-6", "x")).rejects.toBeInstanceOf(JiraResponseError);
  });

  it("edits labels as a diff — only the add/remove delta goes out", async () => {
    const stub = stubFetch([{ body: { fields: { labels: ["maestro", "eski"] } } }, { status: 204 }]);
    await port(stub).setLabels("OPS-6", ["maestro", "yeni"]);

    expect(stub.calls[0]!.method).toBe("GET");
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6?fields=labels");
    expect(stub.calls[1]!.method).toBe("PUT");
    expect(stub.calls[1]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6");
    expect(stub.calls[1]!.body).toEqual({ update: { labels: [{ add: "yeni" }, { remove: "eski" }] } });
  });

  it("skips the write entirely when the labels already match", async () => {
    const stub = stubFetch([{ body: { fields: { labels: ["maestro"] } } }]);
    await port(stub).setLabels("OPS-6", ["maestro"]);
    expect(stub.calls).toHaveLength(1); // just the read
  });

  it("refuses labels Jira would reject, before any request", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).setLabels("OPS-6", ["iki kelime"])).rejects.toThrow(/whitespace/);
    await expect(port(stub).setLabels("OPS-6", [" "])).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("assigns and unassigns via accountId — Cloud has no usernames", async () => {
    const stub = stubFetch([{ status: 204 }, { status: 204 }]);
    const jira = port(stub);
    await jira.assign("OPS-6", ACCOUNT_ID);
    await jira.assign("OPS-6", null);

    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/assignee");
    expect(stub.calls[0]!.body).toEqual({ accountId: ACCOUNT_ID });
    expect(stub.calls[1]!.body).toEqual({ accountId: null });
  });

  it("creates a fan-out child with an ADF description and links it back", async () => {
    const stub = stubFetch([{ status: 201, body: { id: "10020", key: "OPS-9" } }, { status: 201, body: {} }]);
    const res = await port(stub).createLinkedIssue("OPS-6", {
      summary: "iOS tarafı",
      description: "OPS-6 fan-out çocuğu",
      labels: ["maestro"],
    });

    expect(res.key).toBe("OPS-9");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue");
    expect(stub.calls[0]!.body).toEqual({
      fields: {
        project: { key: "OPS" },
        summary: "iOS tarafı",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "OPS-6 fan-out çocuğu" }] }],
        },
        issuetype: { name: "Task" },
        labels: ["maestro"],
      },
    });
    expect(stub.calls[1]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issueLink");
    expect(stub.calls[1]!.body).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "OPS-9" },
      outwardIssue: { key: "OPS-6" },
    });
  });

  it("keeps the orphan key when linking the child fails", async () => {
    const stub = stubFetch([{ status: 201, body: { id: "10020", key: "OPS-9" } }, { status: 404, body: {} }]);
    const error = await port(stub)
      .createLinkedIssue("OPS-6", { summary: "x", description: "y" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraLinkFailedError);
    expect((error as JiraLinkFailedError).childKey).toBe("OPS-9");
  });

  it("verifies membership by accountId or e-mail, never displayName", async () => {
    const page = {
      isLast: true,
      values: [
        { accountId: "712020:other", emailAddress: "other@bank.example", displayName: "Uğur Yıldız", active: true },
        { accountId: ACCOUNT_ID, displayName: "Approver", active: true },
      ],
    };
    const stub = stubFetch([{ body: page }, { body: page }, { body: page }]);
    const jira = port(stub);

    await expect(jira.verifyMembership(ACCOUNT_ID, "gate-approvers")).resolves.toBe(true);
    await expect(jira.verifyMembership("other@bank.example", "gate-approvers")).resolves.toBe(true);
    await expect(jira.verifyMembership("Uğur Yıldız", "gate-approvers")).resolves.toBe(false);
    expect(stub.calls[0]!.url).toContain("/rest/api/3/group/member?groupname=gate-approvers");
  });

  it("skips inactive members and pages until isLast", async () => {
    const inactive = { accountId: ACCOUNT_ID, active: false };
    const stub = stubFetch([
      { body: { isLast: false, values: [inactive] } },
      { body: { isLast: true, values: [{ accountId: ACCOUNT_ID, active: true }] } },
    ]);

    await expect(port(stub).verifyMembership(ACCOUNT_ID, "gate-approvers")).resolves.toBe(true);
    expect(stub.calls).toHaveLength(2);
    expect(new URL(stub.calls[1]!.url).searchParams.get("startAt")).toBe("1");
  });

  it("raises instead of silently denying on an undecidable member page", async () => {
    const stub = stubFetch([{ body: { values: [{ accountId: "712020:other" }] } }]);
    await expect(port(stub).verifyMembership(ACCOUNT_ID, "gate-approvers")).rejects.toBeInstanceOf(
      JiraMembershipUnresolvedError,
    );
  });

  it("lists an issue's comments from the recorded page shape", async () => {
    const stub = stubFetch([{ body: fixture("cloud/comments-list") }]);
    const comments = await port(stub).listComments("OPS-6");

    expect(comments).toHaveLength(1);
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6/comment");
  });

  it("parses a command from a polled comment through the port", async () => {
    const stub = stubFetch([]);
    const comment = {
      author: { accountId: ACCOUNT_ID },
      body: doc(paragraph("/approve")),
      created: "2026-08-10T15:00:00.000+0300",
      updated: "2026-08-10T15:00:00.000+0300",
    };

    const envelope = await port(stub).parseCommand({ ticketKey: "OPS-6", comment });
    expect(envelope?.command).toEqual({ name: "approve" });
    expect(envelope?.author).toBe(ACCOUNT_ID);
  });

  it("delegates searchIssues with the bounded-JQL guard intact", async () => {
    const stub = stubFetch([{ body: fixture("cloud/search-jql") }]);
    const jira = port(stub);

    await expect(jira.searchIssues({ jql: "order by created" })).rejects.toBeInstanceOf(JiraArgumentError);
    const page = await jira.searchIssues({ jql: "project = OPS" });
    expect(page.issues).toHaveLength(6);
  });

  it("refuses webhook verification — the pilot polls, nothing is verifiable", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).verifyWebhook("{}", {})).rejects.toBeInstanceOf(CapabilityNotSupportedError);
  });

  it("does not support transitions (M102 parity with the DC driver)", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).transition("OPS-6", "31")).rejects.toBeInstanceOf(CapabilityNotSupportedError);
  });
});
