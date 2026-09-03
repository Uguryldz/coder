import type { AnalysisDoc, LlmCallLog } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { discoverRepo, fanOutChildren, publishAnalysis, writeAnalysis } from "../src/impl/analysis.js";
import { makeFakes } from "./fakes.js";
import { analysisDoc } from "./harness.js";

const LOG: LlmCallLog = {
  at: "2026-08-09T09:00:00+03:00",
  runId: null,
  role: "analyst",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};

const session = () => ({
  status: "ok" as const,
  value: { resumeToken: "session-9", finalText: "modüller: pay-core", log: LOG as never },
  log: LOG,
});

describe("discoverRepo (step 3ö, M100)", () => {
  it("keeps the session so step 6a continues the same conversation (M30)", async () => {
    const fakes = makeFakes({
      agentSession: session,
      generateObject: () => ({ status: "ok", value: { files: 12, modules: ["pay-core"] }, log: LOG }),
    });
    const found = await discoverRepo(fakes.deps, "PAY-101", "pay");
    expect(found).toEqual({ files: 12, modules: ["pay-core"] });
    expect(fakes.patches).toContainEqual({ resumeToken: "session-9" });
  });

  it("a degraded gateway costs the discovery, not the ticket", async () => {
    const fakes = makeFakes({
      agentSession: () => ({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
    });
    expect(await discoverRepo(fakes.deps, "PAY-101", "pay")).toEqual({ files: 0, modules: [] });
  });
});

describe("writeAnalysis (step 3, M43/M51/M83)", () => {
  const okDoc = (over: Partial<AnalysisDoc> = {}) => ({
    status: "ok" as const,
    value: { ...analysisDoc("kritik"), ...over },
    log: LOG,
  });

  it("takes the risk tier from the document, never from a parameter", async () => {
    const fakes = makeFakes({ generateObject: () => okDoc() });
    const written = await writeAnalysis(fakes.deps, "PAY-101", "pay");
    expect(written.risk).toBe("kritik");
    expect(written.analysis.riskTier).toBe("kritik");
    expect(fakes.patches).toContainEqual({ risk: "kritik" });
  });

  it("refuses a document written against another template version (M83)", async () => {
    const fakes = makeFakes({ generateObject: () => okDoc({ templateVersion: "analysis@0.9.0" }) });
    await expect(writeAnalysis(fakes.deps, "PAY-101", "pay")).rejects.toMatchObject({
      type: "AnalysisTemplateMismatch",
    });
  });

  it("refuses a document written in the wrong language (M59/M104)", async () => {
    const fakes = makeFakes({ generateObject: () => okDoc({ language: "en" }) });
    await expect(writeAnalysis(fakes.deps, "PAY-101", "pay")).rejects.toMatchObject({
      type: "AnalysisLanguageMismatch",
    });
  });

  it("refuses a document that is missing one of the seven sections", async () => {
    const partial = { ...analysisDoc("orta") } as Record<string, unknown>;
    delete partial["testApproach"];
    const fakes = makeFakes({
      generateObject: () => ({ status: "ok", value: partial, log: LOG }),
    });
    await expect(writeAnalysis(fakes.deps, "PAY-101", "pay")).rejects.toThrow();
  });

  it("a degraded gateway stops the analysis rather than shipping a stub (M97)", async () => {
    const fakes = makeFakes({
      generateObject: () => ({ status: "degraded", messageKey: "llm.degraded", dataClass: "gizli" }),
    });
    await expect(writeAnalysis(fakes.deps, "PAY-101", "pay")).rejects.toMatchObject({
      type: "AiAssistRequired",
    });
  });
});

describe("publishAnalysis (M47)", () => {
  it("renders the document once and publishes it once, however often it is retried", async () => {
    const fakes = makeFakes();
    await publishAnalysis(fakes.deps, "PAY-101", analysisDoc("orta"));
    await publishAnalysis(fakes.deps, "PAY-101", analysisDoc("orta"));

    expect(fakes.recorded.published).toHaveLength(1);
    expect(fakes.recorded.published[0]?.doc).toBe("analysis");
    expect(fakes.recorded.published[0]?.markdown).toContain("analysis@1.0.0");
  });
});

describe("fanOutChildren (M100)", () => {
  const withImpact = (): AnalysisDoc => ({
    ...analysisDoc("orta"),
    impactMatrix: [
      { appId: "pay", impacted: true, summary: "ana repo", source: "primary_repo_discovery" },
      { appId: "ledger", impacted: true, summary: "muhasebe kaydı", source: "repo_card" },
      { appId: "crm", impacted: false, summary: "etkisiz", source: "repo_card" },
      { appId: "billing", impacted: true, summary: "fatura", source: "repo_card" },
    ],
  });

  it("opens one child per impacted OTHER application, in a stable order", async () => {
    const fakes = makeFakes();
    const children = await fanOutChildren(fakes.deps, "PAY-101", withImpact());

    expect(children).toHaveLength(2);
    expect(fakes.recorded.children.map((c) => c.description)).toEqual(["fatura", "muhasebe kaydı"]);
  });

  it("never opens a child for the primary application or an unaffected one", async () => {
    const fakes = makeFakes();
    await fanOutChildren(fakes.deps, "PAY-101", withImpact());
    const summaries = fakes.recorded.children.map((c) => c.summary).join(" ");
    expect(summaries).not.toContain("pay");
    expect(summaries).not.toContain("crm");
  });

  it("a retry re-uses the children it already opened", async () => {
    const fakes = makeFakes();
    const first = await fanOutChildren(fakes.deps, "PAY-101", withImpact());
    const second = await fanOutChildren(fakes.deps, "PAY-101", withImpact());
    expect(second).toEqual(first);
    expect(fakes.recorded.children).toHaveLength(2);
  });
});

describe("the analysis-only run — no application bound", () => {
  const okDoc = () => ({ status: "ok" as const, value: analysisDoc("orta"), log: LOG });

  it("writeAnalysis composes its prompt from the ticket alone, with no appId key", async () => {
    const fakes = makeFakes({
      context: { app: null, workspacePath: "" },
      generateObject: () => okDoc(),
    });
    const written = await writeAnalysis(fakes.deps, "PAY-101");
    expect(written.risk).toBe("orta");

    const call = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc");
    const input = call?.input as Record<string, unknown>;
    // Only the repo-derived fact is gone. The analyst must not be told the
    // application is named "" — and must still get everything the ticket-text
    // mode genuinely has: the language, the pinned template, the ticket itself.
    expect(Object.keys(input)).not.toContain("appId");
    expect(input).toMatchObject({
      locale: "tr",
      templateVersion: "analysis@1.0.0",
      summary: "ödeme iki kez düşüyor",
      description: "müşteri iki kez ücretlendiriliyor",
    });
  });

  it("regression: with an appId the prompt still carries it, unchanged", async () => {
    const fakes = makeFakes({ generateObject: () => okDoc() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const call = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc");
    expect((call?.input as Record<string, unknown>)["appId"]).toBe("pay");
  });

  it("fanOutChildren has no primary to exclude: every impacted cell gets its child", async () => {
    const impact: AnalysisDoc = {
      ...analysisDoc("orta"),
      impactMatrix: [
        { appId: "pay", impacted: true, summary: "ödeme servisi", source: "repo_card" },
        { appId: "ledger", impacted: true, summary: "muhasebe kaydı", source: "repo_card" },
        { appId: "crm", impacted: false, summary: "etkisiz", source: "repo_card" },
      ],
    };
    const fakes = makeFakes({ context: { app: null, workspacePath: "" } });
    const children = await fanOutChildren(fakes.deps, "PAY-101", impact);

    // With a primary app, "pay" would have been the parent's own work item and
    // been excluded; with none, it is honestly another application. Stable
    // appId order, unimpacted cells still skipped.
    expect(children).toHaveLength(2);
    expect(fakes.recorded.children.map((c) => c.description)).toEqual([
      "muhasebe kaydı",
      "ödeme servisi",
    ]);
  });
});

/**
 * Studio'nun "Ajan tanımları" ekranındaki Persona alanı, `VariantVersion.
 * configJson.persona` içinde duruyor, `/variants` ile geri okunuyordu — ve
 * akışa HİÇ ulaşmıyordu. Admin ajanın nasıl davranacağını yazıyor, model onu
 * hiç görmüyordu. Bu blok, analiz adımında artık gördüğünü ölçüyor.
 */
describe("analiz adımı Studio'da tanımlı personayı görüyor", () => {
  const doc = analysisDoc("orta");
  const ok = () => ({ status: "ok" as const, value: doc, log: LOG });

  it("persona `input`'un İLK alanı — rol talimatı, uygulanacağı verinin önünde", async () => {
    const fakes = makeFakes({
      persona: { v1: "Bankacılık jargonuna hakim, ölçülü bir analistsin." },
      generateObject: () => ok(),
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const call = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc");
    const input = call?.input as Record<string, unknown>;
    expect(input["persona"]).toBe("Bankacılık jargonuna hakim, ölçülü bir analistsin.");
    expect(Object.keys(input)[0]).toBe("persona");
  });

  it("persona ANALİST varyantından okunur (mühendisinkinden değil)", async () => {
    const fakes = makeFakes({
      context: { variantId: "analist-7", engineerVariantId: "muhendis-9" },
      persona: { "analist-7": "analist personası", "muhendis-9": "mühendis personası" },
      generateObject: () => ok(),
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const input = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as Record<
      string,
      unknown
    >;
    expect(input["persona"]).toBe("analist personası");
  });

  it("persona yazılmamışsa alan HİÇ gitmez — modele adı boş bir ajan tarif edilmez", async () => {
    const fakes = makeFakes({ persona: { v1: "   " }, generateObject: () => ok() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const input = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as object;
    expect("persona" in input).toBe(false);
  });

  it("seam bağlı değilse bugünkü davranış aynen — persona alanı yok", async () => {
    const fakes = makeFakes({ generateObject: () => ok() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    const input = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as object;
    expect("persona" in input).toBe(false);
  });

  it("persona okuması patlarsa ANALİZ DÜŞMEZ — persona bir üst katman, koşulu değil", async () => {
    const fakes = makeFakes({
      persona: { v1: new Error("postgres unreachable") },
      generateObject: () => ok(),
    });
    const result = await writeAnalysis(fakes.deps, "PAY-101", "pay");
    expect(result.risk).toBe(doc.riskTier);
    const input = fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as object;
    expect("persona" in input).toBe(false);
  });
});

/**
 * ── YENİDEN YAZIM BAĞLAMI PROMPTA GİRİYOR ────────────────────────────────────
 *
 * Operatörün kuralı: "ben yorum yazsam da yazmasam da, geri gönderince tekrar
 * incelesin, bağlam kaybı olmasın diye geçmiş var zaten". Yukarıdaki bloklar
 * `writeAnalysis`'in ticket metnini gördüğünü ölçüyor; burası GEÇMİŞİ de
 * gördüğünü ölçüyor — ve geçmiş yoksa promptun bugünküyle bit bit aynı
 * kaldığını.
 */
describe("analiz yeniden yazılırken geçmişi görüyor", () => {
  const doc = analysisDoc("orta");
  const ok = () => ({ status: "ok" as const, value: doc, log: LOG });
  const inputOf = (fakes: ReturnType<typeof makeFakes>): Record<string, unknown> =>
    fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as Record<
      string,
      unknown
    >;

  it("bağlam verilmezse prompt BUGÜNKÜYLE aynı — `rewrite` alanı hiç gitmez", async () => {
    const fakes = makeFakes({ generateObject: () => ok() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay");
    expect("rewrite" in inputOf(fakes)).toBe(false);
  });

  it("geri gönderme gerekçesi prompta giriyor", async () => {
    const fakes = makeFakes({ generateObject: () => ok() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay", { reason: "kabul kriterleri eksik" });
    expect(String(inputOf(fakes)["rewrite"])).toContain("kabul kriterleri eksik");
  });

  /**
   * OPERATÖRÜN KURALININ ZOR YARISI: gerekçe YOK, ama bağlam var.
   *
   * Karar statüyle verildiğinde yazılı gerekçe olmaz. "Yorum yazsam da yazmasam
   * da tekrar incelesin" tam olarak bunu söylüyor — ve o durumda tek bağlam
   * kaynağı ticket yorumları ile önceki analizdir.
   */
  it("gerekçe YOKKEN ticket yorumları bağlamı taşıyor", async () => {
    const fakes = makeFakes({
      generateObject: () => ok(),
      comments: [
        { author: { accountId: "uyildiz" }, body: "kabul kriterlerine limit kontrolü ekleyin" },
      ],
      botUserId: "maestro-bot",
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay", {});
    const note = String(inputOf(fakes)["rewrite"]);
    expect(note).toContain("uyildiz");
    expect(note).toContain("limit kontrolü");
  });

  it("Maestro'nun KENDİ yorumları elenir — model kendi çıktısını cevap sanmaz", async () => {
    const fakes = makeFakes({
      generateObject: () => ok(),
      comments: [
        { author: { accountId: "maestro-bot" }, body: "analiz yayımlandı" },
        { author: { accountId: "uyildiz" }, body: "gerçek yorum" },
      ],
      botUserId: "maestro-bot",
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay", {});
    const note = String(inputOf(fakes)["rewrite"]);
    expect(note).toContain("gerçek yorum");
    expect(note).not.toContain("analiz yayımlandı");
  });

  it("komut zarfları (`/approve`) bağlam değil — elenir", async () => {
    const fakes = makeFakes({
      generateObject: () => ok(),
      comments: [{ author: { accountId: "uyildiz" }, body: "/approve" }],
      botUserId: "maestro-bot",
    });
    await writeAnalysis(fakes.deps, "PAY-101", "pay", {});
    // Elenince geriye hiçbir parça kalmıyor: alan HİÇ gitmiyor.
    expect("rewrite" in inputOf(fakes)).toBe(false);
  });

  /**
   * ÖNCEKİ ANALİZDEN BELGENİN TAMAMI DEĞİL, KİMLİĞİ GİDİYOR.
   *
   * Tamamını göndermek modele kopyalayacağı bir şablon vermek olurdu — istenen
   * yeniden DÜŞÜNMEK, yeniden biçimlendirmek değil. Giden şey "bunu daha önce
   * şöyle değerlendirmiştim" cümlesini kurmaya yetecek en küçük küme.
   */
  it("önceki analizden risk gerekçesi ve kabul kriterleri gidiyor, belgenin tamamı DEĞİL", async () => {
    const fakes = makeFakes({ generateObject: () => ok() });
    const previous = { ...analysisDoc("kritik"), riskReason: "ödeme akışına dokunuyor" };
    await writeAnalysis(fakes.deps, "PAY-101", "pay", { previous });
    const note = String(inputOf(fakes)["rewrite"]);
    expect(note).toContain("kritik");
    expect(note).toContain("ödeme akışına dokunuyor");
    expect(note).toContain(previous.acceptanceCriteria[0]!);
    // Belgenin ANLATI bölümleri gitmiyor — prompt şişmesin.
    expect(note).not.toContain(previous.testApproach);
    expect(note).not.toContain(previous.uiApiChanges);
  });

  it("yorum okuması patlarsa analiz DÜŞMEZ — gerekçe yine geçer", async () => {
    const fakes = makeFakes({
      generateObject: () => ok(),
      comments: new Error("jira 503"),
    });
    const written = await writeAnalysis(fakes.deps, "PAY-101", "pay", { reason: "kapsam yanlış" });
    expect(written.risk).toBe(doc.riskTier);
    expect(String(inputOf(fakes)["rewrite"])).toContain("kapsam yanlış");
  });

  it("bağlam bloğu ticket metninin ARDINDAN gider — talep önce, gerekçe sonra", async () => {
    const fakes = makeFakes({ generateObject: () => ok() });
    await writeAnalysis(fakes.deps, "PAY-101", "pay", { reason: "bir daha bak" });
    const keys = Object.keys(inputOf(fakes));
    expect(keys.indexOf("rewrite")).toBeGreaterThan(keys.indexOf("description"));
  });
});
