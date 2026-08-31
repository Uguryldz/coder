import type { ResolvedDeps } from "@maestro/bff";
import type { TicketKey, WorkflowRunState } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { canReadTickets, startJiraPoller } from "../src/jira-poller.js";

/**
 * Netleştirmeye yeniden girişin WEBHOOK'SUZ kanalı.
 *
 * Kapatılan boşluk: koşu 2b'de `condition(() => inbox.clarified)` ile süresiz
 * bekliyor ve o koşulu açan tek sinyali Jira tarafından gönderen hiçbir şey
 * yoktu. Webhook yolu bunu teslimat geldiğinde çözüyor — ama bu döngünün var
 * olma sebebi tam olarak webhook'un ULAŞMADIĞI kurulum: dışarı çıkışı olmayan
 * kurumsal ağdaki bir Data Center. Orada bu kanal olmasa netleştirme cevabının
 * hiçbir yolu kalmazdı.
 *
 * Tetik ATAMA. Maestro kendini hiçbir yerde bot'a atamıyor — `reassignOnNeedInfo`
 * ticket'ı reporter'a, yani bot'tan UZAĞA atar — dolayısıyla "ticket şu an
 * bot'ta" durumunu üretebilecek tek şey bir insanın hareketidir. Bu kanalda
 * `actor` okunamıyor (bir ticket okuması onu kimin değiştirdiğini söylemez),
 * ve eksik kimlik katmanının işini yönün kendisi görüyor.
 */

const TICKET = "UGURPAY-77" as TicketKey;
const BOT = "maestro-bot";
/** Sorunun sorulduğu an. Saat aşağıda 09:00'da duruyor, yani bundan sonra. */
const ASKED_AT = "2026-08-09T08:30:00.000Z";
const NOW = new Date("2026-08-09T09:00:00.000Z");

interface RoundOptions {
  /** Koşunun `runState` sorgusunun cevabı; `null` = koşu yok. */
  readonly state?: Partial<WorkflowRunState> | null;
  /** Ticket'ın şu anki atananı. */
  readonly assignee?: string | null;
  /** Ticket okuması patlasın. */
  readonly getThrows?: Error;
  /** Sürücü ticket okuyamıyor (kanalın hiç olmadığı kurulum). */
  readonly noTicketReader?: boolean;
  /** Bot hesabı yapılandırılmamış. */
  readonly noBotAccount?: boolean;
  /** Kaç tur koşulsun (yinelenen uyandırmayı sınamak için). */
  readonly rounds?: number;
}

interface RoundResult {
  readonly signals: Array<{ workflowId: string; name: string; arg: unknown }>;
  readonly audits: Array<Record<string, unknown>>;
  readonly lines: string[];
  readonly getTicketCalls: number;
}

