import { describe, expect, it } from "vitest";
import {
  listJiraFieldValues,
  listJiraFields,
  listJiraMatchValues,
  listJiraUsers,
  parseCreateMetaIssueTypes,
  sampledValuesFromSearch,
} from "../src/jira-match-values-service.js";
import { fetchSeedIssueTypes } from "../src/listening-seed.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import type { ConnectorFetch } from "../src/connection-service.js";

/**
 * The values a listening rule can match on — and the localisation trap under
 * them.
 *
 * Measured live on project OPS: `/project/OPS/statuses` names its issue types
 * "Task/Bug/Story/Epic" while `/issue/createmeta/OPS/issuetypes` and the issue
 * resource itself both say "Görev/Hata/Hikaye/Epik". `flow-decision.ts` compares
 * a rule's `matchValue` to `fields.issuetype.name`, so a rule built from the
 * first list matches NOTHING. These tests pin the issue-type branch to the
 * createmeta source, pin the STATUS branch to the statuses payload (it was
 * always right and the shipped status-map feature depends on it), and prove the
 * degradation path never hands back an empty dropdown.
 */

const TOKEN = "jira_secrettoken_xyz789";

/** The live OPS payload, trimmed: English at the top, Turkish in the nest. */
const STATUSES_BODY = [
  {
    name: "Task",
    subtask: false,
    statuses: [
      { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "Yapılacak" } },
      { id: "10001", name: "Devam Ediyor", statusCategory: { key: "indeterminate", name: "Sürüyor" } },
      { id: "10002", name: "Tamam", statusCategory: { key: "done", name: "Bitti" } },
    ],
  },
  {
    name: "Bug",
    subtask: false,
    statuses: [
      { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "Yapılacak" } },
      { id: "10003", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "Sürüyor" } },
    ],
  },
  { name: "Story", subtask: false, statuses: [] },
  { name: "Subtask", subtask: true, statuses: [] },
];

/** What `/issue/createmeta/OPS/issuetypes` actually returned on the live site. */
const CREATEMETA_BODY = {
  startAt: 0,
  maxResults: 50,
  total: 4,
  issueTypes: [
    { id: "10001", name: "Görev", subtask: false },
    { id: "10004", name: "Hata", subtask: false },
    { id: "10002", name: "Hikaye", subtask: false },
    { id: "10005", name: "Subtask", subtask: true },
  ],
};

function conn(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
    config: { email: "bot@ugurbank.local" },
    secretRef: "connector:jira:1",
    secretMask: "z789",
    enabled: true,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    lastTestedAt: null,
    lastTestOk: null,
    lastTestNote: null,
    onPrem: false,
    isDefault: false,
    ...over,
  };
}

/**
 * A fetch stub that answers per URL SUBSTRING, so a test states which endpoint
 * it is serving instead of relying on call order. An unmatched URL is a 404,
 * which is exactly how a deployment without createmeta behaves.
 */
function router(routes: readonly { match: string; status: number; body: unknown }[]): {
  fetch: ConnectorFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: ConnectorFetch = (url) => {
    const href = String(url);
    urls.push(href);
    const hit = routes.find((r) => href.includes(r.match));
    if (hit === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(hit.body), { status: hit.status }));
  };
  return { fetch, urls };
}

const CREATEMETA = { match: "/issue/createmeta/", status: 200, body: CREATEMETA_BODY };
const STATUSES = { match: "/statuses", status: 200, body: STATUSES_BODY };

