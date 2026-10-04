import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findJiraConnection,
  isJiraKind,
  jiraApiBase,
  jiraAuthHeader,
  jiraHeaders,
  jiraUrl,
  type ConnectionRow,
} from "../src/bin/jira-connection.js";

/**
 * Teşhis araçlarının Jira bağlantısı — Data Center DE çalışır.
 *
 * Bu testin var olma sebebi ölçülmüş bir arıza: `kural-provasi`, `mini-test`
 * ve `test-ticket` yalnız `jira_cloud` arıyordu. Data Center'a kurulmuş bir
 * sahada bu araçlar "Jira bağlantısı yok" diye duruyordu — bağlantı vardı,
 * türü `jira_dc`'ydi. Banka kurulumları tipik olarak Data Center'dır, yani
 * araçlar en çok gerektikleri yerde çalışmıyordu.
 */

const CLOUD: ConnectionRow = {
  kind: "jira_cloud",
  baseUrl: "https://kurum.atlassian.net/",
  secretRef: "kv/jira#token",
  configJson: { email: "bot@kurum.com" },
};
const DC: ConnectionRow = {
  kind: "jira_dc",
  baseUrl: "https://jira.banka.local//",
  secretRef: "kv/jira#token",
  configJson: null,
};

describe("bağlantı seçimi iki Jira türünü de tanır", () => {
  it("Cloud bulunur", () => {
    expect(findJiraConnection([CLOUD]).kind).toBe("jira_cloud");
  });

  it("DATA CENTER da bulunur — arızanın kendisi buydu", () => {
    expect(findJiraConnection([DC]).kind).toBe("jira_dc");
  });

  it("etkin olan, kapalı olana tercih edilir", () => {
    const rows = [
      { ...DC, enabled: false, baseUrl: "https://eski.banka.local" },
      { ...DC, enabled: true, baseUrl: "https://yeni.banka.local" },
    ];
    expect(findJiraConnection(rows).baseUrl).toBe("https://yeni.banka.local");
  });

  it("sondaki eğik çizgiler atılır — çift eğik çizgili URL 404 verir", () => {
    expect(findJiraConnection([DC]).baseUrl).toBe("https://jira.banka.local");
    expect(findJiraConnection([CLOUD]).baseUrl).toBe("https://kurum.atlassian.net");
  });

  it("Jira olmayan bağlantılar seçilmez", () => {
    const rows = [{ ...CLOUD, kind: "ado" }, { ...CLOUD, kind: "github" }];
    expect(() => findJiraConnection(rows)).toThrow(/Jira bağlantısı yok/u);
  });

  it("'bağlantı yok' ile 'jeton yok' AYRI arızalardır", () => {
    expect(() => findJiraConnection([])).toThrow(/Jira bağlantısı yok/u);
    expect(() => findJiraConnection([{ ...DC, secretRef: null }])).toThrow(/jetonu yok/u);
  });

  it("Cloud'da e-posta yoksa erken durur — yoksa 401 'jeton yanlış' gibi okunur", () => {
    expect(() => findJiraConnection([{ ...CLOUD, configJson: {} }])).toThrow(/e-posta yok/u);
  });

  it("DC e-posta İSTEMEZ", () => {
    expect(findJiraConnection([DC]).email).toBe("");
  });

  it.each([
    ["jira_cloud", true],
    ["jira_dc", true],
    ["ado", false],
    ["github", false],
    ["confluence", false],
  ])("isJiraKind(%s) = %s", (kind, expected) => {
    expect(isJiraKind(kind)).toBe(expected);
  });
});

describe("kimlik doğrulama şeması türe göre değişir", () => {
  it("Cloud: email:token, Basic", () => {
    const header = jiraAuthHeader(findJiraConnection([CLOUD]), "T0K3N");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice(6), "base64").toString()).toBe("bot@kurum.com:T0K3N");
  });

  it("Data Center: PAT, Bearer — Basic gönderilirse her çağrı 401 döner", () => {
    expect(jiraAuthHeader(findJiraConnection([DC]), "T0K3N")).toBe("Bearer T0K3N");
  });

  it("başlıklar accept taşır", () => {
    for (const row of [CLOUD, DC]) {
      expect(jiraHeaders(findJiraConnection([row]), "t")["accept"]).toBe("application/json");
    }
  });
});

describe("API sürümü türe göre değişir", () => {
  it("Cloud v3, Data Center v2", () => {
    expect(jiraApiBase(findJiraConnection([CLOUD]))).toBe("/rest/api/3");
    expect(jiraApiBase(findJiraConnection([DC]))).toBe("/rest/api/2");
  });

  it("jiraUrl tam adresi doğru sürümle kurar", () => {
    expect(jiraUrl(findJiraConnection([CLOUD]), "/field")).toBe(
      "https://kurum.atlassian.net/rest/api/3/field",
    );
    expect(jiraUrl(findJiraConnection([DC]), "/field")).toBe(
      "https://jira.banka.local/rest/api/2/field",
    );
  });

  it("baştaki eğik çizgi isteğe bağlıdır", () => {
    const conn = findJiraConnection([DC]);
    expect(jiraUrl(conn, "issue/OPS-1")).toBe(jiraUrl(conn, "/issue/OPS-1"));
  });
});

/**
 * KOPYA GERİ GELMESİN.
 *
 * Asıl arıza bir eksik `||` değil, altı aracın bağlantı seçimini kendi
 * kopyasıyla yapmasıydı — biri düzeltilince ötekiler eski hâlinde kalıyordu.
 * Bu blok, kopyanın yeniden doğmasını bin dizinini tarayarak engeller.
 */
describe("teşhis araçları ortak çözücüyü kullanır", () => {
  const BIN = new URL("../src/bin/", import.meta.url).pathname;
  const tools = readdirSync(BIN)
    .filter((f) => f.endsWith(".ts") && f !== "jira-connection.ts")
    .map((f) => ({ name: f, text: readFileSync(join(BIN, f), "utf8") }));

  it("hiçbir araç bağlantıyı elle SEÇMEZ", () => {
    for (const { name, text } of tools) {
      // `tani.ts` bağlantıları LİSTELER (tek bir tane seçmez) — o meşru.
      if (name === "tani.ts") continue;
      expect(text.includes('c.kind === "jira_cloud"'), `${name} bağlantıyı elle seçiyor`).toBe(
        false,
      );
    }
  });

  it("hiçbir araç Basic auth'u ELLE kurmaz", () => {
    for (const { name, text } of tools) {
      expect(/Basic \$\{Buffer/u.test(text), `${name} auth başlığını elle kuruyor`).toBe(false);
    }
  });

  it("hiçbir araç API sürümünü SABİTLEMEZ", () => {
    for (const { name, text } of tools) {
      const inCode = text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .join("\n");
      expect(/\/rest\/api\/[23]\//u.test(inCode), `${name} API sürümünü sabitliyor`).toBe(false);
    }
  });
});
