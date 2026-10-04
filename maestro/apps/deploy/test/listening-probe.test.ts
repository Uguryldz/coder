import { describe, expect, it } from "vitest";
import { probeListeningRule } from "../src/listening-probe.js";

/**
 * "KURALI TEST ET" — kaydetmeden önce kuralı Jira'ya sorup ne getirdiğini görmek.
 *
 * Operatörün kendi cümlesi: "kontrol ekranı ver, loga gerek yok, dinlemede
 * filtre ayarlamak için". Bu testler o provanın üç sınırını çiviliyor: neyi
 * SORMADIĞI (ticket metni), NEREYE sormadığı (bağlanmamış proje), ve eşleşme
 * olmadığında ne gösterdiği (projedeki açık ticket'lar, aynı sütunlarla).
 */

const DRAFT = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype" as const,
  matchValue: "Görev",
  allowedStatuses: null,
};

const TICKET = {
  key: "OPS-12",
  fields: {
    status: { name: "ANALİZ" },
    issuetype: { name: "Task" },
    assignee: { accountId: "maestro-bot" },
    labels: ["maestro"],
  },
};

/** Kural sorgusuna `rule`, teşhis sorgusuna `sample` dönen bir arama. */
function fakeSearch(pages: { rule?: readonly unknown[]; sample?: readonly unknown[] }): {
  search: {
    searchIssues: (r: {
      jql: string;
      fields?: string[];
    }) => Promise<{ issues: Array<{ key?: string }> }>;
  };
  asked: Array<{ jql: string; fields?: string[] }>;
} {
  const asked: Array<{ jql: string; fields?: string[] }> = [];
  return {
    asked,
    search: {
      searchIssues: (request) => {
        asked.push(request);
        const rows = request.jql.includes("statusCategory")
          ? (pages.sample ?? [])
          : (pages.rule ?? []);
        return Promise.resolve({ issues: rows as Array<{ key?: string }> });
      },
    },
  };
}

function options(
  search: ReturnType<typeof fakeSearch>["search"],
  overrides: { bound?: readonly string[]; known?: readonly string[]; boundThrows?: boolean } = {},
): Parameters<typeof probeListeningRule>[0] {
  return {
    search,
    boundProjects: () =>
      overrides.boundThrows === true
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(overrides.bound ?? ["OPS"]),
    known: () => Promise.resolve(overrides.known ?? []),
  };
}

