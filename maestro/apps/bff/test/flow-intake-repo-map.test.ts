import { describe, expect, it } from "vitest";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { harness } from "./helpers.js";
import { issueEvent, signed } from "./payloads.js";

/**
 * The repo map decides the APPLICATION per ticket: the matched rule's Jira
 * field value selects a row; no row (or no map) keeps the project binding's
 * app, exactly as before.
 */
function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_map",
    projectKey: "UGURPAY",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    repoMap: {
      field: "customfield_10234",
      fieldName: "İş Ailesi",
      entries: [
        { value: "Krediler", appId: "bank/kredi", targetBranch: "develop" },
        { value: "Kartlar", appId: "bank/kart" },
      ],
    },
    ...over,
  };
}

async function deliver(h: Awaited<ReturnType<typeof harness>>, ticket: string): Promise<{ appId?: string } | undefined> {
  const before = h.runs.started.length;
  const delivery = signed(issueEvent({ ticket, issueType: "Hata" }));
  const response = await h.app.inject({ method: "POST", url: "/webhooks/jira", headers: delivery.headers, payload: delivery.payload });
  expect(response.statusCode).toBe(202);
  return h.runs.started[before] as { appId?: string } | undefined;
}

describe("intake — repo map picks the application", () => {
  it("routes the ticket to the app its field value maps to (case/whitespace tolerant)", async () => {
    const h = await harness({ listeningRules: [rule()] });
    h.work.putFields("UGURPAY-1", { customfield_10234: " krediler " });
    const started = await deliver(h, "UGURPAY-1");
    expect(started?.appId).toBe("bank/kredi");
    expect(h.work.fieldReads).toEqual([{ ticket: "UGURPAY-1", fieldIds: ["customfield_10234"] }]);
  });

  it("keeps the project binding's app when the value matches no row", async () => {
    const h = await harness({ listeningRules: [rule()] });
    h.work.putFields("UGURPAY-2", { customfield_10234: "Sigorta" });
    expect((await deliver(h, "UGURPAY-2"))?.appId).toBe("ugurpay");
  });

  it("keeps the project binding's app when the rule has no map, and reads no field", async () => {
    const h = await harness({ listeningRules: [rule({ repoMap: null })] });
    expect((await deliver(h, "UGURPAY-3"))?.appId).toBe("ugurpay");
    expect(h.work.fieldReads).toEqual([]);
  });
});
