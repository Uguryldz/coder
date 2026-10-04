import { type MatchResult, type TicketKey, type TicketSnapshot } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { BFF_MESSAGE_KEYS } from "./messages.js";
import { workflowIdFor } from "./gateway.js";
import { resolveGateSteps } from "./gate-defaults.js";
import { flowDecisionFor, statusGateOf, type FlowDecision } from "./flow-decision.js";
import { decisionLogLine, decisionLogMarkdown, type IntakeDecisionFacts } from "./intake-decision-log.js";
import type { ListeningRuleRecord } from "./listening-store.js";
import { isFixedRepoMap, isSearchRepoMap, resolveRepoMapEntry } from "./listening-store.js";
import { projectKeyOf, splitRepoFullName } from "./identifiers.js";

/**
 * Intake: the decision to put a ticket on the workflow engine, and every
 * reason not to. Nothing here guesses — an unmatched ticket goes to the human
 * assignment queue rather than to a default application (M14/M99).
 */

export interface IntakeRequest {
  ticket: TicketKey;
  labels?: readonly string[];
  /**
   * A person asked for this run by name (`/ai-start`, `/ai-assign`), so the
   * opt-in label rule has already been satisfied by the command itself (M48a).
   */
  explicit?: boolean;
  /** `/ai-assign <app>` — overrides the RoutingRule outcome (M99 tier ③). */
  appId?: string;
  /** Audit actor: the requesting human, or `maestro-worker` for a webhook. */
  actor: string;
  /**
   * The ticket's current status name, when the caller knows it. Together with
   * `issueType` and `assignee` it decides which FLOW this ticket runs
   * (`flow-decision.ts`). Absent means "not known here", which matches no rule
   * and falls back to the deployment default — so a caller that cannot supply
   * these (an operator pressing Start in Studio) behaves exactly as before.
   */
  status?: string;
  /** The ticket's issue-type name, when the caller knows it. */
  issueType?: string;
  /**
   * AYNI İKİ ALAN, Jira'nın kendi kimlikleriyle.
   *
   * Takım yönetimli (`style: "next-gen"`) bir projede JQL adları çözmüyor —
   * `issuetype = "Görev"` sıfır ticket, `issuetype = 10008` on dört döner — ve
   * panel o projede kurala ADI değil İD'yi kaydeder. `flow-decision.ts`
   * `matches()` bu yüzden sayısal bir `matchValue`'yu ticket'ın İD'siyle
   * karşılaştırır; id'yi taşımayan bir çağıranda kural bir tek ticket'ı bile
   * eşleştiremezdi — sorgu bulur, filtre eler, ikisi de sessiz.
   *
   * Opsiyonel: id'yi okumamış bir çağıran için alan `undefined` kalır ve
   * eşleşme ADA düşer, yani bugünkü davranış. Kimse bozulmaz.
   */
  statusId?: string;
  issueTypeId?: string;
  /** The account the ticket is assigned to, when the caller knows it. */
  assignee?: string;
}

/**
 * `no_application` ile `unknown_application` AYRI, ve ayrı olmaları gerekiyor.
 *
 * `no_application`: hiçbir yer bir uygulama SÖYLEMEDİ — ne komut, ne eşleme,
 * ne proje bağlaması. Operatörün yapacağı şey ticket'ı birine atamak.
 *
 * `unknown_application`: bir uygulama söylendi ama `Application` tablosunda
 * KAYITLI DEĞİL. Operatörün yapacağı şey bambaşka: depoyu envantere eklemek ya
 * da kuralın eşlemesini düzeltmek. İkisini tek isme sıkıştırmak, operatöre
 * yanlış işi yaptırırdı — "atama bekliyor" diyen bir yorumun altında, aslında
 * atanmış ama kayıtsız bir depo dururdu.
 */
export type IntakeRefusal =
  | "unbound"
  | "not_opted_in"
  | "kill_switch"
  | "no_application"
  | "unknown_application";

export type IntakeOutcome =
  | { accepted: true; workflowId: string; started: boolean }
  | { accepted: false; reason: IntakeRefusal };

/** Tanımı `identifiers.ts`te; buradan yeniden dışavuruluyor. */
export { projectKeyOf };

/**
 * The fields a listening rule matches on, READ from the ticket, for the callers
 * that were not handed them.
 *
 * The webhook knows `issueType`/`assignee`/`labels` because the delivery
 * carries them. Every other entry point — Studio's Start button, `/ai-start`
 * and `/ai-assign` from a Jira comment, the MCP operate tools — knows only a
 * ticket key, and a caller that omits these matches NO rule: `matches()` in
 * `flow-decision.ts` compares them against `null`, so the ticket falls through
 * to the deployment default and loses both the rule's flow and its status map.
 * Measured on the live board: OPS-57 was hand-started under a project whose OPS
 * rule carries a full map, and the ticket never moved — no transition, no
 * status journal line, and nothing on the run to say why.
 *
 * So the hand paths ASK. One read of the ticket buys them the same rule
 * matching the webhook has always had, and the two entry points stop running
 * the same ticket under two different flows.
 *
 * Best-effort by construction. A Jira that will not answer costs rule matching
 * — which is exactly the behaviour these callers had before this existed — and
 * must not cost the run: refusing a hand start because a snapshot read failed
 * would turn a degraded Jira into an operator who cannot start anything.
 *
 * `onError` is where a caller that HAS a logger writes the reason down; there
 * is no logger on `ResolvedDeps`, so this seam cannot write one itself. It is
 * optional because two of the three callers genuinely have nowhere to put it:
 * a Jira comment command and an MCP tool both run outside a request. That is
 * not a quiet failure in the M14 sense — the fallback is recorded where an
 * operator actually looks for it, in the `RUN_STARTED` audit entry, whose
 * `flowReason` reads `default` instead of `rule`.
 *
 * `status` BİR DÖNEM BİLEREK YOKTU, VE O KARAR BİR YOLU SESSİZCE KIRIYORDU.
 *
 * Gerekçe şuydu: donmuş `TicketSnapshot` (M46/M102) statü taşımaz, uydurmak
 * bilmediğini söylemekten kötüdür. İkinci yarısı hâlâ doğru; birincisi artık
 * değil — anlık görüntü statüyü TAŞIYOR (sözleşmeye eklendi, aynı
 * `issueTypeId` gerekçesiyle).
 *
 * Kırığın zinciri uçtan uca ölçüldü (OPS-123):
 *
 *   yeniden başlatma → statü okunmadı
 *   → `statusGateOf` bilinmeyen statüde KAPANIR (fail-closed)
 *   → hiçbir kural eşleşmedi (`flowReason: "default"`)
 *   → `ruleId` yok → depo eşlemesi HİÇ SORULMADI
 *   → proje bağlamasının varsayılanı
 *
 * Aynı ticket, aynı etiket, aynı kural: webhook yolundan
 * `tecnoi-global/wendoc`, yeniden başlatma yolundan `maestro-pilot`. Tek fark
 * giriş yoluydu. Sahadaki iki ayrı şikayet — "yeniden başlat aynı çıktıyı
 * veriyor" ve "eşleme çalışmıyor" — bu tek kırığın iki yüzüydü.
 *
 * Statü artık okunuyor. Adapter vermezse alan yine yazılmaz ve davranış
 * eskisi gibi kalır: "bilmiyorum" demek hâlâ uydurmaktan iyidir.
 */
