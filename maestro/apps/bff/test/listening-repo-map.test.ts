import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}
function post(h: Harness, url: string, token: string, payload?: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "POST", url, headers: auth(token), ...(payload ? { payload } : {}) });
}

/**
 * Depo eşlemesi (repo map) on a listening rule: a Jira field's value → the
 * application the run goes to. Stored with the rule, round-trips through the
 * API, and is refused when it has no rows.
 */
const BASE = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Görev",
  flowType: "gelistirme",
};
const MAP = {
  field: "customfield_10234",
  fieldName: "İş Ailesi",
  entries: [
    { value: "Krediler", appId: "bank/kredi", targetBranch: "develop" },
    { value: "Kartlar", appId: "bank/kart" },
  ],
};

describe("listening rule repo map", () => {
  it("stores the map with the rule and reads it back", async () => {
    const h = await harness();
    const token = await admin(h);
    const created = await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: MAP });
    expect(created.statusCode).toBe(201);
    const list = await h.app.inject({ method: "GET", url: "/studio/listening-rules", headers: auth(token) });
    const rules = list.json<{ rules: { repoMap?: unknown }[] }>().rules;
    expect(rules[0]?.repoMap).toEqual(MAP);
  });

  it("a rule without a map stores null — today's behaviour", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await post(h, "/studio/listening-rules", token, BASE)).statusCode).toBe(201);
    const list = await h.app.inject({ method: "GET", url: "/studio/listening-rules", headers: auth(token) });
    expect(list.json<{ rules: { repoMap?: unknown }[] }>().rules[0]?.repoMap ?? null).toBeNull();
  });

  it("refuses a map with no rows or an empty value", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: { ...MAP, entries: [] } })).statusCode).toBe(400);
    expect(
      (await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: { ...MAP, entries: [{ value: " ", appId: "x" }] } })).statusCode,
    ).toBe(400);
  });
});
