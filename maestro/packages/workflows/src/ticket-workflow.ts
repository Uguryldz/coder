import {
  CancelledFailure,
  condition,
  continueAsNew,
  ContinueAsNew,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  DataClass,
  FlowType,
  RiskTier,
  StepId,
  TicketKey,
  WorkMode,
  WorkflowRunState,
  WorkflowRunStatus,
} from "@maestro/contracts";
import type {
  AnalysisRewriteContext,
  EngineeringResult,
  MaestroActivities,
  PrRef,
  StatusMovePoint,
} from "./activities.js";
import { awaitGreenBuild, runEngineeringLoop } from "./engineering-loop.js";
import { answerModeRequests, assertNotKilled, awaitGate } from "./gate-loop.js";
import { handoverReasonOf } from "./failure-types.js";
import { gatesFor, planFor } from "./gates.js";
import {
  countRejection,
  emptyInbox,
  initialRunState,
  rejectionCounts,
  workflowNow,
} from "./run-state.js";
import {
  ciResultSignal,
  clarificationAnsweredSignal,
  gateDecisionSignal,
  killSwitchSignal,
  modeChangeSignal,
  prChangesRequestedSignal,
  runStateQuery,
} from "./signals.js";

/**
 * The delivery workflow: one Temporal execution per ticket, from the webhook
 * that created it to the merge that closes it.
 *
 * Three properties this file exists to guarantee, and which every change here
 * must preserve:
 *
 *  1. **It waits without cost.** A gate open for sixteen days is a `condition`,
 *     not a poll. Nothing is auto-approved, ever, and nothing times out into a
 *     decision — only reminders escalate (M88).
 *  2. **Context survives.** Engineering resumes the SAME agent session after a
 *     rejection, a CI failure or a PR thread (M30), and the resume token is
 *     carried across `continueAsNew` in the input — a rejection loop is a
 *     continuation, not a restart (M29).
 *  3. **It fails closed.** Scans, CI origin, gate authority and the kill switch
 *     all stop the flow rather than let it through. The only way forward is a
 *     positive result.
 *
 * Determinism: no `Math.random()`, no `process.env`, no I/O, and the only clock
 * reading is `workflowNow()` below. Everything real is an activity; every
 * decision is a pure function in `gates.ts`.
 */

const acts = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * Thinking roles get a patient proxy. `queued` (M55: the subscription pool is
 * full) comes back as a retryable failure, and waiting for a quota window is a
 * legitimate hours-long wait — a three-attempt budget would drop the run.
 *
 * The budget is UNLIMITED rather than fifty, because fifty attempts on the
 * ladder below tops out around fifty hours, and a WEEKLY subscription quota can
 * legitimately be spent for longer than that: a run told "come back on Monday"
 * must not be dropped on Saturday. This is not an infinite-retry hazard — a
 * quota failure carries `nextRetryDelay` naming the moment the window reopens,
 * so the run sleeps until then and costs nothing.
 *
 * What this policy CANNOT promise is that every non-quota fault stops early:
 * to Temporal a plain thrown error is retryable, so a driver exception would
 * ride this same unlimited ladder. The classification therefore lives in the
 * ACTIVITIES, where it is replay-safe to change: `resolveOutcome` throws
 * `blocked` non-retryably, and `guardModelCall` (impl/outcome.ts) bounds a
 * rejected model key at `AUTH_RETRY_MAX_ATTEMPTS` with a journal line per
 * attempt — the install rehearsal found a 403'd key retrying here for days
 * with the run silently `running`. The retry OPTIONS below are deliberately
 * untouched by that fix: they are recorded into workflow history when an
 * activity is scheduled, so editing them would change the commands a replay
 * regenerates, while activity-side classification changes nothing Temporal
 * compares.
 *
 * `POSITIVE_INFINITY` is the SDK's spelling of "no limit": it drops the field,
 * which is the protocol's default. A literal `0` does NOT mean unlimited here —
 * `compileRetryPolicy` rejects it, and the run fails on its first thinking call.
 */
const thinkActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: Number.POSITIVE_INFINITY,
    initialInterval: "1 minute",
    maximumInterval: "1 hour",
    backoffCoefficient: 2,
  },
});

/** Long jobs get their own budget; the engineer may legitimately run for hours. */
const longActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "4 hours",
  retry: { maximumAttempts: 1 },
});

