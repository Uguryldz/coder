import type { TicketKey, WorkflowRunState } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  decideFromStatus,
  gateStatusesForRules,
  gateStatusesOf,
  tryGateStatusDecision,
  type GateStatusReentry,
} from "../src/gate-status-reentry.js";
import type { ListeningRuleRecord, StatusMap } from "../src/listening-store.js";
import type { ResolvedDeps } from "../src/deps.js";

/**
 * KAPI KARARININ STATÜYLE VERİLMESİ — `/approve` yorumunun yanındaki ikinci
 * kanal.
 *
 * ── Kapatılan boşluk ──────────────────────────────────────────────────────
 * Operatörün akışı üç statülü ve son kenarı okuma tarafındaydı:
 *
 *     todo ⇄ analiz → analysisapproval → (eksik varsa) analiz
 *
 * Maestro'nun YAZMA tarafı bu döngüyü zaten sürüyordu. Eksik olan, operatörün
 * ticket'ı `analysisapproval`dan başka bir statüye taşımasının hiçbir şey
 * yapmamasıydı: kapıyı açan tek şey `/approve` yorumuydu, ve panosunda kartı
 * sürükleyen operatör ticket'ı "geliştirme"de görürken koşu hâlâ 4. kapıda
 * bekliyordu.
 *
 * ── Neyin sınandığı ───────────────────────────────────────────────────────
 * Üç katmanlı yankı koruması (yön / zaman / kimlik), çakışan eşlemenin
 * fail-closed düşürülmesi, ve onayın kimlik bilinmeyen kanalda TAŞINMAMASI.
 * Sonuncusu en kolay yanlış yapılacak olan: geri gönderme ile onayın aynı
 * kanaldan geçmesi, imzasız bir onay demek olurdu.
 */

const TICKET = "UGURPAY-77" as TicketKey;
const BOT = "maestro-bot";
/** Kapının açıldığı an. Aşağıdaki gözlemler 10:00'da, yani bundan sonra. */
const GATE_OPENED = "2026-08-09T09:00:00.000Z";
const NOW = new Date("2026-08-09T10:00:00.000Z");

function rule(statusMap: StatusMap | null, over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "UGURPAY",
    assigneeAccountId: BOT,
    matchKind: "assigned",
    matchValue: "*",
    flowType: "analiz",
    priority: 100,
    enabled: true,
    statusMap,
    ...over,
  };
}

describe("gateStatusesOf — bir kuralın kapı statüleri, çakışma elenmiş", () => {
  it("iki alanı da okur", () => {
    const gates = gateStatusesOf({ gateApproveStatus: "Geliştirme", gateReturnStatus: "Analiz" });
    expect(gates).toMatchObject({ approve: "Geliştirme", return: "Analiz", conflicts: [] });
  });

  it("eşleme yoksa hiçbir karar taşımaz — yorum-yalnız kip aynen sürer", () => {
    expect(gateStatusesOf(null)).toMatchObject({ approve: null, return: null, conflicts: [] });
  });

  /**
   * Bu dosyanın en önemli testi. İki yön aynı belgede duruyor: beş alan
   * Maestro'nun ticket'ı nereye taşıdığını, iki alan operatörün taşımasının ne
   * anlama geldiğini söylüyor. Aynı adı iki yöne birden yazmak, Maestro'nun
   * kendi hareketinin kendi kararı olarak geri okunması demek — kapı kendi
   * açılışıyla kendini kapatırdı.
   *
   * Zaman eşiği bunu çoğu durumda yakalar, ve tam olarak bu yüzden ona
   * GÜVENİLMİYOR: korumayı bir yarış koşusunun sonucuna bağlamanın bedeli,
   * yanlış giderse kendi kendini onaylayan bir kapıdır.
   */
  it("Maestro'nun kendi taşıdığı bir statüyle çakışan kapı statüsünü DÜŞÜRÜR", () => {
    const gates = gateStatusesOf({ onRejected: "Analiz", gateReturnStatus: "Analiz" });
    expect(gates.return).toBeNull();
    expect(gates.conflicts).toHaveLength(1);
    expect(gates.conflicts[0]).toContain("onRejected");
  });

  it("çakışmayı büyük/küçük harf ve boşluktan bağımsız görür", () => {
    // Jira statü adları operatörün yazdığı gibi gelir ve iki ekranda iki türlü
    // yazılabilir; koruma yazım farkıyla delinmemeli.
    const gates = gateStatusesOf({ onReview: " İNCELEMEDE ", gateApproveStatus: "incelemede" });
    expect(gates.approve).toBeNull();
    expect(gates.conflicts).toHaveLength(1);
  });

  it("bir alan çakışsa bile diğeri ayakta kalır ve iki çakışma da raporlanır", () => {
    const gates = gateStatusesOf({
      onDone: "Tamam",
      gateApproveStatus: "Tamam",
      gateReturnStatus: "Analiz",
    });
    expect(gates.approve).toBeNull();
    expect(gates.return).toBe("Analiz");
    expect(gates.conflicts).toHaveLength(1);
  });
});

