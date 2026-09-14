import { AppId } from "@maestro/contracts";
import {
  AnalysisDoc,
  type DiscoveryStamp,
  ImplementationPlan,
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
import { analystGuidance } from "./guidance.js";
import { ticketAttachments } from "./attachments.js";
import { analysisInstructions, analysisRules, briefRules, planRules } from "./analysis-template.js";
import { discoveryNotes, loadDiscoveryStamp, storeAnalysis, storeDiscoveryStamp } from "./brief.js";
import { analystPersona, roleVariantId, trainingFor } from "./persona.js";
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
  /**
   * The analysis-agent brief's findings, kept as text: requirement → file:line,
   * what nothing answers, scale-risk traces (N+1, sync transaction, timeouts,
   * pools, prior volume tests), candidate files, existing endpoints/DTOs. Goes
   * to the journal, where the analyst and the planner read it (`brief.ts`).
   */
  notes: z.string().max(12000).default(""),
});

/** What the digest call is told to keep from the discovery session's final text. */
const DISCOVERY_DIGEST_RULES: readonly string[] = [
  "'files' ve 'modules': keşif metninde sayılan dosya sayısı ve modül/paket adları.",
  "'notes': keşif metnindeki bulguları KAYBETMEDEN özetle — her gereksinim için kod karşılığı (dosya:satır), karşılığı olmayanlar, ölçek riski izleri (döngü içinde HTTP/DB çağrısı, tek senkron istek/transaction, timeout/pool/payload limitleri, daha önce hangi hacimle test edildiği), aday dosyalar, mevcut endpoint ve DTO'lar, kapsam seçenekleri ve açık sorular.",
  "Keşif metninde geçmeyen bir dosya yolu, endpoint ya da sayı YAZMA. Metin boşsa 'notes' boş kalır.",
];

/** M18/M97: the analysis cannot be written by a human inside this activity. */
export { AI_ASSIST_REQUIRED } from "../failure-types.js";
import { AI_ASSIST_REQUIRED } from "../failure-types.js";

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
  /**
   * ── ÇALIŞMA ALANI GERÇEKTEN YERİNDE Mİ ───────────────────────────────────
   *
   * Bu kontrol bir dönem yalnız `workspacePath` BOŞ MU diye bakıyordu ve o,
   * klonun koşu boyunca yerinde durduğu varsayımına dayanıyordu. Varsayım
   * sahada yıkıldı: `/workspace` bir tmpfs birimidir ve konteyner her yeniden
   * başladığında SİLİNİR — bir sürüm yükseltmesi, bir çökme, bir
   * `docker compose up` yeter.
   *
   * O zaman koşu satırı hâlâ bir yol taşıyor (dolu, `present: true`) ama dizin
   * YOK. Kontrol farkı göremiyor, ajan oturumu var olmayan bir dizinde
   * açılıyor ve künye "okunamadı" diyordu. Operatörün gördüğü tek şey "analiz
   * ticket metninden üretildi, kod karşılığı yok" oluyordu — sebebi söyleyen
   * tek satır olmadan, üstelik HER yeniden başlatmadan sonra.
   *
   * Artık adım kodu okumadan önce çalışma alanını VAR EDİYOR: yerindeyse
   * dokunmaz, silinmişse yeniden klonlar. Yetenek sunulmayan bir kurulumda
   * (klonlamayan sürücü) eski davranışa düşülür.
   */
  const ensured = await ensureWorkspaceOrKeep(deps, run, ticket, appId);
  if (ensured !== null && ensured !== run.workspacePath) {
    await deps.runs.patch(ticket, { workspacePath: ensured });
  }
  // Bu adımın geri kalanı YOLU okur; koşu satırı yamandı ama eldeki nesne
  // değişmedi, o yüzden yerel bir görünüm tutuluyor.
  const workspacePath = ensured ?? run.workspacePath;

  if (workspacePath.trim() === "") {
    // CANLI BULGU: no WORKSPACE_ROOT → no clone → discovery answered "0 dosya"
    // and nobody could tell it never looked. Say so.
    await record(deps, run, {
      kind: "discovery",
      actor: "system",
      title: "repo keşfi yapılamadı",
      detail: `${appId} için çalışma alanı yok (klon açılmamış): BFF'te WORKSPACE_ROOT ayarlı mı ve depo erişimi var mı kontrol edin — analiz keşifsiz (kod karşılığı ve plan olmadan) devam ediyor.`,
      key: "discovery:no-workspace",
    });
    // Deftere yazılan cümlenin makine-okunur ikizi: belge "OKUNAMADI: çalışma
    // alanı yok" der ve operatör bunu ilk bakışta görür.
    await stamp(deps, run, appId, { read: false, note: "çalışma alanı yok (klon açılmamış)" });
    return { files: 0, modules: [] };
  }

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
  const session = await agentSessionOrNull(deps, run, ticket, appId, workspacePath);
  if (session === null) {
    await stamp(deps, run, appId, { read: false, note: "depo oturumu açılamadı (ajan sürücüsü ya da depo erişimi)" });
    return { files: 0, modules: [] };
  }

  const explored = await resolveOutcome(deps, run, "discovery", session);
  if (explored.status === "degraded") {
    // Politika reddi de "okunmadı"nın bir hâli: oturum açıldı ama bulgu yok.
    await stamp(deps, run, appId, { read: false, note: "keşif oturumu kısıtlandı (politika/kota) — bulgu alınamadı" });
    return { files: 0, modules: [] };
  }

  return finishDiscovery(deps, run, ticket, appId, explored.value);
}

