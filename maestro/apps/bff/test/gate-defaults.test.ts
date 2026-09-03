import { describe, expect, it } from "vitest";
import { GATES_BY_RISK } from "@maestro/contracts";
import { isProductDefault, resolveGateSteps } from "../src/gate-defaults.js";
import { parseGateSteps } from "../src/listening-store.js";

/**
 * KAPI DİZİSİNİN ÜÇ KATMANI, VE ARALARINDAKİ ÖNCELİK.
 *
 *   1. kuralın `gateSteps` seçimi
 *   2. `gates.risk_tiers` parametresi — ürünün varsayılanından FARKLIYSA
 *   3. `GATES_BY_RISK` — bugüne kadarki tek cevap
 *
 * İkinci katman bu turda DİRİLDİ: parametre M51'den beri tanımlı, panelde
 * görünür, 4-göz korumalı ve sürümlenmişti — ve hiçbir kod onu okumuyordu.
 * Operatör düzenlediğinde hiçbir şey olmuyordu, ve o boş bir ayardan kötüdür:
 * panel ona kendi yazdığı değeri geri gösteriyor, sistem başka bir şey
 * yapıyordu.
 */

/** `deps.params.values()` sahtesi — tek parametreyi tek sürümle döndürür. */
function depsWith(value: unknown, version = 1): never {
  return {
    params: {
      values: () =>
        Promise.resolve([{ key: "gates.risk_tiers", scopeRef: null, version, value }]),
    },
  } as never;
}

const NO_PARAMS = { params: { values: () => Promise.resolve([]) } } as never;

describe("kapı dizisi — kural → parametre → sabit", () => {
  it("KURALIN seçimi her şeyi ezer, parametre farklı olsa bile", async () => {
    const answer = await resolveGateSteps(
      depsWith({ dusuk: ["4"], orta: ["4"], kritik: ["4"] }),
      { steps: ["5"] },
      "orta",
    );
    expect(answer).toEqual({ steps: ["5"] });
  });

  it("kuralın BOŞ seçimi de bir seçimdir — parametreye düşülmez", async () => {
    // Bu satır, boş dizinin `null`la karıştırılmadığının ölçümü. Karıştırılsaydı
    // operatörün kapattığı kapılar parametreden geri açılırdı.
    const answer = await resolveGateSteps(
      depsWith({ dusuk: ["4", "5"], orta: ["4", "5"], kritik: ["4", "5"] }),
      { steps: [] },
      "orta",
    );
    expect(answer).toEqual({ steps: [] });
  });

  it("kuralda seçim yoksa DÜZENLENMİŞ parametre devreye girer", async () => {
    // Parametre ürünün varsayılanından farklı: operatör onu gerçekten
    // düzenlemiş. Artık okunuyor — bu turdan önce okunmuyordu.
    const answer = await resolveGateSteps(
      depsWith({ dusuk: ["5"], orta: ["5"], kritik: ["5"] }),
      null,
      "kritik",
    );
    expect(answer).toEqual({ steps: ["5"] });
  });

  it("parametre ürünün VARSAYILANIYSA koşuya hiç yazılmaz", async () => {
    /**
     * Dokunulmamış bir parametre `null` verir, `GATES_BY_RISK`in kopyasını
     * DEĞİL. İki sebep, ikisi de ölçülebilir:
     *
     *  · Koşunun başlangıç girdisi bugünküyle bit bit aynı kalır; alanın
     *    varlığı "operatör seçti" demek olarak okunabilir kalır.
     *  · Ürünün varsayılanı ilerlediğinde (M92 gibi) dokunulmamış kurulumlar
     *    ilerlemeyi ALIR. Değeri kopyalasaydık eski varsayılan donardı.
     */
    const answer = await resolveGateSteps(depsWith({ ...GATES_BY_RISK }), null, "orta");
    expect(answer).toBeNull();
  });

  it("parametre HİÇ YOKSA `null` — kurulum bugüne kadarki gibi çalışır", async () => {
    expect(await resolveGateSteps(NO_PARAMS, null, "orta")).toBeNull();
  });

  it("BOZUK parametre `null`'a düşer — FAIL-CLOSED, ve durdurmaz", async () => {
    /**
     * Bozulmanın yönü bilerek bu: `null` = risk katmanı varsayılanı = muhtemelen
     * DAHA ÇOK onay. Elle düzenlenmiş bozuk bir JSON'ın kimseyi onaysız
     * geçirmemesi gerekir — ve ticket alımını da durdurmaması gerekir, o yüzden
     * fırlatmıyor.
     */
    expect(await resolveGateSteps(depsWith({ dusuk: "hepsi" }), null, "orta")).toBeNull();
    expect(await resolveGateSteps(depsWith("tamamen yanlış"), null, "orta")).toBeNull();
  });

  it("parametre okunamazsa tur DÜŞMEZ — `null` döner", async () => {
    const broken = { params: { values: () => Promise.reject(new Error("db down")) } } as never;
    expect(await resolveGateSteps(broken, null, "orta")).toBeNull();
  });

  it("EN YÜKSEK sürüm kazanır — eski bir sürüm yeni değeri ezmez", async () => {
    const deps = {
      params: {
        values: () =>
          Promise.resolve([
            { key: "gates.risk_tiers", scopeRef: null, version: 1, value: { ...GATES_BY_RISK } },
            {
              key: "gates.risk_tiers",
              scopeRef: null,
              version: 2,
              value: { dusuk: ["5"], orta: ["5"], kritik: ["5"] },
            },
          ]),
      },
    } as never;
    expect(await resolveGateSteps(deps, null, "orta")).toEqual({ steps: ["5"] });
  });

  it("risk katmanı DOĞRU satırı seçer", async () => {
    const deps = depsWith({ dusuk: ["5"], orta: ["4", "5"], kritik: ["4", "5", "12"] });
    expect(await resolveGateSteps(deps, null, "dusuk")).toEqual({ steps: ["5"] });
    expect(await resolveGateSteps(deps, null, "kritik")).toEqual({ steps: ["4", "5", "12"] });
  });
});

