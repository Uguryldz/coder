import { describe, expect, it } from "vitest";
import {
  decisionLogLine,
  decisionLogMarkdown,
  type IntakeDecisionFacts,
} from "../src/intake-decision-log.js";

/**
 * Alım kararının dökümü.
 *
 * Bu modülün tek işi, operatörün "ajan çalışmıyor" dediği anda cevabı TEK
 * yerde göstermek. O yüzden testler biçimi değil, dökümün SÖYLEDİĞİ ŞEYİ
 * ölçüyor: eşleşme yoksa sebebini söylüyor mu, akış seçilmediyse bunun tam
 * boru hattı demek olduğunu söylüyor mu.
 */

const AT = new Date("2026-08-31T09:00:00.000Z");

function facts(over: Partial<IntakeDecisionFacts> = {}): IntakeDecisionFacts {
  return {
    ticket: "OPS-41",
    projectKey: "OPS",
    source: "maestro-worker",
    status: "Analiz Bekliyor",
    issueType: "Hikaye",
    assignee: "712020:bot",
    decision: { flow: "analiz", reason: "rule", ruleId: "lr_1", statusMap: null },
    rulesConsidered: 3,
    analystVariantId: "analyst-default",
    engineerVariantId: "engineer-default",
    accepted: true,
    ...over,
  };
}

describe("karar log satırı", () => {
  it("kuralı, sebebi, akışı ve iki ajanı tek satırda söyler", () => {
    const line = decisionLogLine(facts());
    expect(line).toContain("OPS-41");
    expect(line).toContain("alındı");
    expect(line).toContain("kural=lr_1");
    expect(line).toContain("akis=analiz");
    expect(line).toContain("analist=analyst-default");
    expect(line).toContain("muhendis=engineer-default");
  });

  it("reddedilen alımda sebebi yazar", () => {
    const line = decisionLogLine(
      facts({ accepted: false, refusedReason: "no_application" }),
    );
    expect(line).toContain("alınmadı (no_application)");
  });

  /**
   * Kural bir ajan ADI YAZMAMIŞSA satır "varsayilan" der, boş ya da
   * "(bilinmiyor)" değil: bu bir bilgi EKSİĞİ değil, operatörün yaptığı geçerli
   * bir seçim — kural ajanı ezmiyor, platform varsayılanı koşuyor. İkisini
   * karıştırmak, olmayan bir arızayı aratır.
   */
  it("kural ajan yazmamışsa 'varsayilan' der, boş bırakmaz", () => {
    const line = decisionLogLine(facts({ analystVariantId: null, engineerVariantId: "" }));
    expect(line).toContain("analist=varsayilan");
    expect(line).toContain("muhendis=varsayilan");
  });
});

describe("karar dökümü (.md)", () => {
  it("eşleşen kuralda kuralı ve akışın ne yaptığını yazar", () => {
    const md = decisionLogMarkdown(facts(), AT);
    expect(md).toContain("# Alım kararı — OPS-41");
    expect(md).toContain("lr_1");
    expect(md).toContain("kod YAZILMAZ");
    // Eşleşme varsa "neden eşleşmedi" bölümü hiç görünmemeli.
    expect(md).not.toContain("Neden hiçbir kural eşleşmedi");
  });

  it("akış seçilmediyse bunun TAM BORU HATTI demek olduğunu söyler", () => {
    const md = decisionLogMarkdown(
      facts({ decision: { flow: null, reason: "none" } }),
      AT,
    );
    expect(md).toContain("TAM BORU HATTI");
    expect(md).toContain("UYGULANMADIĞINI");
  });

  /**
   * Bankanın gerçek vakası: tarama yolu durum/tip/atanan alanlarının hiçbirini
   * taşımıyor, dolayısıyla hiçbir kural eşleşemiyor. Döküm bunu ADIYLA
   * söylemezse operatör kuralı tekrar tekrar düzenler — kuralda hata yokken.
   */
  it("alanlar bilinmiyorsa her birini ayrı ayrı sebep olarak gösterir", () => {
    const md = decisionLogMarkdown(
      facts({
        status: null,
        issueType: null,
        assignee: null,
        decision: { flow: null, reason: "none" },
      }),
      AT,
    );
    expect(md).toContain("Neden hiçbir kural eşleşmedi");
    expect(md).toContain("DURUMU bu yolda bilinmiyor");
    expect(md).toContain("TİPİ bu yolda bilinmiyor");
    expect(md).toContain("ATANANI bu yolda bilinmiyor");
  });

  it("hiç kural okunmadıysa sorunun kuralda değil kural yokluğunda olduğunu söyler", () => {
    const md = decisionLogMarkdown(
      facts({ rulesConsidered: 0, decision: { flow: null, reason: "none" } }),
      AT,
    );
    expect(md).toContain("Hiç dinleme kuralı okunamadı");
  });

  it("çakışan kuralları adıyla sayar", () => {
    const md = decisionLogMarkdown(
      facts({
        decision: {
          flow: "analiz",
          reason: "rule_conflict",
          ruleId: "lr_1",
          conflictingRuleIds: ["lr_1", "lr_2"],
          statusMap: null,
        },
      }),
      AT,
    );
    expect(md).toContain("lr_1, lr_2");
  });

  it("durum eşlemesi yoksa panonun oynatılmayacağını söyler", () => {
    const md = decisionLogMarkdown(facts(), AT);
    expect(md).toContain("yalnızca yorum modu");
  });
});