export interface TicketWorkflowInput {
  ticket: TicketKey;
  /**
   * The PRIMARY application this ticket runs against — OPTIONAL, because an
   * analysis-only binding legitimately has none: the analysis document is
   * written from the ticket text, and the repository only ever ENRICHED it
   * (step 3ö's read-only discovery). Intake refuses to start a code-writing
   * flow without one (`no_application`, M99 tier ③), so absence here means
   * "an `analiz` run in ticket-text mode" and nothing else.
   *
   * REPLAY SAFETY: every run started before this field widened carries an
   * appId, and the appId-present path below is command-for-command what it was
   * — the only new branch (skip discovery, journal why) is reachable only when
   * the field is absent, which no recorded history has.
   */
  appId?: string;
  mode: WorkMode;
  dataClass: DataClass;
  /**
   * State that must OUTLIVE a `continueAsNew` (M29). A rejection loop starts a
   * new execution with a fresh history, so anything held in a local is gone:
   * the strike counter would reset (M54 never fires) and the agent session
   * would be lost on the second rejection (M30). Carrying it in the input is
   * what makes the continuation a continuation rather than a restart.
   */
  rejectionCounts?: Record<string, number>;
  /** The agent session to resume; `null`/absent starts a fresh one. */
  resumeToken?: string | null;
  /** The tier the analysis established, so a continuation reuses its gate set. */
  risk?: RiskTier;
  /**
   * ANALİZİN NEDEN YENİDEN YAZILDIĞI — `rejectionCounts` ve `resumeToken` ile
   * TAM AYNI sebeple burada: `continueAsNew`'i AŞMASI gereken durum.
   *
   * ── Bu alan olmasaydı ne olurdu (ölçüldü) ─────────────────────────────────
   * Geri gönderme dalı analizi bağlamla yeniden yazdırıyor, sonra `continueRun`
   * çağırıyor. Devam eden koşu adım 3'ü KOŞULSUZ yeniden çalıştırıyor
   * (aşağıda), yani bağlamlı belge saniyeler içinde BAĞLAMSIZ bir belgeyle
   * eziliyordu — ve kapının yeniden yargıladığı belge o sonuncusu. Dal içinde
   * bağlam vermek tek başına hiçbir şeyi düzeltmiyordu; testin yakaladığı şey
   * bu (`workflow-analysis-rewrite.test.ts`).
   *
   * Bu yüzden geri gönderme dalı artık analizi KENDİSİ yazdırmıyor: bağlamı
   * girdiye koyup devam ediyor, adım 3 bir kez ve doğru bağlamla çalışıyor.
   * Aktivite sayısı da AZALIYOR — aynı belge iki kez üretilmiyordu artık.
   *
   * `previous` belgenin TAMAMI: `continueAsNew` girdisi zaten `statusMap` ve
   * `rejectionCounts` taşıyor, bir `AnalysisDoc` de aynı boyut mertebesinde ve
   * neyin kısaltılacağına aktivite karar veriyor (`rewriteNote`), workflow
   * değil — kısaltma bir prompt kararı, replay edilen bir girdi değil.
   */
  rewrite?: AnalysisRewriteContext | null;
  /**
   * What the listening rule asked for (`planFor`). Absent means the full
   * pipeline — a ticket is never silently under-processed because no rule
   * matched.
   */
  flow?: FlowType | null;
  /**
   * Where the listening rule wants the ticket to SIT on the board at each point
   * of the flow ("durum eşlemesi"). Absent, null or empty is comment-only mode
   * — what every run did before this existed, and still the default.
   *
   * It travels in the input for the same three reasons `flow` does, and one
   * more:
   *
   *  - `packages/workflows` may not read a database (M44), so the rules cannot
   *    be looked up from in here.
   *  - Re-reading them from an ACTIVITY would work, but it would mean a run
   *    could close under a different rule than the one that started it: an
   *    admin editing a rule at lunchtime would change where a morning's tickets
   *    land, and the run's own history would not say why.
   *  - Pinning the map at start makes the whole thing REPLAYABLE. The workflow
   *    decides whether to move at all, and a decision derived from an argument
   *    replays identically forever.
   *
   * The shape is declared here rather than imported from `apps/bff` (which owns
   * `StatusMap`, and depends on this package, not the other way round). It is
   * deliberately a plain optional-string record: this side never validates the
   * names — the BFF's Zod schema did that on the way in — it only decides which
   * of them to hand to the activity.
   */
  statusMap?: TicketStatusMap | null;
  /**
   * HANGİ ONAY KAPILARI AÇILACAK — dinleme kuralının seçtiği dizi, koşuya
   * ÇİVİLENMİŞ hâlde.
   *
   * ── Neden girdide, `statusMap` ile aynı üç sebep ──────────────────────────
   *  · `packages/workflows` veritabanı okuyamaz (M44), kural buradan
   *    sorulamaz.
   *  · Bir AKTİVİTEDEN sorulabilirdi, ama o zaman koşu BAŞLADIĞINDAN BAŞKA bir
   *    kuralla bitebilirdi: öğle arasında kuralı düzenleyen bir admin, sabah
   *    kapıda bekleyen koşunun kaç kapı daha göreceğini değiştirmiş olurdu ve
   *    koşunun kendi geçmişi bunu açıklayamazdı.
   *  · Girdiden türeyen bir karar SONSUZA DEK aynı replay'i verir. Determinizm
   *    burada çivileniyor, ve ölçümü `workflow-gate-steps.test.ts`te.
   *
   * ── ÜÇ DEĞER, ÜÇ ANLAM ────────────────────────────────────────────────────
   *  · YOK/`undefined`  — kural bir dizi seçmedi. `GATES_BY_RISK[risk]`, yani
   *    bugüne kadarki davranış. KAYITLI HER GEÇMİŞ BU DALDA: alan yoktu,
   *    dolayısıyla `undefined` gelir ve eski koşu eski cevabı alır.
   *  · `[]`             — kural "onay kapısı istemiyorum" dedi. Meşru bir
   *    cevap: onay Jira statüsüyle veriliyor.
   *  · dolu dizi        — tam olarak o kapılar, akış sırasında.
   */
  gateSteps?: readonly StepId[] | null;
  /**
   * Kapılar SAHİPSİZ mi açılsın — kural bir onay grubu istemediyse `true`.
   *
   * `gateSteps` "hangi kapılar", bu "kimin adına". İkisi ayrı, çünkü ayrı
   * sorular: kapı dizisini daraltmak isteyip grup kontrolünü isteyen bir
   * kurulum da, tam diziyi isteyip grubu olmayan bir kurulum da meşru.
   *
   * Absent/`false` = bugünkü davranış (kapı `GATE_OWNER` rolü adına açılır).
   * Kayıtlı her geçmiş bu daldadır.
   */
  gateOwnerless?: boolean;
}