describe("probeListeningRule", () => {
  it("eşleşenleri kuralın dört alanıyla döndürür", async () => {
    const { search } = fakeSearch({ rule: [TICKET] });
    const result = await probeListeningRule(options(search), DRAFT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jql).toContain('project = "OPS"');
    expect(result.jql).toContain('issuetype = "Görev"');
    expect(result.matched).toEqual([
      {
        key: "OPS-12",
        status: "ANALİZ",
        issueType: "Task",
        assignee: "maestro-bot",
        labels: ["maestro"],
        alreadyKnown: false,
      },
    ]);
    // Eşleşme varken karşılaştırma listesi çekilmez: cevabı olan bir soruya
    // ikinci bir tablo ve gereksiz bir sorgu.
    expect(result.projectSample).toEqual([]);
  });

  /**
   * TICKET METNİ YOK. `fields` kuralın kendi sorgusuyla birebir aynı olmalı —
   * bu ekran, tarama yolunun bugüne kadar hiç ticket içeriği taşımamış olmasını
   * bozacak yer değil.
   */
  it("özet/açıklama İSTEMEZ — yalnız dört sınıflandırma alanı", async () => {
    const { search, asked } = fakeSearch({ rule: [], sample: [TICKET] });
    await probeListeningRule(options(search), DRAFT);

    expect(asked).not.toHaveLength(0);
    for (const request of asked) {
      expect(request.fields).toEqual(["status", "issuetype", "assignee", "labels"]);
    }
  });

  /**
   * BAĞLANMAMIŞ PROJEYE DENEME BİLE GİTMEZ.
   *
   * Bu platformun Jira servis hesabı çoğu bankada ADMIN'dir: bağlanmamış bir
   * proje kapsam dışı bir proje değil, Maestro'yu hiç duymamış bir ekibin
   * ticket'larıdır. "Sadece deneme" onu okunmamış yapmaz.
   */
  it("bağlı olmayan projeye hiç sorgu göndermez", async () => {
    const { search, asked } = fakeSearch({ rule: [TICKET] });
    const result = await probeListeningRule(
      options(search, { bound: ["BASKA"] }),
      { ...DRAFT, projectKey: "GIZLI" },
    );

    expect(result).toEqual({ ok: false, reason: "unbound_project" });
    expect(asked).toHaveLength(0);
  });

  /** Fail-closed: süzemediğimiz bir turda deneme, bağlanmamış projelere de giderdi. */
  it("bağlı proje listesi okunamazsa denemez", async () => {
    const { search, asked } = fakeSearch({ rule: [TICKET] });
    const result = await probeListeningRule(options(search, { boundThrows: true }), DRAFT);

    expect(result).toEqual({ ok: false, reason: "bindings_unreadable" });
    expect(asked).toHaveLength(0);
  });

  /**
   * Bot hesabı olmayan bir kural için sorgu ÜRETİLMEZ — turun kendisi de bu
   * kuralı atlar, ve deneme onunla aynı cevabı vermeli. Aksi hâlde panelde
   * çalışıyor görünen bir kural sahada hiç aranmaz.
   */
  it("bot hesabı olmayan kuralı aramaz, sebebini adlandırır", async () => {
    const { search, asked } = fakeSearch({ rule: [TICKET] });
    const result = await probeListeningRule(options(search), { ...DRAFT, assigneeAccountId: "" });

    expect(result).toEqual({ ok: false, reason: "no_bot_account" });
    expect(asked).toHaveLength(0);
  });

  /**
   * EKRANIN ASIL DEĞERİ: 0 eşleşme yarım bir cevaptır. Projedeki açık
   * ticket'ları aynı sütunlarla yan yana koymak, operatörün "kuralım Görev
   * diyor ama Jira'da hepsi Task yazıyor" diyebilmesinin tek yolu.
   */
  it("eşleşme yoksa projedeki açık ticket'ları aynı sütunlarla getirir", async () => {
    const { search } = fakeSearch({ rule: [], sample: [TICKET] });
    const result = await probeListeningRule(options(search), DRAFT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toEqual([]);
    expect(result.sampleJql).toContain('project = "OPS"');
    expect(result.sampleJql).toContain("statusCategory != Done");
    expect(result.projectSample[0]?.issueType).toBe("Task");
    expect(result.projectSample[0]?.assignee).toBe("maestro-bot");
  });

  /**
   * "Bu zaten alınmış." Ölçüldü: 14 ticket bulan bir turda "0 alındı" gören
   * operatör taramayı bozuk sandı — oysa on dördünün de koşusu vardı.
   */
  it("koşusu olan ticket'ı işaretler", async () => {
    const { search } = fakeSearch({ rule: [TICKET] });
    const result = await probeListeningRule(options(search, { known: ["OPS-12"] }), DRAFT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched[0]?.alreadyKnown).toBe(true);
  });

  /** Jira'nın reddi adlandırılmış bir cevaptır; en sık sebebi okuma izni. */
  it("Jira sorguyu reddederse sebebini taşır", async () => {
    const search = { searchIssues: () => Promise.reject(new Error("403 Forbidden")) };
    const result = await probeListeningRule(options(search), DRAFT);

    expect(result).toEqual({ ok: false, reason: "search_failed", detail: "403 Forbidden" });
  });

  /**
   * Karşılaştırma listesi bir KOLAYLIK. Alınamaması denemenin başarısız olması
   * değil: operatör yine de "0 eşleşme" ve ürettiği JQL'i görür.
   */
  it("karşılaştırma sorgusu patlarsa denemeyi düşürmez", async () => {
    const search = {
      searchIssues: (request: { jql: string }) =>
        request.jql.includes("statusCategory")
          ? Promise.reject(new Error("403"))
          : Promise.resolve({ issues: [] }),
    };
    const result = await probeListeningRule(options(search), DRAFT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toEqual([]);
    expect(result.projectSample).toEqual([]);
  });

  /** Statü kapısı da sorguya girer — kuralın kaydedilince arayacağı hâliyle. */
  it("izin verilen statüleri sorguya koyar", async () => {
    const { search } = fakeSearch({ rule: [TICKET] });
    const result = await probeListeningRule(options(search), {
      ...DRAFT,
      allowedStatuses: ["ANALİZ", "To Do"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jql).toContain('status in ("ANALİZ", "To Do")');
  });
});
