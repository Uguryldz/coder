import { describe, expect, it } from "vitest";
import { engineerVariantOf } from "../src/impl/deps.js";
import {
  PERSONA_NOTE_TITLE,
  analystPersona,
  engineerPersona,
  withPersona,
} from "../src/impl/persona.js";
import { runContext } from "./doubles.js";
import { makeFakes } from "./fakes.js";

/**
 * Studio'daki "Persona" alanını akışa taşıyan altyapı.
 *
 * Metin `VariantVersion.configJson.persona` içinde duruyor, Studio'da yazılıyor,
 * `/variants` ile geri okunuyor — ve bu pakete HİÇ ulaşmıyordu: `persona`
 * kelimesi `packages/workflows/src` içinde bir kez bile geçmiyordu. Pilot onu
 * okuyup analize ilk bilgi notu olarak veriyor; banka pilotu değil worker'ı
 * çalıştırıyor. Yani admin ajanın nasıl davranacağını yazıyor, model görmüyordu.
 *
 * Aşağıdakiler o altyapıyı sınıyor. Personayı prompta KOYAN satırlar
 * `intake.ts`/`analysis.ts` içinde; bu testler onları beklemeden, taşıyıcının
 * doğru davrandığını sabitliyor.
 */

describe("analystPersona / engineerPersona", () => {
  it("analistin personasını run'ın variantId'sinden okur", async () => {
    const { deps } = makeFakes({ persona: { v1: "Sen kredi analistisin." } });

    expect(await analystPersona(deps, runContext())).toBe("Sen kredi analistisin.");
  });

  it("mühendisin personasını MÜHENDİS ajanından okur, analistinkinden değil", async () => {
    // İki ajanlı kurulumun tam sınavı: iki farklı metin, iki farklı ajan.
    const { deps } = makeFakes({
      context: { variantId: "analyst-kredi", engineerVariantId: "engineer-kredi" },
      persona: { "analyst-kredi": "ANALİST METNİ", "engineer-kredi": "MÜHENDİS METNİ" },
    });
    const run = runContext({ variantId: "analyst-kredi", engineerVariantId: "engineer-kredi" });

    expect(await analystPersona(deps, run)).toBe("ANALİST METNİ");
    expect(await engineerPersona(deps, run)).toBe("MÜHENDİS METNİ");
  });

  it("ayrı bir mühendis ajanı iğnelenmemişse analistin personasını kullanır", async () => {
    // Göç 0022 öncesi açılmış her run ve tek ajanlı her kurulum. Doğru cevap
    // "persona yok" DEĞİL — tek ajan varsa personası da odur.
    const { deps } = makeFakes({ persona: { v1: "TEK AJANIN METNİ" } });

    expect(await engineerPersona(deps, runContext({ engineerVariantId: "" }))).toBe("TEK AJANIN METNİ");
  });

  it("persona okuyucusu bağlı değilse undefined — bugünkü davranış", async () => {
    // `makeFakes`'e `persona` verilmezse `deps.persona` hiç bağlanmaz. Bu hâl
    // "her rol kurumun agent-roles varsayılan promptuyla koşar" demek.
    const { deps } = makeFakes();

    expect(await analystPersona(deps, runContext())).toBeUndefined();
  });

  it("ajan için persona yazılmamışsa undefined — null gerçek bir cevaptır", async () => {
    const { deps } = makeFakes({ persona: { "baska-ajan": "metin" } });

    expect(await analystPersona(deps, runContext())).toBeUndefined();
  });

  it("yalnızca boşluktan ibaret persona yok sayılır", async () => {
    // Boş bir overlay, promptun başına anlamsız bir başlık koymaktan başka bir
    // şey yapmazdı.
    const { deps } = makeFakes({ persona: { v1: "   \n  " } });

    expect(await analystPersona(deps, runContext())).toBeUndefined();
  });

  it("okuma patlarsa adım DÜŞMEZ, ama uyarı yazılır", async () => {
    // Persona bir üst katman, akışın koşulu değil: Postgres erişilemiyor diye
    // onaylanmayı bekleyen bir analizi düşürmek orantısız olurdu.
    const { deps } = makeFakes({ persona: { v1: new Error("connection refused") } });
    const warnings: string[] = [];

    const persona = await analystPersona(deps, runContext(), (m) => warnings.push(m));

    expect(persona).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("v1");
    expect(warnings[0]).toContain("varsayılan rol promptuyla");
  });
});

describe("withPersona", () => {
  const notes = [{ title: "BDDK uyum", content: "kural" }];

  it("personayı listenin BAŞINA koyar — rol talimatı kurallardan önce okunur", async () => {
    const merged = withPersona(notes, "Sen kredi analistisin.");

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ title: PERSONA_NOTE_TITLE, content: "Sen kredi analistisin." });
    expect(merged[1]).toEqual(notes[0]);
  });

  it("persona yoksa listeyi OLDUĞU GİBİ döndürür", async () => {
    // Aynı referans: "persona bağlı değil" hâli çağıran için tam anlamıyla
    // hiçbir değişiklik değil.
    expect(withPersona(notes, undefined)).toBe(notes);
  });

  it("başlığı pilotunkiyle birebir aynıdır", async () => {
    // Aynı ajanı pilotla deneyip worker'a alan operatör iki farklı prompt
    // görmemeli; başlık `apps/pilot/src/run.ts` ile aynı sabit.
    expect(PERSONA_NOTE_TITLE).toBe("Ajan talimatı (persona)");
  });
});

describe("engineerVariantOf", () => {
  it("iğnelenmiş mühendis ajanını döndürür", async () => {
    expect(engineerVariantOf(runContext({ engineerVariantId: "engineer-kredi" }))).toBe("engineer-kredi");
  });

  it("iğne boşsa analistin varyantına düşer — göç öncesi davranış", async () => {
    expect(engineerVariantOf(runContext({ variantId: "v1", engineerVariantId: "" }))).toBe("v1");
  });

  it("yalnızca boşluk da 'iğne yok' demektir", async () => {
    expect(engineerVariantOf(runContext({ variantId: "v1", engineerVariantId: "   " }))).toBe("v1");
  });
});
