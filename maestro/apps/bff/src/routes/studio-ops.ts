import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCsvFileName, auditEventsToCsv, filterAuditEvents } from "../audit-filter.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { RuleIdentityFacts, StatusMapFacts } from "../config-health.js";
import { botAccountIdOf, identityDrift } from "../listening-identity.js";
import { buildConfigFindings, worstSeverity } from "../config-health.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import { pageBody, pageOf, visibleProjects } from "./paging.js";
import { unwired } from "./unwired.js";

/**
 * The operator's half of Studio: what is waiting on a human, what the fleet is
 * doing, what the quota looks like, and what the trail says. The fleet, quota
 * and health screens are M86's admin surface — a developer does not need to
 * know which runner is draining — while the gate board is scoped per project
 * like everything else, because it is a work list rather than an inventory.
 */
export const OPS_ROLES = ["admin", "tech-lead"] as const;

/** Only the trail's own auditors read the whole trail (M33/M86). */
export const AUDIT_ROLES = ["admin", "internal-audit"] as const;

export async function studioOpsRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);
  const opsHandler = [preHandler, requireAnyRole(...OPS_ROLES)];

  /**
   * Open gates — Studio's `notify` board and the same list `list_pending_gates`
   * serves over MCP. Read-only by construction: closing one is a signal
   * (`POST /runs/:ticket/signals/gateDecision`), and there is no method on the
   * gate board that could be mistaken for a decision.
   */
  app.get("/studio/gates", { preHandler }, async (request, reply) => {
    const filter = GateQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");
    const session = sessionOf(request);

    const page = await deps.read.gates.listOpen({
      ...pageOf(request.query),
      ownerGroup: filter.data.ownerGroup ?? null,
      projectKeys: visibleProjects(session),
    });

    // The waiting time is computed here rather than stored: a duration that was
    // written down at open time is wrong by the time anybody reads it.
    const now = deps.clock.now().getTime();
    const items = page.items.map((gate) => ({
      ...gate,
      waitingDays: waitingDays(gate.openedAt, now),
    }));
    return reply.code(200).send(pageBody({ items, nextCursor: page.nextCursor }));
  });

  /** Runner fleet health (M60). Admin surface: it describes the platform, not the work. */
  app.get("/studio/runners", { preHandler: opsHandler }, async (request, reply) => {
    const page = await deps.read.runners.list(pageOf(request.query));
    return reply.code(200).send({
      ...pageBody(page),
      pools: poolsOf(page.items),
    });
  });

  /**
   * Live sandboxes and the workspaces they left behind (M31/M65). Listed here
   * rather than deleted: an idle workspace is archived by the retention job on
   * its own schedule, and a delete button in an operator's hand is how somebody
   * destroys the session a human was mid-way through.
   */
  app.get("/studio/sandboxes", { preHandler: opsHandler }, async (request, reply) => {
    const page = await deps.read.runners.sandboxes(pageOf(request.query));
    return reply.code(200).send(pageBody(page));
  });

  /**
   * The subscription pool and its quota windows (M55). Exposed as accounts
   * rather than a single percentage because the pool is what queues work: one
   * exhausted account with three ready ones is not a platform at 100%.
   */
  app.get("/studio/quota", { preHandler: opsHandler }, async (_request, reply) => {
    const accounts = await deps.read.quota.accounts();
    return reply.code(200).send({ accounts, pool: poolState(accounts) });
  });

  /** Dependency health (M6), beyond the unauthenticated `/readyz` probe. */
  app.get("/studio/health", { preHandler: opsHandler }, async (_request, reply) => {
    const services = await deps.read.health.services();
    // `not_configured` never colours the aggregate: an LLM nobody has set up
    // is a to-do on the settings screen, not a platform that deserves an
    // amber banner — and letting it degrade the overall state would teach
    // operators to ignore that banner, which is how a real outage gets missed.
    const worst = services.some((service) => service.state === "down")
      ? "down"
      : services.some((service) => service.state === "degraded")
        ? "degraded"
        : "healthy";
    return reply.code(200).send({ state: worst, services });
  });

  /**
   * NASIL kurulmuş — yapılandırma teşhisi (`config-health.ts`).
   *
   * `/studio/health`ten AYRI bir uç, ve bu bilinçli bir karar: o uç bir
   * CANLILIK ölçümüdür (probe'lar, 60 sn'de bir, cevabı zamanla değişir), bu
   * ise bir KURULUM gerçeğidir (`.env`'de hangi değişken dolu, sürücü ne
   * yapabiliyor). İkisini tek yanıta katmak `state` toplayıcısını bozardı:
   * yapılandırılmamış bir Jira, kapalı bir Postgres ile aynı kırmızıyı
   * üretirdi — oysa biri bir dosya satırı, diğeri bir kesinti. Ayrıca bu uç
   * veritabanına da bakıyor (varyant denetimi, statü eşlemeleri) ve o okuma
   * canlılık yoklamasının döngüsüne ait değil.
   *
   * Ayrılığın ikinci faydası: `/studio/health` yanıtı BİR HARF DEĞİŞMEDİ, yani
   * mevcut ekran, testler ve alarm kuralları etkilenmedi.
   *
   * KABLOLANMAMIŞ KURULUMDA 503 DEĞİL: eksik bilgiler "bilinmiyor" satırı
   * olarak döner. Bir teşhis ekranının kendisi teşhis edilemez hâle gelirse,
   * kapattığı hata sınıfını yeniden açar.
   */
  app.get("/studio/config-health", { preHandler: opsHandler }, async (_request, reply) => {
    const [clarify, variants] = await Promise.all([
      // Bir okuma hatası "kapalı" DEĞİLDİR: bilinmezliği kapalılık gibi
      // göstermek, operatörü olmayan bir arızayı düzeltmeye gönderirdi.
      settled(deps.clarifyReentryStatus),
      settled(deps.variantModelAudit),
    ]);
    // Kurallar BİR KEZ okunur, iki satırı birden besler. `statusMapFacts` ile
    // ayrı ayrı okumak aynı listeyi iki kez getirir ve — daha kötüsü — iki
    // satırın farklı anlarda okunmuş iki farklı kural kümesini anlatmasına izin
    // verirdi.
    const listening = await listeningFacts(deps);
    const findings = buildConfigFindings({
      deployment: deps.deploymentConfig?.() ?? null,
      intake: deps.commandIntakeStatus?.() ?? null,
      clarify,
      variants,
      statusMaps: listening?.statusMaps ?? null,
      ruleIdentity: listening?.ruleIdentity ?? null,
    });
    return reply.code(200).send({ state: worstSeverity(findings), findings });
  });

  /**
   * TANI RAPORU — sunucuya SSH'lemeden, docker'a girmeden indirilen HTML.
   *
   * Operatörün isteği buydu: "bu scripti uidan göremezmiyim, docker içine
   * girmeden". `./tani.sh`e erişmek bir kabuk, bir SSH anahtarı ve docker
   * yetkisi istiyor — bankada üçü de bir talep formu demek, ve teşhis aracının
   * ulaşılamaz olması onu var olmamış saymakla aynı kapıya çıkıyor.
   *
   * ── NEDEN ADMIN, `opsHandler` DEĞİL ────────────────────────────────────────
   * Ekrandaki yapılandırma TABLOSU tech-lead'e de açık — orada her satır kapalı
   * bir durum ve bir katalog anahtarı. Bu rapor öyle değil: canlı Jira
   * denemelerinin hata gövdelerini, koşu/ticket anahtarlarını ve akış durumunu
   * TEK bir dosyada topluyor, ve o dosya tasarımı gereği e-postayla, destek
   * ticket'ıyla, ekran görüntüsüyle dolaşıyor. Toplanmış hâlin ağırlığı
   * parçaların toplamından fazla, o yüzden gate de daha dar.
   *
   * ── EKSİK OLAN, RAPORUN İÇİNDE SÖYLENİR ────────────────────────────────────
   * Bu rapor `./tani.sh`in ALT KÜMESİ: servis log'ları yok, çünkü BFF bir
   * konteynerin içinde ve kardeş konteynerlerin log'una erişemez (docker
   * soketi bağlı değil ve bağlanmamalı). Eksikliği HTML'in kendi 4. bölümünde
   * adıyla yazılı — üretici öyle kuruyor. Yarım bir rapora bakıp "sorun yok"
   * demek, bu ekranın kapatmaya geldiği hatanın ta kendisi olurdu.
   *
   * 503-by-name, boş sayfa değil: raporu üretemeyen bir kurulumda indirilen boş
   * bir HTML, aynı sessiz-yanlışın daha kötü hâli olurdu.
   */
  app.get(
    "/studio/tani",
    { preHandler: [preHandler, requireAnyRole("admin")] },
    async (_request, reply) => {
      if (deps.taniReport === undefined) unwired("tani");
      const report = await deps.taniReport();
      return reply
        .code(200)
        .header("content-type", "text/html; charset=utf-8")
        // `attachment`: tarayıcıda AÇILMAK yerine inmesi için. Sayfa maskeden
        // geçmiş log ve Jira hata gövdeleri taşıyor, ve bir sekmede açılan
        // sayfa tarayıcı geçmişine yerleşir — indirilen bir dosya, operatörün
        // sildiği zaman gerçekten giden bir eserdir.
        .header("content-disposition", `attachment; filename="${report.fileName}"`)
        // Bir tanı raporu üretildiği ANIN fotoğrafıdır; ara bir vekilin onu
        // saklayıp bir sonraki operatöre eski hâlini vermesi, teşhis aracının
        // verebileceği en yanlış cevap.
        .header("cache-control", "no-store")
        .send(report.html);
    },
  );

  const auditHandler = [preHandler, requireAnyRole(...AUDIT_ROLES)];

  /**
   * The audit trail (M33). Narrower than the rest of the ops surface: the trail
   * records who approved what, so reading all of it is an auditor's privilege
   * rather than an operator's convenience. Filterable by a time window, an
   * exact actor/action and a free-text needle (B13) — the same filter the CSV
   * export honours, so the screen and the file can never disagree.
   */
  app.get("/studio/audit", { preHandler: auditHandler }, async (request, reply) => {
    const filter = AuditQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");

    const page = await deps.read.audit.list({
      ...pageOf(request.query),
      actor: filter.data.actor ?? null,
      subject: filter.data.subject ?? null,
      from: filter.data.from ?? null,
      to: filter.data.to ?? null,
      action: filter.data.action ?? null,
      q: filter.data.q ?? null,
    });
    return reply.code(200).send(pageBody(page));
  });

  /**
   * The regulator export (B13): the SAME filters, but the WHOLE filtered
   * window as one CSV file — the deliberate exception to the paging rule in
   * paging.ts, because a regulator asks for a file, not page one of it. Rows
   * come out in chain order (ascending seq), read through the chain itself so
   * the export can never show a record the trail does not contain.
   */
  app.get("/studio/audit.csv", { preHandler: auditHandler }, async (request, reply) => {
    const filter = AuditQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");

    const events = filterAuditEvents(await deps.audit.read(), filter.data);
    return reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${auditCsvFileName(deps.clock.now())}"`,
      )
      .send(auditEventsToCsv(events));
  });

  /**
   * Recompute the hash chain (M33). A GET because it changes nothing — it
   * recomputes and compares, and a verification that could repair the chain
   * would be a verification nobody should believe.
   */
  app.get(
    "/studio/audit/verification",
    { preHandler: auditHandler },
    async (_request, reply) => {
      const result = await deps.read.audit.verify();
      // 200 either way: "the chain is broken" is a successful answer to the
      // question, and an error status would make a tampered trail look like an
      // endpoint that failed to load.
      return reply.code(200).send(result);
    },
  );
}

