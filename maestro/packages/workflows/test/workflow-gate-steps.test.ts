import { fileURLToPath } from "node:url";
import type { WorkflowHandle } from "@temporalio/client";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StepId } from "@maestro/contracts";
import { GATES_BY_RISK } from "@maestro/contracts";
import {
  Scenario,
  TICKET,
  analysisDoc,
  approval,
  createTestEnv,
  makeActivities,
  runTicket,
} from "./harness.js";
import { ticketWorkflow as legacyWorkflow } from "./legacy/ticket-workflow-v1020.js";

/**
 * KAPI DİZİSİ KURALDAN GELİYOR — ve kayıtlı hiçbir koşu bundan zarar görmüyor.
 *
 * ── Operatörün cümlesi ──────────────────────────────────────────────────────
 * "kapı dizisi jiradan yönetilir zaten" — onay YETKİSİ Jira'nın izin şemasında
 * duruyor, ve Maestro'nun ikinci bir grup katmanı kurması o katmanın boş
 * olduğu bir sahada yalnızca kapıların kapanmamasını üretiyordu.
 *
 * Bu dosya üç şeyi ölçüyor, ve üçü de birbirinden bağımsız:
 *
 *  1. SEÇİM ÇALIŞIYOR MU — kuralın seçtiği dizi tam olarak açılıyor mu,
 *     seçim yokken bugünkü davranış aynen sürüyor mu, boş seçim gerçekten
 *     hiçbir kapı açmıyor mu.
 *  2. SAHİPSİZ KAPI GÜVENLİ Mİ — kapı yine açılıyor, yine bir insan
 *     kapatıyor, kimliği yine kaydediliyor, SoD imza sırası yine geçerli.
 *  3. DETERMİNİZM — sahadaki 1.0.20 ile başlamış, KAPIDA BEKLEYEN bir koşu
 *     yeni koda replay edilebiliyor mu. İDDİA DEĞİL, ÖLÇÜM.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("kapı dizisi kuralda seçilir", () => {
  it("SEÇİM YOKKEN bugünkü davranış birebir sürer — risk katmanı karar verir", async () => {
    // `gateSteps` HİÇ verilmiyor: 0027 öncesi yazılmış her kuralın ve kayıtlı
    // her koşunun hâli. Beklenen cevap `GATES_BY_RISK["kritik"]`in analiz
    // yarısı, çünkü akış `analiz` — yani bugüne kadar ne açılıyorsa o.
    const run = await runTicket(
      env,
      new Scenario({ risk: "kritik", flow: "analiz", gate: () => ({ kind: "approve" }) }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(
      GATES_BY_RISK.kritik.filter((step) => step === "4" || step === "5"),
    );
    // Ve `4` gerçekten oradaydı: bu satır olmadan test, boş bir listeyi boş bir
    // listeyle karşılaştırıp hiçbir şey ölçmemiş olurdu.
    expect(run.scenario.opened).toContain("4");
  });

  it("kuralın seçtiği dizi AÇILIR — risk katmanının söylediği ne olursa olsun", async () => {
    // Risk `kritik`, yani varsayılan dizi 4 VE 5 açardı. Kural yalnız 5
    // istiyor: seçim risk katmanını EZİYOR.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "kritik",
        flow: "analiz",
        gateSteps: ["5"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["5"]);
  });

  it("kuralın seçimi kapı EKLEYEBİLİR de — düşük riskte PO onayı", async () => {
    // Ters yön, ve önemli: seçim yalnız daraltan bir filtre değil. Risk
    // `dusuk` olduğu için varsayılan dizi 4'ü İÇERMEZ; kural onu istiyor.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["4", "5"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(GATES_BY_RISK.dusuk).not.toContain("4");
    expect(run.scenario.opened).toEqual(["4", "5"]);
  });

  it("BOŞ SEÇİM hiçbir kapı açmaz — ve koşu yine de tamamlanır", async () => {
    // Operatörün akışı: onay `analysisapproval → development` statü
    // hareketiyle veriliyor, Maestro'nun ayrıca bir kapı açması gereksiz.
    // `gate` hiç tanımlanmıyor: bir kapı açılsaydı hiçbir karar gelmez ve
    // koşu orada asılı kalırdı — yani bu test kapının açılMAdığını iki kere
    // kanıtlıyor (boş `opened` VE koşunun bitmesi).
    const run = await runTicket(
      env,
      new Scenario({ risk: "kritik", flow: "analiz", gateSteps: [] }),
    );
    expect(run.error).toBeNull();
    expect(run.status).toBe("done");
    expect(run.scenario.opened).toEqual([]);
  });

  it("seçim SIRADAN bağımsızdır — akış sırası her zaman kazanır", async () => {
    // Operatör kutuları ters sırada işaretlerse kapılar ters sırada açılamaz:
    // 5'i 4'ten önce açmak, four-eyes kuralının dayandığı sırayı bozardı.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["5", "4"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["4", "5"]);
  });

  it("seçim yinelenenleri yutar — aynı kapı iki kez açılmaz", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["5", "5", "5"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["5"]);
  });

  it("AKIŞ hâlâ üstün: analiz akışında seçilen 12 açılmaz", async () => {
    // `planFor("analiz")` mühendisliği hiç çalıştırmaz, dolayısıyla ortada bir
    // PR yoktur ve 12'yi açmak açılacak bir şey olmayan bir kapıyı sonsuza
    // dek beklemek olurdu. Seçim akışı EZEMEZ — iki ayrı eksen.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["5", "12"],
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["5"]);
    expect(run.status).toBe("done");
  });

  it("seçim `continueAsNew`i AŞAR — geri gönderilen koşu aynı diziyle sürer", async () => {
    // Bağlam kaybı yok iddiasının kapı dizisi ayağı: koşu 5'te bir kez geri
    // gönderiliyor, `continueAsNew` ile devam ediyor, ve İKİNCİ turda da
    // yalnız 5 açılıyor — dizi girdide taşındığı için.
    const run = await runTicket(
      env,
      new Scenario({
        risk: "kritik",
        flow: "analiz",
        gateSteps: ["5"],
        gate: (step, visit) =>
          step === "5" && visit === 1
            ? { kind: "return_once", reason: "eksik var" }
            : { kind: "approve" },
      }),
    );
    expect(run.error).toBeNull();
    // İki tur, iki kez YALNIZ 5. Dizi taşınmasaydı ikinci tur `kritik`
    // varsayılanına düşer ve 4 de açılırdı.
    expect(run.scenario.opened).toEqual(["5", "5"]);
  });
});

describe("sahipsiz kapı — kapı kalkmaz, yalnız grup sorusu kalkar", () => {
  it("kapı SAHİPSİZ açılır ve yine bir insanın kararıyla kapanır", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["5"],
        gateOwnerless: true,
        gate: () => ({ kind: "approve" }),
      }),
    );
    expect(run.error).toBeNull();
    expect(run.scenario.opened).toEqual(["5"]);
    // Kapı bir GRUP adına açılmadı.
    expect(run.scenario.openedAgainst).toEqual([null]);
    // Ama AÇILDI, ve bir insanın kararıyla kapandı — kimliğiyle birlikte.
    expect(run.scenario.decisions).toHaveLength(1);
    expect(run.scenario.decisions[0]?.actorUserId).toBe("tech-leads-5@bank");
    expect(run.status).toBe("done");
  });

  it("sahipsiz kapıda SoD imza sırası AYNEN geçerli", async () => {
    /**
     * Kaybedilen tek şeyin "hangi grup" olduğu iddiasının ölçümü.
     *
     * Aynı kişi 4'ü imzalıyor, sonra 5'i de imzalamaya kalkıyor. Four-eyes
     * (M32) bunu REDDETMELİ ve kapı AÇIK kalmalı — sahipsizlik bu kuralı
     * gevşetmiyor. Ardından farklı biri geldiğinde kapı kapanıyor, yani
     * kilitlenme de üretilmiyor.
     *
     * `burst` kullanılıyor çünkü iki kararı da ADIYLA göndermek gerekiyor:
     * ilki reddedilecek olan (aynı imza), ikincisi kapatacak olan. Aynı turda
     * gönderilmeleri testi daha da sert yapıyor — workflow ikisini de görmek
     * ve YALNIZ ikincisini kabul etmek zorunda.
     */
    const solo = "tek-kisi@bank";
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gateSteps: ["4", "5"],
        gateOwnerless: true,
        gate: (step) =>
          step === "4"
            ? {
                kind: "burst",
                decisions: [approval("4", { actorUserId: solo })],
              }
            : {
                kind: "burst",
                decisions: [
                  // AYNI imza — reddedilmeli.
                  approval("5", { actorUserId: solo }),
                  // Başka biri — kapıyı kapatmalı.
                  approval("5", { actorUserId: "baska-kisi@bank", signatureSeq: 2 }),
                ],
              },
      }),
    );
    expect(run.error).toBeNull();
    // İlk karar four-eyes yüzünden reddedildi ve bu deftere yazıldı.
    const refused = run.scenario.journal.filter(
      (line) => line.title === "karar reddedildi" && line.detail.includes("sod_violation"),
    );
    expect(refused.length).toBeGreaterThan(0);
    // Kapı sonunda BAŞKA biriyle kapandı — ve `recordGateDecision`a giden
    // kararlar arasında `solo`nun 5'i YOK: reddedilen karar kaydedilmedi.
    const fifth = run.scenario.decisions.filter((d) => d.step === "5");
    expect(fifth.map((d) => d.actorUserId)).toEqual(["baska-kisi@bank"]);
    expect(run.status).toBe("done");
  });

  it("sahiplilik VARSAYILAN OLARAK KAPALI — seçim yapılmamış kural eski dalda", async () => {
    const run = await runTicket(
      env,
      new Scenario({ risk: "dusuk", flow: "analiz", gate: () => ({ kind: "approve" }) }),
    );
    expect(run.error).toBeNull();
    // `gateOwnerless` hiç verilmedi: kapı rolün adına açıldı, tıpkı bugüne
    // kadar olduğu gibi.
    expect(run.scenario.openedAgainst).toEqual(["tech-leads"]);
  });
});

