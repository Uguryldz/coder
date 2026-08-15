import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The listening-rules surface: which tickets Maestro picks up and how it runs
 * them (status/issuetype → flow type), made admin-editable.
 *
 * The behaviours under test are the ones a rule editor must get right: writes
 * are admin-only, reads are admin + tech-lead, the closed domains
 * (matchKind/flowType) are enforced as 400s not 500s, a duplicate trigger is a
 * clean rejection, and every write is audited.
 */

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

const RULE = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Hata",
  flowType: "duzeltme",
  priority: 100,
  enabled: true,
} as const;

describe("POST /studio/listening-rules", () => {
  it("creates a rule and assigns it an id", async () => {
    const h = await harness();
    const token = await admin(h);

    const res = await post(h, "/studio/listening-rules", token, RULE);
    expect(res.statusCode).toBe(201);
    const { rule } = res.json() as { rule: { ruleId: string; flowType: string } };
    expect(rule.ruleId).toMatch(/^lr_/);
    expect(rule.flowType).toBe("duzeltme");

    // It really landed in the store.
    const stored = await h.listening.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.matchValue).toBe("Hata");
  });

  it("rejects an unknown flowType as a 400 (closed domain), never a 500", async () => {
    const h = await harness();
    const token = await admin(h);
    const res = await post(h, "/studio/listening-rules", token, { ...RULE, flowType: "silme" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown matchKind as a 400", async () => {
    const h = await harness();
    const token = await admin(h);
    const res = await post(h, "/studio/listening-rules", token, { ...RULE, matchKind: "component" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a duplicate trigger with a 400 (unique index → clean rejection)", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await post(h, "/studio/listening-rules", token, RULE)).statusCode).toBe(201);
    // Same (project, assignee, matchKind, matchValue) — a second rule for one trigger.
    const dup = await post(h, "/studio/listening-rules", token, { ...RULE, flowType: "analiz" });
    expect(dup.statusCode).toBe(400);
    expect(await h.listening.list()).toHaveLength(1);
  });

  it("is admin-only — a tech-lead cannot create a rule", async () => {
    const h = await harness();
    const token = await techLead(h);
    const res = await post(h, "/studio/listening-rules", token, RULE);
    expect(res.statusCode).toBe(403);
  });

  it("records an audit row on create", async () => {
    const h = await harness();
    const token = await admin(h);
    await post(h, "/studio/listening-rules", token, RULE);
    const events = await h.auditStore.read();
    expect(events.some((e) => e.subject.startsWith("listening-rule:"))).toBe(true);
  });
});

describe("GET /studio/listening-rules", () => {
  it("lists rules for admin and tech-lead", async () => {
    const h = await harness({
      listeningRules: [{ ruleId: "lr_seed", ...RULE }],
    });
    for (const token of [await admin(h), await techLead(h)]) {
      const res = await get(h, "/studio/listening-rules", token);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { rules: unknown[] }).rules).toHaveLength(1);
    }
  });

  it("refuses a viewer", async () => {
    const h = await harness();
    const token = await viewer(h);
    expect((await get(h, "/studio/listening-rules", token)).statusCode).toBe(403);
  });
});

describe("PUT/DELETE /studio/listening-rules/:ruleId", () => {
  it("replaces a rule", async () => {
    const h = await harness({ listeningRules: [{ ruleId: "lr_seed", ...RULE }] });
    const token = await admin(h);
    const res = await put(h, "/studio/listening-rules/lr_seed", token, {
      ...RULE,
      matchValue: "Hikaye",
      flowType: "gelistirme",
    });
    expect(res.statusCode).toBe(200);
    const stored = await h.listening.get("lr_seed");
    expect(stored?.flowType).toBe("gelistirme");
    expect(stored?.matchValue).toBe("Hikaye");
  });

  it("404s a PUT to an unknown rule", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await put(h, "/studio/listening-rules/lr_missing", token, RULE)).statusCode).toBe(404);
  });

  it("deletes a rule", async () => {
    const h = await harness({ listeningRules: [{ ruleId: "lr_seed", ...RULE }] });
    const token = await admin(h);
    expect((await del(h, "/studio/listening-rules/lr_seed", token)).statusCode).toBe(204);
    expect(await h.listening.list()).toHaveLength(0);
  });

  it("404s a DELETE of an unknown rule", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await del(h, "/studio/listening-rules/lr_missing", token)).statusCode).toBe(404);
  });
});

describe("listening surface unwired", () => {
  it("refuses by name (503) when no ListeningStore is wired", async () => {
    const h = await harness({ deps: { listening: undefined } });
    const token = await admin(h);
    const res = await get(h, "/studio/listening-rules", token);
    expect(res.statusCode).toBe(503);
  });
});