const GateQuery = z.object({ ownerGroup: z.string().trim().min(1).max(128).optional() });

const AuditQuery = z.object({
  actor: z.string().trim().min(1).max(256).optional(),
  subject: z.string().trim().min(1).max(256).optional(),
  /** ISO instants, compared lexically against `at`, both bounds inclusive. */
  from: z.string().trim().min(1).max(64).optional(),
  to: z.string().trim().min(1).max(64).optional(),
  action: z.string().trim().min(1).max(128).optional(),
  q: z.string().trim().min(1).max(256).optional(),
});

/** Whole days a gate has been open; floored, because "0 days" is honest on day one. */
export function waitingDays(openedAt: string, now: number): number {
  const opened = Date.parse(openedAt);
  if (Number.isNaN(opened)) return 0;
  return Math.max(0, Math.floor((now - opened) / 86_400_000));
}

/** Per-pool capacity, summed from the runners on this page. */
function poolsOf(
  runners: readonly { pool: string; capacity: number; activeSandboxes: number; state: string }[],
): { pool: string; capacity: number; busy: number; machines: number; unhealthy: number }[] {
  const pools = new Map<string, { pool: string; capacity: number; busy: number; machines: number; unhealthy: number }>();
  for (const runner of runners) {
    const entry = pools.get(runner.pool) ?? {
      pool: runner.pool,
      capacity: 0,
      busy: 0,
      machines: 0,
      unhealthy: 0,
    };
    entry.capacity += runner.capacity;
    entry.busy += runner.activeSandboxes;
    entry.machines += 1;
    if (runner.state === "unreachable" || runner.state === "draining") entry.unhealthy += 1;
    pools.set(runner.pool, entry);
  }
  return [...pools.values()];
}