/**
 * KEŞİF KÜNYESİ — üç çıkışın da geçtiği TEK yer.
 *
 * `discoverRepo`'nun üç çıkışı var (çalışma alanı yok / oturum kurulamadı /
 * başarılı) ve üçü de künye üretir; `read` alanı farkı söyler. Künye YENİ bir
 * bilgi toplamaz: depo adı çalışmanın kendi bağlamından (`run.app`), dal
 * `run.targetBranch`'ten, sayılar zaten deftere yazılan digest'ten gelir —
 * yani ekstra bir Jira/git/SCM çağrısı YOK.
 *
 * Depo adı `<adoProject>/<adoRepo>`: operatörün SCM'de gördüğü ad budur.
 * Kayıt okunamıyorsa (deposuz koşu, eski satır) `appId`'ye düşer — "hangi
 * depo" sorusunun cevapsız kalmasındansa kaba bir cevabı yeğdir.
 */
async function stamp(
  deps: ActivityDeps,
  run: RunContext,
  appId: string,
  found: { read: boolean; files?: number; modules?: readonly string[]; note?: string },
): Promise<void> {
  const app = run.app;
  const built: DiscoveryStamp = {
    repo: app === null ? appId : `${app.adoProject}/${app.adoRepo}`,
    branch: run.targetBranch.trim(),
    files: found.files ?? 0,
    modules: [...(found.modules ?? [])].slice(0, 50),
    read: found.read,
    note: (found.note ?? "").slice(0, 300),
  };
  await storeDiscoveryStamp(deps, run, built);
}

/** The session, or `null` when this deployment has no way to open one. */
async function agentSessionOrNull(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
  /** Adımın VAR ETTİĞİ dizin — bkz. `openSession`. */
  workspacePath: string,
): Promise<Awaited<ReturnType<ActivityDeps["llm"]["agentSession"]>> | null> {
  try {
    return await openSession(deps, run, ticket, appId, workspacePath);
  } catch (error) {
    // CANLI BULGU: the agent driver was not wired (no CLAUDE_BIN_PATH) and every
    // run answered "0 dosya" without a word — the operator could not tell a
    // repository that was read from one that was never opened. The journal
    // says it now, and says what to fix.
    /**
     * ── CLI KOLTUĞU YOKSA KOD YİNE DE OKUNUR ────────────────────────────────
     *
     * Bu dal bir dönem doğrudan "yapılamadı" yazıp dönüyordu ve o, CLI
     * oturumunun TEK okuma yolu olduğu varsayımına dayanıyordu. Varsayım
     * sahada yanlış çıktı: GPT-OSS (ya da başka bir HTTP modeli) ile çalışan
     * bir kurulumda `CLAUDE_BIN_PATH` yoktur, `agentSession` atar ve analiz
     * KOD GÖRMEDEN üretilir — oysa kod diskte, klon zinciri çalışmıştır.
     *
     * Eksik olan tek şey dosyaları modele taşıyacak yoldu. `readWorkspaceDigest`
     * onu verir: dizin ağacı + seçilmiş dosya içerikleri metin olarak okunur ve
     * HTTP modeli o metinle çalışır.
     *
     * CLI oturumunun yerine geçmez (o, dosyaları kendi araçlarıyla gezer; bu,
     * sabit bir özet sunar) ama "kod görmeden analiz" ile "sınırlı da olsa kodu
     * okumuş analiz" arasındaki fark, şikayetin tamamıdır.
     */
    const digest = await workspaceDigestOrNull(deps, run, appId);
    if (digest !== null) return digest;

    await record(deps, run, {
      kind: "discovery",
      actor: "system",
      title: "repo keşfi yapılamadı",
      detail: `${appId} deposu açılamadı: ${String(error).slice(0, 300)} — analiz keşifsiz (kod karşılığı ve plan olmadan) devam ediyor. Ajan sürücüsü (CLAUDE_BIN_PATH) ya da çalışma alanı okuyucusu ve depo erişimini kontrol edin.`,
      key: "discovery:unavailable",
    });
    return null;
  }
}