export async function classifyingFields(
  deps: ResolvedDeps,
  ticket: TicketKey,
  onError: (error: unknown) => void = () => {},
): Promise<Pick<IntakeRequest, "issueType" | "issueTypeId" | "labels" | "assignee" | "status" | "statusId">> {
  let snapshot: TicketSnapshot;
  try {
    snapshot = await deps.work.getTicket(ticket);
  } catch (error) {
    onError(error);
    return {};
  }
  return {
    issueType: snapshot.issueType,
    /**
     * TİP KİMLİĞİ, adının yanında — takım yönetimli projenin tek çalışan
     * anahtarı. O projede kural `10008` tutar, `"Görev"` değil; yalnız adı
     * göndermek, elle başlatılan bir ticket'ı adıyla eşleşmeyen bir kuralla
     * karşılaştırıp sessizce elemek olurdu.
     *
     * `statusId` burada YOK, `status`'ün olmadığı gerekçenin aynısıyla: donmuş
     * `TicketSnapshot` (M46/M102) bir statü alanı taşımıyor, dolayısıyla
     * kimliği de yok. `matchKind: "status"` kuralı bu yollarda ne adla ne de
     * id ile eşleşir — uydurmak, bilmediğini söylemekten kötü olurdu.
     */
    ...(snapshot.issueTypeId === undefined ? {} : { issueTypeId: snapshot.issueTypeId }),
    // Statü kapısı bilinmeyen statüde kapanır; bu iki alan o kapının AÇILABİLİR
    // olmasını sağlar. Adapter vermezse yazılmaz — bkz. yukarıdaki gerekçe.
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    ...(snapshot.statusId === undefined ? {} : { statusId: snapshot.statusId }),
    labels: snapshot.labels,
    // Omitted rather than sent as null, for the reason `flow` and `statusMap`
    // are omitted below: `assignee` is an OPTIONAL field whose absence already
    // means "not known here", and `IntakeRequest` has no null to give it.
    ...(snapshot.assignee === null ? {} : { assignee: snapshot.assignee }),
  };
}