/**
 * The five points a rule may map, as the workflow reads them. Mirrors
 * `StatusMapSchema` in `apps/bff/src/listening-store.ts`; that file is the
 * validator and this is the consumer, so a field added there and not here is
 * simply a point this workflow does not act on yet.
 */
export interface TicketStatusMap {
  onStart?: string;
  onNeedInfo?: string;
  onReview?: string;
  onRejected?: string;
  onDone?: string;
  /**
   * Kapı kararının statüyle verilmesi — OKUMA tarafı. Bu iki alanı workflow
   * OKUMAZ ve okumaması da tasarım: statüyü Jira'da GÖREN taraf BFF/yoklama,
   * ve karar buradan değil oradan bir `gateDecision` sinyali olarak gelir.
   * Burada durmalarının tek sebebi, eşlemenin TEK bir belge olması ve
   * workflow'un onu değiştirmeden taşıması.
   */
  gateApproveStatus?: string;
  gateReturnStatus?: string;
  reassignOnNeedInfo?: boolean;
}

export async function ticketWorkflow(input: TicketWorkflowInput): Promise<WorkflowRunStatus> {
  const ticket = input.ticket;
  const state = initialRunState({
    startedAt: new Date(workflowInfo().startTime).toISOString(),
    mode: input.mode,
    risk: input.risk ?? "orta",
    resumeToken: input.resumeToken ?? null,
    rejectionCounts: input.rejectionCounts,
  });
  const inbox = emptyInbox();

  setHandler(runStateQuery, (): WorkflowRunState => ({
    runId: workflowInfo().runId,
    ticketKey: ticket,
    step: state.step,
    status: state.status,
    risk: state.risk,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    // Yalnız 2b'de beklerken dolu. BFF'in yankı ayıklaması buna dayanıyor:
    // bu damgadan ÖNCEKİ bir Jira olayı sorunun kendi yankısıdır, sonraki
    // olay kullanıcının cevabı olabilir.
    ...(state.awaitingClarificationSince === null
      ? {}
      : { awaitingClarificationSince: state.awaitingClarificationSince }),
    // Yalnız bir onay kapısında beklerken dolu. Statüyle verilen kapı kararının
    // yankı ayıklaması buna dayanıyor — bu damgadan ÖNCEKİ bir statü değişimi
    // kapının kendi açılışının (`onReview` taşıması) yankısıdır.
    ...(state.gateOpenedSince === null ? {} : { gateOpenedSince: state.gateOpenedSince }),
  }));

  // Handlers only ever PUSH. Nothing here consumes, decides or clears — the
  // loops below do that, which is what stops a signal from being overwritten
  // between arriving and being read.
  setHandler(gateDecisionSignal, (d) => void inbox.decisions.push(d));
  setHandler(clarificationAnsweredSignal, () => void (inbox.clarified = true));
  setHandler(ciResultSignal, (s) => void inbox.ciResults.push(s));
  setHandler(prChangesRequestedSignal, (t) => void (inbox.changesRequested = t.text));
  setHandler(modeChangeSignal, (m) => void inbox.modeRequests.push(m));
  setHandler(killSwitchSignal, (k) => void (state.killed = k.level));

  /**
   * Kapı statüleri, kapı yorumuna yazılmak üzere — koşuya ÇİVİLENMİŞ eşlemeden.
   *
   * Bu, okuma tarafının kullandığı değer DEĞİL: karar anında BFF kuralları
   * yeniden okur ve o an ne yazıyorsa o geçerlidir. Buradaki değer yalnızca
   * yorumun metni için, ve çivilenmiş olması yeterli — yorum kapı açılırken
   * bir kez yazılıyor, dolayısıyla o andaki eşleme zaten doğru cevap.
   *
   * `undefined` iki farklı sebeple olabilir ve ikisi de aynı yorumu üretir:
   * yorum-yalnız kip, ya da statü kanalını yapılandırmamış bir eşleme.
   */
  const gateStatuses =
    input.statusMap?.gateApproveStatus === undefined &&
    input.statusMap?.gateReturnStatus === undefined
      ? undefined
      : {
          ...(input.statusMap?.gateApproveStatus === undefined
            ? {}
            : { approve: input.statusMap.gateApproveStatus }),
          ...(input.statusMap?.gateReturnStatus === undefined
            ? {}
            : { return: input.statusMap.gateReturnStatus }),
        };

  /**
   * Kapının sahipsiz açılıp açılmayacağı — girdiden, tam olarak `gateStatuses`
   * gibi: koşu başlarken çivilenir ve replay'de aynı cevabı verir. Absent =
   * `false`, yani kayıtlı her geçmiş ve bugüne kadarki her koşu eski dalda.
   */
  const gateOwnerless = input.gateOwnerless === true;
  const gate = (at: StepId) =>
    awaitGate(acts, state, inbox, ticket, at, gateStatuses, gateOwnerless);
  const stopIfKilled = () => assertNotKilled(acts, state, ticket);

  /**
   * Move the ticket on the operator's board, if their rule asked for it.
   *
   * Two things are load-bearing about this being a local function rather than
   * an unconditional activity call at each point.
   *
   * First, an unmapped point schedules NOTHING. A run in comment-only mode
   * (every rule written before the status map existed, and every rule that
   * deliberately stays that way) produces exactly the history it produced
   * before — no activity, no journal line, no retry budget spent on a decision
   * that was already "do not move". "Absent means do not move at that point" is
   * the map's central promise, and it is kept HERE, in the deterministic half,
   * rather than by an activity that would have to be scheduled to say no.
   *
   * Second, the result is DISCARDED on purpose, and nothing branches on it. The
   * policy the user chose is warn-but-continue: a ticket that could not be
   * moved is a board that is out of date, while a run that stopped over it is
   * work that did not get done. The activity never rejects (see
   * `impl/status-move.ts`) and writes its own journal line with the reason, so
   * the operator learns why without the flow ever learning it happened.
   */
  const moveStatus = async (at: StatusMovePoint, to: string | undefined): Promise<void> => {
    const alsoReporter = at === "need_info" && input.statusMap?.reassignOnNeedInfo === true;
    if (to === undefined && !alsoReporter) return;
    await acts.moveTicketStatus(ticket, {
      at,
      ...(to === undefined ? {} : { status: to }),
      ...(alsoReporter ? { toReporter: true } : {}),
    });
  };

  /**
   * Every step transition goes through here, which is what makes this the one
   * place the kill switch has to be checked. Guarding individual loops instead
   * left whole chains of steps running after the stop — scans, reviews and test
   * runs are all new sandbox work — because each loop only looked once, at its
   * own top.
   */
  const goto = async (next: StepId, note: string): Promise<void> => {
    await stopIfKilled();
    await answerModeRequests(acts, state, inbox, ticket);
    state.step = next;
    // D1: this used to report `startedAt` forever, so a run that had been
    // working for six hours looked untouched in Studio.
    state.updatedAt = workflowNow();
    await acts.journal(ticket, "other", `adım ${next}`, note);
  };

  const handOver = async (reason: string): Promise<WorkflowRunStatus> => {
    state.status = "handover";
    await acts.handOverToHuman(ticket, reason);
    return state.status;
  };

  /**
   * `rewrite` verilirse devam eden koşu analizi YENİDEN yazar ve nedenini
   * bilir; verilmezse girdideki değer TEMİZLENİR (`null`). Temizlik şart:
   * bir kez geri gönderilmiş koşu, sonraki her turunda "hâlâ geri gönderildi"
   * bağlamıyla yazmaya devam ederdi — ve o bağlam artık yanlış.
   */
  const continueRun = (rewrite?: AnalysisRewriteContext): Promise<never> =>
    continueAsNew<typeof ticketWorkflow>({
      ...input,
      risk: state.risk,
      resumeToken: state.resumeToken,
      rejectionCounts: rejectionCounts(state),
      rewrite: rewrite ?? null,
    });

  /**
   * HİÇBİR HATA KOŞUYU SESSİZCE ÖLDÜRMEZ. Operatörün kuralı: "hangi adımda
   * hata aldıysa ona göre aksiyon alsın, takılması imkânsız, Jira'ya
   * bildirsin." Yakalanmamış bir hata yürütmeyi FAIL ediyordu: panelde
   * "hatalı", defterde satır yok, Jira'da ses yok, ticket havuzda. Burada
   * her beklenmeyen hata, düştüğü ADIM ve sebebiyle insana devredilir —
   * `handOverToHuman` defteri, denetimi, bildirimi ve Jira yorumunu yazar —
   * ve tarama pencereli freniyle koşuyu yeniden alır. Yayılması GEREKENLER
   * yayılır: continue-as-new (bir hata değil), iptal, kill-switch.
   */
  try {
    return await runSteps();
  } catch (error) {
    if (shouldPropagate(error)) throw error;
    const reason = `beklenmeyen hata (adım ${state.step}): ${failureText(error)}`;
    try {
      return await handOver(reason);
    } catch {
      // Devir bile yazılamıyorsa (defter/DB yok) geriye yalnız yürütmenin
      // kendi kaydı kalır; o zaman asıl hata Temporal'da adıyla dursun.
      throw error;
    }
  }

  async function runSteps(): Promise<WorkflowRunStatus> {
  // ── 0 · work mode ────────────────────────────────────────────────────────
  await goto("0", `work mode: ${state.mode} · veri sınıfı: ${input.dataClass}`);
  if (state.mode === "human_only") {
    // M73: the humans do the work; Maestro only keeps the record.
    await acts.journal(ticket, "other", "human-only", "Maestro yalnız kanıt topluyor");
    return handOver("human_only");
  }

  // ── 2 · intake, 2b · clarification ───────────────────────────────────────
  await goto("2", "ticket tamlık kontrolü");
  const intake = await thinkActs.runIntake(ticket);
  if (!intake.complete) {
    /**
     * DEFTERE SORUNUN KENDİSİ YAZILIYOR, "soru soruldu" değil.
     *
     * Eski satır `"reporter'a soru soruldu"` idi ve operatörün defterden
     * öğrenebildiği tek şey buydu: hangi soru sorulmuş, ne bekleniyor, cevap
     * gelmiş mi — hiçbiri yoktu. Ticket'a düşen yorumu açıp okumak gerekiyordu,
     * yani defter "şu an ne oluyor" sorusunun cevabı OLAMIYORDU.
     *
     * Soru kırpılıyor: defter satırı bir özet, belgenin kendisi değil; tam
     * metin zaten ticket yorumunda duruyor.
     */
    const question = (intake.question ?? "").trim();
    await goto(
      "2b",
      [
        "reporter'a soru soruldu — cevap bekleniyor",
        `soru: ${question === "" ? "(intake soru üretmedi)" : question.length > 300 ? `${question.slice(0, 300)}…` : question}`,
        "koşu, cevap ticket'a yorum olarak yazılana kadar burada bekler (zaman aşımı yok)",
      ].join(" · "),
    );
    state.status = "gate";
    // Before the question, not after: the board should say "waiting on the
    // reporter" by the time the reporter is looking at the comment that asks
    // them for something. `reassignOnNeedInfo` rides along here too, so the
    // ticket lands in their queue as well as in their column.
    await moveStatus("need_info", input.statusMap?.onNeedInfo);
    await acts.askClarification(ticket, intake.question ?? "");
    /**
     * Beklemenin başladığı an — soru SORULDUKTAN sonra damgalanır.
     *
     * Sıra kritik: `moveStatus("need_info")` ve `askClarification` Jira'da
     * webhook üretir (durum değişti, ticket reporter'a atandı, yorum geldi).
     * Damga bunlardan sonra atıldığı için o yankılar eşiğin GERİSİNDE kalır ve
     * yeniden giriş yolu (`apps/bff/src/routes/webhooks.ts`) onları cevap
     * saymaz. Damgayı `condition`'dan önce koymak da şart: sinyal ilk poll'dan
     * evvel gelirse bile query dolu bir eşik göstermelidir.
     *
     * `workflowNow()` deterministik (Temporal'in kendi saati), replay güvenli.
     */
    state.awaitingClarificationSince = workflowNow();
    // Unbounded on purpose (M61): no auto-reject, no timeout into a decision.
    await condition(() => inbox.clarified);
    // Bekleme bitti: eşik kalkar, böylece 2b'den sonraki bir Jira olayı artık
    // "netleştirme cevabı" olarak okunamaz.
    state.awaitingClarificationSince = null;
    state.status = "running";
    // Cevabın GELDİĞİ de deftere yazılıyor. Eskiden bekleme başlangıcı
    // yazılıyordu ama bitişi yazılmıyordu: defterden bakan biri koşunun hâlâ
    // cevap beklediğini sanabilirdi, oysa çoktan devam etmişti.
    await acts.journal(
      ticket,
      "other",
      "netleştirme cevabı alındı",
      "reporter cevapladı — koşu kaldığı yerden devam ediyor",
    );
  }

  // ── 3ö · discovery, 3 · analysis ─────────────────────────────────────────
  await goto("3o", "salt-okunur repo keşfi");
  // The ticket is being WORKED now — intake either passed or was answered — so
  // this is the first honest moment to claim the card. Moving it at step 0
  // instead would put a ticket in "Devam Ediyor" that is still only being read,
  // and a ticket that then goes back to the reporter would have visited the
  // in-progress column for nothing.
  await moveStatus("start", input.statusMap?.onStart);
  if (input.appId === undefined) {
    // Analysis-only binding: there is no repository to discover, and that is a
    // configuration the operator chose, not a degradation to hide. The journal
    // line is the run's own record of WHY step 3ö did nothing — without it an
    // operator comparing two analiz runs would see one discover twelve files
    // and the other nothing, with no sentence anywhere explaining the gap.
    await acts.journal(
      ticket,
      "discovery",
      "keşif atlandı",
      "kod deposu bağlı değil — keşif atlandı, analiz ticket metninden üretilecek",
    );
  } else {
    await acts.discoverRepo(ticket, input.appId);
  }

  // Yeniden yazım mı, ilk yazım mı — ve bunu SÖYLEYEN tek yer girdi.
  // `null`/absent ilk yazım demek ve bugünkü davranış aynen korunur.
  const rewrite = input.rewrite ?? undefined;
  // Kaç kez geri gönderildi — defterin "kaçıncı tur" cümlesi için, ve
  // `continueAsNew` sınırını aşması gerektiği için girdiden okunuyor.
  const returnTurn = rewrite?.turn ?? 0;
  await goto("3", rewrite === undefined ? "analiz üretiliyor" : "analiz yeniden yazılıyor");
  // A NAMED refusal (ai-assist required, policy block, key rejected, schema
  // unmet five times) is the activity saying "a human must take this". Left
  // uncaught it FAILED the execution: Studio showed "hatalı" at step 3 with
  // no sentence under it, the ticket sat in the pool for days. Caught, it is
  // a hand-over — status, journal line and Jira note all say why.
  let written: Awaited<ReturnType<typeof thinkActs.writeAnalysis>>;
  try {
    written = await thinkActs.writeAnalysis(ticket, input.appId, rewrite);
  } catch (error) {
    const reason = handoverReasonOf(error);
    if (reason === null) throw error;
    return handOver(`analiz üretilemedi: ${reason}`);
  }
  state.analysis = written.analysis;
  state.risk = written.risk;
  await acts.publishAnalysis(ticket, state.analysis);
  const children = await acts.fanOutChildren(ticket, state.analysis);
  if (children.length > 0) {
    await acts.journal(ticket, "analysis", "fan-out", `${children.length} alt ticket açıldı`);
  }

  // ── 4-5 · analysis gates, with the rejection loop ────────────────────────
  // Kuralın seçtiği dizi varsa o, yoksa risk katmanı — karar `gatesFor`ta ve
  // yalnız GİRDİDEN türüyor, yani replay'de aynı cevabı verir.
  const required = gatesFor(state.risk, input.gateSteps);
  const plan = planFor(input.flow);
  const analysisGates = plan.analysisGate ? required.filter((g) => g === "4" || g === "5") : [];
  // Once, on the way INTO the gate set, not once per gate: `onReview` says
  // "a human is now looking at this", and a `yuksek` ticket that opens 4 and
  // then 5 has not stopped being reviewed in between. A per-gate call would
  // also be a second transition to the column the ticket is already in, which
  // the driver answers `already` — a journal line saying nothing happened,
  // written every time something did.
  if (analysisGates.length > 0) await moveStatus("review", input.statusMap?.onReview);
  for (const at of analysisGates) {
    await goto(at, "insan onayı bekleniyor");
    const verdict = await gate(at);
    /**
     * ── "eksik var, bir daha bak" ────────────────────────────────────────────
     *
     * Operatörün akışının üçüncü kenarı: `analysisapproval → analiz`. Aşağıdaki
     * `reject` dalıyla İŞ olarak aynı şeyi yapar — analizi yeniden yazdırır ve
     * aynı koşu olarak devam eder — ve tam olarak üç şeyi YAPMAZ:
     *
     *  1. `countRejection` ÇAĞIRMAZ. M54'ün üç-ret kuralı burada bir ceza
     *     olurdu: geri gönderme rutin bir tur, ve üçüncüsünde koşunun insana
     *     devredilmesi normal çalışmayı üç turda bir durdururdu.
     *  2. Devretmez. Bu yolda `handOver` yok; koşu her zaman devam eder.
     *  3. `onRejected` statüsüne TAŞIMAZ. Ticket'ı incelemeden çıkaran hareketi
     *     zaten operatörün kendisi yaptı — statü kanalıyla geldiyse ticket
     *     `gateReturnStatus`'ta, yorum kanalıyla geldiyse operatör nereye
     *     istediyse orada. Maestro'nun üstüne bir "reddedildi" statüsü yazması,
     *     operatörün açıkça istemediği şey.
     *
     * `goto("3", …)` ile analize dönüş ve `continueRun()` ORTAK: bağlam
     * (kural, akış, ajan varyantları, statü eşlemesi, resume token, ret
     * sayaçları) `continueAsNew` girdisinde taşınır, yani "bağlam kaybı yok".
     */
    if (verdict.decision === "return_analysis") {
      /**
       * ── DEFTER: OPERATÖRÜN "ŞU AN NE OLUYOR" SORUSUNUN CEVABI ────────────
       *
       * Eski satır `"<kullanıcı> · <sebep>"` idi ve sebep yoksa yalnız
       * kullanıcı adıydı. Operatörün şikâyeti tam buydu: "devam eden işlerin
       * geri gönderilen detayları yazmıyor". Bir denetçi ya da ertesi gün
       * ticket'a bakan biri o satırdan kaçıncı tur olduğunu, kararın hangi
       * kanaldan geldiğini, sebebin YAZILMADIĞINI mı yoksa okunmadığını mı,
       * ve şimdi ne olacağını çıkaramıyordu.
       *
       * Yeni satır beşini de söylüyor, ve "sebep belirtilmedi" AÇIKÇA yazılıyor
       * — boş bırakmak, operatörün bir şey yazıp yazmadığını belirsiz bırakır.
       */
      const turn = returnTurn + 1;
      await acts.journal(
        ticket,
        "gate",
        `analize geri gönderildi (${turn}. kez)`,
        [
          `kapı ${at}`,
          `karar veren: ${verdict.actorUserId}`,
          // Karar hangi kanaldan geldi — operatörün "yorum mu yazsam, statü mü
          // taşısam" sorusunun cevabı defterde durmalı.
          `kanal: ${verdict.source === "jira" ? "Jira yorumu/statüsü" : verdict.source}`,
          `sebep: ${verdict.reason === undefined || verdict.reason.trim() === "" ? "belirtilmedi" : verdict.reason}`,
          "şimdi: analiz yeniden yazılıyor (önceki analiz, gerekçe ve ticket yorumları bağlam olarak veriliyor)",
          "not: bu bir RET DEĞİL — ret sayacı artmadı, iş insana devredilmedi",
        ].join(" · "),
      );
      /**
       * ── "BAĞLAM KAYBI YOK" ARTIK MODELE DE GEÇİYOR ──────────────────────
       *
       * Buraya kadarki `continueAsNew` KOŞUNUN bağlamını taşıyordu (kural,
       * akış, varyant, statü eşlemesi, resume token, ret sayaçları). Modelin
       * bağlamı taşınmıyordu: `writeAnalysis` yalnız `summary` + `description`
       * görüyordu, yani ikinci tur BİREBİR AYNI girdiyi alıyordu ve doğal
       * olarak aynı belgeyi üretiyordu. Operatörün "eksik var, bir daha bak"
       * demesinin hiçbir izi yoktu — geri gönderme, sonucu değişmeyen bir tur.
       *
       * ── NEDEN BURADA YAZDIRMIYORUZ, GİRDİYE KOYUYORUZ ────────────────────
       * Bu dal eskiden analizi KENDİSİ yazdırıp öyle devam ediyordu. Devam eden
       * koşu ise adım 3'ü koşulsuz yeniden çalıştırıyor — yani belge iki kez
       * üretiliyordu ve İKİNCİSİ bağlamsızdı. Kapının yeniden yargıladığı belge
       * o bağlamsız olandı: dal içinde bağlam vermek tek başına HİÇBİR ŞEYİ
       * düzeltmiyordu. (Ölçüm: `workflow-analysis-rewrite.test.ts`.)
       *
       * Bağlamı `continueAsNew` girdisine koymak üçünü birden çözüyor: belge
       * bir kez üretiliyor, doğru bağlamla üretiliyor, ve bu dal bir model
       * çağrısı daha az yapıyor.
       *
       * `reason` OPSİYONEL kalıyor ve kalması şart: karar statüyle de
       * verilebiliyor (`gateReturnStatus`) ve o yolda yazılı gerekçe yok.
       * Operatörün kuralı da bunu söylüyor — "ben yorum yazsam da yazmasam da".
       * Gerekçe boşken bağlamı ticket yorumları ve önceki analiz taşır;
       * yorumları aktivite kendisi okur (I/O, bkz. `impl/analysis.ts`).
       *
       * `previous` bellekten geliyor, journal'dan DEĞİL: `state.analysis` az
       * önce onaya çıkan belgenin ta kendisi.
       */
      return continueRun({ reason: verdict.reason, previous: state.analysis, turn });
    }
    // `return_analysis` yukarıda ele alındı, dolayısıyla burada kalan tek
    // "onay değil" ret'tir — ama yine eşitlikle değil, ONAY DEĞİL diye
    // sorulur: 505'teki kardeşiyle aynı gerekçe, dördüncü bir karar sessizce
    // geçip gitmesin.
    if (verdict.decision !== "approve") {
      const strike = countRejection(state, at);
      if (strike.exhausted) return handOver(`${at} kapısında ${strike.count} ret (M54)`);

      // Off the review column before the rewrite starts, so the board stops
      // showing an approver something they have already answered. Ahead of
      // `goto` on purpose: the rewrite is minutes of thinking, and a ticket
      // that sits in "İNCELEMEDE" through all of it invites a second reviewer
      // to pick up work that is already back with the agent.
      await moveStatus("rejected", input.statusMap?.onRejected);
      // Back to analysis with the reason — the agent keeps its context (M30).
      // Geri gönderme dalıyla AYNI şekil ve aynı gerekçe: bağlam devam eden
      // koşunun girdisinde taşınır, analiz orada BİR KEZ ve doğru bağlamla
      // yazılır. Ret'te gerekçe genelde YAZILI (`/reject <sebep>`) ama zorunlu
      // değil — o yüzden burada da yorumlar ile önceki analiz taşınır.
      return continueRun({ reason: verdict.reason, previous: state.analysis });
    }
  }

  /**
   * ── analiz akışı burada BİTER ────────────────────────────────────────────
   *
   * The analysis document is the deliverable, and it has been written,
   * published and approved. Everything below builds software; running it for
   * an `analiz` ticket is not a bigger service, it is the wrong job — and on a
   * deployment configured for analysis only it is also a guaranteed failure
   * (OPS-38 died in `runEngineering` for exactly this reason).
   *
   * Closed as `done`, not handed over: nothing is stuck and nobody is waiting.
   */
  if (!plan.engineering) {
    await goto("13", "analiz teslim edildi");
    await acts.deliverAnalysis(ticket, state.analysis);
    await acts.journal(ticket, "closure", "analiz teslim edildi", "akış: analiz");
    // Before `closeTicket`, so the ticket is already in its final column when
    // the closing comment tells the requester it is finished. Afterwards the
    // reporter would read "tamamlandı" on a card still sitting in review.
    await moveStatus("done", input.statusMap?.onDone);
    await acts.closeTicket(ticket);
    state.status = "done";
    return state.status;
  }

  // ── 6a-10 · engineering loop ─────────────────────────────────────────────
  // Unreachable without an application by construction — intake refuses to
  // start a code-writing flow with no appId (`no_application`), and the
  // `analiz` flow returned above — so this guard is the assertion of that
  // claim, not a path anything is expected to take. It fails CLOSED into a
  // handover rather than letting the engineering loop open a session against
  // a repository that does not exist. Replay-safe: it schedules nothing when
  // `appId` is present, which every in-flight history is.
  if (input.appId === undefined) {
    return handOver("uygulama bağlı değil — mühendislik adımları uygulamasız çalıştırılamaz");
  }
  const built = await runEngineeringLoop({ acts, longActs, goto, gate }, state, inbox, ticket, required);
  if (built.kind === "handover") return handOver(built.reason);
  const attempt = built.attempts;

  // ── 10b · PR and the CI gate ─────────────────────────────────────────────
  await stopIfKilled();
  const pr: PrRef = await acts.openPullRequest(ticket);
  await acts.activatePullRequest(ticket, pr);
  await goto("10b", `PR #${pr.prId} · build validation bekleniyor`);

  const green = await awaitGreenBuild({ acts, longActs }, state, inbox, ticket, attempt);
  if (green.kind === "handover") return handOver(green.reason);

  // ── 11-12 · QA result and PR approval ────────────────────────────────────
  for (const at of required.filter((g) => g === "11" || g === "12")) {
    await goto(at, "insan onayı bekleniyor");
    const verdict = await gate(at);
    /**
     * "Onay DEĞİL" olarak okunuyor, "ret" olarak değil.
     *
     * 11/12'de üçüncü karar (`return_analysis`) hiç gelemez — `canCloseGate`
     * onu yalnız 4/5'te kabul ediyor ve `decideGate` buraya hiç göndermiyor —
     * ama bu satırın "reddedilmeyen her şey onaydır" demesi, gelecekte dördüncü
     * bir kararın sessizce MERGE'e dönüşmesi demek olurdu. Bu kapıların
     * ötesinde geri alınamaz bir birleştirme var; yanlış tarafta hata yapmanın
     * ucuz yönü, işi geri göndermektir.
     */
    if (verdict.decision !== "approve") {
      const strike = countRejection(state, at);
      if (strike.exhausted) return handOver(`${at} kapısında ${strike.count} ret (M54)`);

      inbox.changesRequested = verdict.reason ?? "";
      await goto("12b", "PR yorum döngüsü — aynı oturum devam");
      const fix: EngineeringResult = await longActs.runEngineering(
        ticket,
        state.resumeToken,
        inbox.changesRequested,
        // A round of its own: the 12b fix is neither the last 6a turn nor the
        // last CI fix repeated, and each must leave its own record.
        green.attempts + strike.count,
      );
      state.resumeToken = fix.resumeToken;
      if (!fix.ok && fix.handoverReason !== undefined) return handOver(fix.handoverReason);
      return continueRun();
    }
  }

  // ── 13 · merge, evidence, closure ────────────────────────────────────────
  // The last gate is closed and everything below is irreversible. This check
  // cannot be skipped: an emergency stop that does not stop the MERGE has not
  // stopped the only thing in this system that cannot be undone.
  await stopIfKilled();
  await acts.mergePullRequest(ticket, pr);
  await goto("13", "kanıt paketi");
  const evidence = await acts.buildEvidencePackage(ticket);
  await acts.journal(ticket, "closure", "kanıt paketi", `${evidence.files} dosya`);
  // The engineering flow's `onDone`, for the same reason as the analysis one
  // above: the merge is done and the evidence is packaged, so the card belongs
  // in the finished column before the closing comment says it is.
  await moveStatus("done", input.statusMap?.onDone);
  await acts.closeTicket(ticket);
  state.status = "done";
  return state.status;
  }
}