/**
 * ── DETERMİNİZM: SAHADA KAPIDA BEKLEYEN KOŞULAR ─────────────────────────────
 *
 * Bu değişiklik workflow'un komut dizisine dokunuyor mu? İddia yerine ölçüm.
 *
 * ── Değişen ne, ve neden replay'i bozmaması BEKLENİYOR ──────────────────────
 *  · `gatesFor` ikinci bir argüman aldı; ama kayıtlı geçmişlerde `gateSteps`
 *    alanı HİÇ YOK → `undefined` → aynı `GATES_BY_RISK` cevabı → aynı kapı
 *    dizisi → aynı aktivite dizisi.
 *  · `awaitGate` bir `ownerless` argümanı aldı; kayıtlı geçmişlerde
 *    `gateOwnerless` yok → `false` → `ownerOf` eski `GATE_OWNER` değerini
 *    döndürür → `openGate` AYNI argümanlarla zamanlanır.
 *  · `openGate`in dönüş tipi `string`ten `string | null`a genişledi. Bu bir
 *    TİP değişikliği, bir komut değişikliği değil: aktivitenin tipi ve id'si
 *    aynı, ve Temporal replay'de komutları YALNIZ o ikisiyle eşleştirir
 *    ("does not match activity type of activity command" / "...activity id...";
 *    argüman ya da payload karşılaştıran bir determinizm hatası YOKTUR).
 *
 * Beklenti bu; aşağısı onu ÖLÇÜYOR. Kırılsaydı `runReplayHistory` bir
 * `DeterminismViolationError` atardı ve bu test kırmızı olurdu.
 */
