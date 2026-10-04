import type { ResolvedDeps } from "@maestro/bff";
import type { TicketKey, WorkflowRunState } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { canReadStatuses, canReadWorkflow, startJiraPoller } from "../src/jira-poller.js";

/**
 * KAPI KARARININ STATÜYLE VERİLMESİ — webhook'suz kurulumun kanalı.
 *
 * ── Kapatılan boşluk ──────────────────────────────────────────────────────
 * Operatörün akışı üç statülü ve son kenarı okunmuyordu: kapıyı açan tek şey
 * `/approve` yorumuydu. Panosunda kartı "analize geri" sürükleyen operatör
 * hiçbir şey olmadığını görüyordu.
 *
 * Webhook yolu bunu teslimat geldiğinde çözüyor. Bu döngünün var olma sebebi
 * ise tam olarak webhook'un ULAŞMADIĞI kurulum — dışarı çıkışı olmayan
 * kurumsal ağdaki Data Center — ve orada bu kanal olmasa statü yolu hiç
 * çalışmazdı.
 *
 * ── Bu kanalın kendine özgü zorluğu: KİM taşıdı ───────────────────────────
 * `decideGate` GRUP ÜYELİĞİ soruyor (M32/M35). "Ticket şu an X'te" bunu
 * cevaplayamaz — yalnızca CHANGELOG cevaplayabilir. Bu yüzden kanal
 * `readCurrentStatus` değil `listStatusChanges` okuyor, ve o okuma
 * olmadan hiçbir kapı kararı taşıyamazdı.
 */

const TICKET = "UGURPAY-77" as TicketKey;
const BOT = "maestro-bot";
/** Kapının açıldığı an. Aşağıdaki taşımalar bundan sonra. */
const GATE_OPENED = "2026-08-09T09:00:00.000Z";
const MOVED_AT = "2026-08-09T09:30:00.000Z";
const NOW = new Date("2026-08-09T10:00:00.000Z");

interface StatusChange {
  actorAccountId: string;
  toStatus: string | null;
  at: string;
}

interface RoundOptions {
  readonly state?: Partial<WorkflowRunState> | null;
  readonly changes?: readonly StatusChange[];
  readonly changesThrow?: Error;
  readonly noStatusReader?: boolean;
  readonly noBotAccount?: boolean;
  readonly member?: boolean;
  readonly gateApproveStatus?: string;
  readonly gateReturnStatus?: string;
  /** Maestro'nun KENDİ taşıdığı noktalar — türetme ve çakışma sınamak için. */
  readonly onRejected?: string;
  /** Kapı ORADA açılıyor: kalan tek çakışma yasağı bununla sınanıyor. */
  readonly onReview?: string;
}

interface RoundResult {
  readonly signals: Array<{ name: string; arg: unknown }>;
  readonly lines: string[];
  readonly statusCalls: number;
}

