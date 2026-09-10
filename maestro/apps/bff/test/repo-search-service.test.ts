import { describe, expect, it } from "vitest";
import { matchByName, searchRepos, searchTermsFrom } from "../src/repo-search-service.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import type { ConnectorFetch } from "../src/connection-service.js";

/**
 * TICKET HANGİ DEPOYU İLGİLENDİRİYOR — KODA SORARAK.
 *
 * Depo eşlemesi operatöre "hangi depo" diye soruyordu ve bu, on depolu bir
 * projede işler. Sahada kırıldığı yer söylendi: bir Azure DevOps projesinde
 * ONLARCA depo var ve ticket'ın hangisini ilgilendirdiğini kimse bilmiyor.
 */

const TOKEN = "pat-gizli-deger";

function conn(kind: "ado" | "github" = "ado", baseUrl = "https://dev.azure.com/banka"): ConnectionRecord {
  return {
    id: "scm",
    kind,
    displayName: "SCM",
    baseUrl,
    authKind: "token",
    config: {},
    secretRef: "kv/scm#token",
    secretMask: null,
    enabled: true,
  } as unknown as ConnectionRecord;
}

describe("searchTermsFrom — aranacak terimler", () => {
  it("keeps the words that distinguish, drops the ones every repo carries", () => {
    const terms = searchTermsFrom("Ekstre ekranında bakiye yanlış görünüyor ve bir hata var");
    // "ekran", "hata", "var", "ve", "bir" her depoda geçer — ayırt etmez.
    expect(terms).toContain("Ekstre");
    expect(terms).toContain("bakiye");
    expect(terms).not.toContain("ve");
    expect(terms).not.toContain("bir");
    expect(terms).not.toContain("hata");
  });

  it("drops bare numbers — ticket ids, dates and amounts are not terms", () => {
    expect(searchTermsFrom("OPS-123 tarihinde 1500.00 tutarı hatalı")).not.toContain("1500.00");
  });

  it("de-duplicates while keeping the order the title gave", () => {
    const terms = searchTermsFrom("Kredi başvurusu kredi ekranı Kredi limiti");
    expect(terms.filter((t) => t.toLocaleLowerCase("tr") === "kredi")).toHaveLength(1);
    expect(terms[0]).toBe("Kredi");
  });
});

describe("matchByName — eklentisiz kurulumun cevabı", () => {
  it("matches a repository whose NAME carries a term", () => {
    const hits = matchByName(
      ["Banka/ekstre-servis", "Banka/kredi-api", "Banka/ortak-kutuphane"],
      ["ekstre", "bakiye"],
    );
    expect(hits[0]?.repo).toBe("Banka/ekstre-servis");
    expect(hits).toHaveLength(1);
  });

  it("ranks a repo carrying two terms above one carrying a single term", () => {
    const hits = matchByName(["Banka/kredi-limit-api", "Banka/kredi-api"], ["kredi", "limit"]);
    expect(hits.map((h) => h.repo)).toEqual(["Banka/kredi-limit-api", "Banka/kredi-api"]);
  });

  /**
   * Proje adı KARŞILAŞTIRILMAZ, ve bu kasıtlı: proje adı o projedeki her
   * depoda aynıdır, yani hepsini eşit puanlar ve hiçbir şeyi ayırt etmez.
   * Karşılaştırılsaydı "Kredi" projesindeki 40 depo da eşit puan alırdı.
   */
  it("ignores the project half of the name", () => {
    const hits = matchByName(["Kredi/ekstre-servis", "Kredi/odeme-api"], ["kredi"]);
    expect(hits).toHaveLength(0);
  });
});

describe("searchRepos — Code Search varsa o, yoksa ad eşleşmesi", () => {
  const search = (fetchImpl: ConnectorFetch, repos?: readonly string[]) =>
    searchRepos(
      conn(),
      TOKEN,
      { text: "Ekstre ekranında bakiye yanlış", project: "Banka", ...(repos === undefined ? {} : { repos }) },
      fetchImpl,
    );

  it("uses ADO code search and ranks repositories by how many hits they carry", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const http: ConnectorFetch = (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return Promise.resolve(
        Response.json({
          results: [
            { path: "/src/Ekstre.cs", repository: { name: "ekstre-servis" }, project: { name: "Banka" } },
            { path: "/src/Bakiye.cs", repository: { name: "ekstre-servis" }, project: { name: "Banka" } },
            { path: "/src/Ortak.cs", repository: { name: "ortak-kutuphane" }, project: { name: "Banka" } },
          ],
        }),
      );
    };
    const result = await search(http);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("code-search");
    expect(result.hits[0]).toEqual({
      repo: "Banka/ekstre-servis",
      matches: 2,
      files: ["/src/Ekstre.cs", "/src/Bakiye.cs"],
    });
    // Arama AYRI bir hostta yaşar ve projeyle SINIRLANIR — komşu projenin
    // deposunu klonlamak, yanlış cevabı hiç cevap vermemekten kötü yapar.
    expect(calls[0]?.url).toContain("almsearch.dev.azure.com/banka");
    expect(calls[0]?.body).toMatchObject({ filters: { Project: ["Banka"] } });
  });

  /**
   * Code Search bir EKLENTİDİR; kurulu olmayan organizasyonda uç 404 döner.
   * O hâlde arama "başarısız" değildir — bu kurulumun verebileceği en iyi
   * cevaba düşülür. Aksi hâlde ADO kullanan yarı kurulum hiçbir cevap alamazdı.
   */
  it("falls back to repository names when the Code Search extension is absent", async () => {
    const http: ConnectorFetch = () => Promise.resolve(new Response("not found", { status: 404 }));
    const result = await search(http, ["Banka/ekstre-servis", "Banka/kredi-api"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("repo-names");
    expect(result.hits[0]?.repo).toBe("Banka/ekstre-servis");
  });

  it("says so by name when neither path can answer", async () => {
    const http: ConnectorFetch = () => Promise.resolve(new Response("nope", { status: 404 }));
    const result = await search(http, []);
    expect(result).toEqual({ ok: false, messageKey: "repo_search.unavailable" });
  });

  it("never echoes the token, on any path", async () => {
    const http: ConnectorFetch = () =>
      Promise.resolve(new Response(`denied for ${TOKEN}`, { status: 403 }));
    const result = await search(http, ["Banka/ekstre-servis"]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("refuses a connection that carries no repositories at all", async () => {
    const result = await searchRepos(
      { ...conn(), kind: "jira_cloud" } as ConnectionRecord,
      TOKEN,
      { text: "ekstre" },
      () => Promise.resolve(Response.json({})),
    );
    expect(result.ok).toBe(false);
  });
});