export async function runIntake(deps: ResolvedDeps, request: IntakeRequest): Promise<IntakeOutcome> {
  const projectKey = projectKeyOf(request.ticket);

  // M102: one global webhook delivers every project's traffic; a project that
  // was never bound, or was paused, is dropped without a trace in Jira — the
  // counter is the trace. Answering an unbound project would leak that Maestro
  // is watching it.
  const binding = await deps.bindings.resolve(projectKey);
  if (binding === null || !binding.active) {
    deps.counters.droppedUnbound += 1;
    return { accepted: false, reason: "unbound" };
  }

  /**
   * PROJE SEVİYESİNDEKİ OPT-IN KAPISI YOK (0023).
   *
   * Burada bir kontrol VARDI: `triggerMode === "opt_in"` olan bir projede
   * `optInLabel` etiketini taşımayan ticket `not_opted_in` ile reddediliyordu.
   * Kaldırılmasının sebebi ölçülmüş bir çelişki: tarama yolu
   * (`jira-discovery.ts`) `explicit: true` geçtiği için bu kapıyı ATLIYOR,
   * webhook yolu atlamıyordu — yani AYNI ticket, tarama ile gelirse alınıyor,
   * webhook ile gelirse etiketi yok diye sessizce düşüyordu. Hangi kapıdan
   * girdiğine bağlı iki farklı cevap.
   *
   * Etiket işlevsiz kalmadı, YERİ DEĞİŞTİ: artık dinleme kuralının dördüncü
   * tetikleme tipi (`matchKind: "label"`, `flow-decision.ts`). Tetikleme tek
   * yerde — kuralda — tanımlanır ve o kural ticket'ın AKIŞINI da seçer.
   *
   * `IntakeRefusal`'daki `not_opted_in` üyesi ve `config.optInLabel` DURUYOR:
   * `jira-commands.ts` hâlâ o sebebi ticket'a yazılacak mesaja çeviriyor.
   * Ulaşılamaz hâle gelmiş bir sebebi tip kümesinden çıkarmak ayrı bir
   * temizlik; burada yapılan iş kapıyı kaldırmak.
   */

  // M58: both levels stop new work. `all` also stops running work, but that is
  // the workflow's job — here the only question is whether to take the ticket.
  const killSwitch = await deps.killSwitch.get();
  if (killSwitch.level !== "off") {
    deps.counters.droppedKillSwitch += 1;
    await deps.work.addComment(
      request.ticket,
      deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.killSwitch, {
        level: killSwitch.level,
        reason: killSwitch.reason,
      }),
    );
    return { accepted: false, reason: "kill_switch" };
  }

  // WHICH FLOW — decided here, before the run exists, and passed IN.
  //
  // It cannot be decided inside the workflow: `packages/workflows` may not read
  // a database (M44), and a workflow that re-read the rules on replay would
  // take a different path the moment an admin edited a rule. So the rules are
  // read once, on the way in, and the answer travels in the start input — the
  // same shape `openGate` uses to hand a resolved directory group to
  // `canCloseGate` (HANDOFF item 2).
  //
  // Decided BEFORE the application check below, because the application check
  // now depends on it: whether "no application" is a refusal is a question
  // about which flow would run.
  const flow = await decideFlow(deps, request, projectKey);
  const flowDecision = flow.decision;

  /**
   * Dökümün, karardan öğrenilen her şeyi taşıyan ortak gövdesi.
   *
   * Tek yerde kuruluyor çünkü iki YOLDAN yazılıyor — kabulde ve `no_application`
   * reddinde — ve iki yolun aynı kararı farklı anlatması, dökümü teşhis aracı
   * olmaktan çıkarırdı. Yollar yalnızca son iki alanda (`accepted`,
   * `refusedReason`) ayrılır.
   */
  /**
   * Depo kararı bu noktadan SONRA hesaplanıyor (eşleme, kod araması, bağlama),
   * ama `facts()` hem ondan önce hem sonra çağrılabiliyor — bir reddin dökümü
   * zincir hiç koşmadan yazılabilir. Kapanış o yüzden değişken okuyor: karar
   * varsa döküme girer, yoksa alanlar hiç yazılmaz ("henüz karar verilmedi"
   * ile "bağlamaya düşüldü" ayrı şeyler ve döküm ikisini karıştırmamalı).
   */
  let repoFacts: Pick<
    IntakeDecisionFacts,
    "appId" | "appIdSource" | "repoMapField" | "repoMapValue" | "repoMapMiss"
  > = {};

  const facts = (verdict: Pick<IntakeDecisionFacts, "accepted" | "refusedReason">): IntakeDecisionFacts => ({
    ticket: request.ticket,
    projectKey,
    source: sourceOf(request),
    status: request.status ?? null,
    issueType: request.issueType ?? null,
    // Kimlikler de dökümde: "kuralım 10008 diyor, ticket 10001 taşıyor" ya da
    // "ticket hiç id taşımıyor" cevabı ancak burada okunabilir, ve operatörün
    // sorusu ("kural doğru görünüyor, neden eşleşmedi?") tam olarak bu.
    statusId: request.statusId ?? null,
    issueTypeId: request.issueTypeId ?? null,
    assignee: request.assignee ?? null,
    // `null` ile `[]` farkı burada da korunuyor — döküm bu ikisini AYRI
    // cümlelerle anlatıyor ve operatörü ayrı yerlere gönderiyor.
    labels: request.labels ?? null,
    decision: flowDecision,
    rulesConsidered: flow.rulesConsidered,
    statusBlocked: flow.statusBlocked,
    ungatedRuleIds: flow.ungatedRuleIds,
    analystVariantId: flowDecision.analystVariantId ?? null,
    engineerVariantId: flowDecision.engineerVariantId ?? null,
    ...repoFacts,
    ...verdict,
  });

  // ── Depo eşlemesi ────────────────────────────────────────────────────────
  // The matched rule may map a Jira field's VALUE to an application: the
  // bank's "İş Ailesi" says which repository this ticket belongs to. An
  // explicit `/ai-assign` still wins; a ticket whose value matches no row
  // keeps the project binding's app, exactly as before the map existed.
  const mapped = await resolveRepoMap(deps, request.ticket, flowDecision.ruleId);
  const repoMapMiss = lastRepoMapMiss;
  /**
   * ── DEPOYU KOD ARAMASIYLA BUL ────────────────────────────────────────────
   *
   * Sıradaki yerine dikkat: elle söylenen (`request.appId`) ve kuralın
   * eşlemesi (`mapped`) HER İKİSİ de aramanın ÖNÜNDE. Arama bir tahmindir ve
   * bir tahmin, insanın ya da operatörün açık kararını asla ezmemelidir.
   *
   * Arama yalnız ikisi de susunca konuşur — ve tam olarak o hâl, sahada
   * bildirilen hâldir: "bir projede çok fazla repo var, aradığım analiz kodu
   * hangisinde bilmiyorum". Eşleme yazamayan operatörün elinde bugüne kadar
   * proje bağlamasının varsayılan deposu vardı, yani neredeyse her zaman
   * YANLIŞ depo.
   *
   * Bulunamazsa (arama kurulu değil, eşleşme yok, uç cevap vermedi) zincir
   * eskisi gibi bağlamaya düşer: arama bir EK, bir koşul değil.
   */
  /**
   * Kural "projeyi seç, depoyu bul" diyorsa aranacak proje ONDAN gelir; yoksa
   * Jira'nın proje anahtarı kullanılır. İkisi aynı şey değil: bir Jira projesi
   * "OPS" olabilirken kodun yaşadığı ADO projesi "Bankacılık" olabilir, ve o
   * hâlde arama yanlış projede arardı.
   */
  const searchProject = searchRepoMapProject(deps, flowDecision.ruleId);
  const searched =
    request.appId !== undefined || (mapped !== null && !mapped.search)
      ? null
      : await searchRepoFor(deps, request, (await searchProject) ?? projectKey);
  /**
   * ── DEPO TEK YERDEN GELİR: DİNLEME KURALININ EŞLEMESİ ────────────────────
   *
   * Zincirde bir dönem dördüncü bir halka vardı — `binding.appId`, proje
   * bağlamasının varsayılanı. Kaldırıldı, ve sebebi kaldırmanın maliyetinden
   * daha ağırdı.
   *
   * O halka SESSİZ bir varsayılandı: kuralın eşlemesi cevap veremediğinde
   * (alan okunamadı, değer için satır yok, sürücü alan okuyamıyor) devreye
   * giriyor ve koşuya yine bir depo veriyordu. Operatör panelde bir depo adı
   * görüyor ve eşlemenin çalıştığını sanıyordu. Canlıda ölçüldü:
   * `Uguryldz/maestro-pilot`ın `jiraProjectKey`i NULL — yani sahipsiz — ama
   * OPS bağlamasının varsayılanı o olduğu için Routing listesinde OPS altında
   * görünüyordu. Yanlış depoya güvenle iş yapmak, hiç iş yapmamaktan kötüdür.
   *
   * Kaldırmanın maliyeti ölçüldü ve KABUL EDİLDİ: eşlemesi olmayan bir
   * `gelistirme`/`duzeltme` kuralı artık ticket işlemez. Bu bir gerileme
   * değil, kuralın EKSİK olduğunun söylenmesi — ve söylenme yeri de değişti:
   * kural artık eşlemesiz KAYDEDİLEMİYOR (bkz. `routes/listening.ts`), yani
   * eksik kural canlıya hiç çıkmıyor. Eskiden kural sessizce kaydediliyor,
   * sonra sessizce yanlış depoya iş yapıyordu.
   *
   * `analiz` akışı etkilenmez: belge ticket metninden yazılır, depo
   * gerekmez ve `appId === null` o akışta zaten meşru.
   */
  const appId =
    request.appId ?? (mapped?.search === true ? undefined : mapped?.appId) ?? searched?.appId ?? null;
  /**
   * ZİNCİRİN HANGİ HALKASI CEVAP VERDİ — döküme yazmak için.
   *
   * Kararın kendisi değişmiyor; yalnız GÖRÜNÜR oluyor. Bir dönem bu bilgi
   * hiçbir yere yazılmıyordu ve operatör, bağlamanın varsayılanına düşülmüş
   * bir koşuda da bir depo adı gördüğü için eşlemenin çalıştığını sanıyordu —
   * canlıda ölçülen yanlış-anlatımın kaynağı buydu.
   *
   * Sıra, yukarıdaki `??` zincirinin AYNISI olmak zorunda: ayrışırsa döküm
   * kararı yanlış anlatır, ki bu hiç yazmamaktan kötüdür.
   */
  const appIdSource: NonNullable<IntakeDecisionFacts["appIdSource"]> =
    request.appId !== undefined && request.appId !== null
      ? "request"
      : mapped !== null && mapped.search !== true && mapped.appId !== undefined
        ? "repo_map"
        : searched?.appId !== undefined && searched.appId !== null
          ? "code_search"
          : "none";
  repoFacts = {
    appId: appId ?? null,
    appIdSource,
    repoMapField: mapped?.field ?? null,
    repoMapValue: mapped?.value ?? null,
    repoMapMiss: repoMapMiss,
  };
  if (appId === null || appId === undefined) {
    // Tier ③ of M99, narrowed to the flows it was written for: no rule matched
    // an application and no human said which one, so a flow that WRITES CODE
    // waits for a person rather than starting against a guess. The `analiz`
    // flow is the deliberate exception — an analysis-only binding carries no
    // application at all, the document is written from the ticket text, and
    // refusing it would force an analysis team to bind a repository they do
    // not own.
    if (flowDecision.flow !== "analiz") {
      await deps.work.addComment(
        request.ticket,
        deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.pendingAssignment, {
          ticket: request.ticket,
        }),
      );
      /**
       * REDDİN DE DÖKÜMÜ VAR — ve dökümün asıl varlık sebebi bu dal.
       *
       * Kabul edilen bir alım arkasında bir koşu satırı, bir denetim kaydı ve
       * bir Jira yorumu bırakır; operatörün bakabileceği yerler vardır. Burada
       * hiçbiri yoktur: ticket bir insana havale edilir, koşu AÇILMAZ, denetim
       * zincirine `RUN_STARTED` düşmez. Yalnızca reddi yazmayan bir döküm,
       * "ticket'ıma ne oldu?" sorusunun en çok sorulduğu durumda susardı.
       */
      writeDecisionLog(deps, facts({ accepted: false, refusedReason: "no_application" }));
      return { accepted: false, reason: "no_application" };
    }
  }

  /**
   * ── SEÇİLEN UYGULAMA GERÇEKTEN KAYITLI MI ────────────────────────────────
   *
   * CANLIDA ÖLÇÜLDÜ (OPS-121). Kuralın depo eşlemesi `Application` tablosunda
   * satırı olmayan bir depoyu gösterdi. Sıra şuydu:
   *
   *   1. eşleme doğru çözüldü, log da yazdı ("… sabit uygulamaya bağlı →
   *      Uguryldz/maestro-platform")
   *   2. `signalWithStart` çağrıldı, workflow açıldı, DEPO KLONLANDI
   *      (`checkoutOrNull` → `prepareWorkspace`, `apps/deploy/src/bin/bff.ts`)
   *   3. koşu satırı yazılamadı:
   *      "OPS-121 alınmadı: PrismaClientKnownRequestError: Foreign key
   *       constraint violated on the constraint: WorkflowRun_appId_fkey"
   *
   *   Sonuç: disk harcandı, ticket işlenmedi, ve operatörün elinde ham bir
   *   Prisma hatasından başka bir şey kalmadı. Klonlar da birikti.
   *
   * KONTROLÜN YERİ, düzeltmenin yarısı. `signalWithStart`tan ÖNCE, çünkü klon
   * onun ARDINDAN açılıyor: burada durursak klon hiç açılmaz. Aynı kontrolü
   * `checkoutOrNull` içine ya da koşu yazımına koymak, diski zaten harcadıktan
   * sonra "olmaz" demek olurdu — yani bugünkü davranışın nazikçe yazılmış hâli.
   *
   * `no_application` ile aynı KALIP, ayrı SEBEP: ticket'a bir yorum düşer,
   * karar dökümüne sebep yazılır, koşu AÇILMAZ. Yabancı anahtar hatası artık
   * hiç oluşmaz, çünkü o hataya götüren yazma denemesi hiç yapılmaz.
   *
   * "KAYIT YOK" ile "OKUYAMADIM" AYRI, ve ayrılmaları şart.
   *
   * Registry `null` döndüyse bu bir ÖLÇÜM: satır arandı, bulunamadı, ve o
   * koşuyu açmak yabancı anahtar hatasına koşmak demek. Reddediyoruz.
   *
   * `get` ATARSA hiçbir şey ölçülmemiştir. O hâlde reddetmek, geçici bir
   * veritabanı arızasını "hiçbir ticket alınmıyor"a çevirirdi — yani bir
   * teşhis kontrolü, engellediği arızadan daha büyük bir arıza üretirdi.
   * Bu yüzden okunamayan bir envanterde BUGÜNKÜ davranışa düşülür (koşu açılır)
   * ve sebep log'a yazılır; kayıtsız depo hâli zaten KATMAN 1'de, kural
   * yazılırken de yakalanıyor.
   */
  if (appId !== null && appId !== undefined) {
    let known: boolean;
    try {
      known = (await deps.read.apps.get(appId)) !== null;
    } catch (error) {
      console.warn(
        `[maestro] ${request.ticket}: uygulama envanteri okunamadı (${appId}): ${String(error)} — kayıt kontrolü atlandı, koşu bugünkü gibi açılıyor.`,
      );
      known = true;
    }
    /**
     * ── ARAMANIN BULDUĞU DEPO KENDİLİĞİNDEN KAYDEDİLİR ──────────────────────
     *
     * Bu kapı kayıtsız bir depoya koşu açmayı engeller ve doğru yapar: kayıtsız
     * bir appId'yle açılan koşu `WorkflowRun_appId_fkey` ile patlıyordu, üstelik
     * klon AÇILDIKTAN sonra (OPS-121).
     *
     * Ama kapı, appId'nin bir insan ya da bir kural tarafından SEÇİLDİĞİ
     * dünyada yazıldı. Kod araması o dünyayı değiştirdi: aramanın var olma
     * sebebi ÖNCEDEN BİLİNMEYEN bir depoyu bulmaktır ve önceden bilinmeyen bir
     * depo, doğası gereği envantere kaydedilmiş olamaz. Sahada tam olarak bu
     * oldu — arama `HayatPay/utility-payment-service`i buldu, kapı "kayıtlı
     * değil" deyip ticket'ı reddetti ve operatöre kaydetmesini söyledi. Oysa
     * kaydedecek bir şey seçmemişti; arama seçmişti.
     *
     * Bu yüzden ARAMANIN bulduğu depo burada kaydedilir. Kaydetmek bir onay
     * değil, bir kayıt: depo zaten SCM'de var (arama onu orada buldu), bağlama
     * zaten bu projeye ait, ve kaydın kendisi denetim zincirine yazılıyor.
     *
     * Elle ya da kuralla SEÇİLEN bir depo bu yoldan geçmez ve kapı ona aynen
     * uygulanır: orada kayıtsızlık bir yazım hatasının işaretidir, ve sessizce
     * kaydetmek o hatayı kalıcı hâle getirirdi.
     */
    if (!known && searched?.appId === appId && deps.appRegistry !== undefined) {
      const halves = splitRepoFullName(appId);
      if (halves !== null) {
        try {
          await deps.appRegistry.register({
            appId,
            displayName: appId,
            adoProject: halves.adoProject,
            adoRepo: halves.adoRepo,
            // Envanterin varsayılan profili; imaj Java/Maven'ı da taşır ve
            // analiz akışı zaten derleme yapmaz.
            platform: "linux-node",
            jiraProjectKey: projectKey,
          });
          console.info(
            `[maestro] ${request.ticket}: kod aramasının bulduğu "${appId}" envantere kaydedildi (arama seçti, operatör değil).`,
          );
          known = true;
        } catch (error) {
          console.warn(
            `[maestro] ${request.ticket}: "${appId}" envantere kaydedilemedi: ${String(error)} — koşu açılmayacak.`,
          );
        }
      }
    }
    if (!known) {
      console.warn(
        `[maestro] ${request.ticket}: seçilen uygulama "${appId}" uygulama envanterinde kayıtlı değil — koşu açılmadı, depo klonlanmadı.`,
      );
      await deps.work.addComment(
        request.ticket,
        deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.unknownApplication, {
          ticket: request.ticket,
          appId,
        }),
      );
      writeDecisionLog(deps, facts({ accepted: false, refusedReason: "unknown_application" }));
      return { accepted: false, reason: "unknown_application" };
    }
  }

  /**
   * KAPI DİZİSİ, ÜÇ KATMANIN CEVABI OLARAK — kural → parametre → sabit.
   *
   * `flowDecision.gateSteps` yalnız BİRİNCİ katman (kuralın seçimi). İkinci
   * katman (`gates.risk_tiers` parametresi, artık gerçekten okunuyor) burada
   * devreye giriyor, ve `null` cevabı üçüncü katmana — workflow'un
   * `GATES_BY_RISK`i — düşülmesi demek. Bkz. `gate-defaults.ts`.
   *
   * `"orta"` alım anındaki varsayılan risk ve bilerek: gerçek katmanı analiz
   * belirler (adım 3) ve bu noktada henüz YOKTUR. `initialRunState` de aynı
   * varsayımla başlıyor, yani iki taraf aynı şeyi söylüyor.
   */
  const gateSteps = await resolveGateSteps(deps, flowDecision.gateSteps, "orta");

  /**
   * TICKET UYGULAMASINI NASIL BULDU — koşunun satırına yazılacak `MatchResult`.
   *
   * Bu karar yukarıda ZATEN verildi (`appId` zinciri); bu satır yalnız onu
   * yazıya döküyor. Bkz. `matchOf` — hangi halkanın kazandığı orada, tek
   * yerde, `appId` zincirinin kendi sırasıyla okunuyor.
   */
  const match = matchOf(request, flowDecision, mapped, searched, appId ?? null);

  const outcome = await deps.runs.signalWithStart({
    ticket: request.ticket,
    /**
     * EŞLEŞME KARARI, koşunun başlangıç girdisinde.
     *
     * Sahada ölçülen boşluğun kapandığı yer: `WorkflowRun.matchJson` M99'dan
     * beri şemada duruyordu ama hiçbir üretim kodu yazmıyordu, ve
     * `/onboarding/dry-run` bu yüzden 35 koşunun 35'ini "çözülemedi" kovasına
     * atıyordu (`tierOf`, `apps/bff/src/onboarding-service.ts`). Karar burada
     * veriliyordu; taşınmadığı için kayboluyordu.
     *
     * Koşullu spread, `flow`/`analystVariantId` ile aynı sebeple: karar
     * çıkarılamadıysa alan HİÇ geçilmez ve sütun bugünkü gibi `NULL` kalır.
     * Uydurulmuş bir `MatchResult`, hiç kaydedilmemiş olmasından kötüdür —
     * dry-run onu "yerleşmiş" diye okur ve operatöre hiçbir şeyin
     * yerleştirmediği bir ticket'ı yerleşmiş gösterirdi.
     */
    ...(match === null ? {} : { match }),
    // Omitted rather than sent as null for an analysis-only start: absence is
    // what the workflow reads as "no application", and `StartRunInput` has no
    // null to give it.
    ...(appId === null || appId === undefined ? {} : { appId }),
    // The repo map's row may also name the environment branch (see gateway.ts).
    ...(mapped?.targetBranch === undefined ? {} : { targetBranch: mapped.targetBranch }),
    mode: binding.mode,
    dataClass: binding.dataClass,
    ...(flowDecision.flow === null ? {} : { flow: flowDecision.flow }),
    // Omitted rather than sent as null when the rule maps nothing, for the
    // same reason `flow` is: absent already MEANS comment-only mode, and an
    // explicit null would say the same thing while looking like a choice
    // somebody made.
    ...(flowDecision.statusMap === undefined || flowDecision.statusMap === null
      ? {}
      : { statusMap: flowDecision.statusMap }),
    /**
     * KAPI DİZİSİ — ve neden `statusMap` gibi "boşsa hiç gönderme" DEĞİL.
     *
     * Kardeşlerinde yokluk zaten doğru varsayılanı anlatıyordu, o yüzden boş
     * bir değeri göndermemek doğruydu. Burada yokluk "risk seviyesine göre aç"
     * demek ve BOŞ DİZİ onun tam tersi — "hiçbirini açma". İkisini aynı
     * "gönderme" dalına koymak, operatörün kapattığı kapıları koşu başlarken
     * geri açardı, ve panel kapalı gösterirken kapılar açılırdı.
     *
     * `null` yine de gönderilmez: o gerçekten "seçim yok" demek ve absent ile
     * aynı şey — birini gönderip diğerini göndermemek, aynı anlama iki farklı
     * yol açmak olurdu.
     */
    ...(gateSteps === null ? {} : { gateSteps }),
    /**
     * KURALIN SEÇTİĞİ AJANLAR, koşunun başlangıç girdisine çivilenmiş hâlde.
     *
     * Bu iki satır olmadan `ListeningRule.analystVariantId` sütunu, panel ve
     * `flow-decision.ts` boşuna çalışıyordu: karar `flowDecisionFor` ile burası
     * arasında düşüyor ve her koşu `role='analyst'`in alfabetik olarak İLK
     * satırına iğneleniyordu. Operatörün cümlesi tam buydu — "ajan tanımlarını
     * dinleme kurallarınıda bağlamamışsın".
     *
     * `flow` ve `statusMap` ile aynı biçimde, KOŞULLU spread ile: seçilmemiş
     * alan `null` olarak değil, HİÇ geçilmiyor. Yokluk zaten "kurulumun etkin
     * varyantına düş" demek ve `StartRunInput` bu alanlara `null` kabul etmiyor
     * — boş bir varyant kimliği ise gateway sözleşmesini ilk model çağrısında,
     * üç aktivite denemesi ötede bozardı.
     */
    ...(flowDecision.analystVariantId === undefined || flowDecision.analystVariantId === null
      ? {}
      : { analystVariantId: flowDecision.analystVariantId }),
    ...(flowDecision.engineerVariantId === undefined || flowDecision.engineerVariantId === null
      ? {}
      : { engineerVariantId: flowDecision.engineerVariantId }),
  });

  if (outcome.started) {
    await deps.audit.append({
      actor: request.actor,
      action: "RUN_STARTED",
      subject: request.ticket,
      at: deps.clock.now(),
      meta: {
        workflowId: outcome.workflowId,
        projectKey,
        // An analysis-only start has no application, and the audit row says so
        // in words rather than holding a null a SIEM query would drop: "which
        // app did OPS-41 run against?" must be answerable with "none — ticket-
        // text analysis" months later.
        appId: appId ?? "yok (analiz, ticket metninden)",
        mode: binding.mode,
        dataClass: binding.dataClass,
        assigned: request.appId !== undefined,
        // WHY this ticket runs the flow it does. An operator asking months
        // later "why did OPS-41 write code?" reads it off the audit chain; a
        // log line would be long gone, and the run row records only the flow,
        // not the reason for it.
        flow: flowDecision.flow ?? "varsayilan",
        flowReason: flowDecision.reason,
        ...(flowDecision.ruleId === undefined ? {} : { flowRuleId: flowDecision.ruleId }),
        ...(flowDecision.conflictingRuleIds === undefined
          ? {}
          : { flowConflictingRuleIds: flowDecision.conflictingRuleIds.join(",") }),
        /**
         * WHICH board columns this run was pinned to, recorded next to the
         * flow that was pinned with them. A ticket that moved to a status
         * nobody expected is answered from here — the rule may have been
         * edited since, and the map that actually drove this run is otherwise
         * unrecoverable. Comment-only mode is recorded too, as "yorum" (there
         * IS no map), because "the operator configured nothing" and "the
         * audit did not say" have to be distinguishable.
         */
        statusMap:
          flowDecision.statusMap === undefined || flowDecision.statusMap === null
            ? "yorum"
            : JSON.stringify(flowDecision.statusMap),
        /**
         * HANGİ ONAYLAR bekleniyordu — akışın ve durum eşlemesinin yanında,
         * aynı gerekçeyle. "OPS-41'de neden PO onayı sorulmadı?" sorusunun
         * aylar sonraki tek cevabı bu satır: kural o zamandan beri düzenlenmiş
         * olabilir.
         *
         * Üç durum, ÜÇ AYRI KELİMEYLE — bir null tutulmuyor, çünkü SIEM
         * sorgusu onu düşürür ve üçü ayırt edilemez hâle gelir:
         *   "risk seviyesine göre" → kural seçim yapmadı
         *   "kapı yok"             → kural açıkça hiçbir kapı istemedi
         *   "4,5"                  → tam olarak bunlar
         */
        gateSteps:
          gateSteps === null
            ? "risk seviyesine göre"
            : gateSteps.steps.length === 0
              ? "kapı yok"
              : gateSteps.steps.join(","),
        gateOwner: gateSteps?.ownerless === true ? "sahipsiz" : "grup adına",
        /**
         * Cevap NEREDEN geldi — üç katmanın hangisinden. `gateSteps` neyin
         * seçildiğini söyler, bu satır KİMİN seçtiğini: kural mı, global
         * parametre mi, yoksa ürünün varsayılanı mı. "Ben kuralda seçmedim
         * ama kapılar değişti" sorusunun tek cevabı bu ayrım.
         */
        gateStepsSource:
          flowDecision.gateSteps !== undefined && flowDecision.gateSteps !== null
            ? "kural"
            : gateSteps === null
              ? "ürün varsayılanı (risk seviyesi)"
              : "global parametre (gates.risk_tiers)",
        /**
         * HANGİ AJAN koştu — akışın ve durum eşlemesinin yanında, aynı
         * satırda, aynı gerekçeyle. Kural sonradan düzenlenmiş olabilir;
         * "OPS-41'i hangi ajan analiz etti?" sorusunun aylar sonraki tek
         * cevabı bu denetim satırıdır.
         *
         * `"kurulum varsayılanı"` KELİMEYLE yazılıyor, bir null tutulmuyor:
         * bir SIEM sorgusu null'ı düşürür ve "kural ajan seçmedi" ile "denetim
         * söylemedi" ayırt edilemez hâle gelirdi. Oysa bu ikisi arasındaki
         * fark, operatörün "seçtiğim ajan koştu mu?" sorusunun ta kendisi.
         */
        analystVariant: flowDecision.analystVariantId ?? "kurulum varsayılanı",
        engineerVariant: flowDecision.engineerVariantId ?? "kurulum varsayılanı",
      },
    });

    /**
     * Say ON THE TICKET that the work was picked up.
     *
     * Reported from the field: an operator assigned a ticket to the bot, the
     * sweep took it, a run started — and Jira showed nothing at all. From
     * where they were sitting, assigning the ticket had done nothing; the only
     * evidence lived in a panel they had no reason to open yet.
     *
     * Only on `started`. A delivery that JOINED a run already going has
     * nothing new to announce, and a second "picked this up" comment on the
     * same ticket reads as the platform having lost track of itself.
     *
     * Fail-soft: the run is under way and a comment that could not be posted
     * must not undo it. Jira being briefly unreachable is not a reason to
     * refuse work it already accepted.
     */
    await deps.work
      .addComment(
        request.ticket,
        deps.messages.t(deps.config.locale, BFF_MESSAGE_KEYS.intakeAccepted, {
          ticket: request.ticket,
        }),
      )
      .catch(() => undefined);
  }

  /**
   * KABUL YOLUNUN DÖKÜMÜ — `started` olsun ya da olmasın.
   *
   * Yukarıdaki denetim satırı ve Jira yorumu yalnızca YENİ bir koşu açıldığında
   * yazılır; mevcut bir koşuya KATILAN teslimat ikisini de üretmez. Döküm o
   * ayrımı yapmıyor, çünkü cevapladığı soru farklı: "bu ticket bu teslimatta
   * hangi kuralla, hangi akışa, hangi ajana düştü?" — ve bu sorunun cevabı,
   * koşunun o an açılmış olup olmamasından bağımsız olarak vardır. Yalnızca
   * `started` için yazsaydı, aynı ticket'a gelen ikinci teslimat dökümde hiç
   * görünmez ve "kuralı değiştirdim, bir şey değişmedi" şikayeti izsiz kalırdı.
   */
  writeDecisionLog(deps, facts({ accepted: true }));

  return { accepted: true, workflowId: outcome.workflowId ?? workflowIdFor(request.ticket), started: outcome.started };
}

