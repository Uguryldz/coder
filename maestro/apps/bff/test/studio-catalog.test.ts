import { describe, expect, it } from "vitest";
import { CONFIDENTIAL_GROUP } from "../src/knowledge-policy.js";
import { auth } from "./helpers.js";
import {
  AT,
  CALL,
  PUBLIC_DOC,
  SCAN,
  SECRET_DOC,
  TICKET,
  adminToken,
  memberToken,
  outsiderToken,
  studioHarness,
} from "./studio-fixtures.js";

describe("GET /studio/apps", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/studio/apps" })).statusCode).toBe(401);
  });

  it("returns the registry to any session", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/apps", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { appId: string; adoRepo: string; platform: string }[] };
    expect(body.items[0]).toMatchObject({ appId: "ugurpay", adoRepo: "ugurpay", platform: "linux-node" });
  });

  it("404s an application that is not registered", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/yok-boyle-bir-uygulama",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects an app id the contract would not accept", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/NOT_AN_APP_ID",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/apps/:appId/repo-card", () => {
  it("returns the stored card", async () => {
    const h = await studioHarness();
    h.read.apps.putRepoCard({
      appId: "ugurpay",
      modules: [{ name: "limit", path: "src/limit", summary: "Kredi limiti hesaplama" }],
      generatedFromSha: "abc1234",
      version: 2,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/ugurpay/repo-card",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { modules: { name: string }[]; version: number };
    expect(body.version).toBe(2);
    expect(body.modules[0]?.name).toBe("limit");
  });

  /**
   * M100: an application onboarded this morning has no card. Inventing an empty
   * one would let an analysis claim it checked a repository it never read.
   */
  it("404s rather than inventing an empty card", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/apps/ugurpay/repo-card",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "no_repo_card" });
  });
});

/**
 * M18/M63. The classification boundary is the reason this endpoint exists at
 * all rather than Studio querying an index directly.
 */
describe("GET /studio/knowledge", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/studio/knowledge?q=analiz" })).statusCode).toBe(401);
  });

  it("requires a query rather than dumping the index", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns the documents a plain session may read", async () => {
    const h = await studioHarness();
    h.read.knowledge.put(PUBLIC_DOC);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: { id: string; source: string }[]; withheld: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.source).toBe("rules/analiz-sablonu.md");
    expect(body.withheld).toBe(0);
  });

  it("withholds a gizli document from a session without the clearance", async () => {
    const h = await studioHarness();
    h.read.knowledge.put(PUBLIC_DOC);
    h.read.knowledge.put(SECRET_DOC);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: { id: string }[]; withheld: number };
    expect(body.items.map((doc) => doc.id)).toEqual(["kb-1"]);
    // Counted rather than silently dropped: a short list teaches a user the
    // knowledge base lacks something it has.
    expect(body.withheld).toBe(1);
  });

  it("shows a gizli document to a cleared session", async () => {
    const h = await studioHarness();
    h.read.knowledge.put(SECRET_DOC);
    await h.addUser({ username: "yetkili", groups: [CONFIDENTIAL_GROUP] });
    const token = await h.login("yetkili");

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: { id: string }[]; withheld: number };
    expect(body.items.map((doc) => doc.id)).toEqual(["kb-2"]);
    expect(body.withheld).toBe(0);
  });

  /**
   * The rule the packet brief names explicitly: an unlabelled document is
   * `gizli`. A store that forgot to set the field must not become a leak.
   */
  it("treats an unlabelled document as gizli", async () => {
    const h = await studioHarness();
    h.read.knowledge.put({ ...PUBLIC_DOC, id: "kb-3", dataClass: undefined as never });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/knowledge?q=analiz",
      headers: auth(token),
    });

    const body = response.json() as { items: unknown[]; withheld: number };
    expect(body.items).toHaveLength(0);
    expect(body.withheld).toBe(1);
  });
});

describe("GET /studio/scans", () => {
  it("does not show a stranger the findings of a project they cannot see", async () => {
    const h = await studioHarness();
    h.read.scans.put(SCAN);
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/scans", headers: auth(token) });

    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("returns the finding with its file and rule to a project member", async () => {
    const h = await studioHarness();
    h.read.scans.put(SCAN);
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/scans", headers: auth(token) });

    const body = response.json() as {
      items: { ticketKey: string; outcome: string; finding: { ruleId: string; file: string; severity: string } }[];
    };
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.outcome).toBe("fail");
    expect(body.items[0]?.finding).toMatchObject({ ruleId: "sql-concat", file: "src/export.ts", severity: "medium" });
  });
});

describe("GET /studio/cost", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/cost", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns the gateway call log to an admin", async () => {
    const h = await studioHarness();
    h.read.cost.put(CALL);
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/cost", headers: auth(token) });

    const body = response.json() as { items: { model: string; driver: string; usd: number }[] };
    expect(body.items[0]).toMatchObject({ model: "claude-opus-5", driver: "anthropic-direct", usd: 0.42 });
  });
});

describe("GET /studio/users/:username", () => {
  it("refuses a caller who is not an admin", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/users/uye.kisi",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns roles and groups but never password material", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "ayse.kaya", roles: ["tech-lead"], groups: ["tech-leads"] });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/users/ayse.kaya",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ username: "ayse.kaya", roles: ["tech-lead"], groups: ["tech-leads"], active: true });
    expect(Object.keys(body)).not.toContain("passwordHash");
  });

  it("404s an unknown account", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/users/kimse.yok",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });
});
