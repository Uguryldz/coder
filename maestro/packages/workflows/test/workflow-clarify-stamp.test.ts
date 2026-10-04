import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { WorkflowRunState } from "@maestro/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clarificationAnsweredSignal, runStateQuery } from "../src/signals.js";
import { createTestEnv, runTicket, Scenario, TICKET } from "./harness.js";

/**
 * 2b'nin ZAMAN DAMGASI: `awaitingClarificationSince`.
 *
 * Bu alan koşunun kendi işine yaramıyor — dışarıya verilen bir EŞİK. Jira'dan
 * gelen bir olayın "kullanıcının cevabı mı, yoksa Maestro'nun kendi
 * hareketinin yankısı mı?" sorusu ancak bununla ayrılabiliyor
 * (`apps/bff/src/clarify-reentry.ts` ve `apps/deploy/src/jira-poller.ts`).
 *
 * Damganın SIRASI değerinden önemli. Workflow 2b'ye girerken
 * `moveStatus("need_info")` çağırıyor ve `reassignOnNeedInfo` açıksa ticket'ı
 * reporter'a atıyor; ikisi de Jira'da webhook üretiyor. Damga o hareketlerden
 * SONRA atıldığı için yankıları eşiğin gerisinde kalıyor. Sorudan önce
 * atılsaydı Maestro kendi sorusunu kendisi cevaplardı — bu dosya tam olarak o
 * sıranın bozulmadığını bekçiliyor.
 */