async function round(options: RoundOptions = {}): Promise<RoundResult> {
  const lines: string[] = [];
  const signals: RoundResult["signals"] = [];
  let statusCalls = 0;

  const state: WorkflowRunState | null =
    options.state === null
      ? null
      : ({
          runId: "run-1",
          ticketKey: TICKET,
          step: "4",
          status: "gate",
          startedAt: "2026-08-09T08:00:00.000Z",
          updatedAt: GATE_OPENED,
          gateOpenedSince: GATE_OPENED,
          ...options.state,
        } as WorkflowRunState);

  const deps = {
    // Yorum yolu bu testte yok: `handleCommand` bağlamayı sorar ve bağlanmamış
    // projeyi sessizce düşürür, yani tur komut tarafında hiçbir şey yapmaz.
    bindings: { resolve: () => Promise.resolve(null) },
    counters: { droppedUnbound: 0 },
    clock: { now: () => NOW },
    runs: {
      queryRunState: () => Promise.resolve(state),
      signal: (_id: string, name: string, arg: unknown) => {
        signals.push({ name, arg });
        return Promise.resolve("delivered");
      },
    },
    listening: {
      list: () =>
        Promise.resolve([
          {
            ruleId: "lr_1",
            projectKey: "UGURPAY",
            assigneeAccountId: BOT,
            matchKind: "assigned",
            matchValue: "*",
            flowType: "analiz",
            priority: 100,
            enabled: true,
            statusMap: {
              ...(options.onRejected === undefined ? {} : { onRejected: options.onRejected }),
              ...(options.onReview === undefined ? {} : { onReview: options.onReview }),
              gateApproveStatus: options.gateApproveStatus ?? "Geliştirme",
              gateReturnStatus: options.gateReturnStatus ?? "Analiz",
            },
          },
        ]),
    },
    gates: { ownerGroup: () => Promise.resolve("product-owners") },
    work: { verifyMembership: () => Promise.resolve(options.member ?? true) },
    audit: { append: () => Promise.resolve({ seq: 41 }) },
  } as unknown as ResolvedDeps;

  const statusReader = {
    readCurrentStatus: () => Promise.resolve("Analiz"),
    listStatusChanges: (): Promise<readonly StatusChange[]> => {
      statusCalls += 1;
      if (options.changesThrow !== undefined) return Promise.reject(options.changesThrow);
      return Promise.resolve(
        options.changes ?? [{ actorAccountId: "ayse.kaya", toStatus: "Analiz", at: MOVED_AT }],
      );
    },
  };

  const loop = startJiraPoller({
    deps,
    comments: { listComments: () => Promise.resolve([]) },
    openTickets: () => Promise.resolve([TICKET]),
    // Aralık asla ateşlemesin: sınanan `startJiraPoller`'ın kendi ilk turu.
    intervalMs: 3_600_000,
    log: (message) => lines.push(message),
    ...(options.noStatusReader === true ? {} : { statuses: statusReader }),
    ...(options.noBotAccount === true ? {} : { botAccountId: () => Promise.resolve(BOT) }),
  });

  await settle();
  loop.stop();
  return { signals, lines, statusCalls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const summaryOf = (lines: string[]): string =>
  lines.find((line) => line.startsWith("[yoklama] tur bitti")) ?? "";

describe("canReadStatuses", () => {
  it("İKİ yöntemi birden ister — biri diğerini VARSAYMAK kastın hatasıdır", () => {
    // `readCurrentStatus` "ticket şu an nerede", `listStatusChanges` "oraya kim
    // taşıdı". Kanal ikisine de muhtaç ve ikincisi olmadan hiçbir karar
    // veremez, çünkü üyelik bir kişiye sorulur.
    expect(
      canReadStatuses({
        readCurrentStatus: () => Promise.resolve(null),
        listStatusChanges: () => Promise.resolve([]),
      }),
    ).toBe(true);
    expect(canReadStatuses({ readCurrentStatus: () => Promise.resolve(null) })).toBe(false);
    expect(canReadStatuses({ readCurrentStatus: true, listStatusChanges: true })).toBe(false);
    expect(canReadStatuses(null)).toBe(false);
  });
});

describe("poller gate-status channel", () => {
  it("kapı statüsüne taşınan ticket'ı analize geri gönderir", async () => {
    const result = await round();

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.name).toBe("gateDecision");
    expect(result.signals[0]?.arg).toMatchObject({ decision: "return_analysis", step: "4" });
    expect(result.lines.some((l) => l.includes("analize geri gönderildi"))).toBe(true);
    expect(summaryOf(result.lines)).toContain("1 kapı statüyle kapandı");
  });

  it("onay statüsüne taşınan ticket'ta kapıyı ONAYLAR — changelog aktörü taşıyor", async () => {
    // Bu, changelog okumasının var olma sebebi. Aktör bilinmeseydi üyelik
    // ölçülemez ve onay taşınamazdı; imzasız bir onay SoD'nin (M32)
    // engellemek için var olduğu şeydir.
    const result = await round({
      changes: [{ actorAccountId: "ayse.kaya", toStatus: "Geliştirme", at: MOVED_AT }],
    });
    expect(result.signals[0]?.arg).toMatchObject({ decision: "approve", actorUserId: "ayse.kaya" });
  });

  it("onay grubunun üyesi olmayan biri kapıyı statüyle açamaz", async () => {
    const result = await round({
      changes: [{ actorAccountId: "yabanci", toStatus: "Geliştirme", at: MOVED_AT }],
      member: false,
    });
    expect(result.signals).toHaveLength(0);
    expect(result.lines.some((l) => l.includes("not_member"))).toBe(true);
    expect(summaryOf(result.lines)).toContain("1 statü kararı kabul edilmedi");
  });

  // ── yankı koruması ─────────────────────────────────────────────────────────

  /**
   * KİMLİK katmanı. Maestro kapıya girerken ticket'ı `onReview`e KENDİSİ
   * taşıyor ve o taşıma changelog'a BOT adıyla düşer. Ayıklanmazsa kapı kendi
   * açılışıyla kendini kapatırdı.
   */
  it("bot'un kendi taşıması karar sayılmaz", async () => {
    const result = await round({
      changes: [{ actorAccountId: BOT, toStatus: "Analiz", at: MOVED_AT }],
    });
    expect(result.signals).toHaveLength(0);
  });

  /**
   * ZAMAN katmanı, ve bu kanalda changelog KAYDININ zamanıyla ölçülüyor —
   * turun saatiyle değil. Yoklama 60 saniyede bir çalışır, yani "şimdi" her
   * zaman hareketten sonradır; turun saati kullanılsaydı kapı açılmadan önce
   * yapılmış bir taşıma bile eşiği geçerdi.
   */
  it("kapı açılmadan ÖNCE yapılmış bir taşımayı karar saymaz", async () => {
    const result = await round({
      changes: [{ actorAccountId: "ayse.kaya", toStatus: "Analiz", at: "2026-08-09T08:30:00.000Z" }],
    });
    expect(result.signals).toHaveLength(0);
  });

  it("okunamayan bir damgayla karar üretmez — eşiksiz kalan koruma korumasızdır", async () => {
    const result = await round({
      changes: [{ actorAccountId: "ayse.kaya", toStatus: "Analiz", at: "" }],
    });
    expect(result.signals).toHaveLength(0);
  });

  /**
   * YÖN katmanı, KALAN TEK YASAĞIYLA: kapı kenarı `onReview` ile çakışırsa
   * düşer — kapı ORADA açılıyor, dolayısıyla oradan bir karar okunamaz.
   *
   * `onRejected` ile çakışma ARTIK YASAK DEĞİL ve bu turun sebebi o: operatörün
   * hattında `analiz` hem "iş burada yapılır" hem "buraya geri gönder", ve eski
   * koruma bu doğru yapılandırmayı reddediyordu.
   */
  it("onReview ile çakışan kenarda kanal kapanır ve operatöre söylenir", async () => {
    const result = await round({ onReview: "Analiz", gateReturnStatus: "Analiz" });
    expect(result.signals).toHaveLength(0);
    expect(result.lines.some((l) => l.includes("çakışık"))).toBe(true);
  });

  /**
   * ── "KAYITLAR ATLANMASIN" ──────────────────────────────────────────────
   *
   * Ticket KAPIDA BEKLERKEN bir yere taşındı ve o statünün kuralda tanımlı bir
   * rolü yok. Eskiden bu sessizce düşüyordu — operatörün "taşıdım, hiçbir şey
   * olmadı" sorusunun hiçbir yerde cevabı yoktu.
   *
   * Gürültü değil: buraya gelen hareket zaten kapıda bekleyen bir koşuya ait ve
   * kapı açıldıktan sonra olmuş. Kuralın TANIDIĞI noktalar da satıra yazılıyor,
   * ki cümle teşhis olsun, şikâyet değil.
   */
  it("tanımsız bir statüye taşıma SESSİZCE DÜŞMEZ — tanınan noktalarla yazılır", async () => {
    const result = await round({
      changes: [{ actorAccountId: "ayse.kaya", toStatus: "Beklemede", at: MOVED_AT }],
    });
    expect(result.signals).toHaveLength(0);
    const line = result.lines.find((l) => l.includes("tanımlı bir rol"));
    expect(line).toBeDefined();
    // Kuralın kendi noktaları satırda: operatör farkı bir bakışta görsün.
    expect(line).toContain("Beklemede");
    // Ve bir KARAR verilmedi: satır yalnız "yok sayıldı" diyor.
    expect(result.lines.some((l) => l.includes("onaylandı"))).toBe(false);
  });

  // ── kanalın açık olması ────────────────────────────────────────────────────

  /**
   * MOTOR ÖNCE, JIRA SONRA. Kapı açık değilse Jira hiç aranmaz — kapıda
   * bekleyen koşu, açık koşuların küçük bir alt kümesidir ve çoğu tur sıfır ek
   * çağrıdır.
   */
  it("kapıda beklemeyen bir koşu için Jira'ya hiç gitmez", async () => {
    const result = await round({ state: { gateOpenedSince: undefined, step: "3" } });
    expect(result.statusCalls).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("statü okuyucusu olmayan sürücüde kanal YOKTUR — /approve tek yol kalır", async () => {
    const result = await round({ noStatusReader: true });
    expect(result.statusCalls).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("bot kimliği bilinmiyorsa kanal kapalı — kendi taşımasını ayıklayamaz", async () => {
    // Kimlik katmanı kurulamıyorsa Maestro'nun kendi `onReview` hareketi
    // ayıklanamaz. Netleştirme kanalının aynı durumdaki duruşuyla aynı.
    const result = await round({ noBotAccount: true });
    expect(result.statusCalls).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("changelog okunamazsa turu düşürmez, sebebi adıyla yazar", async () => {
    const result = await round({ changesThrow: new Error("403 Forbidden") });
    expect(result.lines.some((l) => l.includes("kapı statüsü okunamadı"))).toBe(true);
    // Tur yine bitti: kanal bir yan iştir ve bir ticket'ın hatası turu
    // durdurmamalı.
    expect(summaryOf(result.lines)).not.toBe("");
  });

  /**
   * SAHADAN GELEN ŞİKÂYETİN KENDİSİ: "geri gönderdim, hiçbir şey olmadı."
   *
   * `gateApproveStatus`/`gateReturnStatus` 1.0.20'de geldi, yani YÜKSELTİLEN
   * her kurulumda ikisi de boş başlıyor ve kanal kapalı doğuyor. Kapalı olması
   * doğru (fail-closed), SESSİZ olması değildi: operatör ticket'ı taşıyor,
   * `decideFromStatus` soracak bir ad bulamıyor, tur `no_gate_statuses` ile
   * sessizce çıkıyor, ve log "yoklama çalışıyor, kimse bir şey yapmadı" diyen
   * turla HARF HARF aynı görünüyordu. Operatörün elinde ayırt edecek hiçbir şey
   * yoktu — ve panelde doldurulacak iki alan olduğunu bilmesinin yolu da.
   */
  it("kapı statüleri hiç yapılandırılmamışsa SESSİZ kalmaz — çaresiyle birlikte yazar", async () => {
    const result = await round({ gateApproveStatus: "", gateReturnStatus: "" });
    // Karar üretilmedi: kanal kapalı ve kapalı kalmalı.
    expect(result.signals).toHaveLength(0);
    const summary = summaryOf(result.lines);
    expect(summary).toContain("1 kapı statü kanalı kapalı");
    // Sayı tek başına yetmez: operatöre NE YAPACAĞINI söylemeli.
    expect(summary).toContain("/approve");
  });

  /** Yapılandırılmış bir kuralda bu sayaç susmalı — yoksa her tur bağırırdı. */
  it("kapı statüleri doluyken bu satır HİÇ çıkmaz", async () => {
    const result = await round();
    expect(summaryOf(result.lines)).not.toContain("kapı statü kanalı kapalı");
  });
});

/**
 * `canReadWorkflow` — iş akışı okuyucusu BAĞLI MI.
 *
 * Bu kontrol, sürücüde var olan ama üretim bileşimine hiç bağlanmamış bir
 * yeteneği açtı: `JiraCloudWorkPort.readProjectWorkflow` yazılmıştı, ama
 * `deps.jiraWorkflow`a hiçbir yerde atanmıyordu — yani
 * `GET /studio/jira-workflow` HER kurulumda 503 dönüyordu ve ona dayanan
 * hiçbir ekran yazılamıyordu.
 *
 * Yetenek SORULUYOR, varsayılmıyor: Data Center sürücüsünde bu metot henüz yok
 * ve "sürücü okuyamıyor" ile "bu projenin iş akışı yok" farklı iki şey.
 */
describe("canReadWorkflow", () => {
  it("metodu OLAN sürücüyü tanır", () => {
    expect(canReadWorkflow({ readProjectWorkflow: () => Promise.resolve({}) })).toBe(true);
  });

  it("metodu olmayanı tanımaz — 503-adıyla reddedilecek", () => {
    expect(canReadWorkflow({ readCurrentStatus: () => Promise.resolve(null) })).toBe(false);
  });

  it.each([[null], [undefined], ["metin"], [42], [{ readProjectWorkflow: "fonksiyon değil" }]])(
    "%s için false",
    (driver) => {
      expect(canReadWorkflow(driver)).toBe(false);
    },
  );
});