describe("gateStatusesForRules — proje genelinde", () => {
  it("birden çok kuralın statülerini TOPLAR: iki ad aynı kararı verebilir", () => {
    // `flow-decision`ın "en dar kural kazanır" kuralından bilerek farklı: orada
    // soru "hangi akış koşacak" (tek cevabı olmalı), burada "operatör bu
    // hareketle ne demek istedi" (bir ad, herhangi bir kuralda tanımlıysa
    // anlamı vardır).
    const statuses = gateStatusesForRules(
      [
        rule({ gateApproveStatus: "Geliştirme" }),
        rule({ gateApproveStatus: "Development" }, { ruleId: "lr_2" }),
      ],
      "UGURPAY",
    );
    expect(decideFromStatus(statuses, "Geliştirme")).toBe("approve");
    expect(decideFromStatus(statuses, "Development")).toBe("approve");
  });

  it("aynı adı iki KARARA birden bağlayan kurallar o adı düşürür", () => {
    // Tek kurala bakan `gateStatusesOf` bunu göremez. Yanlış tahminin bir yönü
    // "onaylanmadığı hâlde ilerlemek", dolayısıyla belirsizlik fail-closed.
    const statuses = gateStatusesForRules(
      [rule({ gateApproveStatus: "Analiz" }), rule({ gateReturnStatus: "Analiz" }, { ruleId: "lr_2" })],
      "UGURPAY",
    );
    expect(decideFromStatus(statuses, "Analiz")).toBeNull();
    expect(statuses.conflicts.some((line) => line.includes("hem onay hem geri gönderme"))).toBe(true);
  });

  it("başka projenin ve KAPALI kuralın statülerini okumaz", () => {
    const statuses = gateStatusesForRules(
      [
        rule({ gateApproveStatus: "Geliştirme" }, { projectKey: "BASKA" }),
        rule({ gateReturnStatus: "Analiz" }, { ruleId: "lr_2", enabled: false }),
      ],
      "UGURPAY",
    );
    expect(decideFromStatus(statuses, "Geliştirme")).toBeNull();
    expect(decideFromStatus(statuses, "Analiz")).toBeNull();
  });
});

// ── karar yolu ───────────────────────────────────────────────────────────────

interface RunOptions {
  readonly state?: Partial<WorkflowRunState> | null;
  readonly rules?: readonly ListeningRuleRecord[];
  readonly status?: string;
  readonly identity?: { actor: string | undefined; bot: string };
  readonly canApprove?: boolean;
  /** Karar veren onay grubunun üyesi mi — `decideGate`in sorduğu şey. */
  readonly member?: boolean;
  readonly rulesThrow?: boolean;
}

interface RunResult {
  readonly outcome: GateStatusReentry;
  readonly signals: Array<{ name: string; arg: unknown }>;
  readonly audits: Array<Record<string, unknown>>;
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const signals: RunResult["signals"] = [];
  const audits: RunResult["audits"] = [];

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
        options.rulesThrow === true
          ? Promise.reject(new Error("depo okunamadı"))
          : Promise.resolve(options.rules ?? [rule({ gateApproveStatus: "Geliştirme", gateReturnStatus: "Analiz" })]),
    },
    gates: { ownerGroup: () => Promise.resolve("product-owners") },
    work: { verifyMembership: () => Promise.resolve(options.member ?? true) },
    audit: {
      append: (event: Record<string, unknown>) => {
        audits.push(event);
        return Promise.resolve({ seq: 41 });
      },
    },
  } as unknown as ResolvedDeps;

  const outcome = await tryGateStatusDecision(
    deps,
    {
      ticket: TICKET,
      status: options.status ?? "Analiz",
      canApprove: options.canApprove ?? true,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      observedAt: NOW,
    },
    `maestro-${TICKET}`,
  );
  return { outcome, signals, audits };
}