describe("listJiraMatchValues — Cloud issue types", () => {
  it("returns the LOCALISED names from createmeta, not the English ones from /statuses", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);

    expect(result).toMatchObject({ ok: true, values: ["Görev", "Hata", "Hikaye", "Subtask"] });
    // The names the statuses payload would have produced must NOT appear: those
    // are the ones that silently match no ticket.
    if (result.ok) {
      expect(result.values).not.toContain("Task");
      expect(result.values).not.toContain("Bug");
      expect(result.values).not.toContain("Story");
    }
    // Only the project probe (which form to save) and createmeta were called —
    // the /statuses fallback costs a request we did not need.
    expect(urls).toEqual([
      "https://ugurbank.atlassian.net/rest/api/3/project/OPS",
      "https://ugurbank.atlassian.net/rest/api/3/issue/createmeta/OPS/issuetypes",
    ]);
  });

  it("parses the paginated {values:[…]} shape as well as {issueTypes:[…]}", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { values: CREATEMETA_BODY.issueTypes } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, values: ["Görev", "Hata", "Hikaye", "Subtask"] });
  });

  it("presents Basic auth with the stored email and never puts the token in the URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch: ConnectorFetch = (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return Promise.resolve(new Response(JSON.stringify(CREATEMETA_BODY), { status: 200 }));
    };
    await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);

    const auth = (calls[0]?.init?.headers as Record<string, string>).authorization ?? "";
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      `bot@ugurbank.local:${TOKEN}`,
    );
    expect(calls[0]?.url).not.toContain(TOKEN);
  });
});

describe("listJiraMatchValues — degradation when createmeta cannot answer", () => {
  it("falls back to /statuses on a 403 and SAYS it degraded, instead of emptying the list", async () => {
    const { fetch, urls } = router([
      { match: "/issue/createmeta/", status: 403, body: { errorMessages: ["no create permission"] } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stale, possibly-wrong-language names — but a list the operator can read.
      expect(result.values).toEqual(["Task", "Bug", "Story", "Subtask"]);
      expect(result.degraded).toBe(true);
      expect(result.degradedKey).toBe("onboard.jira.issuetypes_degraded");
    }
    // project probe, createmeta, then the fallback.
    expect(urls).toHaveLength(3);
    expect(urls[2]).toContain("/project/OPS/statuses");
  });

  it("falls back when createmeta 404s (an older deployment without the endpoint)", async () => {
    const { fetch } = router([STATUSES]); // createmeta unmatched → 404
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true });
  });

  it("falls back when createmeta answers 200 with a shape it does not recognise", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { unexpected: true } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true });
    if (result.ok) expect(result.values).toEqual(["Task", "Bug", "Story", "Subtask"]);
  });

  it("treats an EMPTY createmeta page as no answer and degrades rather than returning []", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { issueTypes: [] } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true });
    if (result.ok) expect(result.values.length).toBeGreaterThan(0);
  });

  it("reports a secret-free failure when BOTH sources fail, and never leaks the token", async () => {
    const { fetch } = router([]); // everything 404s
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.http_error" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a thrown fetch as unreachable rather than throwing to the caller", async () => {
    const fetch: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    await expect(listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch)).resolves.toMatchObject(
      { ok: false, messageKey: "onboard.jira.unreachable" },
    );
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("listJiraMatchValues — status branch (regression lock)", () => {
  /**
   * The status-map feature ships against these names. This branch was CORRECT
   * before the issue-type fix and must stay byte-identical: the nested statuses
   * of `/project/{key}/statuses` are the same strings `fields.status.name`
   * carries, and createmeta must never be consulted for them.
   */
  it("reads the NESTED status names off /project/{key}/statuses, de-duplicated", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);

    expect(result).toMatchObject({
      ok: true,
      values: ["Yapılacaklar", "Devam Ediyor", "Tamam", "İNCELEMEDE"],
    });
    expect(urls).toEqual([
      "https://ugurbank.atlassian.net/rest/api/3/project/OPS",
      "https://ugurbank.atlassian.net/rest/api/3/project/OPS/statuses",
    ]);
    // No `degraded` flag ever appears on the status path.
    expect(result.ok && "degraded" in result).toBe(false);
  });

  it("still maps a status HTTP error to the same secret-free key", async () => {
    const { fetch } = router([{ match: "/statuses", status: 401, body: { message: "Unauthorized" } }]);
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);
    expect(result).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.http_error",
      messageParams: { status: "401" },
    });
  });
});