describe("isProductDefault — 'dokunulmamış' neye denir", () => {
  it("üç katmanın üçü de aynıysa dokunulmamıştır", () => {
    expect(isProductDefault({ ...GATES_BY_RISK })).toBe(true);
  });

  it("SIRA ve YİNELENEN fark etmez — küme karşılaştırılır", () => {
    // Operatör aynı değeri farklı sırada yazdıysa hâlâ dokunmamıştır. Sırayı
    // önemsemek, hiçbir şey değiştirmemiş bir kurulumu "düzenlenmiş" sayıp
    // varsayılanın ilerlemesinden mahrum bırakırdı.
    expect(
      isProductDefault({
        dusuk: ["12", "5"],
        orta: ["5", "4", "12", "11"],
        kritik: ["12", "11", "9", "5", "4"],
      }),
    ).toBe(true);
  });

  it("TEK bir katman ayrılsa bile düzenlenmiş sayılır", () => {
    // Katman katman karışık kullanmak (biri parametreden, diğeri sabitten)
    // üçüncü bir yapılandırma uydurmak olurdu ve hangi cevabın nereden geldiğini
    // kimse söyleyemezdi.
    expect(isProductDefault({ ...GATES_BY_RISK, dusuk: ["5"] })).toBe(false);
  });
});

describe("parseGateSteps — kolon değerinden seçime", () => {
  it("YOKLUK ile BOŞ DİZİ ayrı kalır — bu şemanın tek zor kararı", () => {
    // `null` = "seçim yok, varsayılana düş"; `{steps: []}` = "kapı istemiyorum".
    // `parseStatusMap` boş nesneyi `null`'a indiriyordu; burada indirmek,
    // operatörün kapattığı kapıları geri açardı.
    expect(parseGateSteps(null)).toBeNull();
    expect(parseGateSteps(undefined)).toBeNull();
    expect(parseGateSteps({ steps: [] })).toEqual({ steps: [] });
  });

  it("seçimi AKIŞ SIRASINA sokar ve yinelenenleri atar", () => {
    // İki özdeş seçim tek bir JSON olarak saklanmalı, yoksa "kural değişti mi"
    // sorusunu hiçbir yüzey doğru cevaplayamaz.
    expect(parseGateSteps({ steps: ["12", "4", "5", "4"] })).toEqual({
      steps: ["4", "5", "12"],
    });
  });

  it("`ownerless` yalnız `true` iken saklanır", () => {
    // `false` yazmak, kayıtlı geçmişlerde hiç olmayan bir alanı yeni satırlarda
    // varmış gibi gösterirdi ve ikisi ayırt edilemezdi.
    expect(parseGateSteps({ steps: ["5"], ownerless: false })).toEqual({ steps: ["5"] });
    expect(parseGateSteps({ steps: ["5"], ownerless: true })).toEqual({
      steps: ["5"],
      ownerless: true,
    });
  });

  it("BOZUK değer `null`'a düşer ve sebebi RAPORLANIR", () => {
    const reasons: string[] = [];
    expect(parseGateSteps({ steps: ["99"] }, (r) => reasons.push(r))).toBeNull();
    expect(parseGateSteps("düz metin", (r) => reasons.push(r))).toBeNull();
    // Bilinmeyen anahtar da reddedilir (`.strict()`): sessizce düşen bir
    // `stepsX`, operatörün kapıların neden açıldığını hiç anlayamaması demekti.
    expect(parseGateSteps({ steps: ["5"], stepsX: [] }, (r) => reasons.push(r))).toBeNull();
    expect(reasons).toHaveLength(3);
  });
});