describe("tryGateStatusDecision — geri gönderme", () => {
  it("kapı statüsüne taşınan ticket analize geri gönderilir", async () => {
    const result = await run({ status: "Analiz", identity: { actor: "ayse.kaya", bot: BOT } });

    expect(result.outcome).toMatchObject({ kind: "decided", decision: "return_analysis", step: "4" });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.name).toBe("gateDecision");
    expect(result.signals[0]?.arg).toMatchObject({ decision: "return_analysis", step: "4" });
  });

  /**
   * "Geri gönder" bir RET DEĞİL, ve denetim izi bunu böyle söylemek zorunda:
   * bir denetçinin "bu ticket kaç kez reddedildi" sorusuna rutin inceleme
   * turlarını ret sayarak cevap vermek hem sayıyı hem anlamı bozar.
   */
  it("denetime GATE_RETURN yazar, GATE_REJECT değil", async () => {
    const result = await run({ status: "Analiz", identity: { actor: "ayse.kaya", bot: BOT } });
    expect(result.audits[0]).toMatchObject({ action: "GATE_RETURN", subject: TICKET });
  });

  it("kararın hangi statüden geldiğini kaydeder — aylar sonra tek cevap bu", async () => {
    const result = await run({ status: "Analiz", identity: { actor: "ayse.kaya", bot: BOT } });
    expect((result.signals[0]?.arg as { reason: string }).reason).toContain("Analiz");
  });

  /**
   * Statü değiştirmek, YETKİYİ ATLAMANIN yolu değildir. Geri gönderme bir
   * analiz turu HARCATIR (model çağırır, ticket'ın içeriğini değiştirir), yani
   * bir "durdurma" değil bir iş başlatmadır ve grubun üyeliğini gerektirir.
   */
  it("onay grubunun üyesi olmayan biri analizi yeniden yazdıramaz", async () => {
    const result = await run({
      status: "Analiz",
      identity: { actor: "yabanci", bot: BOT },
      member: false,
    });
    expect(result.outcome).toMatchObject({ kind: "decided", result: { ok: false, reason: "not_member" } });
    expect(result.signals).toHaveLength(0);
    expect(result.audits).toHaveLength(0);
  });
});

describe("tryGateStatusDecision — onay ve kimlik", () => {
  it("kimliği bilinen kanalda onay statüsü kapıyı kapatır", async () => {
    const result = await run({
      status: "Geliştirme",
      identity: { actor: "ayse.kaya", bot: BOT },
      canApprove: true,
    });
    expect(result.outcome).toMatchObject({ kind: "decided", decision: "approve" });
    expect(result.audits[0]).toMatchObject({ action: "GATE_APPROVE" });
  });

  /**
   * YOKLAMA kanalı. Bir ticket okuması onu kimin taşıdığını söylemez,
   * dolayısıyla grup üyeliği ölçülemez — ve ölçülemeyen bir yetkiyle kapı
   * açmak, kapının var olma sebebini ortadan kaldırır.
   *
   * Asimetri bilerek: geri gönderme aynı kanalda ÇALIŞIR (aşağıdaki test),
   * çünkü kimseyi bir şeyi onaylamış saymaz.
   */
  it("onayı taşımayan kanalda onay statüsü karar üretmez, ve sebebi adıyla söylenir", async () => {
    const result = await run({
      status: "Geliştirme",
      canApprove: false,
      identity: { actor: "ayse.kaya", bot: BOT },
    });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "approval_needs_identity" });
    expect(result.signals).toHaveLength(0);
  });

  it("aynı kanalda GERİ GÖNDERME çalışır — kimse hiçbir şeyi onaylamış olmaz", async () => {
    // Aktör yine BİLİNİYOR (üyelik ona soruluyor); `canApprove: false` yalnız
    // "bu kanal onayı taşımaz" der. İkisi ayrı sorular ve ayrı kaldıkları için
    // bu asimetri ifade edilebiliyor.
    const result = await run({
      status: "Analiz",
      canApprove: false,
      identity: { actor: "ayse.kaya", bot: BOT },
    });
    expect(result.outcome).toMatchObject({ kind: "decided", decision: "return_analysis" });
  });
});