/**
 * Devre DEĞİL, yayılma: continue-as-new bir hata değildir; iptal ve
 * kill-switch bilerek verilmiş kesme kararlarıdır — kill-switch aktivitenin
 * içinden de gelebilir (`ActivityFailure` → cause `KillSwitch`), o yüzden
 * sebep zinciri yürünür.
 */
function shouldPropagate(error: unknown): boolean {
  if (error instanceof ContinueAsNew || isCancellation(error)) return true;
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (typeof node === "object" && node !== null && !seen.has(node)) {
    seen.add(node);
    const record = node as { type?: unknown; message?: unknown; cause?: unknown };
    if (record.type === "KillSwitch") return true;
    // Bir aktiviteyi kesen abort sebebi (`kill_switch_stop_all`) düz bir
    // Error olarak gelir; adı onu ayırt eder.
    if (typeof record.message === "string" && /kill[_ ]switch/i.test(record.message)) return true;
    if (node instanceof CancelledFailure) return true;
    node = record.cause;
  }
  return false;
}

/** Sebep zinciri, dıştan içe — aktivitenin kendi cümlesi de gelsin. */
function failureText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (typeof node === "object" && node !== null && !seen.has(node) && parts.length < 4) {
    seen.add(node);
    const record = node as { message?: unknown; cause?: unknown };
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (message !== "" && !parts.includes(message)) parts.push(message);
    node = record.cause;
  }
  return (parts.length === 0 ? String(error) : parts.join(" ← ")).slice(0, 400);
}