/**
 * Which flow this ticket runs, and why.
 *
 * The rule set is read from the listening store — the rows an admin edits in
 * Studio — and matched against the ticket the caller described. Two things make
 * this SAFE to fall back rather than refuse:
 *
 *  - A deployment with no `ListeningStore` wired (the store is optional, like
 *    every other capability the composition root may omit) has no rules to
 *    read, so every ticket takes the deployment default. That is exactly the
 *    behaviour before this existed.
 *  - A store that FAILS to answer is treated the same way. A database blip must
 *    not stop a ticket that would otherwise run: the deployment default is a
 *    deliberate operator choice, not a guess, so falling back to it is safer
 *    than refusing the intake or inventing a flow.
 */
/**
 * The repo-map row the ticket's field value selects on the matched rule, or
 * null: no rule, no map, driver cannot read fields, field empty, no row.
 * Never throws — a Jira hiccup here must not turn into a refused intake.
 */
export /**
 * Ticket'ın metnini koda sorup bir depo önerir — ya da `null`.
 *
 * Ticket metni BURADA okunur, `classifyingFields`in verdiği alanlarla değil:
 * o anlık görüntü sınıflandırma alanlarını taşır (tip, etiket, atanan), özet
 * ve açıklamayı değil. Aranacak terimler tam da orada yaşıyor.
 *
 * Her hata `null`'a düşer ve alım devam eder: bir arama arızası, ticket'ın
 * hiç işlenmemesine yol açmamalı.
 */