describe("listJiraMatchValues — Data Center stays on its verified source", () => {
  /**
   * DC keeps `/project/{key}/statuses` for BOTH kinds. Server/DC documents the
   * same createmeta route, but with no DC instance to measure we will not trade
   * a list that works for one that might 404 — see the comment in
   * `jiraMatchSource`.
   */
  it("reads DC issue types off /rest/api/2/project/{key}/statuses with a bearer token", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const calls: string[] = [];
    const spy: ConnectorFetch = (url, init) => {
      calls.push(((init?.headers as Record<string, string>) ?? {}).authorization ?? "");
      return fetch(url, init);
    };
    const result = await listJiraMatchValues(conn({ kind: "jira_dc" }), "OPS", "issuetype", TOKEN, spy);

    expect(result).toMatchObject({ ok: true, values: ["Task", "Bug", "Story", "Subtask"] });
    expect(urls).toEqual([
      "https://ugurbank.atlassian.net/rest/api/2/project/OPS",
      "https://ugurbank.atlassian.net/rest/api/2/project/OPS/statuses",
    ]);
    expect(urls.join(" ")).not.toContain("createmeta");
    expect(calls[0]).toBe(`Bearer ${TOKEN}`);
  });

  it("reads DC statuses off the same endpoint, unchanged", async () => {
    const { fetch } = router([STATUSES]);
    const result = await listJiraMatchValues(conn({ kind: "jira_dc" }), "OPS", "status", TOKEN, fetch);
    expect(result).toMatchObject({
      ok: true,
      values: ["Yapılacaklar", "Devam Ediyor", "Tamam", "İNCELEMEDE"],
    });
  });
});

describe("listJiraMatchValues — team-managed projects need IDS, not names", () => {
  /**
   * Measured live on OPS (team-managed: `style: "next-gen"`, `simplified:
   * true`), over one and the same ticket set:
   *
   *   issuetype = "Görev"        ->  0 tickets      issuetype = 10008 -> 14
   *   status in ("Yapılacaklar") ->  0 tickets      status = 10004    -> 12
   *
   * No error, just an empty page. So the screen must be able to save the ID,
   * which means the list has to carry it and the answer has to say which kind
   * of project this is.
   */
  const NEXT_GEN = {
    match: "/project/OPS",
    status: 200,
    body: { id: "10100", key: "OPS", name: "Ops", style: "next-gen", simplified: true },
  };
  const CLASSIC = {
    match: "/project/OPS",
    status: 200,
    body: { id: "10100", key: "OPS", name: "Ops", style: "classic", simplified: false },
  };
  /** `/project/OPS` and `/project/OPS/statuses` both match "/project/OPS", so
   *  the more specific route must be listed FIRST for the stub to serve it. */
  const routes = (project: { match: string; status: number; body: unknown }) => [
    CREATEMETA,
    STATUSES,
    project,
  ];

  it("reports teamManaged and the issue-type ids the JQL needs", async () => {
    const { fetch } = router(routes(NEXT_GEN));
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({
      ok: true,
      teamManaged: true,
      values: ["Görev", "Hata", "Hikaye", "Subtask"],
      options: [
        { name: "Görev", id: "10001" },
        { name: "Hata", id: "10004" },
        { name: "Hikaye", id: "10002" },
        { name: "Subtask", id: "10005" },
      ],
    });
  });

  it("reports teamManaged and the STATUS ids off /project/{key}/statuses", async () => {
    const { fetch } = router(routes(NEXT_GEN));
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);
    expect(result).toMatchObject({
      ok: true,
      teamManaged: true,
      options: [
        { name: "Yapılacaklar", id: "10000" },
        { name: "Devam Ediyor", id: "10001" },
        { name: "Tamam", id: "10002" },
        { name: "İNCELEMEDE", id: "10003" },
      ],
    });
    // `values` keeps its old meaning for every caller that never asked for ids.
    if (result.ok) expect(result.values).toEqual(["Yapılacaklar", "Devam Ediyor", "Tamam", "İNCELEMEDE"]);
  });

  it("says teamManaged:false for a company-managed project, ids still reported", async () => {
    const { fetch } = router(routes(CLASSIC));
    const issueTypes = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(issueTypes).toMatchObject({ ok: true, teamManaged: false });
    if (issueTypes.ok) expect(issueTypes.options?.[0]).toEqual({ name: "Görev", id: "10001" });
    const statuses = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);
    expect(statuses).toMatchObject({ ok: true, teamManaged: false });
  });

  it("accepts either marker alone — older Cloud sends only `simplified`", async () => {
    const only = (body: unknown) => ({ match: "/project/OPS", status: 200, body });
    for (const body of [{ simplified: true }, { style: "next-gen" }, { style: "NEXT-GEN" }]) {
      const { fetch } = router([CREATEMETA, STATUSES, only(body)]);
      expect(await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch)).toMatchObject({
        teamManaged: true,
      });
    }
    for (const body of [{}, { style: "classic" }, { simplified: false }]) {
      const { fetch } = router([CREATEMETA, STATUSES, only(body)]);
      expect(await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch)).toMatchObject({
        teamManaged: false,
      });
    }
  });

  it("FAIL-SOFT: an unreadable project resource means company-managed, not a failed list", async () => {
    // The project probe 404s (unmatched); the list must still come back.
    const { fetch } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, teamManaged: false });
    if (result.ok) expect(result.values).toEqual(["Görev", "Hata", "Hikaye", "Subtask"]);
  });

  it("serialises a numeric id as a string, the form a rule stores", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { issueTypes: [{ id: 10008, name: "Görev" }] } },
      STATUSES,
      NEXT_GEN,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    if (result.ok) expect(result.options).toEqual([{ name: "Görev", id: "10008" }]);
  });

  it("degraded fallback still carries the group's issue-type id", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 403, body: {} },
      { match: "/project/OPS/statuses", status: 200, body: [{ id: "10011", name: "Task", statuses: [] }] },
      NEXT_GEN,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true, teamManaged: true });
    // The GROUP's name may be the wrong localisation; its id is not.
    if (result.ok) expect(result.options).toEqual([{ name: "Task", id: "10011" }]);
  });
});

