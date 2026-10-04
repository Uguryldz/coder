import { describe, expect, it } from "vitest";
import { auth } from "./helpers.js";
import { memberToken, studioHarness } from "./studio-fixtures.js";

/**
 * `GET /variants/default-training/:role` — the shipped agent training per
 * role, for Studio's "Varsayılan eğitimi yükle". The text is the locale
 * catalogue's `agent.training.*`, the same string the seed plants as the
 * default agent's persona.
 */
describe("GET /variants/default-training/:role", () => {
  it("returns the shipped training for the four chain roles", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    for (const [role, marker] of [
      ["analyst", "ANALİZ AJANISIN"],
      ["planner", "PLANCI AJANSIN"],
      ["engineer", "GELİŞTİRİCİ AJANSIN"],
      ["dev_reviewer", "DOĞRULAYICI AJANSIN"],
    ] as const) {
      const response = await h.app.inject({ method: "GET", url: `/variants/default-training/${role}`, headers: auth(token) });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ role: string; persona: string }>();
      expect(body.role).toBe(role);
      expect(body.persona).toContain(marker);
    }
  });

  it("is 404 for a role without a shipped training, and for an unknown role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect((await h.app.inject({ method: "GET", url: "/variants/default-training/intake", headers: auth(token) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/variants/default-training/wizard", headers: auth(token) })).statusCode).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/variants/default-training/planner" })).statusCode).toBe(401);
  });
});