/**
 * "Projeyi ara" kipindeki kuralın ARANACAK PROJESİ — ya da `null`.
 *
 * Bu kipte `entries[0].appId` bir depo değil, bir PROJE adıdır: operatör
 * hangi depo olduğunu bilmiyor, hangi proje olduğunu biliyor.
 */
async function searchRepoMapProject(deps: ResolvedDeps, ruleId: string | undefined): Promise<string | null> {
  if (ruleId === undefined || deps.listening === undefined) return null;
  try {
    const rule = await deps.listening.get(ruleId);
    const map = rule?.repoMap ?? null;
    if (!isSearchRepoMap(map)) return null;
    const project = map?.entries[0]?.appId.trim() ?? "";
    return project === "" ? null : project;
  } catch {
    return null;
  }
}

async function searchRepoFor(
  deps: ResolvedDeps,
  request: IntakeRequest,
  projectKey: string,
): Promise<{ appId: string } | null> {
  const search = deps.repoSearch;
  if (search === undefined) return null;
  try {
    const snapshot = await deps.work.getTicket(request.ticket);
    const text = `${snapshot.summary ?? ""}\n${snapshot.description ?? ""}`.trim();
    if (text === "") return null;
    const found = await search({ text, project: projectKey });
    if (found === null) return null;
    console.info(`[maestro] ${request.ticket}: depo kod aramasıyla seçildi → ${found.repo} (${found.why}).`);
    return { appId: found.repo };
  } catch (error) {
    console.warn(`[maestro] ${request.ticket}: depo araması yapılamadı: ${String(error)} — eşleme/bağlama kullanılacak.`);
    return null;
  }
}

