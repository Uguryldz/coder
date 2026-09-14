import { MatchResult } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { TEST_APPLICATIONS, harness, testApplication } from "./helpers.js";
import { issueEvent, signed } from "./payloads.js";

/**
 * ── EŞLEŞME KARARI KOŞUNUN SATIRINA ULAŞIR (M99 `matchJson`) ────────────────
 *
 * SAHADA ÖLÇÜLEN KIRIK. `WorkflowRun.matchJson` sütunu M99'dan beri şemada
 * (`packages/db/prisma/schema.prisma`) ama hiçbir ÜRETİM kodu yazmıyordu: tek
 * yazıcı demo seed'iydi (`packages/db/src/seed-demo.ts`). Bu sessiz bir kayıp
 * değildi, ekranda duruyordu — `tierOf()` (`apps/bff/src/onboarding-service.ts`)
 * her koşuda `MatchResult.safeParse(null)` ile başarısız olup `"unresolved"`
 * dönüyor, `/onboarding/dry-run` 35 koşunun 35'ini "çözülemedi" kovasına
 * atıyor, operatör "uygulamalar ekranı doğrulanamıyor" diyordu.
 *
 * Karar ZATEN alımda veriliyordu (`runIntake`'in `appId` zinciri). Eksik olan
 * onu TAŞIMAKTI. Bu dosya kararın koşunun başlangıç girdisine gerçekten
 * bindiğini ölçüyor — `flow-intake-repo-map.test.ts` ile aynı yol
 * (`h.runs.started`), çünkü ölçülecek şey aynı: gateway'e ne gitti.
 *
 * Her beklenti `MatchResult.safeParse`ten de geçiriliyor: sütunu OKUYAN taraf
 * tam olarak bunu yapıyor, ve doğrulamayan bir değer yazmak sütunu yazmamakla
 * aynı kapıya çıkardı — dry run yine "çözülemedi" derdi.
 */

function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_eslesme",
    projectKey: "UGURPAY",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    repoMap: {
      field: "customfield_10234",
      fieldName: "İş Ailesi",
      entries: [{ value: "Krediler", appId: "bank/kredi" }],
    },
    ...over,
  };
}

const MAPPED_APPS = [...TEST_APPLICATIONS, testApplication("bank/kredi", "bank", "kredi")];

/** Bir webhook teslimatı, ve gateway'e giden başlangıç girdisi. */
async function deliver(
  h: Awaited<ReturnType<typeof harness>>,
  ticket: string,
): Promise<{ appId?: string; match?: unknown } | undefined> {
  const before = h.runs.started.length;
  const delivery = signed(issueEvent({ ticket, issueType: "Hata" }));
  const response = await h.app.inject({
    method: "POST",
    url: "/webhooks/jira",
    headers: delivery.headers,
    payload: delivery.payload,
  });
  expect(response.statusCode).toBe(202);
  return h.runs.started[before] as { appId?: string; match?: unknown } | undefined;
}

describe("alım — eşleşme kararı koşuya taşınır (M99 matchJson)", () => {
  /**
   * KURALIN DEPO EŞLEMESİ KARAR VERDİ → `via: "rule"`.
   *
   * `tierOf` bunu BİRİNCİ kademeye ("byRule") koyuyor ve doğru: deterministik
   * bir kural kararı, bekleyen bir insan onayı yok. Dry run'ın operatöre
   * "bu ticket'lar yerleşti" diyebilmesinin tek yolu bu satır.
   */
  it("kuralın depo eşlemesi seçtiyse kararı 'rule' olarak taşır, kuralın kimliğiyle", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.work.putFields("UGURPAY-1", { customfield_10234: "Krediler" });

    const started = await deliver(h, "UGURPAY-1");
    expect(started?.appId).toBe("bank/kredi");
    expect(started?.match).toEqual({ via: "rule", ruleId: "lr_eslesme", appId: "bank/kredi" });

    // Sütunu okuyan taraf (`tierOf`) tam olarak bu ayrıştırmayı yapıyor.
    const parsed = MatchResult.safeParse(started?.match);
    expect(parsed.success).toBe(true);
  });

  /**
   * ZİNCİRİN SON HALKASI — proje bağlamasının kendi uygulaması.
   *
   * Eşleme bir satır bulamadığında koşu yine açılıyor (bugünkü davranış,
   * `flow-intake-repo-map.test.ts` bunu ayrıca sabitliyor) ve kararın
   * kaydedilmesi tam olarak BURADA önemli: sahada ölçülen 35 koşunun ezici
   * çoğunluğu bu halkadan geçiyordu, ve hiçbiri kaydedilmiyordu.
   */
  it("eşleme tutmayıp bağlamanın uygulamasına düşse bile kararı KAYDEDER", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.work.putFields("UGURPAY-2", { customfield_10234: "Sigorta" });

    const started = await deliver(h, "UGURPAY-2");
    expect(started?.appId).toBe("ugurpay");
    // Karar hâlâ bir KURAL kararı — kimliği kararı veren kuralın kimliği.
    expect(started?.match).toEqual({ via: "rule", ruleId: "lr_eslesme", appId: "ugurpay" });
    expect(MatchResult.safeParse(started?.match).success).toBe(true);
  });

  /**
   * HİÇBİR KOŞU KARARSIZ AÇILMAZ — kırığın özeti tek satırda.
   *
   * Düzeltmeden önce bu beklenti HER koşuda kırılırdı: `match` diye bir alan
   * yoktu, sütun `NULL` kalıyordu, ve dry run 35/35'i "çözülemedi" sayıyordu.
   */
  it("uygulaması olan hiçbir koşu eşleşme kararı OLMADAN açılmaz", async () => {
    const h = await harness({ applications: MAPPED_APPS, listeningRules: [rule()] });
    h.work.putFields("UGURPAY-3", { customfield_10234: "Krediler" });

    const started = await deliver(h, "UGURPAY-3");
    expect(started?.appId).toBeTruthy();
    expect(started?.match).toBeDefined();
  });
});
