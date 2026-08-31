import { describe, expect, it } from "vitest";
import {
  activeAnalystVariantId,
  activeEngineerVariantId,
  activeTemplateVersion,
  DEFAULT_ANALYST_VARIANT,
  DEFAULT_ENGINEER_VARIANT,
  pinnedOr,
  UNVERSIONED_TEMPLATE,
  type RunPinDb,
} from "../src/stores/run-pins.js";

/**
 * What a run is pinned to when it opens.
 *
 * The fallbacks are the point. An empty variant is not a neutral default: it
 * reaches the gateway as a contract violation on the first model call, which is
 * how a run opened without one presents itself — as a model failure, three
 * activity retries away from the actual mistake.
 */

/**
 * `variant` DERİN birleşiyor, üstüne yazılmıyor: testlerin çoğu yalnızca
 * `findFirst`i tarif ediyor ve `findUnique`ı hiç ilgilendirmiyor. Sığ bir
 * spread, o testlerin her birine ilgisiz bir `findUnique` yazdırırdı.
 */
function db(over: Partial<{ variant: Partial<RunPinDb["variant"]>; analysisTemplateVersion: RunPinDb["analysisTemplateVersion"] }> = {}): RunPinDb {
  return {
    variant: {
      findFirst: () => Promise.resolve(null),
      findUnique: () => Promise.resolve(null),
      ...over.variant,
    },
    analysisTemplateVersion: over.analysisTemplateVersion ?? { findFirst: () => Promise.resolve(null) },
  };
}

describe("activeAnalystVariantId", () => {
  it("uses the analyst variant the deployment has", async () => {
    const id = await activeAnalystVariantId(
      db({ variant: { findFirst: () => Promise.resolve({ id: "analyst-kredi" }) } }),
    );
    expect(id).toBe("analyst-kredi");
  });

  it("falls back to a named variant rather than an empty string", async () => {
    expect(await activeAnalystVariantId(db())).toBe(DEFAULT_ANALYST_VARIANT);
    expect(DEFAULT_ANALYST_VARIANT.length).toBeGreaterThan(0);
  });

  it("asks for the analyst role, not whichever variant sorts first", async () => {
    // `engineer-default` sorts before `analyst-kredi` by id; asking without the
    // role filter would pin an analysis run to the engineering agent.
    let asked: unknown;
    await activeAnalystVariantId(
      db({
        variant: {
          findFirst: (args) => {
            asked = args.where;
            return Promise.resolve({ id: "analyst-kredi" });
          },
        },
      }),
    );
    expect(asked).toEqual({ role: "analyst" });
  });
});

describe("activeEngineerVariantId", () => {
  it("uses the engineer variant the deployment has", async () => {
    const id = await activeEngineerVariantId(
      db({ variant: { findFirst: () => Promise.resolve({ id: "engineer-dotnet" }) } }),
    );
    expect(id).toBe("engineer-dotnet");
  });

  it("falls back to a named variant rather than an empty string", async () => {
    expect(await activeEngineerVariantId(db())).toBe(DEFAULT_ENGINEER_VARIANT);
    expect(DEFAULT_ENGINEER_VARIANT.length).toBeGreaterThan(0);
  });

  it("asks for the ENGINEER role — the whole point of the second pin", async () => {
    // Bu satır olmadan mühendislik turu analistin ajanıyla koşuyordu: pin tekti
    // ve onu `activeAnalystVariantId` `role: 'analyst'` diye planlıyordu.
    let asked: unknown;
    await activeEngineerVariantId(
      db({
        variant: {
          findFirst: (args) => {
            asked = args.where;
            return Promise.resolve({ id: "engineer-dotnet" });
          },
        },
      }),
    );
    expect(asked).toEqual({ role: "engineer" });
  });

  it("mühendis ve analist iğneleri BİRBİRİNDEN FARKLI rolleri sorar", async () => {
    // Aynı sahte veritabanına iki soru: ikisi de aynı rolü sorsaydı, iki ajanlı
    // bir kurulum tek ajanla koşardı — göç 0022 öncesinin tam olarak hâli.
    const roles: unknown[] = [];
    const shared = db({
      variant: {
        findFirst: (args) => {
          roles.push(args.where);
          return Promise.resolve(null);
        },
      },
    });
    await activeAnalystVariantId(shared);
    await activeEngineerVariantId(shared);
    expect(roles).toEqual([{ role: "analyst" }, { role: "engineer" }]);
  });
});