/**
 * CLI oturumu açılamadığında dosyaları okuyup bir oturum SONUCU gibi döndürür.
 *
 * Dönen şekil `agentSession`ınkiyle aynı olmak ZORUNDA: çağıran iki yolu
 * ayırmamalı, yoksa "hangi yoldan okundu" sorusu her adıma sızar. Fark tek bir
 * yerde görünür — defterdeki satır, hangi yolun kullanıldığını söyler.
 */
async function workspaceDigestOrNull(
  deps: ActivityDeps,
  run: RunContext,
  appId: string,
): Promise<Awaited<ReturnType<ActivityDeps["llm"]["agentSession"]>> | null> {
  const read = deps.scm.readWorkspaceDigest?.bind(deps.scm);
  if (read === undefined) return null;
  try {
    const digest = await read({ workspacePath: run.workspacePath });
    if (digest === null || digest.files.length === 0) return null;
    await record(deps, run, {
      kind: "discovery",
      actor: "system",
      title: "repo CLI'sız okundu",
      detail:
        `${appId}: ajan CLI koltuğu yok, depo doğrudan okundu — ${String(digest.files.length)} dosya` +
        `${digest.truncated ? " (özet kırpıldı)" : ""}. Analiz kod tabanını görüyor.`,
      key: "discovery:digest",
    });
    const body = `${digest.tree}\n\n${digest.files.map((f) => `--- ${f.path} ---\n${f.text}`).join("\n\n")}`;
    return { status: "ok", value: { resumeToken: "", finalText: body }, log: null } as never;
  } catch {
    return null;
  }
}

/**
 * Çalışma alanını var eder; dokunamıyorsa `null` döner (çağıran eski yola düşer).
 *
 * Yeniden klonlama SESSİZ değil: deftere yazılır, çünkü "analizim neden bu
 * kadar sürdü" ve "klon neden iki kez açıldı" sorularının cevabı burasıdır.
 */
async function ensureWorkspaceOrKeep(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
): Promise<string | null> {
  const ensure = deps.scm.ensureWorkspace?.bind(deps.scm);
  if (ensure === undefined) return null;
  try {
    const path = await ensure({
      runId: run.runId,
      appId,
      ...(run.targetBranch === undefined || run.targetBranch === null ? {} : { targetBranch: run.targetBranch }),
    });
    if (path !== null && path !== run.workspacePath) {
      await record(deps, run, {
        kind: "discovery",
        actor: "system",
        title: "çalışma alanı yeniden açıldı",
        detail: `${appId} klonu diskte yoktu (çalışma alanı geçici bir birimdir ve servis yeniden başlayınca silinir) — keşiften önce yeniden klonlandı.`,
        key: "discovery:reclone",
      });
    }
    return path;
  } catch (error) {
    await record(deps, run, {
      kind: "discovery",
      actor: "system",
      title: "çalışma alanı açılamadı",
      detail: `${appId} yeniden klonlanamadı: ${String(error)} — analiz keşifsiz sürüyor.`,
      key: "discovery:reclone-failed",
    });
    return null;
  }
}

