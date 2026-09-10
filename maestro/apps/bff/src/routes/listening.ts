import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ListeningRuleRecord, ListeningStore } from "../listening-store.js";
import {
  ASSIGNED_MATCH_VALUE,
  AllowedStatusesSchema,
  FLOW_TYPES,
  GateStepsSchema,
  MATCH_KINDS,
  RepoMapSchema,
  StatusMapSchema,
} from "../listening-store.js";
import { realignRules } from "../listening-identity.js";
import { seedProjectDefaults } from "../listening-seed.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { poolExitGaps } from "../listening-pool.js";
import { assertWritable } from "../platform/propose.js";
import { unwired } from "./unwired.js";

/**
 * The listening-rules surface ("dinleme kuralları").
 *
 * An admin defines, from Studio, which tickets Maestro picks up and how it runs
 * them: "in project X, a ticket assigned to the bot whose <status|issuetype> is
 * <value> runs as <analiz|duzeltme|gelistirme>". These rows replace the
 * hard-coded `discoveryJql` (`apps/pilot/src/config.ts`), so the pilot's
 * discovery becomes configuration, not code.
 *
 * A rule is a trigger-to-flow mapping — not a model choice or a data-class
 * decision — so it is NOT four-eyes-guarded (unlike `dataclass.policy`). It is a
 * simple admin CRUD, gated the same way connections are: reads for admin +
 * tech-lead, writes for admin. Every write is audited.
 */

const READ_ROLES = ["admin", "tech-lead"] as const;
const WRITE_ROLES = ["admin"] as const;
/**
 * Who may trigger the default-rule seed. Wider than `WRITE_ROLES` on purpose:
 * seeding is the "works out of the box" step of onboarding (an admin/tech-lead
 * surface), it only ADDS the platform's own conservative defaults and never
 * touches an existing rule, so it is gated like onboarding rather than like a
 * free-form rule edit.
 */
const SEED_ROLES = ["admin", "tech-lead"] as const;

/** The seed endpoint's body: which project to seed defaults for. */
const SeedBody = z.object({ projectKey: z.string().trim().min(1).max(32) }).strict();

/** The `:id` path param — a rule id is an opaque token. */
const IdParam = z.object({ ruleId: z.string().min(1).max(64) });

/**
 * The write body a route accepts. Mirrors the DB CHECK domains: `matchKind` and
 * `flowType` are closed enums here so an invalid value is a 400, not a row the
 * database rejects with a 500-shaped constraint error.
 */
/**
 * An optional agent-variant reference (Faz 3): absent, null and "" all mean
 * "the default agent" and normalise to `null`, so the DB stores one shape and
 * the pilot mirror never sees an empty string masquerading as a choice.
 */
const VariantRef = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((value) => (value == null || value === "" ? null : value));

/**
 * The Jira status map (durum eşlemesi), optional per rule. Absent, null and the
 * empty object all normalise to `null` — comment-only mode, today's behaviour —
 * so the DB stores ONE shape for "this rule does not move tickets" and a UI that
 * renders an empty form does not accidentally look like a configured map.
 *
 * `StatusMapSchema` is `.strict()`, so a misspelt key (`onDoneX`) and a
 * non-string value are both a 400 through the same `invalid_listening_rule`
 * code the rest of this body already uses. That is deliberate: a silently
 * dropped key would show up much later as tickets that mysteriously never move,
 * with nothing on the screen to explain why.
 */
const StatusMapRef = StatusMapSchema.nullish().transform((value) =>
  value == null || Object.keys(value).length === 0 ? null : value,
);

/**
 * IZIN VERILEN STATULER — her kuralda sorulan statu kapisi (0024).
 *
 * Yokluk, `null` ve bos dizi tek bir seye normalize olur: `null` = "statu
 * kisiti yok". `StatusMapRef`in gerekcesinin aynisi — bir anlamin iki temsili,
 * er ya da gec birbirinden farkli davranmaya baslar.
 *
 * REDDETMIYOR, cunku mevcut kurallar. 0024 oncesi yazilmis her satir kisitsiz
 * ve panelden duzenlendiginde bu govdeden gecmek zorunda; burada zorunlu kilmak,
 * operatorun bir ajani degistirmek icin actigi kurali kaydedememesi demek
 * olurdu. Zorunluluk PANELDE (yeni kuralda statu secili gelir) ve GORUNURLUKTE
 * (kisitsiz kural her yuzeyde isaretli); kapinin kendisi `flow-decision.ts`te.
 */