describe("activeTemplateVersion", () => {
  it("pins the newest published version", async () => {
    const version = await activeTemplateVersion(
      db({ analysisTemplateVersion: { findFirst: () => Promise.resolve({ version: 7 }) } }),
    );
    expect(version).toBe("7");
  });

  it("names the absence rather than pinning an empty string", async () => {
    // `assertDocument` compares this against what the analyst stamped and
    // reports the mismatch; "" would make that message say nothing.
    expect(await activeTemplateVersion(db())).toBe(UNVERSIONED_TEMPLATE);
  });
});

/**
 * Dinleme kuralının iğnesi ile kurulum varsayılanı arasındaki seçim.
 *
 * Bu blok bir davranışı ÖLÇÜYOR: kural bir ajan seçmediğinde hiçbir şeyin
 * değişmemesi (geriye dönük uyum) ve seçilen ajan artık yokken düşüşün
 * GÖRÜNÜR olması. İkisi de sessiz kalırsa, operatör "seçtiğim ajan koşuyor"
 * sanısıyla baş başa kalır — projenin kapatmaya çalıştığı hatanın ta kendisi.
 */
describe("pinnedOr", () => {
  it("kural bir ajan seçmişse ONU kullanır", async () => {
    const used = await pinnedOr(
      db({ variant: { findUnique: () => Promise.resolve({ id: "analyst-kredi" }) } }),
      "analyst-kredi",
      () => Promise.resolve(DEFAULT_ANALYST_VARIANT),
    );
    expect(used).toBe("analyst-kredi");
  });

  it("kural ajan seçmemişse varsayılana düşer ve HİÇ sorgu yapmaz", async () => {
    let asked = 0;
    const fake = db({
      variant: {
        findUnique: () => {
          asked += 1;
          return Promise.resolve(null);
        },
      },
    });
    for (const empty of [null, undefined, "", "   "]) {
      expect(await pinnedOr(fake, empty, () => Promise.resolve(DEFAULT_ANALYST_VARIANT))).toBe(
        DEFAULT_ANALYST_VARIANT,
      );
    }
    // Yoklukta aranacak bir kimlik yok; sorgu yapmak boşuna bir gidiş olurdu.
    expect(asked).toBe(0);
  });

  it("seçilen ajan SİLİNMİŞSE varsayılana düşer, ama SESSİZCE DEĞİL", async () => {
    const warnings: Array<[string, string]> = [];
    const used = await pinnedOr(
      db({ variant: { findUnique: () => Promise.resolve(null) } }),
      "analyst-silinmis",
      () => Promise.resolve(DEFAULT_ANALYST_VARIANT),
      (pinnedId, fallbackId) => warnings.push([pinnedId, fallbackId]),
    );
    expect(used).toBe(DEFAULT_ANALYST_VARIANT);
    // İki kimlik birden: "hangisi gitti" ve "yerine hangisi koştu" ayrı sorular.
    expect(warnings).toEqual([["analyst-silinmis", DEFAULT_ANALYST_VARIANT]]);
  });

  it("doğrulama sorgusu PATLARSA iğneye güvenir — hata ≠ yokluk", async () => {
    // Bir veritabanı aksaklığı yüzünden operatörün açıkça seçtiği ajanı
    // değiştirmek, doğrulamanın önlemeye çalıştığı hatanın aynısı olurdu.
    let fellBack = false;
    const used = await pinnedOr(
      db({ variant: { findUnique: () => Promise.reject(new Error("postgres yok")) } }),
      "engineer-dotnet",
      () => {
        fellBack = true;
        return Promise.resolve(DEFAULT_ENGINEER_VARIANT);
      },
    );
    expect(used).toBe("engineer-dotnet");
    expect(fellBack).toBe(false);
  });

  it("kimliği TRIMLEYEREK sorar — panelden gelen boşluk bir ajan silmez", async () => {
    let asked: unknown;
    const used = await pinnedOr(
      db({
        variant: {
          findUnique: (args) => {
            asked = args.where;
            return Promise.resolve({ id: "engineer-dotnet" });
          },
        },
      }),
      "  engineer-dotnet  ",
      () => Promise.resolve(DEFAULT_ENGINEER_VARIANT),
    );
    expect(asked).toEqual({ id: "engineer-dotnet" });
    expect(used).toBe("engineer-dotnet");
  });
});
