import { TicketSnapshot } from "@maestro/contracts";
import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  doc,
  heading,
  JiraArgumentError,
  JiraDcConfig,
  JiraDcWorkPort,
  JiraLinkFailedError,
  JiraResponseError,
  paragraph,
  signWebhookBody,
} from "../src/index.js";
import { fixture, stubFetch, type FetchStub } from "./helpers.js";

const SECRET = "webhook-shared-secret";

const config = JiraDcConfig.parse({
  baseUrl: "https://jira.internal.bank",
  tokenRef: "kv/jira/pat",
  webhookSecretRef: "kv/jira/webhook",
});

function port(stub: FetchStub): JiraDcWorkPort {
  return new JiraDcWorkPort({
    config,
    token: () => "pat-123",
    webhookSecret: () => SECRET,
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
  });
}

describe("JiraDcWorkPort", () => {
  it("reads a ticket and returns a contract-valid snapshot", async () => {
    const stub = stubFetch([{ body: fixture("issue-get") }]);
    const snapshot = await port(stub).getTicket("UGURPAY-501");

    expect(TicketSnapshot.parse(snapshot).key).toBe("UGURPAY-501");
    expect(stub.calls[0]!.url).toContain("/rest/api/2/issue/UGURPAY-501?fields=");
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it("rejects a malformed issue key before touching the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).getTicket("not-a-key")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("posts a plain string comment as wiki markup", async () => {
    const stub = stubFetch([{ body: fixture("comment-created-response") }]);
    const res = await port(stub).addComment("UGURPAY-501", "durum: analiz hazır");

    expect(res.commentId).toBe("45230");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/comment");
    expect(stub.calls[0]!.body).toEqual({ body: "durum: analiz hazır" });
  });

  it("renders an ADF document for the DC v2 comment API", async () => {
    const stub = stubFetch([{ body: fixture("comment-created-response") }]);
    await port(stub).addComment("UGURPAY-501", doc(heading(2, "Analiz hazır"), paragraph("Kapsam uygun.")));

    expect(stub.calls[0]!.body).toEqual({ body: "h2. Analiz hazır\n\nKapsam uygun." });
  });

  it("edits the progress comment in place (M75)", async () => {
    const stub = stubFetch([{ body: fixture("comment-created-response") }]);
    const res = await port(stub).updateComment("UGURPAY-501", "45230", "▶ Maestro durum: adım 6a");

    expect(res.commentId).toBe("45230");
    expect(stub.calls[0]!.method).toBe("PUT");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/comment/45230");
  });

  it("fails loudly when Jira answers a comment write without an id", async () => {
    const stub = stubFetch([{ body: { self: "https://jira.internal.bank/x" } }]);
    await expect(port(stub).addComment("UGURPAY-501", "x")).rejects.toBeInstanceOf(JiraResponseError);
  });

  it("sets labels with a single Edit Issue call (M102 permission set)", async () => {
    const stub = stubFetch([{ status: 204 }]);
    await port(stub).setLabels("UGURPAY-501", [" maestro ", "risk-orta"]);

    expect(stub.calls[0]!.method).toBe("PUT");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501");
    expect(stub.calls[0]!.body).toEqual({ fields: { labels: ["maestro", "risk-orta"] } });
  });

  it("refuses labels Jira would reject", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).setLabels("UGURPAY-501", ["iki kelime"])).rejects.toThrow(/whitespace/);
    await expect(port(stub).setLabels("UGURPAY-501", [" "])).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("assigns and unassigns via the DC username field", async () => {
    const stub = stubFetch([{ status: 204 }, { status: 204 }]);
    const jira = port(stub);
    await jira.assign("UGURPAY-501", "mert.demir");
    await jira.assign("UGURPAY-501", null);

    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/assignee");
    expect(stub.calls[0]!.body).toEqual({ name: "mert.demir" });
    expect(stub.calls[1]!.body).toEqual({ name: null });
  });

  it("creates a fan-out child and links it to the parent", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("issue-created-response") }, { status: 201, body: {} }]);
    const res = await port(stub).createLinkedIssue("UGURPAY-501", {
      summary: "iOS tarafı",
      description: "child of UGURPAY-501",
      labels: ["maestro"],
    });

    expect(res.key).toBe("UGURPAY-612");
    expect(stub.calls[0]!.body).toEqual({
      fields: {
        project: { key: "UGURPAY" },
        summary: "iOS tarafı",
        description: "child of UGURPAY-501",
        issuetype: { name: "Task" },
        labels: ["maestro"],
      },
    });
    expect(stub.calls[1]!.url).toBe("https://jira.internal.bank/rest/api/2/issueLink");
    expect(stub.calls[1]!.body).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "UGURPAY-612" },
      outwardIssue: { key: "UGURPAY-501" },
    });
  });

  it("surfaces the orphan child key when linking fails", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("issue-created-response") }, { status: 403, body: {} }]);
    const error = await port(stub)
      .createLinkedIssue("UGURPAY-501", { summary: "s", description: "d" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraLinkFailedError);
    expect((error as JiraLinkFailedError).childKey).toBe("UGURPAY-612");
  });

  it("confirms group membership from the member API", async () => {
    const stub = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(stub).verifyMembership("Mert.Demir", "tech-leads")).resolves.toBe(true);

    const url = stub.calls[0]!.url;
    expect(url).toContain("groupname=tech-leads");
    expect(url).toContain("includeInactiveUsers=false");
  });

  it("denies a user who is not in the group", async () => {
    const stub = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(stub).verifyMembership("ayse.kaya", "tech-leads")).resolves.toBe(false);
  });

  it("matches on the stable user key and e-mail as well", async () => {
    const byKey = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(byKey).verifyMembership("JIRAUSER10344", "tech-leads")).resolves.toBe(true);
    const byMail = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(byMail).verifyMembership("can.ozturk@bank.example", "tech-leads")).resolves.toBe(true);
  });

  it("walks all member pages before denying", async () => {
    const firstPage = {
      maxResults: 2,
      startAt: 0,
      total: 3,
      isLast: false,
      values: [{ name: "a.user", key: "JIRAUSER1" }, { name: "b.user", key: "JIRAUSER2" }],
    };
    const secondPage = { maxResults: 2, startAt: 2, total: 3, isLast: true, values: [{ name: "selin.arslan" }] };
    const stub = stubFetch([{ body: firstPage }, { body: secondPage }]);

    await expect(port(stub).verifyMembership("selin.arslan", "tech-leads")).resolves.toBe(true);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.url).toContain("startAt=2");
  });

  it("verifies webhook signatures with the injected secret", async () => {
    const raw = JSON.stringify(fixture("webhook-comment-created"));
    const jira = port(stubFetch([]));

    await expect(jira.verifyWebhook(raw, signWebhookBody(raw, SECRET))).resolves.toBeUndefined();
    await expect(jira.verifyWebhook(raw, signWebhookBody(raw, "wrong"))).rejects.toThrow(/verification failed/);
  });

  it("parses commands out of verified payloads and never throws on unknown ones", async () => {
    const jira = port(stubFetch([]));
    const envelope = await jira.parseCommand(fixture("webhook-comment-created"));
    expect(envelope).toMatchObject({ ticketKey: "UGURPAY-501", command: { name: "approve" } });

    const payload = fixture("webhook-comment-created") as { comment: { body: string } };
    payload.comment.body = "/deploy-prod hemen";
    await expect(jira.parseCommand(payload)).resolves.toBeNull();
    expect(jira.parseCommandDetailed(payload).invalid).toMatchObject({ messageKey: "command.unknown" });
    await expect(jira.parseCommand(fixture("webhook-issue-created"))).resolves.toBeNull();
  });

  it("does not implement workflow transitions (M102)", async () => {
    await expect(port(stubFetch([])).transition("UGURPAY-501", "31")).rejects.toBeInstanceOf(
      CapabilityNotSupportedError,
    );
  });
});
