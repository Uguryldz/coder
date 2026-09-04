import {
  AnalysisDoc,
  NonEmpty,
  PublishTarget,
  type RiskTier,
  type TicketKey,
} from "@maestro/contracts";
import { renderAnalysisMarkdown } from "@maestro/publish";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { AnalysisRewriteContext } from "../activities.js";
import { priorWorkNote, readHumanComments } from "./comments.js";
import type { ActivityDeps, RunContext } from "./deps.js";
import { guardModelCall, resolveOutcome } from "./outcome.js";
import { analystPersona } from "./persona.js";
import { activitySeq, audit, record } from "./record.js";

/**
 * Steps 3ö and 3: read-only repo discovery and the analysis document.
 *
 * The analysis is the one artefact a human gate judges, so everything here is
 * fail-closed: a document that misses a section, names the wrong template
 * version (M83) or is written in the wrong language never reaches step 4.
 */

export const DiscoveryDigest = z.object({
  files: z.number().int().nonnegative(),
  modules: z.array(NonEmpty).max(200),
});

/** M18/M97: the analysis cannot be written by a human inside this activity. */
export const AI_ASSIST_REQUIRED = "AiAssistRequired";

function aiAssistRequired(what: string, messageKey: string): ApplicationFailure {
  return ApplicationFailure.create({
    message: `${what} needs a human in ai-assist mode: ${messageKey}`,
    type: AI_ASSIST_REQUIRED,
    nonRetryable: true,
  });
}

/**
 * Step 3ö — a read-only session in the PRIMARY application's repo (M100). The
 * session's resume token is kept: step 6a continues the same conversation
 * rather than re-reading the repository (M30).
 */
export async function discoverRepo(
  deps: ActivityDeps,
  ticket: TicketKey,
  appId: string,
): Promise<{ files: number; modules: string[] }> {
  const run = await deps.runs.get(ticket);

  /**
   * No checkout, no discovery.
   *
   * `workspacePath` is empty for a run whose repository could not be cloned —
   * no token, a private repo, a network that refuses. Opening a session on an
   * empty path would either read the worker's own working directory or fail
   * three activity retries deep; neither is a repository the ticket is about.
   *
   * Skipping is the correct answer rather than a workaround: the analysis is
   * WORSE without a repository, not wrong. It is what the pilot has always
   * produced, and the alternative — failing the run — turns a degraded
   * analysis into no analysis at all.
   */
  if (run.workspacePath.trim() === "") return { files: 0, modules: [] };

  /**
   * A session backend that cannot run is the same answer as one that refuses.
   *
   * `agentSession` THROWS for a runner that is absent or misconfigured — no
   * CLI on the host, a seat that is not logged in — while a policy refusal
   * comes back as a value `resolveOutcome` turns into `degraded`. The two are
   * the same fact for this step: there is no session, so there is no
   * discovery. Letting the throw escape would fail the whole run over an
   * optional reading pass, three retries deep, with a message about an agent
   * runner on a ticket nobody asked to be coded.
   *
   * Narrow on purpose: only the session call is guarded. Everything after it —
   * the digest, the context write — must still fail loudly, because those are
   * steps whose absence would silently change what the analyst is told.
   */
  const session = await agentSessionOrNull(deps, run, ticket, appId);
  if (session === null) return { files: 0, modules: [] };

  const explored = await resolveOutcome(deps, run, "discovery", session);
  if (explored.status === "degraded") return { files: 0, modules: [] };

  return finishDiscovery(deps, run, ticket, appId, explored.value);
}

/** The session, or `null` when this deployment has no way to open one. */
async function agentSessionOrNull(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
): Promise<Awaited<ReturnType<ActivityDeps["llm"]["agentSession"]>> | null> {
  try {
    return await openSession(deps, run, ticket, appId);
  } catch {
    return null;
  }
}

function openSession(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
): ReturnType<ActivityDeps["llm"]["agentSession"]> {
  return deps.llm.agentSession({
    workspacePath: run.workspacePath,
    task: deps.translate(run.locale, "agent.discovery_task", { ticket, appId }),
    /**
     * No MCP server for the discovery pass.
     *
     * Reading a checkout is what the agent's own file tools already do, and
     * `@maestro/mcp-servers`' workspace server has no runnable entry point —
     * asking for it made every deployment fail with "mcpServers were requested
     * but no --mcp-config path was given", which reads as a configuration
     * mistake rather than as a server nobody starts.
     *
     * The engineering turn is where an MCP surface earns its keep: it needs
     * tools the CLI does not ship (the platform's own read model, the ticket).
     * This step needs a directory, and it has one.
     */
    mcpServers: [],
    dataClass: run.dataClass,
    variantId: run.variantId,
  });
}