/**
 * Eşleme neden cevap veremedi — çağrının HEMEN ardından okunur.
 *
 * Bir dönem bu sebepler yalnız `console.warn`a gidiyordu ve dört ayrı hal
 * ("sürücü alan okuyamıyor", "alan okunamadı", "değer için satır yok",
 * "kuralda eşleme yok") operatöre tek bir sessizlik olarak ulaşıyordu — üstelik
 * her birinde yapılacak şey farklı. Dönüş tipini değiştirmemek için modül
 * düzeyinde taşınıyor: `resolveRepoMap` tek akışta, tek çağrıyla kullanılıyor.
 */
let lastRepoMapMiss: string | null = null;

async function resolveRepoMap(
  deps: ResolvedDeps,
  ticket: TicketKey,
  ruleId: string | undefined,
): Promise<{ appId: string; targetBranch?: string; field: string; value: string; search?: boolean } | null> {
  lastRepoMapMiss = null;
  if (ruleId === undefined || deps.listening === undefined) return null;
  let rule: ListeningRuleRecord | null;
  try {
    rule = await deps.listening.get(ruleId);
  } catch {
    lastRepoMapMiss = "dinleme kuralı okunamadı";
    return null;
  }
  const map = rule?.repoMap ?? null;
  if (map === null) return null;
  /**
   * "PROJEYİ SEÇ, DEPOYU SİSTEM BULSUN" kipinde `entries[0].appId` bir depo
   * DEĞİL, aranacak projedir. Buradan bir depo dönemez; `search: true` ile
   * çağırana "bu kural aramayı istiyor" denir ve karar zinciri aramayı çalıştırır.
   */
  if (isSearchRepoMap(map)) {
    const project = map.entries[0]?.appId.trim() ?? "";
    console.info(`[maestro] ${ticket}: dinleme kuralı ${ruleId} depoyu ARAMAYLA seçecek (proje: ${project === "" ? "—" : project}).`);
    return { appId: "", field: map.field, value: "*", search: true };
  }
  if (isFixedRepoMap(map)) {
    const fixed = resolveRepoMapEntry(map, undefined);
    if (fixed === null) return null;
    console.info(`[maestro] ${ticket}: dinleme kuralı ${ruleId} sabit uygulamaya bağlı → ${fixed.appId}${fixed.targetBranch === undefined ? "" : ` (${fixed.targetBranch})`}.`);
    return { appId: fixed.appId, ...(fixed.targetBranch === undefined ? {} : { targetBranch: fixed.targetBranch }), field: map.field, value: "*" };
  }
  const readFields = deps.work.readFields?.bind(deps.work);
  if (readFields === undefined) {
    lastRepoMapMiss = "bu Jira sürücüsü alan okuyamıyor";
    console.warn(`[maestro] ${ticket}: dinleme kuralı ${ruleId} depo eşlemesi taşıyor ama bu Jira sürücüsü alan okuyamıyor — proje bağlamasının uygulaması kullanılıyor.`);
    return null;
  }
  let values: Record<string, string>;
  try {
    values = await readFields(ticket, [map.field]);
  } catch (error) {
    lastRepoMapMiss = `alan (${map.field}) Jira'dan okunamadı: ${String(error)}`;
    console.warn(`[maestro] ${ticket}: depo eşlemesi alanı (${map.field}) okunamadı: ${String(error)} — proje bağlamasının uygulaması kullanılıyor.`);
    return null;
  }
  const value = values[map.field];
  const entry = resolveRepoMapEntry(map, value);
  if (entry === null) {
    lastRepoMapMiss = `${map.fieldName ?? map.field} = ${JSON.stringify(value ?? "")} için eşleme tablosunda satır yok`;
    console.info(`[maestro] ${ticket}: ${map.fieldName ?? map.field} = "${value ?? ""}" için depo eşlemesinde satır yok — proje bağlamasının uygulaması kullanılıyor.`);
    return null;
  }
  console.info(`[maestro] ${ticket}: depo eşlemesi ${map.fieldName ?? map.field} = "${value ?? ""}" → ${entry.appId}${entry.targetBranch === undefined ? "" : ` (${entry.targetBranch})`}.`);
  return { appId: entry.appId, ...(entry.targetBranch === undefined ? {} : { targetBranch: entry.targetBranch }), field: map.field, value: value ?? "" };
}