const AllowedStatusesRef = AllowedStatusesSchema.nullish().transform((value) => {
  if (value == null) return null;
  const cleaned = value.map((name) => name.trim()).filter((name) => name !== "");
  return cleaned.length === 0 ? null : cleaned;
});

/**
 * ONAY KAPILARI — yokluk ile boş dizi AYRI, ve `StatusMapRef` ile `AllowedStatusesRef`
 * gibi normalize EDİLMEZ.
 *
 * O ikisi boşu `null`'a indiriyordu çünkü orada iki temsil tek davranışa
 * iniyordu. Burada inmiyor: `null` "seçim yok, varsayılana düş" (0027 öncesi
 * her kural), `{steps: []}` ise "onay kapısı istemiyorum". Bir `transform`
 * yazıp boş diziyi `null`'a çevirmek, operatörün panelde kapattığı kapıları
 * kaydet tuşuna basar basmaz geri açardı — ve hiçbir yüzey nedenini
 * söyleyemezdi.
 *
 * `nullish()` ile absent de `null`'a iner, çünkü İKİSİ aynı şeydir: alanı hiç
 * göndermemiş bir istemci ile açıkça `null` göndermiş bir istemci, ikisi de
 * "seçim yok" diyor.
 */
const GateStepsRef = GateStepsSchema.nullish().transform((value) => value ?? null);
const RepoMapRef = RepoMapSchema.nullish().transform((value) => value ?? null);

const RuleBody = z.object({
  projectKey: z.string().trim().min(1).max(32),
  assigneeAccountId: z.string().trim().min(1).max(128),
  matchKind: z.enum(MATCH_KINDS as unknown as [string, ...string[]]),
  /**
   * The status or issue-type name that triggers the rule. Still required for an
   * `assigned` rule, whose value is normalised below — the column is NOT NULL
   * and the unique trigger index needs a real string to collide on.
   */
  matchValue: z.string().trim().min(1).max(128),
  flowType: z.enum(FLOW_TYPES as unknown as [string, ...string[]]),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
  /** Which agent variant runs the analysis side; null → default agent. */
  analystVariantId: VariantRef,
  /** Which agent variant runs the engineering side; null → default agent. */
  engineerVariantId: VariantRef,
  /** The Jira status map; null → comment-only mode (Maestro never moves the ticket). */
  statusMap: StatusMapRef,
  /** Hangi statudeki ticketlar islensin; null → statu kisiti yok (bkz. AllowedStatusesRef). */
  allowedStatuses: AllowedStatusesRef,
  /** Hangi onaylar beklensin; null → risk seviyesine gore (bkz. GateStepsRef). */
  gateSteps: GateStepsRef,
  /** Depo eşlemesi: Jira alanı değeri → uygulama (+hedef dal); null → proje bağlamasının uygulaması. */
  repoMap: RepoMapRef,
});

/**
 * DENEME GÖVDESİ — kural taslağının yalnız ARAMAYI ilgilendiren yarısı.
 *
 * `RuleBody`'nin alt kümesi, ve kasıtlı olarak: bir prova `flowType`,
 * `priority` ya da ajan varyantlarını sormaz — bunların hiçbiri JQL'e girmez,
 * ve istemek, henüz akışını seçmemiş bir operatörün kuralını deneyememesi
 * demek olurdu. Alan adları ve kısıtlar `RuleBody` ile BİREBİR aynı: deneme,
 * kaydedilecek olandan farklı bir şeyi kabul ederse "test ettiğim kural" ile
 * "kaydettiğim kural" ayrışır, ki bu ekranın önlemek için var olduğu şey tam
 * olarak budur.
 */