/**
 * Whether the pool as a whole can still take work (M55). `exhausted` is the
 * state that makes a workflow QUEUE rather than fail, so it is reported as a
 * fact about the pool rather than folded into an average.
 */
function poolState(accounts: readonly { state: string }[]): {
  ready: number;
  cooling: number;
  exhausted: number;
  disabled: number;
  hasCapacity: boolean;
} {
  const count = (state: string): number => accounts.filter((a) => a.state === state).length;
  const ready = count("ready");
  return {
    ready,
    cooling: count("cooling"),
    exhausted: count("exhausted"),
    disabled: count("disabled"),
    hasCapacity: ready > 0,
  };
}

/**
 * Bir isteğe bağlı okuyucunun cevabı, ya da null.
 *
 * Kablolanmamış (`undefined`) ve FIRLATAN okuyucu aynı cevabı veriyor, ve bu
 * doğru: ikisi de "bu gerçeği bilmiyoruz" demek. Fırlatanın 500 olması,
 * veritabanı bir an takıldığı için bütün teşhis ekranını karartırdı — oysa
 * ekranın geri kalan altı satırı hâlâ okunabilir durumda.
 */
async function settled<T>(read: (() => Promise<T>) | undefined): Promise<T | null> {
  if (read === undefined) return null;
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Dinleme kurallarından çıkan İKİ gerçek, TEK okumayla: statü eşlemesi tarafı
 * (kaç kural var, kaçında eşleme dolu) ve bot kimliği tarafı (kuralların
 * taşıdığı kimlik, bağlantının bildiğiyle uyuşuyor mu).
 *
 * Kuralların kendisinden sayılıyor, ayrı bir sayaçtan değil: bir sayaç
 * kurallarla ayrışabilir ve ekran "eşleme var" derken hiçbir ticket kıpırdamaz.
 * Depo kablolanmamışsa null — 503 değil, çünkü bu ekranın tek bir satırı.
 */
async function listeningFacts(
  deps: ResolvedDeps,
): Promise<{ statusMaps: StatusMapFacts; ruleIdentity: RuleIdentityFacts } | null> {
  if (deps.listening === undefined) return null;
  try {
    const rules = await deps.listening.list();

    /**
     * Bağlantıların öğrendiği bot kimliği — kural kimliğinin kıyaslanacağı
     * gerçek. Bağlantı deposu kablolanmamış ya da okunamıyorsa `null`, ve bu
     * "kimlikler ayrışık" DEĞİL "kıyaslanamadı" demek: `identityDrift` o
     * durumda hiçbir fark İDDİA ETMEZ, yalnız `jirauser` desenini sayar.
     */
    const botAccountId =
      deps.connections === undefined
        ? null
        : await deps.connections
            .list()
            .then((connections) => botAccountIdOf(connections))
            .catch(() => null);

    const drift = identityDrift(rules, botAccountId);

    return {
      statusMaps: {
        ruleCount: rules.length,
        mappedRuleCount: rules.filter(
          (rule) => rule.statusMap != null && Object.keys(rule.statusMap).length > 0,
        ).length,
      },
      ruleIdentity: {
        ruleCount: rules.length,
        staleRuleCount: drift.staleRuleCount,
        staleAccountCount: drift.staleAccountIds.length,
        internalKeyRuleCount: drift.internalKeyRuleCount,
        connectionKnown: drift.connectionAccountId !== null,
      },
    };
  } catch {
    return null;
  }
}
