import { describe, expect, it } from "vitest";
import { roleResolver } from "../src/stores/gate-directory.js";

/**
 * ROL → DİZİN GRUBU EŞLEMESİ — ve eşlemenin YOKLUĞU.
 *
 * ── Ölçülmüş arıza ────────────────────────────────────────────────────────
 * Eşleme yokken son çare rolün KENDİ ADIYDI (`product-owners`). O ad Jira'da
 * bir grup değil, dolayısıyla `verifyMembership` 404 alıyor ve HER kapı kararı
 * — `/approve` yorumu da, statü taşıması da — sessizce düşüyordu. Operatör
 * statüyü taşıyor, hiçbir şey olmuyor, ekranda tek bir sebep satırı yok.
 *
 * Asıl kusur, o fallback'in İKİ AYRI DURUMU tek cevaba indirmesiydi: "grup
 * eşlendi ama yanlış eşlendi" ile "hiç eşlenmedi". İkisi de 404 üretiyor ama
 * biri bir yazım hatası, diğeri bir kurulum tercihi — ve karışınca ikisine de
 * doğru davranmak imkânsız.
 */
describe("roleResolver", () => {
  it("GATE_GROUPS eşlemesini okur", () => {
    const resolve = roleResolver({
      GATE_GROUPS: "product-owners=jira-users-uyildiz,tech-leads=jira-admins",
    });
    expect(resolve("product-owners")).toBe("jira-users-uyildiz");
    expect(resolve("tech-leads")).toBe("jira-admins");
  });

  it("eşlenmemiş rolü GATE_GROUP_DEFAULT karşılar", () => {
    const resolve = roleResolver({
      GATE_GROUPS: "product-owners=po-group",
      GATE_GROUP_DEFAULT: "hepsi",
    });
    expect(resolve("tech-leads")).toBe("hepsi");
  });

  /**
   * Bu satır düzeltmenin kalbi: hiçbir eşleme yoksa cevap `null` — rolün kendi
   * adı DEĞİL. `null` sayesinde çağıran "yapılandırılmamış"ı ayırt edebiliyor
   * ve olmayan bir gruba üyelik sormaya kalkmıyor.
   */
  it("hiçbir eşleme yoksa null döner — rol adına DÜŞMEZ", () => {
    expect(roleResolver({})("product-owners")).toBeNull();
    expect(roleResolver({ GATE_GROUPS: "", GATE_GROUP_DEFAULT: "" })("tech-leads")).toBeNull();
  });

  /**
   * Dizini bu adlarla kurmuş bir kurulum etkilenmez, ama artık bunu AÇIKÇA
   * söylemesi gerekiyor. Açık olan, tahmin edilmiş olandan her zaman iyidir:
   * eskiden "eşleme yok" ile "eşleme rol adına eşit" aynı şeydi.
   */
  it("rol adının kendisi grup adıysa açıkça eşlenebilir", () => {
    const resolve = roleResolver({ GATE_GROUPS: "product-owners=product-owners" });
    expect(resolve("product-owners")).toBe("product-owners");
  });

  it("bozuk girdileri düşürür, tahmin etmez", () => {
    const resolve = roleResolver({ GATE_GROUPS: "bozuk,=grup,rol=,product-owners=iyi" });
    expect(resolve("product-owners")).toBe("iyi");
    expect(resolve("bozuk")).toBeNull();
    expect(resolve("rol")).toBeNull();
  });
});
