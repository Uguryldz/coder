import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { resolveRepoMapEntry } from "../src/listening-store.js";
import { TEST_APPLICATIONS, auth, harness, testApplication, type Harness } from "./helpers.js";

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

/**
 * Esleme satirlarinin gosterdigi depolar, envanterde KAYITLI.
 *
 * Kural yazma yolu artik her `repoMap.entries[].appId` icin `Application`
 * satirini ariyor (OPS-121) — bu describe eslemenin SAKLANMASINI olcuyor, o
 * yuzden fixture depolarinin kayitli olmasi gerekiyor. Kayitsiz halin kendi
 * describe'i asagida.
 */
const MAPPED_APPS = [
  ...TEST_APPLICATIONS,
  testApplication("bank/kredi", "bank", "kredi"),
  testApplication("bank/kart", "bank", "kart"),
];

describe("listening rule repo map", () => {
  it("stores the map with the rule and reads it back", async () => {
    const h = await harness({ applications: MAPPED_APPS });
    const token = await admin(h);
    const created = await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: MAP });
    expect(created.statusCode).toBe(201);
    const list = await h.app.inject({ method: "GET", url: "/studio/listening-rules", headers: auth(token) });
    const rules = list.json<{ rules: { repoMap?: unknown }[] }>().rules;
    expect(rules[0]?.repoMap).toEqual(MAP);
  });

  it("a rule without a map stores null — today's behaviour", async () => {
    const h = await harness({ applications: MAPPED_APPS });
    const token = await admin(h);
    expect((await post(h, "/studio/listening-rules", token, BASE)).statusCode).toBe(201);
    const list = await h.app.inject({ method: "GET", url: "/studio/listening-rules", headers: auth(token) });
    expect(list.json<{ rules: { repoMap?: unknown }[] }>().rules[0]?.repoMap ?? null).toBeNull();
  });

  it("refuses a map with no rows or an empty value", async () => {
    const h = await harness({ applications: MAPPED_APPS });
    const token = await admin(h);
    expect((await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: { ...MAP, entries: [] } })).statusCode).toBe(400);
    expect(
      (await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: { ...MAP, entries: [{ value: " ", appId: "x" }] } })).statusCode,
    ).toBe(400);
  });
});

/**
 * MULTI-VALUE FIELDS — labels, checkboxes, components.
 *
 * `fieldText` renders a ticket's `["maestro", "app:ekstre"]` as the single
 * string "maestro, app:ekstre", and a mapping row holds ONE value. Comparing
 * the joined text against one row matched nothing, which silently disabled
 * every map built on labels — the field that, on a live instance, already
 * carried the repository names (`app:ekstre-uretim-servisi`).
 *
 * So the ticket's value is read as a LIST: split on commas, and a row matches
 * when it equals any member. A single-valued field is a list of one and keeps
 * behaving exactly as before.
 */
describe("resolveRepoMapEntry with multi-value fields", () => {
  const map = {
    field: "labels",
    fieldName: "Etiketler",
    entries: [
      { value: "app:ekstre-uretim-servisi", appId: "bank/ekstre" },
      { value: "app:kart", appId: "bank/kart" },
    ],
  };

  it("matches one label out of a comma-joined list", () => {
    expect(resolveRepoMapEntry(map, "maestro, app:ekstre-uretim-servisi")?.appId).toBe("bank/ekstre");
    expect(resolveRepoMapEntry(map, "app:kart, maestro-bekliyor")?.appId).toBe("bank/kart");
  });

  it("still matches a single value, with or without stray spaces", () => {
    expect(resolveRepoMapEntry(map, "app:kart")?.appId).toBe("bank/kart");
    expect(resolveRepoMapEntry(map, "  app:kart  ")?.appId).toBe("bank/kart");
  });

  it("matches case-insensitively in Turkish", () => {
    const tr = { field: "customfield_1", entries: [{ value: "İş Ailesi", appId: "bank/x" }] };
    expect(resolveRepoMapEntry(tr, "iş ailesi")?.appId).toBe("bank/x");
  });

  it("returns null when no member matches", () => {
    expect(resolveRepoMapEntry(map, "maestro, maestro-bekliyor")).toBeNull();
    expect(resolveRepoMapEntry(map, undefined)).toBeNull();
  });
});

/**
 * KATMAN 1 — KURAL YAZILIRKEN REDDET (OPS-121).
 *
 * Canlida olculdu: bir kuralin `repoMap`i `Application` tablosunda satiri
 * OLMAYAN bir depoyu gosteriyordu. Alim eslemeyi dogru cozdu, depoyu KLONLADI,
 * ve ancak kosu satiri yazilirken `WorkflowRun_appId_fkey` ile patladi. Hata
 * saatler once, kural KAYDEDILIRKEN oradaydi — burasi o an.
 *
 * Studio'da bir koruma zaten var (bilinmeyen SCM deposunu `POST
 * /onboarding/apps` ile kaydeder) ama YALNIZ ARAYUZDE: bu testler API'ye
 * dogrudan yazan istemciyi temsil ediyor.
 */
describe("listening rule repo map — unregistered application is refused on write", () => {
  const UNKNOWN = {
    field: "customfield_10234",
    fieldName: "İş Ailesi",
    entries: [{ value: "Krediler", appId: "bank/kredi" }],
  };

  it("refuses a POST whose map points at an unregistered app, and NAMES it", async () => {
    // Envanterde `bank/kredi` YOK — canliyi ureten hâlin ta kendisi.
    const h = await harness();
    const token = await admin(h);

    const response = await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: UNKNOWN });

    expect(response.statusCode).toBe(400);
    // "Bir sey yanlis" operatorun duzeltebilecegi bir cevap degil; hangi appId
    // oldugunu SOYLEMEK oyle.
    expect(response.json()).toMatchObject({
      error: "listening_repo_map_unknown_app",
      details: { appIds: ["bank/kredi"] },
    });
  });

  it("names EVERY unknown app, not just the first", async () => {
    const h = await harness({ applications: [...TEST_APPLICATIONS, testApplication("bank/kart", "bank", "kart")] });
    const token = await admin(h);

    const response = await post(h, "/studio/listening-rules", token, {
      ...BASE,
      repoMap: {
        ...UNKNOWN,
        entries: [
          { value: "Krediler", appId: "bank/kredi" },
          { value: "Kartlar", appId: "bank/kart" },
          { value: "Sigorta", appId: "bank/sigorta" },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ details: { appIds: string[] } }>().details.appIds).toEqual([
      "bank/kredi",
      "bank/sigorta",
    ]);
  });

  it("accepts the same map once the app IS registered — the regression guard", async () => {
    const h = await harness({ applications: MAPPED_APPS });
    const token = await admin(h);

    expect((await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: UNKNOWN })).statusCode).toBe(201);
  });

  it("guards PUT too — a rule EDITED into an unregistered app is refused", async () => {
    const h = await harness({ applications: MAPPED_APPS });
    const token = await admin(h);
    const created = await post(h, "/studio/listening-rules", token, { ...BASE, repoMap: UNKNOWN });
    const ruleId = created.json<{ rule: { ruleId: string } }>().rule.ruleId;

    const response = await h.app.inject({
      method: "PUT",
      url: `/studio/listening-rules/${ruleId}`,
      headers: auth(token),
      payload: { ...BASE, repoMap: { ...UNKNOWN, entries: [{ value: "Krediler", appId: "bank/silinmis" }] } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "listening_repo_map_unknown_app",
      details: { appIds: ["bank/silinmis"] },
    });
  });
});