const TestBody = z
  .object({
    projectKey: z.string().trim().min(1).max(32),
    assigneeAccountId: z.string().trim().min(1).max(128),
    matchKind: z.enum(MATCH_KINDS as unknown as [string, ...string[]]),
    matchValue: z.string().trim().min(1).max(128),
    allowedStatuses: AllowedStatusesRef,
  })
  .strict();

/**
 * The rule as it is STORED, from the rule as it was sent.
 *
 * One normalisation, and it exists for the unique index rather than for taste.
 * An `assigned` rule ("bota atanan her ticket") compares no field, so whatever
 * the client put in `matchValue` is meaningless — but if two clients send two
 * different meaningless strings, the (projectKey, assigneeAccountId, matchKind,
 * matchValue) index sees two distinct triggers and a project quietly ends up
 * with several catch-all rules that all match every ticket. Pinning the value
 * to one literal here makes "at most one catch-all per project and bot" a
 * database guarantee, enforced against every client including a hand-rolled
 * curl, instead of a rule the Studio form happens to follow.
 */
/**
 * Havuzlu (statü seçili) bir kural, ticket'ın havuzdan çıkacağı durumları
 * eşlemeden KAYDEDİLEMEZ — bkz. `listening-pool.ts`. 400 `listening_pool_without_exit`,
 * eksik alanlar `details.missing` içinde adlandırılmış.
 */
function assertPoolExits(record: Pick<ListeningRuleRecord, "allowedStatuses" | "statusMap" | "flowType" | "gateSteps">): void {
  const missing = poolExitGaps({
    allowedStatuses: record.allowedStatuses,
    statusMap: record.statusMap,
    flowType: record.flowType,
    gateSteps: record.gateSteps,
  });
  if (missing.length > 0) throw badRequest("listening_pool_without_exit", { missing });
}

/**
 * DEPO EŞLEMESİNİN GÖSTERDİĞİ HER UYGULAMA KAYITLI OLMAK ZORUNDA.
 *
 * CANLIDA ÖLÇÜLDÜ (OPS-121). Bir kuralın `repoMap`i `Application` tablosunda
 * satırı OLMAYAN bir depoyu gösteriyordu. Alım tarafı eşlemeyi doğru çözdü,
 * log'u da yazdı — "dinleme kuralı sabit uygulamaya bağlı →
 * Uguryldz/maestro-platform" — depoyu KLONLADI, ve ancak koşu satırı
 * yazılırken patladı:
 *
 *   OPS-121 alınmadı: PrismaClientKnownRequestError:
 *   Foreign key constraint violated on the constraint: WorkflowRun_appId_fkey
 *
 * Yani disk harcandı, ticket işlenmedi ve operatörün gördüğü tek şey ham bir
 * Prisma hatası oldu. Hatanın kaynağı ise saatler önce, kural KAYDEDİLİRKEN
 * oradaydı — o yüzden burada, yazma anında reddediliyor.
 *
 * Studio'da bir koruma zaten var (`Listening.tsx`: bilinmeyen SCM deposunu
 * `POST /onboarding/apps` ile kaydeder), ama o YALNIZ ARAYÜZDE: API'ye
 * doğrudan yazılan bir kural ya da sonradan silinmiş bir depo aynı hatayı
 * üretir. Bir veri bütünlüğü kuralının tek uygulayıcısı bir ekran olamaz.
 *
 * `notFound` değil `badRequest`, ve bilerek: eksik olan istenen KAYNAK değil,
 * gönderilen GÖVDE — kuralın kendisi burada yok, bir alanı geçersiz. Bilinmeyen
 * appId'ler `details.appIds` içinde ADLANDIRILIYOR: "bir şey yanlış" operatörün
 * düzeltebileceği bir cevap değil, "bank/kredi kayıtlı değil" ise öyle.
 */