async function openSession(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
  /**
   * Oturumun açılacağı dizin — koşu satırındaki yol DEĞİL, adımın az önce VAR
   * ETTİĞİ yol. İkisi ayrışabilir: çalışma alanı geçici bir birimdir ve servis
   * yeniden başlayınca silinir, o zaman adım yeniden klonlar ve yeni yolu bu
   * parametreyle taşır. Satırdaki eski yolu okumak, oturumu var olmayan bir
   * dizinde açmak olurdu — sahada tam olarak bu oluyordu.
   */
  workspacePath: string,
): ReturnType<ActivityDeps["llm"]["agentSession"]> {
  return deps.llm.agentSession({
    workspacePath,
    // The analysis agent's TRAINING (its Studio persona, else the shipped
    // text) leads; the task line below it names the ticket and the repo.
    task: `${await trainingFor(deps, run, "analyst")}\n\n${deps.translate(run.locale, "agent.discovery_task", { ticket, appId })}`,
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
        input: { appId, rules: DISCOVERY_DIGEST_RULES, findings: explored.finalText },
      },
      DiscoveryDigest,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "discovery-digest", digest);
  const value = resolved.status === "degraded" ? { files: 0, modules: [], notes: "" } : resolved.value;
  // First line: the counts the entry always carried. Below it: the findings
  // the analyst and the planner read back (`discoveryNotes` in brief.ts).
  const notes = value.notes.trim();
  await record(deps, run, {
    kind: "discovery",
    actor: "ai",
    title: "repo keşfi",
    detail: `${value.files} dosya · ${value.modules.length} modül${notes === "" ? "" : `\n${notes}`}`,
    key: "discovery",
  });
  // Künye, deftere yazılan AYNI sayılardan: belge "14 dosya, 3 modül okundu"
  // derken defteri tekrar eder, ayrı bir ölçüm uydurmaz.
  // Digest düşerse depo YİNE okundu (oturum açıldı, ajan gezdi) ama sayı
  // kalmadı: `read: true` doğru, "0 dosya" yanıltıcı olurdu — künye bunu
  // sayıyı susturup notta söyler.
  await stamp(
    deps,
    run,
    appId,
    resolved.status === "degraded"
      ? { read: true, note: "depo okundu; bulgu özeti alınamadı (dosya/modül sayısı yok)" }
      : { read: true, files: value.files, modules: value.modules },
  );
  return { files: value.files, modules: [...value.modules] };
}

/**
 * ANALİSTİN ŞEMASI — belgenin şeması EKSİ keşif künyesi.
 *
 * `AnalysisDoc.omit({ discovery: true })`: `.strict()` korunur, yani model
 * `discovery` alanını çıktısına koyarsa belge AYRIŞMAZ. Künyeyi modelin
 * uydurmasını engelleyen şey bir prompt cümlesi değil — alanın modelin
 * gördüğü şemada hiç bulunmaması, ve fazladan alanın şemayı düşürmesi.
 * Alan `writeAnalysis` sonunda kod tarafından, adım 3ö'nün ölçümünden
 * doldurulur.
 */
const ANALYST_DOC_SCHEMA = AnalysisDoc.omit({ discovery: true });
/** The document as the MODEL writes it: everything but the stamp. */
type AnalystDoc = z.infer<typeof ANALYST_DOC_SCHEMA>;