describe("listJiraMatchValues — guards that must not reach the network", () => {
  it("refuses a kind that cannot list values", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn({ kind: "github" }), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.not_listable" });
    expect(urls).toHaveLength(0);
  });

  it("refuses a missing token and an empty project key", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    expect(await listJiraMatchValues(conn(), "OPS", "issuetype", null, fetch)).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.no_token",
    });
    expect(await listJiraMatchValues(conn(), "   ", "issuetype", TOKEN, fetch)).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.bad_response",
    });
    expect(urls).toHaveLength(0);
  });
});

describe("parseCreateMetaIssueTypes", () => {
  it("de-duplicates, trims, and keeps subtask types", () => {
    expect(
      parseCreateMetaIssueTypes({
        issueTypes: [{ name: " Görev " }, { name: "Görev" }, { name: "Subtask", subtask: true }],
      }),
    ).toEqual(["Görev", "Subtask"]);
  });

  it("returns null (not []) for shapes it cannot read, so the caller degrades", () => {
    expect(parseCreateMetaIssueTypes(null)).toBeNull();
    expect(parseCreateMetaIssueTypes([])).toBeNull();
    expect(parseCreateMetaIssueTypes({ issueTypes: [] })).toBeNull();
    expect(parseCreateMetaIssueTypes({ issueTypes: [{ id: "1" }] })).toBeNull();
  });
});