async function assertMappedAppsExist(
  deps: ResolvedDeps,
  repoMap: ListeningRuleRecord["repoMap"],
): Promise<void> {
  if (repoMap === null || repoMap === undefined) return;
  // Tekilleştirilmiş, çünkü aynı depoyu gösteren beş satır operatöre beş kez
  // aynı ismi göstermemeli; sırası korunuyor ki mesaj gövdedeki sırayı izlesin.
  const appIds = [...new Set(repoMap.entries.map((entry) => entry.appId))];
  const unknown: string[] = [];
  for (const appId of appIds) {
    if ((await deps.read.apps.get(appId)) === null) unknown.push(appId);
  }
  if (unknown.length > 0) throw badRequest("listening_repo_map_unknown_app", { appIds: unknown });
}

function storedRule<T extends { matchKind: string; matchValue: string }>(body: T): T {
  return body.matchKind === "assigned" ? { ...body, matchValue: ASSIGNED_MATCH_VALUE } : body;
}

function listeningDeps(deps: ResolvedDeps): { store: ListeningStore } {
  if (deps.listening === undefined) unwired("listening");
  return { store: deps.listening };
}

export async function listeningRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...WRITE_ROLES)];

  /** List every rule, ordered (projectKey, priority). */
  app.get("/studio/listening-rules", { preHandler: readHandler }, async (_request, reply) => {
    const { store } = listeningDeps(deps);
    const rules = await store.list();
    return reply.code(200).send({ rules });
  });

  /**
   * Is the ticket sweep running, and what did it last find?
   *
   * The rules screen could show what Maestro is SUPPOSED to pick up and had no
   * way to say whether anything was actually looking. An operator whose
   * tickets never arrive has to distinguish three states that need three
   * different fixes: the sweep is off, it runs and finds nothing, or it is
   * failing. This answers exactly that.
   */
  app.get("/studio/listening-status", { preHandler: readHandler }, async (_request, reply) => {
    const read = deps.discoveryStatus;
    return reply.code(200).send(
      read === undefined
        ? {
            enabled: false,
            intervalMs: 0,
            lastRunAt: null,
            lastStarted: 0,
            rulesSearched: 0,
            lastError: null,
            // Tarama HİÇ bağlı değilken havuzda kalan da yok: `null` burada
            // "bilinmiyor" değil, "sorulacak bir tarama yok" demek — ve panel
            // ikisini de aynı şekilde okur (kalan gösterme).
            poolRemaining: null,
            // Aynı gerekçe: tarama hiç bağlı değilken yeniden başlatılan da,
            // devredilen de yok.
            lastRestarted: 0,
            lastHandedOver: 0,
            lastLeftInPool: 0,
            leftInPoolKeys: [],
          }
        : read(),
    );
  });

  /**
   * How ticket COMMANDS reach this deployment — the setup wizard's fifth
   * question, answered by the platform rather than guessed by the screen.
   *
   * `/approve` and `/reject <sebep>` arrive as ticket comments, and there are
   * two ways to read one: Jira calls us (webhook), or we ask Jira (the poller
   * in `apps/deploy/src/jira-poller.ts`). The wizard asks which, and it can
   * only ask honestly if it knows three things this route reports: what is in
   * force now, whether the work driver can read a comment thread AT ALL, and
   * whether a saved change is picked up without a service restart.
   *
   * The middle one is the reason this endpoint exists. Offering "biz Jira'ya
   * soralım" on a driver with no `listComments`, accepting the answer and then
   * never polling is the worst outcome available on this screen — an approval
   * gate that waits forever with a setting that says it should not.
   *
   * A deployment that reports nothing gets the CONSERVATIVE answer rather than
   * a 503: webhook-only, no comment reader, restart required. The wizard has to
   * stay walkable on an install that predates this route, and every one of
   * those defaults makes it promise less rather than more.
   */
  app.get("/studio/command-intake", { preHandler: readHandler }, async (_request, reply) => {
    const read = deps.commandIntakeStatus;
    return reply.code(200).send(
      read === undefined
        ? {
            mode: "webhook",
            pollSeconds: 0,
            canReadComments: false,
            appliesLive: false,
            source: "default",
          }
        : read(),
    );
  });

  /**
   * Sweep NOW — the "test" button behind the rules screen.
   *
   * Asked for directly after a sweep that was configured, healthy and taking
   * nothing: "tarama ok ama yine de panele gelmiyor, daha test butonu yok mu?".
   * Until this existed the only way to check a rule you had just written was to
   * wait out the interval and read the container log, which needs a shell on
   * the server — so the person allowed to write rules could not verify their
   * own work.
   *
   * A write, not a read: it starts runs. Same role gate as creating a rule.
   * 503 when the deployment runs no sweep (webhook-only), because "nothing
   * happened" and "there is nothing to run" are different answers.
   */
  app.post("/studio/listening-sweep", { preHandler: writeHandler }, async (request, reply) => {
    const run = deps.discoveryRun;
    // `sweepConfigured` is how a composition root that builds deps BEFORE the
    // sweep says "there is nothing to run"; a plain undefined says the same for
    // one that never wires it at all.
    if (run === undefined || deps.sweepConfigured?.() === false) {
      /**
       * Not an error the operator caused: a webhook-only install runs no sweep
       * at all. 503 with a reason beats a button that silently does nothing.
       */
      /**
       * Two different absences, one honest answer.
       *
       * The sweep is off either because nobody asked for it
       * (`JIRA_DISCOVER_MS` unset) or because the work driver cannot search —
       * only Jira Cloud offers JQL. The composition root knows which; it says
       * so at boot and passes the reason here, so the operator is not sent to
       * edit a setting that would change nothing.
       */
      const message =
        deps.sweepUnavailableReason?.() ??
        "Bu kurulumda ticket taraması açık değil. .env dosyasına JIRA_DISCOVER_MS " +
          "ekleyip (örn. 300000) servisleri yeniden başlatın.";
      /**
       * Said in the LOG too, not only in the response.
       *
       * The boot banner names this once, at start-up — which the operator who
       * presses the button hours later is not reading. Whoever is handed the
       * container log after a "tarama çalışmıyor" report needs the reason at
       * the moment of the press, next to the 503 the panel showed.
       */
      request.log.warn(
        { reason: message },
        "listening-sweep refused: this deployment runs no ticket sweep",
      );
      return reply.code(503).send({ error: "sweep_not_configured", message });
    }
    try {
      const started = await run();
      return reply.code(200).send({
        started: [...started],
        /** The round's own numbers, so the panel need not re-fetch. */
        status: deps.discoveryStatus?.() ?? null,
      });
    } catch (error) {
      // A sweep that throws is a real answer for the operator to see, not a
      // 500 with a stack trace: the usual cause is Jira refusing the search.
      return reply.code(200).send({
        started: [],
        error: error instanceof Error ? error.message : String(error),
        status: deps.discoveryStatus?.() ?? null,
      });
    }
  });

  /**
   * KURALI TEST ET — kaydetmeden önce Jira'ya sor, ne getirdiğini göster.
   *
   * Operatörün sözleriyle istendi: "kontrol ekranı ver, loga gerek yok,
   * dinlemede filtre ayarlamak için". Bugüne kadar yeni bir kuralın doğru olup
   * olmadığını öğrenmenin tek yolu onu KAYDEDİP bir tur beklemek ve konteyner
   * log'unu okumaktı — sunucuda kabuk gerektiren bir iş, yani kural yazma
   * yetkisi verilen kişi kendi işini doğrulayamıyordu.
   *
   * BU BİR PROVA: hiçbir şey yazmaz, hiçbir koşu başlatmaz, kural kaydetmez.
   * O yüzden `assertWritable` YOK — bakım kilidi altındaki bir kurulumda
   * "neden ticket gelmiyor" sorusunu sormak yasaklanmamalı; kilit YAZMAYI
   * durdurur, teşhisi değil.
   *
   * Yetki yine de WRITE_ROLES: gösterdiği şey bir projenin ticket alanları, ve
   * bunu görmeye hakkı olan kişi kuralı yazabilen kişidir.
   *
   * `POST`, çünkü gövdede bir kural taslağı taşır — okuma olması onu GET
   * yapmaz; bir JQL'i ve statü listesini query string'e dizmek hem kırılgan hem
   * de sunucu log'una yapılandırma sızdırmanın yolu olurdu.
   */
  app.post("/studio/listening-rules/test", { preHandler: writeHandler }, async (request, reply) => {
    const probe = deps.listeningProbe;
    if (probe === undefined) {
      /**
       * Sessiz boş sonuç YOK. Arama sunmayan bir sürücüde (Azure DevOps) ya da
       * tarama hiç kurulmamışsa "0 eşleşme" göstermek, bu ekranın var olma
       * sebebi olan sessiz-yanlışın aynısı olurdu: operatör kuralını suçlar,
       * oysa sorulan hiçbir soru yoktur.
       */
      const message =
        deps.sweepUnavailableReason?.() ??
        "Bu kurulumun Jira sürücüsü JQL araması sunmuyor, kural denenemez.";
      return reply.code(503).send({ error: "probe_not_available", message });
    }

    const body = TestBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    const draft = storedRule(body.data);
    const result = await probe({
      projectKey: draft.projectKey,
      assigneeAccountId: draft.assigneeAccountId,
      matchKind: draft.matchKind as "status" | "issuetype" | "assigned" | "label",
      matchValue: draft.matchValue,
      allowedStatuses: draft.allowedStatuses,
    });

    /**
     * Başarısız bir deneme de 200'dür, gövdesinde ADLANDIRILMIŞ sebebiyle.
     *
     * "Proje bağlı değil" ya da "kuralda bot hesabı yok" operatörün DÜZELTEBİLECEĞİ
     * bir cevap, sunucunun bir arızası değil — ve bir HTTP hata kodu, panelde
     * ekranın kendisi yerine genel bir hata kutusu gösterirdi. Sebep serbest
     * metin değil ki panel kendi katalogundan çevirebilsin.
     */
    return reply.code(200).send(result);
  });

  /** Create a rule. A duplicate trigger (unique index) becomes a 409. */
  app.post("/studio/listening-rules", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const body = RuleBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    const ruleId = `lr_${randomBytes(9).toString("hex")}`;
    const record: ListeningRuleRecord = {
      ruleId,
      ...storedRule(body.data as Omit<ListeningRuleRecord, "ruleId">),
    };
    assertPoolExits(record);
    await assertMappedAppsExist(deps, record.repoMap);
    try {
      await store.put(record);
    } catch (error) {
      // The unique (projectKey, assigneeAccountId, matchKind, matchValue) index
      // rejects a second rule for the same trigger — that is a 409, not a 500.
      if (isUniqueViolation(error)) throw badRequest("duplicate_listening_rule");
      throw error;
    }
    await audit(deps, request, ruleId, "created");
    return reply.code(201).send({ rule: record });
  });

  /**
   * Seed the DEFAULT rules for a project — the "works out of the box" step.
   *
   * Reads the project's real issue types off live Jira (via the stored Jira
   * connection that knows the bot account) and creates one `issuetype` rule per
   * non-subtask type: bug-like types run `duzeltme`, everything else `analiz`,
   * and `gelistirme` is never assigned automatically (see listening-seed.ts).
   * IDEMPOTENT — existing triggers are skipped, so an admin's hand-edited flow
   * type survives any number of re-seeds.
   *
   * Honesty rules: a missing Jira connection or an untested one (no bot
   * account) is a NAMED 409 the operator can fix; a Jira read that fails is the
   * fail-soft fallback — NO rules are written (never invented type names) and
   * the response says why with `created: 0`.
   */
  app.post(
    "/studio/listening-rules/seed-defaults",
    { preHandler: [authGuard(deps), requireAnyRole(...SEED_ROLES)] },
    async (request, reply) => {
      await assertWritable(deps);
      listeningDeps(deps); // 503-by-name before anything else when unwired

      const body = SeedBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_listening_seed");

      const outcome = await seedProjectDefaults(deps, body.data.projectKey);
      if (!outcome.ok) {
        if (outcome.reason === "listening_unwired") unwired("listening");
        if (outcome.reason === "connections_unwired") unwired("connections");
        if (outcome.reason === "issue_types_unavailable") {
          // The fallback: Jira's type list could not be read, so nothing was
          // seeded and no type name was invented. Not an error status — the
          // store is exactly as the caller left it, and the reason is named.
          return reply
            .code(200)
            .send({ created: 0, skipped: 0, rules: [], reason: outcome.reason });
        }
        // no_jira_connection / bot_account_unknown: deployment facts an
        // operator can act on (add a Jira connection / run its live test).
        throw conflict(outcome.reason, { projectKey: body.data.projectKey });
      }

      if (outcome.created > 0) {
        await audit(deps, request, `seed:${body.data.projectKey}`, "seeded");
      }
      return reply
        .code(200)
        .send({ created: outcome.created, skipped: outcome.skipped, rules: outcome.rules });
    },
  );

  /**
   * KURALLARDAKİ BOT HESABINI BAĞLANTIDAKİYLE HİZALA.
   *
   * ── HANGİ ARIZAYI KAPATIYOR ─────────────────────────────────────────────
   * Bir dinleme kuralı bot hesabının bir KOPYASINI taşır (`assigneeAccountId`),
   * çünkü tarama o değeri doğrudan JQL'e yapıştırır. Kopya, bağlantının
   * öğrendiği kimlik DEĞİŞTİĞİNDE ayrışır — ve bir kez ayrıştı: Data Center
   * yoklaması kullanıcı adı (`name`, "ugyildiz") yerine iç tutamağı (`key`,
   * "jirauser13506") okuyordu, o değer kurallara tohumlandı, ve JQL `assignee`yi
   * kullanıcı adıyla çözdüğü için her tarama boş döndü. Jira buna hata değil
   * 200 + boş sayfa cevabı verdiği için hiçbir yerde görünmüyordu.
   *
   * `connection-service.ts` düzeltildi ve bağlantı testi `config.botAccountId`i
   * doğru değere çekiyor. Ama mevcut kurallar kendi kopyalarını taşıyor: kod
   * düzelse de bu satırlar düzelmez, ve düzelmezse tarama düzelmiş bir
   * bağlantının yanında hâlâ hiçbir şey bulmaz. Onlarca kuralı elle düzenlemek
   * ise bir çözüm değil.
   *
   * ── NEDEN BİR DÜĞME, NEDEN OTOMATİK DEĞİL ───────────────────────────────
   * Sessiz otomatik yazma YOK, ve bu bilinçli. Bir kuralın hangi ticket'ları
   * aldığı bu kurulumun en görünür davranışı; operatör bakmıyorken onu
   * değiştirmek, düzeltmeye çalıştığımız sessiz-yanlışın ters yönde tekrarı
   * olurdu. Bir SQL migration'ı da yazamazdı: doğru değer hesaplanamaz (tek
   * kaynağı Jira'nın `/myself` cevabı, yani bir ağ çağrısı) ve `jirauser`
   * deseni bir tahmindir — bazı DC kurulumlarında `key` gerçekten kullanıcı
   * adına eşittir.
   *
   * Bu yüzden hizalama operatörün BASTIĞI bir iştir, ve bastığında ne olduğunu
   * GÖRÜR: cevap kaç kuralın hangi kimlikten hangisine taşındığını sayar,
   * denetim kaydı da aynısını yazar.
   *
   * ── NEYE DAYANIR ────────────────────────────────────────────────────────
   * `jirauser` desenine DEĞİL: kaynak, bağlantı testinin Jira'dan canlı olarak
   * öğrendiği `config.botAccountId`. Desen yalnız `/studio/config-health`
   * satırında bir uyarı metni seçer, hiçbir yazmayı yönlendirmez. Böylece
   * desene uymayan bozuk bir kimlik de düzelir, desene uyan doğru bir kullanıcı
   * adı da yanlışlıkla bozulmaz.
   *
   * İDEMPOTENT: zaten doğru olan kurala dokunulmaz, ikinci basış `changed: []`
   * döner. Yetki `WRITE_ROLES` — kural yazabilen kişinin işi — ve bakım kilidi
   * altında `assertWritable` ile durur, çünkü bu gerçek bir yazma.
   */
  app.post(
    "/studio/listening-rules/realign-bot",
    { preHandler: writeHandler },
    async (request, reply) => {
      await assertWritable(deps);
      const { store } = listeningDeps(deps);
      if (deps.connections === undefined) unwired("connections");

      const outcome = await realignRules(store, deps.connections);
      if (!outcome.ok) {
        /**
         * İki adlandırılmış ret, ikisi de operatörün DÜZELTEBİLECEĞİ durumlar:
         *
         *  · `bot_account_unknown` — hiçbir Jira bağlantısı test edilmemiş, yani
         *    yazılacak bir gerçek yok. Yapılacak şey bağlantı testini çalıştırmak.
         *  · `duplicate_listening_rule` — hizalanan kural, aynı tetikleyiciyi
         *    zaten yeni kimlikle taşıyan bir kuralla çakıştı (operatör hem eski
         *    hem yeni kimlikle kural yazmış). Çakışan kuralın id'si söylenir.
         */
        throw conflict(outcome.reason, {
          ...(outcome.reason === "duplicate_listening_rule" ? { ruleId: outcome.ruleId } : {}),
        });
      }

      // Denetim yalnız GERÇEKTEN bir şey değiştiyse: hiçbir kuralı taşımayan bir
      // basış, denetim izinde bir yapılandırma değişikliği gibi görünmemeli.
      if (outcome.changed.length > 0) {
        await deps.audit.append({
          actor: sessionActor(sessionOf(request)),
          action: "PARAM_CHANGED",
          subject: `listening-rule:realign`,
          at: deps.clock.now(),
          meta: {
            surface: "listening",
            verb: "bot_realigned",
            // Kimlikler denetime GİRER ve bu doğru: bir Jira hesap kimliği sır
            // değil (bkz. connections.ts'in aynı kararı), ve "hangi değerden
            // hangisine" olmadan kayıt sorulan soruyu cevaplamıyor.
            accountIdNow: outcome.accountId,
            ruleCount: outcome.changed.length,
            accountIdsWas: [...new Set(outcome.changed.map((c) => c.from))].join(", "),
          },
        });
      }

      return reply.code(200).send({
        accountId: outcome.accountId,
        changed: outcome.changed,
        untouched: outcome.untouched,
      });
    },
  );

  /** Replace a rule by id. */
  app.put("/studio/listening-rules/:ruleId", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_listening_rule_id");
    const body = RuleBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    if ((await store.get(params.data.ruleId)) === null) throw notFound("no_such_listening_rule");

    const record: ListeningRuleRecord = {
      ruleId: params.data.ruleId,
      ...storedRule(body.data as Omit<ListeningRuleRecord, "ruleId">),
    };
    assertPoolExits(record);
    await assertMappedAppsExist(deps, record.repoMap);
    try {
      await store.put(record);
    } catch (error) {
      if (isUniqueViolation(error)) throw badRequest("duplicate_listening_rule");
      throw error;
    }
    await audit(deps, request, params.data.ruleId, "updated");
    return reply.code(200).send({ rule: record });
  });

  /** Delete a rule. */
  app.delete("/studio/listening-rules/:ruleId", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_listening_rule_id");

    const removed = await store.remove(params.data.ruleId);
    if (!removed) throw notFound("no_such_listening_rule");
    await audit(deps, request, params.data.ruleId, "deleted");
    return reply.code(204).send();
  });
}

/** A Postgres unique-constraint violation (Prisma P2002 or a raw 23505). */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "23505";
}

/**
 * The audit row for a listening-rule change. Uses `PARAM_CHANGED` — a listening
 * rule is platform configuration in the same governance category — and carries
 * the rule id and the verb.
 */
async function audit(
  deps: ResolvedDeps,
  request: Parameters<typeof sessionOf>[0],
  ruleId: string,
  verb: string,
): Promise<void> {
  await deps.audit.append({
    actor: sessionActor(sessionOf(request)),
    action: "PARAM_CHANGED",
    subject: `listening-rule:${ruleId}`,
    at: deps.clock.now(),
    meta: { surface: "listening", verb },
  });
}