/** M83/M59: the pinned template and the project's language are not negotiable. */
function assertDocument(run: RunContext, doc: AnalystDoc): void {
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
  // A repo-backed run must say what it touches; the schema no longer forces
  // a row (an analysis-only run has none to give), so the run decides here.
  if (run.app !== null && doc.impactMatrix.length === 0) {
    throw new Error("analysis names no impacted application although the run has a repository");
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
  // Studio'nun "Öğrenme kaynakları" ekranındaki etkin notlar — global olanlar +
  // yalnız bu ajana hedeflenenler. Personanın HEMEN ARDINDAN: rol talimatı,
  // sonra kurum bilgisi, sonra analiz edilecek talep. Not yoksa alan hiç
  // gitmez; prompt bugünküyle bit bit aynı kalır.
  const guidance = await analystGuidance(deps, run);
  // Ticket'ın ekleri (metin/Word/PDF), aktivitenin İÇİNDE okunup metne
  // indirgenir — Temporal geçmişine girmez. Ek yoksa alan hiç gitmez; prompt
  // eksiz ticket için bit bit aynı kalır. Okunan ekler deftere yazılır ki
  // operatör analizin neyi gördüğünü bilsin (ve neyi göremediğini).
  const attachments = await ticketAttachments(deps, ticket);
  // Studio'da yayınlanan şablonun başlık + talimatları, belgenin alanlarına
  // sırayla eşlenmiş; ve şemanın söyleyemediği kurallar (dil, sürüm, deposuz
  // koşuda etki matrisi). Okunamazsa alan gitmez, analist şemayla çalışır.
  const instructions = await analysisInstructions(deps, run);
  // Salt-okunur keşif ajanının bulguları (adım 3ö), defterden. Analist kod
  // karşılığını, eksikleri ve ölçek riskini BUNDAN yazar; bulgu yoksa (deposuz
  // koşu) o alanlar boş kalır ve kurallar bunu söyler.
  const discovery = await discoveryNotes(deps, run);
  const rules = [...analysisRules(run), ...briefRules(run, discovery !== null)];
  if (attachments.length > 0) {
    await record(deps, run, {
      kind: "other",
      actor: "ai",
      title: "ekler okundu",
      detail: attachments
        .map((a) => `${a.name} (${a.kind}${a.note === undefined ? "" : ` — ${a.note}`})`)
        .join(", "),
      key: `attachments:${activitySeq()}`,
    });
  }
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
          ...(guidance.length === 0 ? {} : { guidance }),
          // Rol ve kurum bilgisinden SONRA, talebin ÖNÜNDE: önce kim olduğun,
          // sonra kurallar ve bölüm talimatları, sonra analiz edilecek talep.
          rules,
          ...(instructions === null ? {} : { template: instructions }),
          // `appId` is the ONLY repo-derived fact in this prompt — everything
          // else (locale, template pin, the ticket's own text) holds without a
          // repository. An analysis-only run omits it rather than sending a
          // blank, so the analyst is never told the application is named "".
          ...(appId === undefined ? {} : { appId }),
          locale: run.locale,
          templateVersion: run.templateVersion,
          summary: snapshot.summary,
          description: snapshot.description,
          // Ekler ticket metninin HEMEN ARDINDAN: açıklama "ekteki dokümana
          // bakın" der, doküman onu izler. Okunamayan ek de adıyla gider;
          // model onu "incelenmeli" diye anar, içeriğini uydurmaz.
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(discovery === null ? {} : { discovery }),
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
      ANALYST_DOC_SCHEMA,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "analysis", outcome);
  if (resolved.status === "degraded") throw aiAssistRequired("analysis", resolved.messageKey);

  const written = ANALYST_DOC_SCHEMA.parse(resolved.value);
  assertDocument(run, written);
  await deps.runs.patch(ticket, { risk: written.riskTier });
  await record(deps, run, {
    kind: "analysis",
    actor: "ai",
    title: "analiz yazıldı",
    detail: [
      `risk: ${written.riskTier} — ${written.riskReason}`,
      `${String(written.requirements.length)} gereksinim · ${String(written.businessRules.length)} iş kuralı · ${String(written.codeMapping.length)} kod karşılığı · ${String(written.gaps.length)} eksik · ${String(written.scaleRisks.length)} ölçek riski · ${String(written.openQuestions.length)} açık soru`,
    ].join("\n"),
    // A rewrite after a rejection can legitimately land on the same tier and
    // the same criteria count; keying on the document's shape would hide the
    // second version behind the first.
    key: `analysis:${activitySeq()}`,
  });
  // The PLANNER — a separate call with its own brief, after the analysis and
  // only when there is a repository to plan against. Fail-soft: an analysis
  // without a plan still reaches the gate; the developer then works from the
  // acceptance criteria, as it always did.
  const plan =
    discovery === null || (appId === undefined && run.app === null)
      ? null
      : await writePlan(deps, run, snapshot, written, discovery);
  /**
   * KÜNYEYİ MODEL DEĞİL, KOD KOYAR.
   *
   * `discovery` alanı `ANALYST_DOC_SCHEMA`'da YOK — model onu üretemez, çünkü
   * üretebilseydi uydururdu: bir keşif hiç çalışmamışken de "depoyu okudum"
   * cümlesini kurabilen taraf o. Burada okunan künye adım 3ö'nün kendi
   * ölçümü (`storeDiscoveryStamp`), yani belgeye giren şey bir beyan değil
   * kayıt.
   *
   * `null` iki halde: bu koşuda keşif adımı hiç çalışmadı (deposuz analiz
   * koşusu — workflow `discoverRepo`'yu çağırmaz) ya da künye depodan
   * okunamadı. İkisinde de bölüm hiç çizilmez; belge bugünküyle aynı kalır.
   */
  const stampRead = await loadDiscoveryStamp(deps, run);
  const analysis: AnalysisDoc = { ...written, plan, discovery: stampRead };
  await storeAnalysis(deps, run, analysis);
  return { analysis, risk: analysis.riskTier };
}