describe("tryGateStatusDecision — yankı koruması", () => {
  /**
   * ZAMAN katmanı. Maestro kapıya girerken ticket'ı `onReview`e KENDİSİ taşıyor
   * ve `openGate` Jira'ya kapı yorumunu yazıyor. Damga bunlardan SONRA
   * atıldığı için o yankılar eşiğin gerisinde kalır.
   */
  it("kapı açılmadan ÖNCEKİ bir statü kendi hareketinin yankısıdır", async () => {
    const result = await run({
      status: "Analiz",
      identity: { actor: "ayse.kaya", bot: BOT },
      state: { gateOpenedSince: "2026-08-09T11:00:00.000Z" },
    });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "before_gate_opened" });
  });

  /**
   * Damganın yokluğu kapının açık OLMAMASININ kendisi: `gate-loop.ts` onu
   * açılışta atıyor, kapanışta siliyor. `status === "gate"` yetmezdi — 2b
   * netleştirme beklemesi de kendini öyle raporlar ve o onaylanacak bir şey
   * değildir.
   */
  it("kapı açık değilken hiçbir statü karar üretmez", async () => {
    const result = await run({
      status: "Analiz",
      state: { gateOpenedSince: undefined, step: "2b" },
    });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "not_at_gate" });
  });

  it("koşu yoksa sessizce geçer", async () => {
    const result = await run({ state: null });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "not_at_gate" });
  });

  /** KİMLİK katmanı: olayı bot'un kendisi ittiyse bu bir karar değil, kendi sesi. */
  it("bot'un kendi ittiği olay karar sayılmaz", async () => {
    const result = await run({ status: "Analiz", identity: { actor: BOT, bot: BOT } });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "bot_echo" });
  });

  it("kimlik katmanı kurulmuşsa aktörsüz bir teslimat tetiklemez", async () => {
    // Bilinmeyen bir kimlik "bot değil" DEMEK DEĞİLDİR, ve yanlış tarafta hata
    // yapmanın bedeli kapının kendi kendini kapatması olur.
    const result = await run({ status: "Analiz", identity: { actor: undefined, bot: BOT } });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "actor_unknown" });
  });

  it("çakışık eşleme kanalı kapatır ve bunu ADIYLA söyler", async () => {
    const result = await run({
      status: "Analiz",
      rules: [rule({ onRejected: "Analiz", gateReturnStatus: "Analiz" })],
      identity: { actor: "ayse.kaya", bot: BOT },
    });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "status_map_conflict" });
  });

  it("sıradan bir statü hareketi ile hiç yapılandırılmamış kanalı AYIRIR", async () => {
    // İkisi de "karar yok" ama farklı şeyler: biri gürültü, diğeri operatöre
    // söylenecek bir eksiklik.
    const configured = await run({
      status: "Beklemede",
      identity: { actor: "ayse.kaya", bot: BOT },
    });
    expect(configured.outcome).toMatchObject({ kind: "skipped", reason: "not_a_gate_status" });

    const unconfigured = await run({
      status: "Beklemede",
      rules: [rule(null)],
      identity: { actor: "ayse.kaya", bot: BOT },
    });
    expect(unconfigured.outcome).toMatchObject({ kind: "skipped", reason: "no_gate_statuses" });
  });

  it("kural deposu okunamıyorsa fırlatmaz — kapı kanalı bir yan iştir", async () => {
    const result = await run({
      status: "Analiz",
      rulesThrow: true,
      identity: { actor: "ayse.kaya", bot: BOT },
    });
    expect(result.outcome).toMatchObject({ kind: "skipped", reason: "no_gate_statuses" });
  });
});