async function decideFlow(deps: ResolvedDeps, request: IntakeRequest, projectKey: string): Promise<FlowOutcome> {
  const fallback = (): FlowOutcome => ({
    decision:
      deps.config.defaultFlow === undefined || deps.config.defaultFlow === null
        ? { flow: null, reason: "none" }
        : { flow: deps.config.defaultFlow, reason: "default" },
    // Bir kural OKUNMADIĞINDA sayı 0'dır ve bu, dökümün en teşhis edici
    // satırı: "kural yok" ile "kural var ama eşleşmedi" birbirinden ancak
    // burada ayrılır. Store'un olmadığı ya da cevap vermediği hâl de aynı
    // sayıyı verir — ikisinde de karara giren kural sayısı gerçekten sıfırdır.
    rulesConsidered: 0,
    statusBlocked: [],
    ungatedRuleIds: [],
  });

  if (deps.listening === undefined) return fallback();

  let rules: readonly ListeningRuleRecord[];
  try {
    rules = await deps.listening.list();
  } catch {
    return fallback();
  }

  const ticket = {
    projectKey,
    status: request.status ?? null,
    issueType: request.issueType ?? null,
    /**
     * KİMLİKLER de karara giriyor — takım yönetimli projenin tek çalışan
     * anahtarı (`flow-decision.ts` `matches`). Bunlar olmadan o projedeki
     * kural, kendisini bulan sorgunun getirdiği ticket'ı bile eleyerek
     * ADA düşen bir karşılaştırmaya takılırdı.
     *
     * Yokluk `null`'a çevriliyor — `labels`'ta olduğu gibi: bir kural,
     * kimsenin okumadığı bir alan üzerinden ateşlememeli, ve `matches()`
     * sayısal bir kuralı `null` kimlikle eşleştirmez.
     */
    statusId: request.statusId ?? null,
    issueTypeId: request.issueTypeId ?? null,
    assignee: request.assignee ?? null,
    /**
     * ETİKETLER, karara giden yolda.
     *
     * Bu satırın yokluğu ölçülebilir bir sessiz-yanlıştı: `matchKind: "label"`
     * (0023) kuralları burada `undefined` gördükleri için HİÇBİR ticket'ı
     * eşleştiremiyordu — panelde yazılan, kaydedilen ve doğru görünen bir
     * kural, tek bir ticket'ta bile ateşlemiyordu.
     *
     * `null` ile `[]` farkı korunuyor (`ClassifiableTicket` bu farkı okur):
     * `[]` "bu ticket'ın etiketi yok", `null` "bu yol etiketleri okumadı".
     * `IntakeRequest.labels` opsiyonel olduğu için yokluk `null`'a çevriliyor —
     * webhook dışındaki yollar etiketi gerçekten bilmiyor ve bir kural,
     * kimsenin okumadığı bir alan üzerinden ateşlememeli.
     */
    labels: request.labels ?? null,
  };

  /**
   * STATÜ KAPISININ bu ticket'a kural kural ne dediği (0024).
   *
   * `flowDecisionFor` yalnızca KAZANANI döndürür; elenenler kararın içinde
   * görünmez. Oysa operatörün sorusu ("bota atadım, hiçbir şey olmadı")
   * tam olarak elenenlerle ilgili, ve statü yüzünden elenen bir kural ortada
   * bir koşu BIRAKMAZ — bakılacak bir satır bile olmaz. Bu yüzden kapı burada
   * ikinci kez, dökümü yazmak için soruluyor.
   *
   * Yalnızca bu projenin ETKİN kuralları: başka bir projenin kuralı bu
   * ticket'ı zaten hiç eşleştirmez, dolayısıyla "statü yüzünden elendi"
   * demek yanlış olurdu — elenme sebebi statü değil, proje.
   */
  const mine = rules.filter((rule) => rule.enabled && rule.projectKey === projectKey);
  const statusBlocked: { ruleId: string; allowed: readonly string[] }[] = [];
  const ungatedRuleIds: string[] = [];
  for (const rule of mine) {
    const gate = statusGateOf(rule, ticket.status, ticket.statusId);
    if (gate === "ungated") ungatedRuleIds.push(rule.ruleId);
    // `unknown_status` de kapalı sayılır ve kapalı olarak RAPORLANIR: kapının
    // fail-closed yönü dökümde de aynı yönde okunmalı, yoksa statüsü hiç
    // okunmamış bir ticket "kapı sorunu yok" diye görünürdü.
    else if (gate === "closed" || gate === "unknown_status") {
      statusBlocked.push({ ruleId: rule.ruleId, allowed: rule.allowedStatuses ?? [] });
    }
  }

  return {
    decision: flowDecisionFor(rules, ticket, deps.config.defaultFlow),
    // Kaç kural OKUNDU — bu projeninkiler değil, karara giren kümenin tamamı:
    // "0 kural" cevabı, kuralların hiç okunamadığını söyleyen cevaptır.
    rulesConsidered: rules.length,
    statusBlocked,
    ungatedRuleIds,
  };
}

/**
 * Akış kararı ve KARARIN ETRAFINDAKİ ÖLÇÜMLER.
 *
 * `FlowDecision` yalnızca sonucu taşır — hangi akış, hangi kural, neden. Döküm
 * (`intake-decision-log.ts`) ise sonucun ETRAFINI sorar: kaç kural okundu,
 * hangileri statü yüzünden elendi, hangilerinde hiç statü kısıtı yok. Bunlar
 * karara girmez ama kararı AÇIKLAR, ve ikisini tek tipte birleştirmek
 * `FlowDecision`'ı — koşunun başlangıç girdisine çivilenen sözleşmeyi —
 * teşhis alanlarıyla şişirirdi.
 */
interface FlowOutcome {
  readonly decision: FlowDecision;
  readonly rulesConsidered: number;
  readonly statusBlocked: readonly { readonly ruleId: string; readonly allowed: readonly string[] }[];
  readonly ungatedRuleIds: readonly string[];
}

/**
 * Ticket'ı HANGİ YOLUN getirdiği, dökümün okuyucusu için.
 *
 * `IntakeRequest`'te bir `source` alanı yok ve eklenmiyor: her çağrı yerini
 * güncellemek gerekirdi ve elde zaten aynı soruya cevap veren iki alan var.
 * `actor` yolu adlandırır (webhook ve tarama sistem aktörleriyle gelir, bir
 * insan kendi kimliğiyle), `explicit` ise bir insanın adıyla mı istediğini
 * söyler.
 */