describe("fetchSeedIssueTypes — the seed matches on the same names", () => {
  /**
   * The default-rule seed writes `matchValue` straight into a listening rule,
   * so it has to prefer the same source: a seeded "Task" rule is a project that
   * silently listens to nothing.
   */
  it("seeds from the LOCALISED createmeta names, keeps the subtask flag AND the id", async () => {
    /**
     * `id` DE TAŞINIR, ve bu isteğe bağlı bir ayrıntı değil.
     *
     * Takım yönetimli ("next-gen") bir projede JQL iş tipi adlarını hiç kabul
     * etmez ve hata da vermez — boş sayfa döner. Canlıda OPS üzerinde ölçüldü:
     * `issuetype = "Görev"` → 0 ticket, `issuetype = 10008` → 14 ticket. Yani
     * adla tohumlanmış bir kural sonsuza dek hiçbir ticket bulmaz.
     *
     * Tohum id'yi burada alamazsa, o projede yazacak doğru değeri hiç
     * göremez — `seedDefaultRules`ın takım yönetimli dalı ada düşer.
     */
    const { fetch } = router([CREATEMETA, STATUSES]);
    const result = await fetchSeedIssueTypes(conn(), "OPS", TOKEN, fetch);
    expect(result).toEqual({
      ok: true,
      issueTypes: [
        { name: "Görev", subtask: false, id: "10001" },
        { name: "Hata", subtask: false, id: "10004" },
        { name: "Hikaye", subtask: false, id: "10002" },
        { name: "Subtask", subtask: true, id: "10005" },
      ],
    });
  });

  it("degrades to /statuses rather than seeding nothing when createmeta 403s", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 403, body: {} },
      STATUSES,
    ]);
    const result = await fetchSeedIssueTypes(conn(), "OPS", TOKEN, fetch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issueTypes.map((t) => t.name)).toEqual(["Task", "Bug", "Story", "Subtask"]);
  });

  it("keeps DC on the statuses payload, never calling createmeta", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await fetchSeedIssueTypes(conn({ kind: "jira_dc" }), "OPS", TOKEN, fetch);
    expect(result.ok).toBe(true);
    expect(urls).toEqual(["https://ugurbank.atlassian.net/rest/api/2/project/OPS/statuses"]);
  });

  it("reports unavailable when nothing answers, without throwing", async () => {
    const { fetch } = router([]);
    await expect(fetchSeedIssueTypes(conn(), "OPS", TOKEN, fetch)).resolves.toEqual({
      ok: false,
      reason: "issue_types_unavailable",
    });
  });
});

describe("listJiraFields — the fields a repo map can use", () => {
  it("reads /field on Cloud (v3) and DC (v2), custom fields first", async () => {
    const body = [
      { id: "summary", name: "Summary", custom: false },
      { id: "customfield_10234", name: "İş Ailesi", custom: true, schema: { type: "option" } },
      { id: "components", name: "Component/s", custom: false },
    ];
    const cloud = router([{ match: "/rest/api/3/field", status: 200, body }]);
    const got = await listJiraFields(conn(), TOKEN, cloud.fetch);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.fields.map((f) => f.id)).toEqual(["customfield_10234", "components"]);
    const dc = router([{ match: "/rest/api/2/field", status: 200, body }]);
    const gotDc = await listJiraFields(conn({ kind: "jira_dc", authKind: "bearer" }), TOKEN, dc.fetch);
    expect(gotDc.ok).toBe(true);
    expect(dc.urls[0]).toContain("/rest/api/2/field");
  });

  it("reports an unreachable or empty answer instead of an empty list", async () => {
    const empty = router([{ match: "/field", status: 200, body: [] }]);
    expect(await listJiraFields(conn(), TOKEN, empty.fetch)).toEqual({ ok: false, messageKey: "onboard.jira.bad_response" });
    const http = router([{ match: "/field", status: 401, body: {} }]);
    const got = await listJiraFields(conn(), TOKEN, http.fetch);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.messageKey).toBe("onboard.jira.http_error");
    expect(await listJiraFields(conn(), null, empty.fetch)).toEqual({ ok: false, messageKey: "onboard.jira.no_token" });
  });
});

describe("listJiraFieldValues — a select field that is not on the create screen", () => {
  it("reads the whole option list from a recent ticket's edit screen (editmeta)", async () => {
    const search = { issues: [{ key: "OTYT-7", fields: { customfield_10234: null } }] };
    const editmeta = { fields: { customfield_10234: { name: "İş Ailesi", allowedValues: [{ value: "Sigorta" }, { value: "Krediler" }, { value: "Kartlar" }] } } };
    const { fetch, urls } = router([
      { match: "/issue/createmeta", status: 200, body: { projects: [] } },
      { match: "/search", status: 200, body: search },
      { match: "/issue/OTYT-7/editmeta", status: 200, body: editmeta },
    ]);
    const got = await listJiraFieldValues(conn({ kind: "jira_dc", authKind: "bearer" }), "OTYT", "customfield_10234", TOKEN, fetch);
    expect(got).toEqual({ ok: true, values: ["Kartlar", "Krediler", "Sigorta"], source: "editmeta" });
    expect(urls.some((u) => u.includes("/rest/api/2/issue/OTYT-7/editmeta"))).toBe(true);
  });

  it("on Cloud falls back to the field's context options, before the values in use", async () => {
    const search = { issues: [{ key: "OPS-1", fields: { customfield_10234: { value: "Krediler" } } }] };
    const { fetch } = router([
      { match: "/issue/createmeta", status: 200, body: { projects: [] } },
      { match: "/search", status: 200, body: search },
      { match: "/editmeta", status: 200, body: { fields: {} } },
      { match: "/field/customfield_10234/context?", status: 200, body: { values: [{ id: "10100" }] } },
      { match: "/context/10100/option", status: 200, body: { isLast: true, values: [{ value: "Krediler" }, { value: "Kartlar" }, { value: "Eski", disabled: true }] } },
    ]);
    const got = await listJiraFieldValues(conn(), "OPS", "customfield_10234", TOKEN, fetch);
    expect(got).toEqual({ ok: true, values: ["Kartlar", "Krediler"], source: "options" });
  });
});

