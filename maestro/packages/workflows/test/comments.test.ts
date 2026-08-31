import { describe, expect, it } from "vitest";
import {
  COMMENT_BLOCK_TITLE,
  MAX_COMMENTS,
  MAX_COMMENT_TEXT,
  commentAuthorId,
  commentText,
  humanCommentsOf,
  withComments,
} from "../src/impl/comments.js";
import { SNAPSHOT } from "./doubles.js";

/**
 * İki Jira lehçesi, tek ayıklama. Cloud (REST v3) yazarı `accountId` ile ve
 * gövdeyi ADF belgesi olarak verir; Data Center (REST v2) `accountId` bilmez ve
 * gövdeyi düz string gönderir. Bir lehçeyi kaçırmak, o kurulumda yorumların
 * SESSİZCE hiç okunmaması demek — yani intake'in netleştirme cevabını hiç
 * görmemesi ve ticket'ı sonsuza dek iade etmesi.
 */

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("commentAuthorId — iki lehçe", () => {
  it("Cloud: `accountId`", () => {
    expect(commentAuthorId({ accountId: "712020:abc", displayName: "Uğur" })).toBe("712020:abc");
  });

  it("Data Center: `name`, `key` veya `emailAddress`", () => {
    expect(commentAuthorId({ name: "uyildiz" })).toBe("uyildiz");
    expect(commentAuthorId({ key: "JIRAUSER1" })).toBe("JIRAUSER1");
    expect(commentAuthorId({ emailAddress: "u@bank" })).toBe("u@bank");
  });

  it("`displayName` KİMLİK DEĞİL — iki kişi aynı ada sahip olabilir", () => {
    expect(commentAuthorId({ displayName: "Uğur Yıldız" })).toBe("");
  });

  it("kimliksiz/bozuk yazar boş string", () => {
    expect(commentAuthorId(null)).toBe("");
    expect(commentAuthorId("uyildiz")).toBe("");
    expect(commentAuthorId({ accountId: "   " })).toBe("");
  });
});

describe("commentText — iki lehçe", () => {
  it("Data Center: gövde zaten düz string", () => {
    expect(commentText("prod ortamında oluyor")).toBe("prod ortamında oluyor");
  });

  it("Cloud: ADF belgesinin metni toplanır", () => {
    expect(commentText(adf("prod ortamında oluyor"))).toBe("prod ortamında oluyor");
  });

  it("iç içe ADF düğümleri de toplanır (liste, panel, alıntı)", () => {
    const nested = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "bir" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "iki" }] }] },
          ],
        },
      ],
    };
    expect(commentText(nested)).toBe("bir\niki");
  });

  it("tanınmayan gövde boş metin — patlamaz", () => {
    expect(commentText(null)).toBe("");
    expect(commentText(42)).toBe("");
    expect(commentText({ type: "doc" })).toBe("");
  });
});

describe("humanCommentsOf — neyin bağlama girdiği", () => {
  const cloud = (accountId: string, text: string) => ({ author: { accountId }, body: adf(text) });
  const dc = (name: string, body: string) => ({ author: { name }, body });

  it("botun KENDİ notlarını eler", () => {
    const out = humanCommentsOf([cloud("bot", "Maestro sordu"), cloud("uyildiz", "cevap")], "bot");
    expect(out).toEqual([{ author: "uyildiz", text: "cevap" }]);
  });

  it("bot kimliği bilinmiyorsa eleme YAPILMAZ — bilinçli, ve çağıran uyarır", () => {
    const out = humanCommentsOf([cloud("bot", "Maestro sordu"), cloud("uyildiz", "cevap")]);
    expect(out).toHaveLength(2);
  });

  it("komut zarflarını eler — `/approve` kapıya emirdir, bağlam değil", () => {
    expect(humanCommentsOf([dc("uyildiz", "/approve"), dc("uyildiz", "/reject sebep")])).toEqual([]);
  });

  it("boş ve yazarsız yorumları eler", () => {
    const out = humanCommentsOf([dc("uyildiz", "   "), { author: {}, body: "sahipsiz" }, dc("u", "gerçek")]);
    expect(out).toEqual([{ author: "u", text: "gerçek" }]);
  });

  it(`en fazla ${MAX_COMMENTS} yorum, ve EN TAZE olanlar`, () => {
    const many = Array.from({ length: 25 }, (_, i) => dc("u", `yorum-${i}`));
    const out = humanCommentsOf(many);
    expect(out).toHaveLength(MAX_COMMENTS);
    // Son 10: geveze bir ticket promptu şişirip modeli asıl talepten
    // uzaklaştırmasın, ama en yeni cevap MUTLAKA görülsün.
    expect(out.at(-1)?.text).toBe("yorum-24");
    expect(out[0]?.text).toBe("yorum-15");
  });

  it(`tek yorum ${MAX_COMMENT_TEXT} karakterde kırpılır`, () => {
    const out = humanCommentsOf([dc("u", "x".repeat(5_000))]);
    expect(out[0]?.text).toHaveLength(MAX_COMMENT_TEXT + 1); // + kırpma işareti
    expect(out[0]?.text.endsWith("…")).toBe(true);
  });

  it("dizi olmayan/bozuk kaynakları atlar, patlamaz", () => {
    expect(humanCommentsOf([null, "metin", 7, dc("u", "gerçek")])).toEqual([
      { author: "u", text: "gerçek" },
    ]);
  });
});

describe("withComments — snapshot KLONLANIR, sözleşme donmuş kalır", () => {
  it("yorum yoksa snapshot AYNEN döner (yeni nesne bile değil)", () => {
    expect(withComments(SNAPSHOT, [])).toBe(SNAPSHOT);
  });

  it("yorumlar açıklamanın sonuna, başlıklı bir blok olarak eklenir", () => {
    const out = withComments(SNAPSHOT, [{ author: "uyildiz", text: "prod ortamında" }]);
    expect(out.description).toContain(SNAPSHOT.description);
    expect(out.description).toContain(COMMENT_BLOCK_TITLE);
    expect(out.description).toContain("- uyildiz: prod ortamında");
  });

  it("özgün snapshot DEĞİŞMEZ — kopya, mutasyon değil", () => {
    const before = SNAPSHOT.description;
    withComments(SNAPSHOT, [{ author: "u", text: "cevap" }]);
    expect(SNAPSHOT.description).toBe(before);
  });

  it("açıklama dışındaki her alan korunur", () => {
    const out = withComments(SNAPSHOT, [{ author: "u", text: "cevap" }]);
    expect({ ...out, description: SNAPSHOT.description }).toEqual(SNAPSHOT);
  });
});