/**
 * Step 3 (second call) — the implementation plan the developer follows: which
 * files change, the endpoint contract, the DTO fields, and the conventions to
 * copy. Reads the analysis it plans for and the discovery notes; never the
 * ticket alone, so it cannot plan against a code base it has not seen.
 */
async function writePlan(
  deps: ActivityDeps,
  run: RunContext,
  snapshot: { summary: string; description: string },
  analysis: AnalystDoc,
  discovery: string,
): Promise<ImplementationPlan | null> {
  // The PLANNER's own agent definition (role `planner`) — its training is
  // the persona; the field rules below explain the JSON shape.
  const persona = await trainingFor(deps, run, "planner");
  const plannerVariant = await roleVariantId(deps, run, "planner");
  const guidance = await analystGuidance(deps, run);
  try {
    const outcome = await guardModelCall(deps, run, "plan", () =>
      deps.llm.generateObject(
        {
          role: "planner",
          variantId: plannerVariant,
          dataClass: run.dataClass,
          schemaName: "implementation-plan",
          input: {
            persona,
            ...(guidance.length === 0 ? {} : { guidance }),
            rules: planRules(),
            summary: snapshot.summary,
            description: snapshot.description,
            analysis: {
              requirements: analysis.requirements,
              businessRules: analysis.businessRules,
              acceptanceCriteria: analysis.acceptanceCriteria,
              scope: analysis.scope,
              uiApiChanges: analysis.uiApiChanges,
              codeMapping: analysis.codeMapping,
              gaps: analysis.gaps,
              scopeOptions: analysis.scopeOptions,
              openQuestions: analysis.openQuestions,
            },
            discovery,
          },
        },
        ImplementationPlan,
      ),
    );
    const resolved = await resolveOutcome(deps, run, "plan", outcome);
    if (resolved.status === "degraded") {
      await record(deps, run, {
        kind: "analysis",
        actor: "ai",
        title: "uygulama planı yazılamadı",
        detail: resolved.messageKey,
        key: `plan:${activitySeq()}`,
      });
      return null;
    }
    const plan = ImplementationPlan.parse(resolved.value);
    await record(deps, run, {
      kind: "analysis",
      actor: "ai",
      title: "uygulama planı yazıldı",
      detail: [
        `${String(plan.files.length)} dosya · ${String(plan.endpoints.length)} endpoint · ${String(plan.dtos.length)} DTO`,
        ...plan.files.slice(0, 12).map((file) => `- ${file.path} — ${file.change}`),
      ].join("\n"),
      key: `plan:${activitySeq()}`,
    });
    return plan;
  } catch (error) {
    await record(deps, run, {
      kind: "analysis",
      actor: "ai",
      title: "uygulama planı yazılamadı",
      detail: `analiz plansız kapıya gidiyor — ${String(error).slice(0, 300)}`,
      key: `plan:${activitySeq()}`,
    });
    return null;
  }
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
    // Only a REPO-BACKED cell with a registry-shaped id is a work item. A
    // `ticket` cell ("BOA", "kredi tahsis") is a statement in the document —
    // there is no application to open a child under, and a child ticket
    // labelled `app:BOA` would be an invented assignment.
    .filter((cell) => cell.source !== "ticket" && AppId.safeParse(cell.appId).success)
    .sort((a, b) => a.appId.localeCompare(b.appId));

  const children: TicketKey[] = [];
  for (const cell of impacted) {
    let created: { key: TicketKey };
    try {
      created = await deps.idempotency.once(`${run.runId}:fanout:${cell.appId}`, () =>
        deps.work.createLinkedIssue(ticket, {
          summary: deps.translate(run.locale, "jira.child_summary", { ticket, app: cell.appId }),
          description: cell.summary,
          labels: ["maestro", `app:${cell.appId}`],
        }),
      );
    } catch (error) {
      // A child ticket is a CONVENIENCE on top of a delivered analysis. Jira
      // refusing it (a project without the child issue type, a field the
      // screen does not carry — HTTP 400) used to fail the whole run at step
      // 3, after the analysis was written and published. Named in the
      // journal with Jira's own sentence; the flow goes on to the gate.
      await record(deps, run, {
        kind: "other",
        actor: "ai",
        title: "alt ticket açılamadı",
        detail: `${cell.appId} · ${String(error instanceof Error ? error.message : error).slice(0, 400)} · analiz teslim edildi, alt ticket elle açılabilir`,
        key: `fanout-failed:${cell.appId}`,
      });
      continue;
    }
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
