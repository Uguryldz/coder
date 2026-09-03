import { fileURLToPath } from "node:url";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalysisDoc } from "@maestro/contracts";
import type { AnalysisRewriteContext, MaestroActivities } from "../src/activities.js";
import type { WorkflowHandle } from "@temporalio/client";
import type { StepId } from "@maestro/contracts";
import { TICKET, Scenario, analysisDoc, createTestEnv, makeActivities, runTicket } from "./harness.js";
import { ticketWorkflow as legacyWorkflow } from "./legacy/ticket-workflow-v1020.js";

/**
 * "GERİ GÖNDERİNCE TEKRAR İNCELESİN" — ve tekrar incelemenin GEÇMİŞİ görmesi.
 *
 * ── Operatörün kuralı, kendi ifadesiyle ───────────────────────────────────
 * "ben yorum yazsam da yazmasam da, geri gönderince tekrar incelesin, bağlam
 *  kaybı olmasın diye geçmiş var zaten"
 *
 * Bu cümlede iki şart var ve ikincisi bu dosyaya kadar tutulmuyordu:
 *
 *   1. Geri gönderme yeniden yazdırır. TUTULUYORDU
 *      (`workflow-gate-return.test.ts`).
 *   2. Yeniden yazım GEÇMİŞİ görür. TUTULMUYORDU — `writeAnalysis` modele
 *      yalnız `summary` + `description` gönderiyordu, yani ikinci tur birebir
 *      aynı girdiyi alıyor ve doğal olarak aynı belgeyi üretiyordu. Operatör
 *      "eksik var" deyip aynı analizi geri alıyordu.
 *
 * Aşağısı ikinci şartı, üç ayrı kanaldan (gerekçe / yorum / önceki analiz)
 * ölçüyor — ve `reason`'ın YOKLUĞUNDA da bağlam gittiğini, çünkü operatörün
 * kuralının asıl zor yarısı orası.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

/**
 * SAHADAKİ 1.0.20 workflow'unu kapıda BEKLEYEN hâlde bırakır ve geçmişini verir.
 *
 * `runTicket` kullanılamaz: o yardımcı koşuyu KAPANANA kadar sürüyor, oysa
 * ölçmek istediğimiz şey tam olarak kapanMAMIŞ bir koşu. Burada koşu kapı 5'i
 * açana kadar bırakılıyor, hiç karar verilmiyor, ve o andaki geçmiş alınıyor.
 */
async function runLegacyToGate(): Promise<Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>> {
  legacyId += 1;
  const taskQueue = `maestro-legacy-${legacyId}`;
  const opened: StepId[] = [];
  const risk = "dusuk" as const;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL("./legacy/ticket-workflow-v1020.ts", import.meta.url),
    ),
    activities: makeActivities(new Scenario({ risk, flow: "analiz" }), {
      // Kapı AÇILIR ama hiçbir karar sinyali gönderilmez: koşu orada bekler.
      openGate: async (_ticket, step) => {
        opened.push(step);
        return "tech-leads";
      },
      writeAnalysis: async () => ({ analysis: analysisDoc(risk), risk }),
    }),
  });
  const running = worker.run();
  try {
    const handle = await env.client.workflow.start(legacyWorkflow, {
      taskQueue,
      workflowId: `legacy-${legacyId}`,
      args: [{ ticket: TICKET, appId: "pay", mode: "full_auto", dataClass: "dahili", flow: "analiz" }],
    });
    // Kapı açılana kadar sür; açıldığı an koşu beklemeye geçmiş demektir.
    for (let turn = 0; turn < 200 && opened.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(opened.length).toBeGreaterThan(0);
    // Bekleme durumunun geçmişe İŞLENMESİ için bir tur daha.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const history = await handle.fetchHistory();
    // Geçmişin GERÇEKTEN kapıya kadar geldiğini kanıtla: `openGate` orada
    // olmasaydı bu test hiçbir şey ölçmezdi (kapıdan önce zaten hiçbir şey
    // değişmedi). `writeAnalysis` de orada — imzası değişen aktivite.
    const scheduled = (history.events ?? [])
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter((n): n is string => typeof n === "string");
    expect(scheduled).toContain("writeAnalysis");
    expect(scheduled).toContain("openGate");
    return history;
  } finally {
    worker.shutdown();
    await running.catch(() => undefined);
  }
}