describe("listJiraFieldValues — a field's values for the repo map", () => {
  const META = {
    projects: [{ key: "OPS", issuetypes: [
      { name: "Görev", fields: { customfield_10234: { name: "İş Ailesi", allowedValues: [{ value: "Krediler" }, { value: "Kartlar" }] } } },
      { name: "Hata", fields: { customfield_10234: { allowedValues: [{ value: "Sigorta" }, { value: "Krediler" }] } } },
    ] }],
  };
  it("prefers Jira's allowed values, de-duplicated across issue types", async () => {
    const { fetch } = router([{ match: "/issue/createmeta?projectKeys=OPS", status: 200, body: META }]);
    const got = await listJiraFieldValues(conn({ kind: "jira_dc", authKind: "bearer" }), "OPS", "customfield_10234", TOKEN, fetch);
    expect(got).toEqual({ ok: true, values: ["Kartlar", "Krediler", "Sigorta"], source: "createmeta" });
  });

  it("falls back to the values in use on the project's tickets", async () => {
    const SEARCH = { issues: [
      { fields: { customfield_10234: { value: "Krediler" } } },
      { fields: { customfield_10234: null } },
      { fields: { customfield_10234: [{ value: "Kartlar" }, { value: "Krediler" }] } },
    ] };
    const { fetch, urls } = router([
      { match: "/issue/createmeta", status: 200, body: { projects: [] } },
      { match: "/search", status: 200, body: SEARCH },
    ]);
    const got = await listJiraFieldValues(conn(), "OPS", "customfield_10234", TOKEN, fetch);
    expect(got).toEqual({ ok: true, values: ["Kartlar", "Krediler"], source: "sample" });
    expect(urls[1]).toContain("/rest/api/3/search/jql?jql=");
    expect(urls[1]).toContain("fields=customfield_10234");
  });

  it("says so when the field carries no value anywhere, and refuses a bad field id", async () => {
    const { fetch } = router([{ match: "/issue/createmeta", status: 200, body: {} }, { match: "/search", status: 200, body: { issues: [] } }]);
    expect(await listJiraFieldValues(conn(), "OPS", "customfield_1", TOKEN, fetch)).toEqual({ ok: false, messageKey: "onboard.jira.field_no_values" });
    expect(await listJiraFieldValues(conn(), "OPS", "../x", TOKEN, fetch)).toEqual({ ok: false, messageKey: "onboard.jira.bad_response" });
  });
});

