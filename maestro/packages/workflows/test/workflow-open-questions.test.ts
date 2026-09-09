import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, createTestEnv, runTicket } from "./harness.js";

/**
 * ANALİZDEN SONRA BULUNAN AÇIK SORULAR KİMSEYE SORULMUYORDU.
 *
 * ── Boşluğun kendisi ────────────────────────────────────────────────────────
 * Sıra şu: tamlık kontrolü (adım 2) kodu GÖRMEDEN sorar, 2b'de cevaplanır,
 * keşif, sonra analiz. Analiz ajanı kodu OKUDUKTAN sonra yeni sorular bulur
 * ("bu hangi serviste yapılacak") ve `openQuestions`a yazar. O sorular yalnız
 * BELGEYE giriyordu; tasarım "insan onay kapısında görür" varsayıyordu ama
 * varsayım üç yoldan da kaçıyordu:
 *
 *  · düşük riskte analiz kapısı hiç açılmıyor (`GATES_BY_RISK.dusuk`),
 *  · kural `gateSteps: []` derse hiçbir kapı açılmıyor,
 *  · ve geliştirici brifingi cevapları "ticket yorumlarında" sanıyor.
 *
 * Yani cevabı olmayan bir soruyla kod yazılıyordu. Bu dosya üç şeyi ölçer:
 * kapının GERÇEKTEN zorlandığını, açık soru YOKKEN hiçbir şeyin değişmediğini,
 * ve `duzeltme` akışının bu zorlamadan MUAF kaldığını.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("açık sorular kapıyı zorlar", () => {
  it("DÜŞÜK riskte, kural kapı seçmemişken bile kapı 5 açılır", async () => {
    // `gateSteps: []` = "hiç onay kapısı istemiyorum" — ve risk `dusuk`, yani
    // iki kaynağın ikisi de analiz kapısı istemiyor. Açık soru üçüncü bir
    // kaynak: cevabı olmayan bir soruyla kod yazılamaz.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: [],
        openQuestions: ["Bu değişiklik hangi serviste yapılacak?"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["5"]);
  });

  it("defterde kapının NEDEN açıldığı yazar — operatörün sorusunun cevabı", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: [],
        openQuestions: ["Hangi servis?", "Limit kimden gelecek?"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    const forced = run.scenario.journal.find((entry) =>
      entry.title.includes("açık soru nedeniyle"),
    );
    expect(forced).toBeDefined();
    // Soru SAYISI: operatör "kaç soru yüzünden durdu" diye sorabilmeli.
    expect(forced?.detail).toContain("2 açık soru");
    // Ve soruların KENDİSİ: kapıyı kapatacak kişi neyi cevaplayacağını
    // defterden görmeli, belgeyi açmak zorunda kalmadan.
    expect(forced?.detail).toContain("Hangi servis?");
    expect(forced?.detail).toContain("Limit kimden gelecek?");
    // "Bu bir kural/risk kararı değildi" cümlesi — zorlamanın kaynağı.
    expect(forced?.detail).toContain("kural seçiminden gelmedi");
  });

  it("açık soru YOKKEN davranış birebir aynı kalır — kapı yok, defter satırı yok", async () => {
    const run = await runTicket(
      env,
      new Scenario({ risk: "dusuk", flow: "analiz", gateSteps: [], gate: () => ({ kind: "approve" }) }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual([]);
    expect(
      run.scenario.journal.filter((entry) => entry.title.includes("açık soru nedeniyle")),
    ).toHaveLength(0);
  });

  it("kural zaten 5'i seçmişse kapı İKİ KEZ açılmaz", async () => {
    // Zorlama bir EKLEME değil, bir GARANTİ: kapı zaten dizideyse dokunulmaz.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["4", "5"],
        openQuestions: ["Hangi servis?"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["4", "5"]);
    expect(
      run.scenario.journal.filter((entry) => entry.title.includes("açık soru nedeniyle")),
    ).toHaveLength(0);
  });

  it("kural 4'ü seçmişse, zorlanan 5 AKIŞ SIRASINDA arkasına eklenir", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["4"],
        openQuestions: ["Hangi servis?"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["4", "5"]);
  });

  it("DÜZELTME akışında açık soru olsa bile kapı AÇILMAZ", async () => {
    // `planFor("duzeltme").analysisGate === false` bilinçli bir karar: küçük
    // düzeltmeler analiz kapısından geçmez. Açık soru bunu EZMEZ — ezseydi her
    // küçük düzeltme insan kuyruğuna girerdi.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "duzeltme",
        openQuestions: ["Hangi servis?"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).not.toContain("4");
    expect(run.scenario.opened).not.toContain("5");
    expect(
      run.scenario.journal.filter((entry) => entry.title.includes("açık soru nedeniyle")),
    ).toHaveLength(0);
  });
});