let legacyId = 0;

/** `writeAnalysis`'e geçen her çağrının bağlamını toplayan bir casus. */
function spy(): {
  calls: (AnalysisRewriteContext | undefined)[];
  override: Partial<MaestroActivities>;
} {
  const calls: (AnalysisRewriteContext | undefined)[] = [];
  const risk = "dusuk" as const;
  return {
    calls,
    override: {
      writeAnalysis: async (_ticket, _appId, rewrite) => {
        calls.push(rewrite);
        return { analysis: analysisDoc(risk), risk };
      },
    },
  };
}

describe("analiz yeniden yazılırken GEÇMİŞ modele geçiyor", () => {
  it("ilk tur bağlamsız — ortada yeniden yazılan bir şey yok", async () => {
    const watch = spy();
    const run = await runTicket(
      env,
      new Scenario({ risk: "dusuk", flow: "analiz", gate: () => ({ kind: "approve" }) }),
      watch.override,
    );

    expect(run.error).toBeNull();
    expect(watch.calls).toHaveLength(1);
    // Bugünkü prompt bit bit korunuyor: bağlam alanı HİÇ gitmiyor.
    expect(watch.calls[0]).toBeUndefined();
  });

  it("geri göndermede gerekçe VE önceki analiz geçiyor", async () => {
    const watch = spy();
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gate: (step, visit) =>
          step === "5" && visit === 1
            ? { kind: "return_once", reason: "kabul kriterleri eksik" }
            : { kind: "approve" },
      }),
      watch.override,
    );

    expect(run.error).toBeNull();
    // İKİ çağrı, üç değil: geri gönderme dalı artık analizi kendisi
    // yazdırmıyor — bağlamı devam eden koşunun girdisine koyuyor ve belge
    // ORADA bir kez üretiliyor. Eski hâlinde üç çağrı vardı ve sonuncusu
    // (kapının yargıladığı) BAĞLAMSIZDI.
    expect(watch.calls).toHaveLength(2);
    expect(watch.calls[0]).toBeUndefined();
    expect(watch.calls[1]?.reason).toBe("kabul kriterleri eksik");
    // Önceki analiz BELLEKTEN geliyor (`state.analysis`), journal'dan değil —
    // journal okuması yeni bir aktivite, yani komut dizisinde bir değişiklik
    // olurdu ve kapıda bekleyen koşular için gerçek bir replay riski.
    expect(watch.calls[1]?.previous).toMatchObject({ riskTier: "dusuk" });
  });

  /**
   * BU DOSYANIN EN ÖNEMLİ TESTİ, ve operatörün kuralının zor yarısı.
   *
   * Karar statü kanalıyla verildiğinde (`gateReturnStatus`) yazılı bir gerekçe
   * YOKTUR. "Yorum yazsam da yazmasam da tekrar incelesin" tam olarak bunu
   * söylüyor: gerekçe boşken de yeniden yazım bağlamsız kalmamalı — önceki
   * analiz taşınmalı ki model "bunu daha önce şöyle değerlendirmiştim, şimdi
   * neden yeniden isteniyor" sorusunu sorabilsin.
   */
  it("gerekçe YOKKEN de bağlam gidiyor — önceki analiz taşınır", async () => {
    const watch = spy();
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gate: (step, visit) =>
          step === "5" && visit === 1 ? { kind: "return_once" } : { kind: "approve" },
      }),
      watch.override,
    );

    expect(run.error).toBeNull();
    expect(watch.calls).toHaveLength(2);
    const second = watch.calls[1];
    expect(second).toBeDefined();
    // Gerekçe yok — ve olmaması normal.
    expect(second?.reason).toBeUndefined();
    // Ama bağlam var: bu çağrı bir YENİDEN YAZIM, ve modele öyle görünüyor.
    expect(second?.previous).toMatchObject({ riskTier: "dusuk" });
  });

  it("ret dalı da aynı bağlamı taşır — o da analizi yeniden yazdırıyor", async () => {
    const watch = spy();
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gate: (step, visit) =>
          step === "5" && visit === 1
            ? { kind: "reject_once", reason: "kapsam yanlış" }
            : { kind: "approve" },
      }),
      watch.override,
    );

    expect(run.error).toBeNull();
    expect(watch.calls).toHaveLength(2);
    expect(watch.calls[1]?.reason).toBe("kapsam yanlış");
    expect(watch.calls[1]?.previous).toBeDefined();
  });

  /**
   * Her turun bağlamı KENDİ önceki turundan gelir, ilkinden değil. Dört tur
   * geri gönderme, dört kez taze bağlam — `continueAsNew` sınırında bile.
   */
  it("dört tur geri göndermede her tur bir öncekini görür", async () => {
    const calls: (AnalysisRewriteContext | undefined)[] = [];
    let turn = 0;
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gate: (step, visit) =>
          step === "5" && visit <= 4 ? { kind: "return_always" } : { kind: "approve" },
      }),
      {
        writeAnalysis: async (_ticket, _appId, rewrite) => {
          calls.push(rewrite);
          turn += 1;
          // Her tur AYIRT EDİLEBİLİR bir belge üretir, ki bir sonrakinin
          // gerçekten bir ÖNCEKİNİ gördüğü ölçülebilsin.
          const doc: AnalysisDoc = { ...analysisDoc("dusuk"), riskReason: `tur-${turn}` };
          return { analysis: doc, risk: "dusuk" };
        },
      },
    );

    expect(run.error).toBeNull();
    expect(calls).toHaveLength(5);
    expect(calls[0]).toBeUndefined();
    // 2. tur 1.'yi, 3. tur 2.'yi… — zincir kopmuyor.
    expect(calls.slice(1).map((c) => c?.previous?.riskReason)).toEqual([
      "tur-1",
      "tur-2",
      "tur-3",
      "tur-4",
    ]);
  });
});