describe("listJiraFields — narrowed to a project", () => {
  const ALL = [
    { id: "customfield_10234", name: "İş Ailesi", custom: true },
    { id: "customfield_10999", name: "Başka Takımın Alanı", custom: true },
    { id: "components", name: "Component/s", custom: false },
  ];
  it("puts the project's screen fields first and keeps the rest, marked — a shared field is never hidden", async () => {
    const meta = { projects: [{ key: "OTYT", issuetypes: [{ fields: { customfield_10999: {}, summary: {} } }] }] };
    const { fetch } = router([
      { match: "/field", status: 200, body: ALL },
      { match: "/issue/createmeta?projectKeys=OTYT", status: 200, body: meta },
    ]);
    const got = await listJiraFields(conn(), TOKEN, fetch, "OTYT");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.fields.map((f) => `${f.id}:${f.scope}`)).toEqual([
        "customfield_10999:project",
        "customfield_10234:other",
        "components:other",
      ]);
    }
  });

  it("falls back to fields carrying values on the project's tickets, and to the full list when nothing is known", async () => {
    const sample = { issues: [{ fields: { customfield_10999: { value: "x" }, customfield_10234: null, components: [] } }] };
    const { fetch } = router([
      { match: "/field", status: 200, body: ALL },
      { match: "/issue/createmeta", status: 200, body: { projects: [] } },
      { match: "/search", status: 200, body: sample },
    ]);
    const got = await listJiraFields(conn(), TOKEN, fetch, "OTYT");
    if (got.ok) expect(got.fields.map((f) => `${f.id}:${f.scope}`)).toEqual(["customfield_10999:project", "customfield_10234:other", "components:other"]);
    const nothing = router([{ match: "/field", status: 200, body: ALL }]);
    const all = await listJiraFields(conn(), TOKEN, nothing.fetch, "OTYT");
    if (all.ok) expect(all.fields).toHaveLength(3);
  });
});

/**
 * The rule form's "bot hesabı" was free text: an operator hand-copied a
 * 24-character account id and one wrong character made the rule match nothing,
 * silently and forever. These tests pin the list that replaces the box —
 * including DC, whose users carry no `accountId` at all.
 */