describe("determinizm — kapı dizisi değişikliği kapıda bekleyen koşuları bozmuyor", () => {
  /**
   * 180 sn zaman aşımı: replay'in kendisi saniyeler sürüyor, ama önce eski
   * kaynakla bir koşuyu kapıya kadar sürmek gerekiyor ve o iş zaman atlamalı
   * sunucuda gerçek zamanlı ilerliyor (kapı bir `condition`, atlanacak bir
   * zamanlayıcı değil). Varsayılan 5 sn burada ölçülen şeyi değil, kurulumu
   * keserdi.
   */
  it("SAHADAKİ 1.0.20 ile başlamış, kapıda BEKLEYEN bir koşu yeni koda geçer", async () => {
    try {
      Runtime.install({ logger: new DefaultLogger("ERROR") });
    } catch {
      /* already installed */
    }

    const legacy = await runLegacyToGate();

    await expect(
      Worker.runReplayHistory(
        {
          workflowsPath: fileURLToPath(new URL("../src/ticket-workflow.ts", import.meta.url)),
          replayName: "legacy-1.0.20-waiting-at-gate-gatesteps",
        },
        legacy,
      ),
    ).resolves.toBeUndefined();
  });

});

let legacyId = 0;

/**
 * SAHADAKİ 1.0.20 workflow'unu kapıda BEKLEYEN hâlde bırakır ve geçmişini verir.
 *
 * `workflow-analysis-rewrite.test.ts`teki kardeşinin aynısı ve bilerek: aynı
 * ölçüm, aynı yolla yapılmalı ki iki testin kırmızıya dönmesi aynı şeyi
 * söylesin. `runTicket` kullanılamaz — o koşuyu KAPANANA kadar sürer, oysa
 * ölçülmek istenen tam olarak kapanMAMIŞ bir koşu.
 */
async function runLegacyToGate(): Promise<Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>> {
  legacyId += 1;
  const taskQueue = `maestro-gatesteps-legacy-${legacyId}`;
  const opened: StepId[] = [];
  const risk = "dusuk" as const;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("./legacy/ticket-workflow-v1020.ts", import.meta.url)),
    activities: makeActivities(new Scenario({ risk, flow: "analiz" }), {
      // Kapı AÇILIR ama hiçbir karar sinyali gönderilmez: koşu orada bekler —
      // sahadaki durumun ta kendisi.
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
      workflowId: `gatesteps-legacy-${legacyId}`,
      args: [{ ticket: TICKET, appId: "pay", mode: "full_auto", dataClass: "dahili", flow: "analiz" }],
    });
    for (let turn = 0; turn < 200 && opened.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(opened.length).toBeGreaterThan(0);
    // Bekleme durumunun geçmişe İŞLENMESİ için bir tur daha.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const history = await handle.fetchHistory();
    // Geçmişin GERÇEKTEN kapıya kadar geldiğini kanıtla: `openGate` orada
    // olmasaydı bu test hiçbir şey ölçmezdi.
    const scheduled = (history.events ?? [])
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter((n): n is string => typeof n === "string");
    expect(scheduled).toContain("openGate");
    expect(scheduled).toContain("writeAnalysis");
    return history;
  } finally {
    worker.shutdown();
    await running.catch(() => undefined);
  }
}