/**
 * ── DETERMİNİZM: KAPIDA BEKLEYEN KOŞULAR ────────────────────────────────────
 *
 * `writeAnalysis` bir Temporal AKTİVİTESİ ve imzası değişti. Sahada (bankada ve
 * dev'de) kapıda bekleyen koşular var: onların geçmişi ESKİ kodla yazıldı ve
 * yeni kod o geçmişi replay edecek. Soru şu: aktivite argümanlarının değişmesi
 * determinizm hatası üretir mi?
 *
 * ── ÖLÇÜLEN CEVAP: HAYIR ────────────────────────────────────────────────────
 * Temporal'ın Rust core'u replay'de komutları YALNIZ şu ikisiyle eşleştirir —
 * "does not match activity type of activity command" ve "does not match
 * activity id of activity command" (core-bridge ikilisindeki determinizm hata
 * metinleri; argüman/payload karşılaştıran bir mesaj YOK). Aktivite TİPİ
 * (`writeAnalysis`) ve ID'si (workflow'daki çağrı SIRASINDAN türer) değişmedi:
 * `writeAnalysis` hâlâ aynı yerlerde, aynı sırada, aynı sayıda çağrılıyor.
 * Değişen tek şey YENİ zamanlamaların payload'ı.
 *
 * Aşağıdaki test bunu iddia olarak değil ÖLÇÜM olarak yapıyor: bir koşu
 * çalıştırılır, geçmişi alınır ve o geçmiş yeni workflow koduna REPLAY edilir.
 * Determinizm hatası olsaydı `runReplayHistory` `DeterminismViolationError`
 * atardı.
 */