/** Digest what the session found, and record it. */
async function finishDiscovery(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
  explored: { resumeToken: string; finalText: string },
): Promise<{ files: number; modules: string[] }> {
  await deps.runs.patch(ticket, { resumeToken: explored.resumeToken });
  const digest = await guardModelCall(deps, run, "discovery-digest", () =>
    deps.llm.generateObject(
      {
        role: "analyst",
        variantId: run.variantId,
        dataClass: run.dataClass,
        schemaName: "repo-discovery",
        input: { appId, findings: explored.finalText },
      },
      DiscoveryDigest,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "discovery-digest", digest);
  const value = resolved.status === "degraded" ? { files: 0, modules: [] } : resolved.value;
  await record(deps, run, {
    kind: "discovery",
    actor: "ai",
    title: "repo keşfi",
    detail: `${value.files} dosya · ${value.modules.length} modül`,
    key: "discovery",
  });
  return { files: value.files, modules: [...value.modules] };
}

/** M83/M59: the pinned template and the project's language are not negotiable. */
function assertDocument(run: RunContext, doc: AnalysisDoc): void {
  if (doc.templateVersion !== run.templateVersion) {
    throw ApplicationFailure.create({
      message: `analysis used template ${doc.templateVersion}, the run is pinned to ${run.templateVersion}`,
      type: "AnalysisTemplateMismatch",
      nonRetryable: true,
    });
  }
  if (doc.language !== run.locale) {
    throw ApplicationFailure.create({
      message: `analysis is in "${doc.language}", the project's language is "${run.locale}"`,
      type: "AnalysisLanguageMismatch",
      nonRetryable: true,
    });
  }
}

/**
 * YENİDEN YAZIM BAĞLAMI — analizin ikinci (ve üçüncü, ve dördüncü) turunda
 * modelin görmesi gereken şey.
 *
 * ── NEDEN VAR ───────────────────────────────────────────────────────────────
 * Operatörün kendi cümlesi: "ben yorum yazsam da yazmasam da, geri gönderince
 * tekrar incelesin, bağlam kaybı olmasın diye geçmiş var zaten". Kapıdan
 * `analysisapproval → analiz` geri göndermesi "yeniden incele" demek, ve
 * yeniden inceleme AYNI GİRDİYLE yapılırsa aynı belgeyi üretir — operatör iki
 * tur sonunda hiçbir şeyin değişmediğini görür, ki bu geri göndermenin
 * kendisini işlevsiz kılar.
 *
 * `intake.ts`'in `runIntake`'i bu dersi çoktan almış: netleştirme cevapları
 * yorumlarda duruyor, snapshot'ta değil, ve onlarsız ikinci tur aynı soruyu
 * tekrar soruyor. Analiz tarafında aynı gerekçe geçerliydi ama uygulanmamıştı:
 * `writeAnalysis` modele YALNIZ `summary` + `description` gönderiyordu.
 *
 * ── ÜÇ ALAN, ÜÇ FARKLI SORUNUN CEVABI ───────────────────────────────────────
 *  · `reason`   — "neden geri geldi": kapıda yazılmış gerekçe, VARSA. Statüyle
 *                 verilen bir geri gönderme gerekçesiz gelir ve bu normaldir.
 *  · `comments` — "ne konuşuldu": operatör gerekçeyi kapı alanına değil,
 *                 ticket'a yorum olarak yazmış olabilir; çoğu zaman öyle yazar.
 *                 `reason` boşken TEK bağlam kaynağı budur.
 *  · `previous` — "daha önce ne yazmıştım": önceki analizin KENDİSİ değil, onu
 *                 tanımlayan kısa kimlik (risk katmanı + gerekçesi + kabul
 *                 kriterleri). Aşağıda gerekçesi var.
 *
 * ÜÇÜ DE OPSİYONEL, ve hiçbiri yoksa çağrı bugünkü davranışını bit bit korur —
 * ilk tur (`ticket-workflow.ts:394`) bağlamsız çağırır ve öyle kalmalı: ortada
 * yeniden yazılan bir şey yok.
 */
export type { AnalysisRewriteContext } from "../activities.js";

/** Yeniden yazım bloğunun prompt içindeki başlığı. */
export const REWRITE_NOTE_TITLE = "--- Bu analiz YENİDEN yazılıyor ---";

/**
 * ÖNCEKİ ANALİZDEN NE GİDER, VE NEDEN TAMAMI DEĞİL.
 *
 * Belgenin tamamını geri göndermek cazip ama yanlış: yedi bölümlük bir
 * `AnalysisDoc` promptun en uzun parçası olurdu ve modele kendi çıktısını
 * kopyalayacak bir şablon vermiş olurduk — istenen şey yeniden DÜŞÜNMEK,
 * yeniden BİÇİMLENDİRMEK değil. Aynı belgenin geri gelmesi zaten operatörün
 * şikâyet ettiği şeydi.
 *
 * Giden üç şey, "bunu daha önce şöyle değerlendirmiştim" cümlesini kurmaya
 * yetecek en küçük küme: risk katmanı, o katmanın GEREKÇESİ (modelin kendi
 * muhakemesinin özeti) ve kabul kriterleri (operatörün en sık "eksik" dediği
 * bölüm — `workflow-gate-return.test.ts`'in senaryosu bile "kabul kriterleri
 * eksik"). Kriterler de ilk beşle sınırlı: onuncu kriter ikinci turda neyin
 * eksik olduğunu anlatmaz, promptu uzatır.
 */
function previousNote(previous: AnalysisDoc): string {
  const criteria = previous.acceptanceCriteria.slice(0, 5).map((c) => `  - ${c}`);
  return [
    `Önceki analiz — risk: ${previous.riskTier} (${previous.riskReason})`,
    "Önceki kabul kriterleri:",
    ...criteria,
  ].join("\n");
}

/**
 * Yeniden yazım bağlamını modele giden TEK bir metin bloğuna çevirir; bağlam
 * boşsa `undefined` döner ve prompt'a hiç alan eklenmez.
 *
 * Tek blok, çünkü `withComments`'in gerekçesiyle aynı: bu metnin tamamı insan
 * yazısı ya da modelin kendi eski çıktısı, yani VERİ — talimat değil. Tek bir
 * alanda toplanması, gateway'in enjeksiyon çitinin hepsine birden uygulanmasını
 * sağlar; üç ayrı alan üç ayrı çit demek olurdu.
 */
export function rewriteNote(context: AnalysisRewriteContext | undefined): string | undefined {
  if (context === undefined) return undefined;
  const parts: string[] = [];
  const reason = (context.reason ?? "").trim();
  if (reason !== "") parts.push(`Geri gönderme gerekçesi: ${reason}`);
  if (context.previous !== undefined) parts.push(previousNote(context.previous));
  const comments = context.comments ?? [];
  if (comments.length > 0) {
    parts.push(
      ["Ticket üzerindeki insan yorumları:", ...comments.map((c) => `  - ${c.author}: ${c.text}`)].join(
        "\n",
      ),
    );
  }
  // Hiçbir parça yoksa alan HİÇ gitmez. Boş bir "yeniden yazılıyor" başlığı
  // modele "bir şey değişti" der ve neyin değiştiğini söylemez — gürültü.
  if (parts.length === 0) return undefined;
  return [REWRITE_NOTE_TITLE, ...parts].join("\n");
}

/**
 * Yorumları OKUYAN taraf, ve neden burada okunuyor.
 *
 * Yorum okumak bir I/O — Jira'ya gider. Workflow kodu I/O yapamaz (determinizm),
 * dolayısıyla `ticket-workflow.ts` bunu geçiremezdi; geçirebilseydi bile
 * geçirmemeliydi: okuma zamanı ÖNEMLİ. Operatör kapıda "geri gönder" dedikten
 * SONRA da yorum yazabilir, ve aktivite çalıştığı anda okumak o yorumu da
 * yakalar. Workflow'un elindeki (kapı kararı anındaki) bir liste yakalayamazdı.
 *
 * Yalnız bir YENİDEN YAZIM için okunur (`rewrite !== undefined`). İlk turda
 * ticket'ta zaten yorum yoktur ya da varsa da talebin parçasıdır ve
 * `description`'da durur; her analiz çağrısına bir Jira okuması eklemek bedelini
 * çıkarmayan bir yavaşlama olurdu.
 *
 * `readHumanComments` ATMAZ (bkz. `comments.ts`): Jira 5xx verirse liste boş
 * döner, uyarı satırı yazılır ve analiz `reason` + `previous` ile devam eder.
 * Çağıran açıkça bir liste verdiyse ona dokunulmaz — testin ve pilotun kendi
 * listesini enjekte edebilmesi için.
 */
async function withReadComments(
  deps: ActivityDeps,
  ticket: TicketKey,
  rewrite: AnalysisRewriteContext | undefined,
): Promise<AnalysisRewriteContext | undefined> {
  if (rewrite === undefined || rewrite.comments !== undefined) return rewrite;
  return {
    ...rewrite,
    // Uyarı satırı "analiz" der, "intake" değil: bu adım başarısız okumada
    // operatörü kendi adımına baksın diye.
    comments: await readHumanComments(deps, ticket, undefined, "analiz"),
  };
}

/**
 * Step 3. The risk tier is the DOCUMENT's, never a parameter and never a
 * default: it is the reason the analysis is read before the gates are chosen
 * (M51). `AnalysisDoc` is `.strict()` with seven required sections, so a
 * partial answer fails here instead of at a human's desk.
 *
 * `rewrite` OPSİYONEL ve bir REPLAY meselesi: bu bir Temporal aktivitesi ve
 * sahada kapıda bekleyen koşular var. Yeni argüman workflow'un komut DİZİSİNİ
 * değiştirmiyor — aynı sırada aynı aktiviteler, aynı `activityId` — yalnız
 * yeni zamanlamaların taşıdığı payload'a bir alan ekliyor. `openGate`'in
 * `gateStatuses` eklemesiyle birebir aynı şekil ve aynı gerekçe
 * (`activities.ts`).
 */
export async function writeAnalysis(
  deps: ActivityDeps,
  ticket: TicketKey,
  appId?: string,
  rewrite?: AnalysisRewriteContext,
): Promise<{ analysis: AnalysisDoc; risk: RiskTier }> {
  const run = await deps.runs.get(ticket);
  const snapshot = await deps.work.getTicket(ticket);
  const note = rewriteNote(await withReadComments(deps, ticket, rewrite));
  // Önceki koşuların özeti — `run` üzerinde geliyor, yani bir aktivite daha
  // eklemeden (bkz. `RunContext.priorWork`). `intake.ts` ile AYNI metni
  // üretir (`priorWorkNote`): iki adımın gördüğü geçmiş ayrışmamalı.
  const priorNote = priorWorkNote(run.priorWork);
  // Studio'nun "Ajan tanımları" ekranında bu analist ajanı için yazılmış
  // persona, varsa. `input`'un İLK alanı olarak gidiyor: rol talimatı,
  // uygulanacağı verinin önünde okunmalı — pilot da personayı analiz bağlamının
  // ilk bilgi notu yapıyor.
  const persona = await analystPersona(deps, run);
  // The auth guard is what keeps a rejected model key from retrying this
  // activity in silence for days (see `guardModelCall`).
  const outcome = await guardModelCall(deps, run, "analysis", () =>
    deps.llm.generateObject(
      {
        role: "analyst",
        variantId: run.variantId,
        dataClass: run.dataClass,
        schemaName: "analysis-doc",
        input: {
          ...(persona === undefined ? {} : { persona }),
          // `appId` is the ONLY repo-derived fact in this prompt — everything
          // else (locale, template pin, the ticket's own text) holds without a
          // repository. An analysis-only run omits it rather than sending a
          // blank, so the analyst is never told the application is named "".
          ...(appId === undefined ? {} : { appId }),
          locale: run.locale,
          templateVersion: run.templateVersion,
          summary: snapshot.summary,
          description: snapshot.description,
          // Ticket metninin ARDINDAN: "şunu analiz et" önce gelir, "ve şu
          // sebeple bir daha bak" sonra. Ters sırada, geri gönderme gerekçesi
          // analiz edilecek talep sanılabilirdi.
          ...(note === undefined ? {} : { rewrite: note }),
          /**
           * ÖNCEKİ DENEMELER — koşu öldü ve yeniden başladıysa, orada ne oldu.
           *
           * `rewrite`ten AYRI bir alan, çünkü ayrı bir olgu: `rewrite` AYNI
           * koşunun ikinci turu ("operatör geri gönderdi"), bu ise ÖNCEKİ
           * koşunun işi ("koşu düştü, yenisi başladı"). İkisi aynı anda da
           * olabilir — düşüp yeniden başlayan bir koşu da kapıdan geri
           * gönderilebilir — ve tek alanda birleştirmek, modele hangisinin
           * hangisi olduğunu söylememek olurdu.
           *
           * En SONDA: en güncel bağlam (ticket metni, sonra geri gönderme
           * gerekçesi) önce okunur, tarih en sonda. Bir çelişkide güncelin
           * kazanması gereken sıra bu.
           *
           * `null` (ilk koşu, ezici çoğunluk) → alan HİÇ gitmez ve prompt bit
           * bit bugünküyle aynı kalır.
           */
          ...(priorNote === undefined ? {} : { priorWork: priorNote }),
        },
      },
      AnalysisDoc,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "analysis", outcome);
  if (resolved.status === "degraded") throw aiAssistRequired("analysis", resolved.messageKey);

  const analysis = AnalysisDoc.parse(resolved.value);
  assertDocument(run, analysis);
  await deps.runs.patch(ticket, { risk: analysis.riskTier });
  await record(deps, run, {
    kind: "analysis",
    actor: "ai",
    title: "analiz yazıldı",
    detail: `risk: ${analysis.riskTier} — ${analysis.riskReason}`,
    // A rewrite after a rejection can legitimately land on the same tier and
    // the same criteria count; keying on the document's shape would hide the
    // second version behind the first.
    key: `analysis:${activitySeq()}`,
  });
  return { analysis, risk: analysis.riskTier };
}

/** Step 3, publication (M47): the same document on every configured target. */
export async function publishAnalysis(
  deps: ActivityDeps,
  ticket: TicketKey,
  analysis: AnalysisDoc,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  const targets = z
    .array(PublishTarget)
    .min(1)
    .parse(await deps.params.publishTargets(run.runId, "analysis"));
  const markdown = renderAnalysisMarkdown(analysis, {
    translate: deps.translate,
    locale: run.locale,
    runId: run.runId,
    ticketKey: ticket,
  });
  // Idempotent by construction on the driver side (M75 bookkeeping), and by
  // the guard here: a retry must not post the analysis to Jira twice.
  const receipts = await deps.idempotency.once(`${run.runId}:publish:analysis`, () =>
    deps.publish.publish({ runId: run.runId, doc: "analysis", targets, locale: run.locale }, markdown),
  );
  await record(deps, run, {
    kind: "analysis",
    title: "analiz yayımlandı",
    detail: receipts.map((r) => `${r.target}:${r.ref}`).join(", "),
    key: "publish-analysis",
  });
}

/**
 * M100 fan-out: every OTHER application the impact matrix marks as impacted
 * gets a child ticket in the parent's project. The assignment comes from the
 * analysis, not from a rule lookup — the matrix is the decision.
 */
export async function fanOutChildren(
  deps: ActivityDeps,
  ticket: TicketKey,
  analysis: AnalysisDoc,
): Promise<TicketKey[]> {
  const run = await deps.runs.get(ticket);
  // The filter excludes the PRIMARY application — the parent ticket already is
  // its work item. An analysis-only run has no primary application, so there
  // is no self to exclude: every impacted cell the matrix names is "another"
  // application, and each honestly gets its child ticket.
  const impacted = analysis.impactMatrix
    .filter((cell) => cell.impacted && (run.app === null || cell.appId !== run.app.appId))
    .sort((a, b) => a.appId.localeCompare(b.appId));

  const children: TicketKey[] = [];
  for (const cell of impacted) {
    const created = await deps.idempotency.once(`${run.runId}:fanout:${cell.appId}`, () =>
      deps.work.createLinkedIssue(ticket, {
        summary: deps.translate(run.locale, "jira.child_summary", { ticket, app: cell.appId }),
        description: cell.summary,
        labels: ["maestro", `app:${cell.appId}`],
      }),
    );
    children.push(created.key);
    await audit(deps, run, {
      action: "ASSIGN_APP",
      subject: created.key,
      meta: { via: "analysis_fanout", appId: cell.appId, parentTicketKey: ticket },
      key: `fanout:${cell.appId}`,
    });
  }
  return children;
}