describe("listJiraUsers — the bot account a rule can be pointed at", () => {
  const CLOUD_BODY = [
    { accountId: "5b10a2844c20165700ede21g", displayName: "Otomasyon Botu", emailAddress: "bot@ugurbank.local", active: true },
    { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Ayşe Yılmaz", active: true },
  ];

  it("normalises a Cloud body onto accountId / displayName / email", async () => {
    const { fetch, urls } = router([{ match: "/user/search", status: 200, body: CLOUD_BODY }]);
    const got = await listJiraUsers(conn(), "bot", TOKEN, fetch);
    expect(got).toEqual({
      ok: true,
      users: [
        { accountId: "5b10a2844c20165700ede21g", displayName: "Otomasyon Botu", email: "bot@ugurbank.local", active: true },
        { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Ayşe Yılmaz", active: true },
      ],
    });
    expect(urls[0]).toContain("/rest/api/3/user/search?query=bot");
    expect(urls[0]).toContain("maxResults=50");
  });

  it("reads a Data Center body, where the identifier is `key` or `name`, off the v2 `username` endpoint", async () => {
    const DC_BODY = [
      { key: "JIRAUSER10100", name: "botuser", displayName: "Otomasyon Botu", emailAddress: "bot@ugurbank.local", active: true },
      { name: "ayse", displayName: "Ayşe Yılmaz", active: true },
    ];
    const { fetch, urls } = router([{ match: "/user/search", status: 200, body: DC_BODY }]);
    const spy: ConnectorFetch = (url, init) => {
      expect((init?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
      return fetch(url, init);
    };
    const got = await listJiraUsers(conn({ kind: "jira_dc", authKind: "bearer" }), "bot", TOKEN, spy);
    expect(got).toEqual({
      ok: true,
      users: [
        { accountId: "JIRAUSER10100", displayName: "Otomasyon Botu", email: "bot@ugurbank.local", active: true },
        { accountId: "ayse", displayName: "Ayşe Yılmaz", active: true },
      ],
    });
    expect(urls[0]).toContain("/rest/api/2/user/search?username=bot");
  });

  it("drops deactivated accounts — a rule pointed at one could never fire", async () => {
    const { fetch } = router([
      {
        match: "/user/search",
        status: 200,
        body: [
          { accountId: "live", displayName: "Çalışan", active: true },
          { accountId: "gone", displayName: "Ayrılan", active: false },
          { accountId: "assumed", displayName: "İşareti Olmayan" },
        ],
      },
    ]);
    const got = await listJiraUsers(conn(), "", TOKEN, fetch);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.users.map((u) => u.accountId)).toEqual(["live", "assumed"]);
  });

  it("refuses a connection with no token, and a kind that cannot list", async () => {
    const { fetch, urls } = router([{ match: "/user/search", status: 200, body: CLOUD_BODY }]);
    expect(await listJiraUsers(conn(), "bot", null, fetch)).toEqual({ ok: false, messageKey: "onboard.jira.no_token" });
    expect(await listJiraUsers(conn({ kind: "github" }), "bot", TOKEN, fetch)).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.not_listable",
    });
    expect(urls).toHaveLength(0);
  });

  it("reports a provider failure as a secret-free key and never echoes the token", async () => {
    const http = router([{ match: "/user/search", status: 403, body: { message: `denied for ${TOKEN}` } }]);
    const denied = await listJiraUsers(conn(), "bot", TOKEN, http.fetch);
    expect(denied).toEqual({ ok: false, messageKey: "onboard.jira.http_error", messageParams: { status: "403" } });
    expect(JSON.stringify(denied)).not.toContain(TOKEN);

    const down: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    const unreachable = await listJiraUsers(conn(), "bot", TOKEN, down);
    expect(unreachable).toEqual({ ok: false, messageKey: "onboard.jira.unreachable" });
    expect(JSON.stringify(unreachable)).not.toContain(TOKEN);

    const junk = router([{ match: "/user/search", status: 200, body: { values: [] } }]);
    expect(await listJiraUsers(conn(), "bot", TOKEN, junk.fetch)).toEqual({
      ok: false,
      messageKey: "onboard.jira.bad_response",
    });
  });
});

/**
 * DEĞER KUTUSU KULLANICI ALANLARINDA DA DOLU GELMELİ.
 *
 * Örnekleme bir dönem yalnız `value` ve `name` anahtarlarını okuyordu. Canlıda
 * ölçüldü: "Atanan Kişi" ve "Raporlayan" alanlarında değer kutusu boş
 * geliyordu, çünkü Jira bir kullanıcıyı `{ displayName, accountId }` olarak
 * döner — ikisini de taşımaz. Alan seçilebiliyor ama seçenek çıkmıyordu.
 *
 * Anahtar sırası `fieldText` ile aynı olmalı: biri operatöre listelenen metni
 * üretir, öteki ticket geldiğinde eşleştirilecek metni. Ayrışırlarsa operatör
 * listeden seçer, motor başka metinle karşılaştırır, eşleşme hiç tutmaz.
 */
describe("sampledValuesFromSearch — Jira'nın her değer şekli", () => {
  const issues = (fields: Record<string, unknown>[]): unknown => ({
    issues: fields.map((f) => ({ fields: f })),
  });

  it("reads a user field through displayName — the assignee box used to come up empty", () => {
    const body = issues([
      { assignee: { accountId: "712020:a", displayName: "Uğur Yıldız" } },
      { assignee: { accountId: "712020:b", displayName: "Ayşe Demir" } },
      { assignee: { accountId: "712020:a", displayName: "Uğur Yıldız" } },
      { assignee: null },
    ]);
    expect(sampledValuesFromSearch(body, "assignee").sort()).toEqual(["Ayşe Demir", "Uğur Yıldız"]);
  });

  it("reads a parent/epic through key when it carries no value or name", () => {
    const body = issues([{ parent: { id: "10001", key: "OPS-1" } }, { parent: { id: "10002", key: "OPS-2" } }]);
    expect(sampledValuesFromSearch(body, "parent").sort()).toEqual(["OPS-1", "OPS-2"]);
  });

  it("still prefers value over name, and name over displayName", () => {
    const body = issues([
      { f: { value: "Krediler", name: "yanlış", displayName: "yanlış" } },
      { f: { name: "Kartlar", displayName: "yanlış" } },
    ]);
    expect(sampledValuesFromSearch(body, "f").sort()).toEqual(["Kartlar", "Krediler"]);
  });

  it("flattens a multi-value field and drops the empties", () => {
    const body = issues([{ labels: ["depo-platform", "acil"] }, { labels: ["depo-platform"] }, { labels: [] }]);
    expect(sampledValuesFromSearch(body, "labels").sort()).toEqual(["acil", "depo-platform"]);
  });
});