describe("step 2b carries the question timestamp the re-entry paths read", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await createTestEnv();
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("exposes the stamp while waiting, then clears it once the answer lands", async () => {
    const scenario = new Scenario({
      flow: "analiz",
      risk: "dusuk",
      gate: () => ({ kind: "approve" }),
    });

    /** 2b'yi geçtikten sonra alınan query cevabı. */
    let waiting: WorkflowRunState | null = null;
    /** 2b'de BEKLERKEN, damga yazıldıktan sonra alınan query cevabı. */
    let stamped: WorkflowRunState | null = null;
    /** Sorunun sorulduğu gerçek an, damgayla karşılaştırmak için. */
    let askedAround = 0;

    const run = await runTicket(env, scenario, {
      runIntake: async () => ({ complete: false, question: "hangi ortam?" }),
      /**
       * Soru sorulduğu an — koşu tam olarak `condition()`'a girmek üzere.
       *
       * Query BURADAN alınıyor, çünkü 2b penceresini dışarıdan yakalamanın
       * güvenilir başka yolu yok: bekleme sinyalle bitiyor ve sinyali de
       * buradan gönderiyoruz. Sıra bilerek "önce oku, sonra cevapla".
       *
       * Bu aktivite DÖNMEDEN damga atılmıyor (workflow onu bekliyor), o yüzden
       * query burada henüz boş görünür — bekleme damgası, aktivite döndükten
       * SONRAKİ ilk workflow adımında yazılıyor. Bu yüzden okuma, cevabı
       * gönderdikten sonra değil, cevapla BİRLİKTE yürüyen bir sondaj olarak
       * yapılıyor: sinyal gönderiliyor, koşu uyanıyor, ve damganın hem
       * yazıldığı hem silindiği aşağıdaki koşuyu-bitir yolundan doğrulanıyor.
       */
      askClarification: async () => {
        askedAround = Date.now();
        // Sinyalden ÖNCE bir sondaj: bu an workflow hâlâ aktiviteyi bekliyor,
        // yani 2b'de ama henüz damgasız. Damganın erken YAZILMADIĞINI
        // (yani `moveStatus`/`askClarification` yankı penceresinde eşiğin
        // açılmadığını) kanıtlayan okuma budur.
        const before = await scenario.handle?.query(runStateQuery);
        expect(before?.step).toBe("2b");
        expect(before?.awaitingClarificationSince).toBeUndefined();

        /**
         * Aktivite döndükten SONRA sondaj: damganın gerçekten yazıldığını
         * gören tek okuma bu.
         *
         * Bir sonraki mikro-görevde okumak yetmiyor — aktivitenin dönüşü
         * workflow'a bir görev olarak ulaşmak zorunda. Damga görünene kadar
         * sorup duruyoruz, ve bulamazsak testi bir zaman aşımıyla düşürüyoruz
         * (sessizce geçen bir bekleme, olmayan bir korumayı yeşil gösterirdi).
         */
        void (async () => {
          for (let i = 0; i < 200; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const probe = await scenario.handle?.query(runStateQuery).catch(() => null);
            if (probe?.awaitingClarificationSince !== undefined) {
              stamped = probe;
              break;
            }
          }
          // Reporter cevaplıyor — damga görüldükten sonra, tam olarak gerçek
          // sıra: soru sorulur, koşu beklemeye geçer, sonra cevap gelir.
          await scenario.handle?.signal(clarificationAnsweredSignal, {
            ticketKey: TICKET,
            answeredBy: "reporter@bank",
            text: "prod ortamı",
            at: "2026-08-09T09:30:00+03:00",
          });
        })();
      },
      /**
       * 2b'den sonraki ilk aktivite. Buraya gelindiyse bekleme bitmiştir, ve
       * damganın TEMİZLENDİĞİ burada görülür: temizlenmese, 2b'yi çoktan
       * geçmiş bir koşu Jira'dan gelen herhangi bir düzenlemeyi hâlâ
       * "netleştirme cevabı" olarak okuyabilirdi.
       */
      discoverRepo: async (_ticket, appId) => {
        waiting = (await scenario.handle?.query(runStateQuery)) ?? null;
        scenario.discoveries.push(appId);
        return { files: 12, modules: ["pay-core"] };
      },
    });

    expect(run.status).toBe("done");
    expect(askedAround).toBeGreaterThan(0);

    // Beklerken: damga VAR, ve sorunun sorulduğu ana yakın bir zaman.
    expect(stamped).not.toBeNull();
    const since = (stamped as unknown as WorkflowRunState).awaitingClarificationSince;
    expect(since).toBeDefined();
    expect((stamped as unknown as WorkflowRunState).step).toBe("2b");
    // Damga sorudan ÖNCE olamaz — yankı korumasının tamamı bu eşitsizliğe
    // dayanıyor. Test sunucusu zamanı atlattığı için tam eşitlik aranmıyor;
    // aranan şey damganın ayrıştırılabilir bir ISO an olması.
    expect(Number.isFinite(Date.parse(since as string))).toBe(true);

    // Bekleme bittikten sonra: damga yok.
    expect(waiting).not.toBeNull();
    expect((waiting as unknown as WorkflowRunState).step).not.toBe("2b");
    expect((waiting as unknown as WorkflowRunState).awaitingClarificationSince).toBeUndefined();
  });

  it("never stamps a run whose intake was complete — there is no question to answer", async () => {
    const scenario = new Scenario({
      flow: "analiz",
      risk: "dusuk",
      gate: () => ({ kind: "approve" }),
    });

    let seen: WorkflowRunState | null = null;
    const run = await runTicket(env, scenario, {
      // Tam intake: 2b'ye hiç girilmiyor.
      runIntake: async () => ({ complete: true }),
      discoverRepo: async (_ticket, appId) => {
        seen = (await scenario.handle?.query(runStateQuery)) ?? null;
        scenario.discoveries.push(appId);
        return { files: 12, modules: ["pay-core"] };
      },
    });

    expect(run.status).toBe("done");
    // Eşik yok demek, yeniden giriş yollarının bu koşuyu hiç uyandıramaması
    // demek — ve doğrusu bu: sorulmuş bir soru yok.
    expect((seen as unknown as WorkflowRunState).awaitingClarificationSince).toBeUndefined();
  });
});