async function round(options: RoundOptions = {}): Promise<RoundResult> {
  const lines: string[] = [];
  const signals: RoundResult["signals"] = [];
  const audits: RoundResult["audits"] = [];
  let getTicketCalls = 0;

  const state: WorkflowRunState | null =
    options.state === null
      ? null
      : ({
          runId: "run-1",
          ticketKey: TICKET,
          step: "2b",
          status: "gate",
          startedAt: "2026-08-09T08:00:00.000Z",
          updatedAt: "2026-08-09T08:30:00.000Z",
          awaitingClarificationSince: ASKED_AT,
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
      signal: (workflowId: string, name: string, arg: unknown) => {
        signals.push({ workflowId, name, arg });
        return Promise.resolve("delivered");
      },
    },
    audit: {
      append: (event: Record<string, unknown>) => {
        audits.push(event);
        return Promise.resolve();
      },
    },
  } as unknown as ResolvedDeps;

  const ticketReader = {
    getTicket: (): Promise<{ assignee: string | null }> => {
      getTicketCalls += 1;
      if (options.getThrows !== undefined) return Promise.reject(options.getThrows);
      return Promise.resolve({ assignee: options.assignee ?? null });
    },
  };

  const loop = startJiraPoller({
    deps,
    comments: { listComments: () => Promise.resolve([]) },
    openTickets: () => Promise.resolve([TICKET]),
    // Aralık asla ateşlemesin: sınanan, `startJiraPoller`'ın kendi başlattığı
    // ilk turdur, ve ek turlar aşağıda elle tetiklenir.
    intervalMs: 3_600_000,
    log: (message) => lines.push(message),
    ...(options.noTicketReader === true ? {} : { tickets: ticketReader }),
    // Kimlik artık her tur ÇÖZÜLÜYOR (boot'ta bir kez okunmuyor): kurulumdan
    // sonra panelde öğrenilen bir kimliğin yeniden başlatma beklememesi için.
    ...(options.noBotAccount === true ? {} : { botAccountId: () => Promise.resolve(BOT) }),
  });

  await settle();
  // Ek turlar: aynı süreçte ikinci bir turun ne yaptığını görebilmek için
  // döngüyü yeniden kurmadan bekliyoruz — `startJiraPoller` ilk turu kendisi
  // başlatıyor, sonraki turlar zamanlayıcıdan gelir. Yinelenen uyandırma
  // testinde döngü yeniden başlatılmaz; `wokeUp` bellek süreç-yereldir ve
  // aynı `loop` içinde yaşar.
  loop.stop();
  return { signals, audits, lines, getTicketCalls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const summaryOf = (lines: string[]): string =>
  lines.find((line) => line.startsWith("[yoklama] tur bitti")) ?? "";

describe("canReadTickets", () => {
  it("accepts a driver that really offers the reader", () => {
    expect(canReadTickets({ getTicket: () => Promise.resolve({ assignee: null }) })).toBe(true);
  });

  // Eski kastın varsaydığı şey tam olarak buydu: alanın VAR OLMASI. Çağrılabilir
  // olmayan bir şeyi çağırmak, kontrolün önlemek için var olduğu hatayı üretir.
  it("rejects a driver whose getTicket is not callable", () => {
    expect(canReadTickets({ getTicket: true })).toBe(false);
  });

  it("rejects nothing at all rather than throwing on it", () => {
    expect(canReadTickets(null)).toBe(false);
    expect(canReadTickets(undefined)).toBe(false);
  });
});

describe("poller clarify re-entry (step 2b)", () => {
  it("wakes a 2b run once the ticket is assigned back to the bot", async () => {
    const result = await round({ assignee: BOT });

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      workflowId: `maestro-${TICKET}`,
      name: "clarificationAnswered",
      arg: { ticketKey: TICKET },
    });
    // Operatörün aradığı tek olay kendi satırını alıyor, ve tur özeti sayıyor.
    expect(result.lines.some((l) => l.includes("netleştirme cevaplandı"))).toBe(true);
    expect(summaryOf(result.lines)).toContain("1 netleştirme cevaplandı");
  });

  it("records the wake in the audit chain, naming the channel rather than a person", async () => {
    const result = await round({ assignee: BOT });

    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]).toMatchObject({
      action: "CLARIFICATION_ANSWERED",
      subject: TICKET,
      meta: { source: "jira_poller", assignee: BOT },
    });
    // Kim cevapladığını bu kanal BİLMİYOR; uydurulmuş bir isim yerine kanalın
    // adı yazılıyor.
    expect((result.signals[0]?.arg as { answeredBy: string }).answeredBy).toBe("jira-poller");
  });

  // ── yön katmanı ────────────────────────────────────────────────────────────

  it("leaves the run waiting while the ticket still sits with the reporter", async () => {
    // `reassignOnNeedInfo` ticket'ı reporter'a attı ve o henüz geri vermedi.
    const result = await round({ assignee: "mert.demir" });
    expect(result.signals).toHaveLength(0);
  });

  it("leaves the run waiting when the ticket is unassigned", async () => {
    const result = await round({ assignee: null });
    expect(result.signals).toHaveLength(0);
  });

  // ── zaman katmanı ──────────────────────────────────────────────────────────

  it("does not answer its own question before the question was asked", async () => {
    // `reassignOnNeedInfo` KAPALI olan kurulum: ticket soru sorulurken de
    // bot'ta kalır. Zaman eşiği olmasa döngü ilk turunda kendi sorusunu
    // cevaplardı — bu kanaldaki tek koruma budur.
    const result = await round({
      assignee: BOT,
      state: { awaitingClarificationSince: "2026-08-09T09:30:00.000Z" },
    });
    expect(result.signals).toHaveLength(0);
  });

  it("does nothing for a 2b run that carries no question timestamp", async () => {
    const result = await round({ assignee: BOT, state: { awaitingClarificationSince: undefined } });
    expect(result.signals).toHaveLength(0);
    // Eşik yoksa ticket bile okunmuyor: ölçemeyeceğimiz bir koruma için
    // Jira'ya tur başına bir istek daha atmanın anlamı yok.
    expect(result.getTicketCalls).toBe(0);
  });

  // ── kapsam dışı ────────────────────────────────────────────────────────────

  it("ignores a run that is waiting at some other gate", async () => {
    const result = await round({ assignee: BOT, state: { step: "4" } });
    expect(result.signals).toHaveLength(0);
    expect(result.getTicketCalls).toBe(0);
  });

  it("ignores a ticket with no run at all", async () => {
    const result = await round({ assignee: BOT, state: null });
    expect(result.signals).toHaveLength(0);
  });

  it("is off entirely when the driver cannot read a ticket", async () => {
    const result = await round({ assignee: BOT, noTicketReader: true });
    expect(result.signals).toHaveLength(0);
  });

  it("is off entirely when the deployment configured no bot account", async () => {
    // Karşılaştırılacak kimlik yoksa "bot'a atandı" ölçülemez, ve ölçülemeyen
    // bir korumayla ilerlemek korumasız ilerlemektir.
    const result = await round({ assignee: BOT, noBotAccount: true });
    expect(result.signals).toHaveLength(0);
    expect(result.getTicketCalls).toBe(0);
  });

  it("names a ticket read that failed rather than dying silently", async () => {
    const result = await round({ assignee: BOT, getThrows: new Error("401 Unauthorized") });

    expect(result.signals).toHaveLength(0);
    const named = result.lines.find((l) => l.includes("netleştirme için ticket okunamadı"));
    expect(named).toBeDefined();
    expect(named).toContain("401 Unauthorized");
    // Tur, bu ticket'ın okunamaması yüzünden yarıda kalmıyor.
    expect(summaryOf(result.lines)).not.toBe("");
  });

  it("does not name a PAT or a secret in the failure line", async () => {
    const result = await round({
      assignee: BOT,
      getThrows: new Error("401 Unauthorized"),
    });
    for (const line of result.lines) {
      expect(line).not.toContain("pat-");
      expect(line).not.toContain("Bearer");
    }
  });
});