describe("determinizm — kapıda bekleyen koşular yeni koda güvenle geçer", () => {
  it("geri gönderme geçmişi yeni workflow koduna replay edilir", async () => {
    try {
      Runtime.install({ logger: new DefaultLogger("ERROR") });
    } catch {
      /* already installed */
    }

    const watch = spy();
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gate: (step, visit) =>
          step === "5" && visit === 1
            ? { kind: "return_once", reason: "kabul kriterleri eksik" }
            : { kind: "approve" },
      }),
      watch.override,
    );
    expect(run.error).toBeNull();

    const handle = run.scenario.handle;
    expect(handle).toBeDefined();
    const history = await handle!.fetchHistory();

    // Geçmiş, YENİ workflow kaynağına karşı yeniden oynatılıyor. Atmıyorsa
    // komut dizisi eşleşti demektir — argüman değişikliği bir ihlal DEĞİL.
    await expect(
      Worker.runReplayHistory(
        {
          workflowsPath: fileURLToPath(new URL("../src/ticket-workflow.ts", import.meta.url)),
          replayName: "analysis-rewrite-determinism",
        },
        history,
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * ── ASIL ÖLÇÜM: SAHADA (1.0.20) BAŞLAMIŞ BİR KOŞU, YENİ KODA GİRİYOR ──────
   *
   * Yukarıdaki test yeni kodun kendi geçmişini replay ediyor — gerekli ama
   * yetersiz. Sahadaki soru başka: bankada ve dev'de KAPIDA BEKLEYEN koşular
   * var, geçmişleri ESKİ kodla yazıldı, ve yeni worker o geçmişleri replay
   * edecek. Bu test tam olarak onu yapıyor: koşu `test/legacy/`teki 1.0.20
   * kaynağıyla ÇALIŞTIRILIYOR, geçmişi alınıyor, ve o geçmiş YENİ kaynağa
   * replay ediliyor.
   *
   * ── BEKLENEN SONUÇ VE NEDEN ─────────────────────────────────────────────
   * KAPIDA BEKLERKEN yakalanan bir koşu güvenle geçer. Kapıya kadarki komut
   * dizisi (work mode, intake, keşif, analiz, yayım, fan-out, kapı açılışı,
   * kapı beklemesi) DEĞİŞMEDİ — `writeAnalysis`'e eklenen argüman aktivitenin
   * TİPİNİ ve ID'sini değiştirmiyor, ve Temporal replay'de komutları yalnız o
   * ikisiyle eşleştiriyor.
   *
   * Değişen tek şey kapı KARARINDAN SONRAKİ dal: geri gönderme artık analizi
   * kendisi yazdırmıyor, bağlamı `continueAsNew` girdisine koyuyor. O dala
   * GİRMİŞ bir geçmiş — yani zaten geri gönderilmiş ve devam etmiş bir koşu —
   * farklı bir komut dizisi görürdü. Ama böyle bir geçmiş replay EDİLMEZ:
   * `continueAsNew` yeni bir execution başlatır ve eski execution KAPANIR;
   * kapalı bir koşunun geçmişi hiçbir worker tarafından yeniden oynatılmaz.
   * Yaşayan tek şey devam eden koşudur, ve o koşu adım 0'dan yeni kodla
   * başlar.
   */
  it("SAHADAKİ 1.0.20 ile başlamış, kapıda bekleyen bir koşu yeni koda geçer", async () => {
    try {
      Runtime.install({ logger: new DefaultLogger("ERROR") });
    } catch {
      /* already installed */
    }

    // Kapıda BEKLEYEN bir koşu: karar hiç verilmiyor, koşu 5'te asılı kalıyor.
    // Sahadaki durumun ta kendisi.
    const legacy = await runLegacyToGate();

    await expect(
      Worker.runReplayHistory(
        {
          workflowsPath: fileURLToPath(new URL("../src/ticket-workflow.ts", import.meta.url)),
          replayName: "legacy-1.0.20-waiting-at-gate",
        },
        legacy,
      ),
    ).resolves.toBeUndefined();
  });
});