function sourceOf(request: IntakeRequest): string {
  if (request.actor === "maestro-worker") {
    return request.explicit === true ? "tarama (keşif turu)" : "webhook (Jira teslimatı)";
  }
  return request.explicit === true ? `komut/panel (${request.actor})` : `webhook (${request.actor})`;
}

/**
 * TICKET UYGULAMASINI NASIL BULDU — koşunun satırına yazılacak `MatchResult`.
 *
 * ── NEDEN VAR: SAHADA ÖLÇÜLEN BOŞLUK ────────────────────────────────────────
 * `WorkflowRun.matchJson` M99'dan beri şemada (`packages/db/prisma/schema.prisma`)
 * ama hiçbir ÜRETİM kodu yazmıyordu — tek yazıcı demo seed'iydi. Bu, teşhisi
 * zor bir sessizlik değildi; ekranda duruyordu: `tierOf()`
 * (`onboarding-service.ts`) her koşuda `MatchResult.safeParse(null)` ile
 * başarısız olup `"unresolved"` dönüyor, `/onboarding/dry-run` 35 koşunun
 * 35'ini "çözülemedi" kovasına atıyor, operatör "uygulamalar ekranı
 * doğrulanamıyor" diyordu. Karar zaten alımda veriliyordu; yalnızca
 * taşınmıyordu.
 *
 * ── SIRA, `appId` ZİNCİRİNİN SIRASIDIR ──────────────────────────────────────
 * Bu işlev kararı YENİDEN VERMİYOR, verilmiş kararı ADLANDIRIYOR — ve bu
 * yüzden dallar yukarıdaki `appId` zinciriyle harfi harfine aynı sırada:
 *
 *   `request.appId` → `mapped.appId` → `searched.appId` → `binding.appId`
 *
 * İkinci bir sıralama yazmak, satırın ekranda söylediği ile koşunun gerçekte
 * yaptığının sessizce ayrılması demekti; kaydın tek değeri, gerçekten olanı
 * anlatması.
 *
 *  · `human` — bir insan `/ai-assign` ile adıyla söyledi. `channel` M99'un
 *    kendi sözlüğü: komut yoluyla geldiyse `jira_command`, panelden geldiyse
 *    `studio`. `sourceOf` ile aynı iki ayrım, aynı iki alandan okunuyor.
 *  · `rule` — kararı dinleme kuralının depo eşlemesi verdi; `ruleId` o kuralın
 *    kimliği, yani dry-run "hangi kural yerleştirdi" sorusuna cevap verebilir.
 *  · `ai_suggestion` — depoyu KOD ARAMASI önerdi. Bu bir tahmindir ve M99 onu
 *    tam olarak öyle sınıflandırıyor: `validatedAtGate: false`, çünkü analiz
 *    kapısında bir insan onaylayana kadar onaylanmış değildir. `confidence`
 *    sabit 0.5: arama uç noktası bir skor DÖNDÜRMÜYOR, ve uydurulmuş yüksek
 *    bir güven, ekranın bir tahmini yerleşmiş göstermesi demek olurdu.
 *  · `rule` (bağlama) — zincirin son halkası proje bağlamasının kendi
 *    uygulaması. Bu da deterministik bir kural kararıdır ve `ruleId` olarak
 *    kararı veren kuralın kimliği yazılır; kural yoksa `binding:<proje>`,
 *    çünkü `NonEmpty` boş dizeyi reddeder ve boş bir kimlik satırı
 *    ayrıştırılamaz hâle getirirdi.
 *
 * ── `null` NE DEMEK ─────────────────────────────────────────────────────────
 * Uygulama YOK (analiz-yalnız koşu: bağlama uygulama adı vermedi ve `analiz`
 * akışı bunu bilerek kabul ediyor). M99'un beş `via` değerinin hiçbiri
 * "uygulamasız" demiyor — `onboarding` bile greenfield bir KURULUMU anlatıyor,
 * bir analizi değil — ve olmayan bir eşleşme için bir eşleşme uydurmak, dry
 * run'a yalan söylemek olurdu. Sütun `NULL` kalır, `tierOf` onu `unresolved`
 * okur ve bu DOĞRUdur: o ticket'ın bir uygulamaya yerleşmesi hiç olmadı.
 */
export function matchOf(
  request: IntakeRequest,
  decision: FlowDecision,
  mapped: { appId: string; search?: boolean } | null,
  searched: { appId: string } | null,
  appId: string | null,
): MatchResult | null {
  if (appId === null || appId.trim() === "") return null;

  if (request.appId !== undefined) {
    return {
      via: "human",
      appId,
      assignedBy: request.actor,
      // `explicit` bir insanın ADIYLA istediğini söylüyor (`/ai-start`,
      // `/ai-assign`); `sourceOf` aynı alandan aynı ayrımı okuyor.
      channel: request.explicit === true ? "jira_command" : "studio",
    };
  }

  const ruleId = decision.ruleId;
  if (mapped !== null && mapped.search !== true && mapped.appId === appId && ruleId !== undefined) {
    return { via: "rule", ruleId, appId };
  }

  if (searched !== null && searched.appId === appId) {
    return { via: "ai_suggestion", appId, confidence: SEARCH_MATCH_CONFIDENCE, validatedAtGate: false };
  }

  // Zincirin son halkası: proje bağlamasının kendi uygulaması. Kararı veren
  // kuralın kimliği varsa o yazılır; yoksa bağlamanın kendisi adlandırılır —
  // `NonEmpty` boş dizeyi reddeder ve boş bir `ruleId`, satırı okunamaz kılardı.
  return { via: "rule", ruleId: ruleId ?? `binding:${request.ticket.split("-")[0] ?? "?"}`, appId };
}

/**
 * KOD ARAMASININ ÖNERİSİNE VERİLEN GÜVEN — sabit, ve bilerek ortada.
 *
 * Arama uç noktası bir skor döndürmüyor: elinde "bu depoda eşleşme var"
 * cevabından fazlası yok. 0.5 o bilgisizliğin dürüst karşılığı — yüksek bir
 * değer uydurmak, dry-run ekranının bir TAHMİNİ yerleşmiş bir karar gibi
 * göstermesi demek olurdu; düşük bir değer ise öneriyi hiç yapılmamış gibi
 * gösterirdi. M99'un ikinci kademesi zaten "insan kapıda onaylayana kadar
 * kesin değil" diyor ve `validatedAtGate: false` bunu ayrıca söylüyor.
 */
const SEARCH_MATCH_CONFIDENCE = 0.5;

/**
 * Kararın dökümünü yazar — ve yazamazsa SESSİZCE PES EDER.
 *
 * Fail-soft olması `deps.decisionLog` sözleşmesinin kendi gerekçesi: bir
 * teşhis satırı uğruna, çalışan bir ticket alımını reddetmek yanlış takas
 * olurdu. Sink'in kendi hatası zaten `apps/deploy` tarafında yutuluyor; buradaki
 * `try` onun için değil, seam'i sağlayan HERHANGİ bir uygulamanın atabileceği
 * hata için — opsiyonel bir bağımlılığın davranışına güvenmek, tam olarak
 * fail-soft olmamak demektir.
 */
function writeDecisionLog(deps: ResolvedDeps, facts: IntakeDecisionFacts): void {
  if (deps.decisionLog === undefined) return;
  try {
    deps.decisionLog(decisionLogLine(facts), decisionLogMarkdown(facts, deps.clock.now()));
  } catch {
    // Yutuldu, bilerek: yukarıdaki gerekçe.
  }
}
