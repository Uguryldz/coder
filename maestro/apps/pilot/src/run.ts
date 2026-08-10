import type { AdoCiDriver } from "@maestro/adapter-ado";
import {
  bulletList,
  doc,
  heading,
  inlineCode,
  paragraph,
  strong,
  text,
  type JiraCloudWorkPort,
} from "@maestro/adapter-jira";
import type { AuditChain } from "@maestro/audit";
import type {
  AnalysisDoc,
  ApplicationRecord,
  AuditAction,
  CommandEnvelope,
  LlmRole,
  TicketKey,
} from "@maestro/contracts";
import type { LlmGateway } from "@maestro/llm-gateway";
import { compiledProfileFor, scanForPii, type LoadedPiiPolicy } from "@maestro/pii";
import type { RepoRef, ScmPort } from "@maestro/ports";
import { z } from "zod";
import {
  ADO_PROJECT,
  ADO_REPO,
  corpAccountOf,
  GITHUB_PUSH_TTL_SECONDS,
  GITHUB_TARGET_BRANCH,
  PILOT_VARIANT,
  type ScmMode,
} from "./config.js";
import { produceAnalysis } from "./analysis.js";
import { analysisToDocs, attachAnalysisDocs, type DocStore } from "./docs.js";
import { pollForCommand, PollAbortedError } from "./poll.js";
import type { PilotSettings, SettingsStore } from "./settings.js";
import type { StateStore } from "./state.js";
import {
  createWorkspace,
  IMPLEMENTATION_PATH,
  TEST_PATH,
  type CreateWorkspaceOptions,
  type DemoWorkspace,
} from "./workspace.js";

/**
 * The shortened delivery flow, run against a REAL Jira Cloud site:
 *
 *   intake → analiz → İNSAN KAPISI → kod → tarama → test → PR → İNSAN KAPISI → merge
 *
 * The difference from the demo is the Jira edge: every getTicket/addComment/
 * setLabels call reaches the live site, and the two human gates are resolved by
 * POLLING the ticket's comments (Atlassian Cloud cannot deliver a webhook to
 * localhost). ADO, as in the demo, is a prop; the model, PII and audit are real.
 */

/** A step that failed for a reason worth showing on screen rather than a stack. */
export class PilotStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotStepError";
  }
}

const IntakeVerdict = z
  .object({
    complete: z.boolean(),
    missing: z.array(z.string()).max(5),
    note: z.string().min(1),
  })
  .strict();
type IntakeVerdict = z.infer<typeof IntakeVerdict>;

const CodeDraft = z
  .object({
    summary: z.string().min(1),
    implementation: z.string().min(1),
    test: z.string().min(1),
  })
  .strict();
type CodeDraft = z.infer<typeof CodeDraft>;

const MAX_ENGINEER_ATTEMPTS = 3;

/** Models sometimes fence code even when told not to; the fence is not code. */
function stripFences(value: string): string {
  const fenced = /^\s*```(?:[a-zA-Z]*)\n([\s\S]*?)```\s*$/.exec(value);
  return (fenced?.[1] ?? value).trim();
}

const APPLICATION = {
  appId: "ugurpay",
  displayName: "Ugur Payments",
  adoProject: ADO_PROJECT,
  adoRepo: ADO_REPO,
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: false,
  createdVia: "import",
} as const;

/** GitHub-only run inputs; present iff `scmMode === "github"`. */
export interface GithubRunConfig {
  /** Credential-free HTTPS remote, e.g. https://github.com/owner/repo.git */
  remoteUrl: string;
  /** GitHub owner/repo for the Application Registry record used by the driver. */
  owner: string;
  repo: string;
}

export interface PilotRunDeps {
  work: JiraCloudWorkPort;
  scm: ScmPort;
  ci: AdoCiDriver;
  /** Which SCM edge is live (M-C2). `fake` keeps the ADO prop; `github` pushes for real. */
  scmMode?: ScmMode;
  /** Required when `scmMode === "github"`: where the runner clones/pushes. */
  github?: GithubRunConfig;
  /** Injected exec runner for the git push; tests stub it (never shell out). */
  workspaceOptions?: CreateWorkspaceOptions;
  /**
   * PR merge-status source. Defaults to `scm`. On the github path this points
   * at the FAKE (CI + merge stay faked in C2 — real GitHub checks is C3), so
   * `getPrStatus` and the merge simulation do not hit the real GitHub PR. Its
   * OWN repo ref is used for the status call (an ADO-shaped ref), not the
   * github owner/repo the branch/PR steps use.
   */
  mergeStatus?: Pick<ScmPort, "getPrStatus" | "resolveRepo">;
  /**
   * Called on the github path once the REAL PR is open, so the faked CI signal
   * can be delivered for its real id (real GitHub checks is C3). No-op on fake.
   */
  onRealPrOpened?: (prId: number, sourceRef: string) => void;
  llm: LlmGateway;
  audit: AuditChain;
  piiPolicy: LoadedPiiPolicy;
  store: StateStore;
  /** Runtime settings (approver group, model, poll ms, data class, operator). */
  settings: SettingsStore;
  /** Holds the generated .docx/.pdf so the download route can stream them. */
  docs: DocStore;
  /** Stands in for the human who presses "Complete" in the ADO PR screen. */
  completePullRequest: (prId: number) => boolean;
  /** Called whenever the Jira side changed, so the UI can refresh its pane. */
  onJiraChanged?: () => void;
  ciTimeoutMs?: number;
  mergePollMs?: number;
  /** Poll interval for the gate comment poller (ms). */
  commandPollMs?: number;
  /** Injected sleep so tests advance the gate poller without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export class PilotRun {
  private runId = "";
  private ticketKey: TicketKey | null = null;
  private progressCommentId: string | null = null;
  private workspace: DemoWorkspace | null = null;
  private repo: RepoRef | null = null;
  private branch = "";
  /** Commit sha pushed on the github path; null on the fake path. */
  private pushedCommitSha: string | null = null;
  private ciWaiter: { prId: number; resolve: (ok: boolean) => void } | null = null;
  /** Aborts the running gate poller when the flow ends or is stopped. */
  private abort: AbortController | null = null;
  /**
   * The settings this run was started with, snapshotted at start(). Because a
   * settings change is refused WHILE a run is in progress (server.ts guard), the
   * six values are fixed for a whole run: reading them once here keeps approver
   * group / data class / model / operator consistent across every step, so a
   * gate is never opened for one group and closed against another.
   */
  private runSettings: PilotSettings;

  constructor(private readonly deps: PilotRunDeps) {
    this.runSettings = deps.settings.snapshot();
  }

  // ---------------------------------------------------------------- run

  async start(ticketKey: TicketKey): Promise<void> {
    const { store } = this.deps;
    if (store.snapshot().running) throw new Error("akış zaten çalışıyor");
    // Snapshot the settings for the whole run (they cannot change mid-run — the
    // server refuses a settings write while running), so every step sees one
    // consistent approver group / model / data class / operator / poll interval.
    this.runSettings = this.deps.settings.snapshot();
    this.ticketKey = ticketKey;
    this.runId = `pilot-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
    this.progressCommentId = null;
    this.repo = null;
    this.branch = "";
    this.pushedCommitSha = null;
    this.abort = new AbortController();
    this.deps.docs.clear();
    store.update((state) => {
      state.running = true;
      state.finished = false;
      state.failure = null;
      state.runId = this.runId;
      state.ticketKey = ticketKey;
      // Reflect the settings this run actually uses (they may have changed since boot).
      state.model = this.runSettings.model;
      state.approverGroup = this.runSettings.approverGroup;
      state.browseUrl = `${state.jiraSite}/browse/${ticketKey}`;
      state.awaitingGate = null;
      state.docsReady = false;
      state.log = [];
      state.llmCalls = 0;
      state.tokens = 0;
      state.maskedFields = 0;
      for (const step of state.steps) {
        step.state = "bekliyor";
        step.notes = [];
      }
    });
    store.log("info", `▶ akış başladı · run ${this.runId} · ticket ${ticketKey} (CANLI Jira)`);

    try {
      await this.record("RUN_STARTED", { ticket: ticketKey });
      const analysis = await this.stepIntakeAndAnalysis();
      await this.stepAnalysisGate();
      const draft = await this.stepEngineering(analysis);
      const prId = await this.stepPullRequest(draft, analysis);
      await this.stepPrGate(prId);
      await this.stepMerge(prId);
      store.update((state) => {
        state.finished = true;
        state.running = false;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.log("err", `✗ akış durdu: ${message}`);
      store.update((state) => {
        state.failure = message;
        state.running = false;
      });
    } finally {
      this.abort?.abort();
      this.abort = null;
      await this.workspace?.dispose();
      this.workspace = null;
      await this.verifyAudit();
    }
  }

  private requireTicket(): TicketKey {
    if (this.ticketKey === null) throw new PilotStepError("ticket seçilmeden akış başlatılamaz");
    return this.ticketKey;
  }

  // -------------------------------------------------------------- steps

  /** ① ticket read + ② analysis. */
  private async stepIntakeAndAnalysis(): Promise<AnalysisDoc> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    store.step("1", "calisiyor");

    const ticket = await work.getTicket(ticketKey);
    store.log("ok", `✓ CANLI Jira'dan okundu: ${ticket.key} — ${ticket.summary}`);
    store.note("1", `bildiren: ${ticket.reporter} · bileşen: ${ticket.components.join(", ") || "—"}`);

    const labels = ticket.labels.includes("maestro") ? ticket.labels : [...ticket.labels, "maestro"];
    await work.setLabels(ticketKey, labels);
    store.log("dim", `→ etiketler güncellendi (canlı): ${labels.join(", ")}`);

    const progress = await work.addComment(
      ticketKey,
      doc(
        paragraph([strong("▶ Maestro durum:"), text(" analiz hazırlanıyor…")]),
        paragraph("Bu yorum yenisi açılmadan düzenlenerek güncellenir (M75)."),
      ),
    );
    this.progressCommentId = progress.commentId;
    this.deps.onJiraChanged?.();
    store.step("1", "tamam", "canlı Jira'ya durum yorumu bırakıldı");

    store.step("2", "calisiyor");
    const intake = await this.think<IntakeVerdict>("intake", "IntakeVerdict", IntakeVerdict, {
      gorev: "Ticket geliştirmeye başlamak için yeterli mi? Eksikleri listele.",
      dil: "tr",
      ticket: {
        key: ticket.key,
        ozet: ticket.summary,
        aciklama: ticket.description,
        bilesenler: ticket.components,
      },
      kurallar: ["Kısa yaz.", "missing en fazla 3 madde.", "note tek cümle, Türkçe."],
    });
    store.log(
      intake.display.complete ? "ok" : "warn",
      `${intake.display.complete ? "✓" : "!"} intake: ${intake.display.note}`,
    );
    if (!intake.display.complete && intake.display.missing.length > 0) {
      store.note("2", `eksik görülen: ${intake.display.missing.join(" · ")}`);
      store.log(
        "warn",
        "! gerçek akışta burada 2b clarification kapısı açılır; bu kısaltılmış pilotta devam ediliyor",
      );
    }

    // The REAL agent-roles analyst (M43/M108/M109): a real analysis TEMPLATE
    // decides the sections and the fail-closed validation, a real AnalysisContext
    // carries the ticket (repo-card/knowledge are wired when populated — see
    // analysis.ts), and PILOT_VARIANT is the variant. The seven-section check is
    // no longer a hand-rolled Zod here; it comes from the template.
    const analysis = await produceAnalysis({
      llm: this.deps.llm,
      ticket,
      variantId: PILOT_VARIANT,
      dataClass: this.runSettings.dataClass,
    });
    store.log(
      "ok",
      `✓ analyst: şablon ${analysis.display.impactMatrix.length ? "7/7 doğrulandı" : "doğrulandı"} · risk: ${analysis.display.riskTier} · etki satırı: ${analysis.display.impactMatrix.length}`,
    );
    store.note("2", `risk: ${analysis.display.riskTier} — ${analysis.display.riskReason}`);

    await this.updateProgress("analiz hazır — onay bekleniyor");
    await work.addComment(ticketKey, analysisComment(analysis.display));
    this.deps.onJiraChanged?.();

    await this.generateAnalysisDocs(analysis.display);

    store.step("2", "tamam");
    return analysis.display;
  }

  /**
   * Render the analysis to a real `.docx` and `.pdf` and park them for download.
   *
   * This is the same analysis the reviewer reads in the Jira comment, rendered
   * through the publish package's real drivers — not a second summary. It runs
   * AFTER the comment so a rendering hiccup never blocks the delivery flow: the
   * files are a convenience, and the page simply does not show the buttons if
   * generation failed (the failure is logged, not swallowed into a stack trace).
   */
  private async generateAnalysisDocs(analysis: AnalysisDoc): Promise<void> {
    const { store, docs, work } = this.deps;
    const ticketKey = this.requireTicket();
    try {
      const generated = await analysisToDocs(analysis, ticketKey, this.runId);
      docs.put(this.runId, generated);
      store.update((state) => {
        state.docsReady = true;
      });
      store.log(
        "ok",
        `✓ analiz belgesi üretildi: ${generated.pdf.fileName} (${generated.pdf.bytes.byteLength} B) · ${generated.docx.fileName} (${generated.docx.bytes.byteLength} B)`,
      );
      // The documents exist — now attach them to the live ticket (M103r), so a
      // human no longer drags the Word/PDF in by hand. This runs AFTER the files
      // are parked for download, so a Jira hiccup here never costs the reviewer
      // the download buttons: `attachAnalysisDocs` is fail-soft and never throws.
      const result = await attachAnalysisDocs(
        work,
        ticketKey,
        generated,
        (kind, message) => store.log(kind, message),
      );
      if (result.attached) this.deps.onJiraChanged?.();
    } catch (error) {
      store.log("warn", `! analiz belgesi üretilemedi (akış etkilenmedi): ${String(error)}`);
    }
  }

  /** ③ human gate on the analysis (M51 gate "5") — resolved by polling comments. */
  private async stepAnalysisGate(): Promise<void> {
    const { store } = this.deps;
    const approverGroup = this.runSettings.approverGroup;
    await this.record("GATE_OPEN", { step: "5", group: approverGroup });
    store.step("3", "onay");
    store.log(
      "warn",
      `⏸ kapı açık — GERÇEK Jira'da yoruma /approve yazılmasını bekliyorum (grup: ${approverGroup})`,
    );
    const envelope = await this.awaitApproval("3");
    store.step("3", "tamam", `onaylayan: ${envelope.author}`);
    store.log("ok", `✓ analiz onayı: ${envelope.author} · grup üyeliği doğrulandı`);
  }

  private githubMode(): boolean {
    return this.deps.scmMode === "github";
  }

  /** The Application Registry record the ScmPort resolves; owner/repo on github. */
  private application(): ApplicationRecord {
    if (this.githubMode() && this.deps.github) {
      return { ...APPLICATION, adoProject: this.deps.github.owner, adoRepo: this.deps.github.repo };
    }
    return APPLICATION;
  }

  /** ④ + ⑤ + ⑥ — engineering, scan and the test that really runs. */
  private async stepEngineering(analysis: AnalysisDoc): Promise<CodeDraft> {
    const { store, scm } = this.deps;
    const ticketKey = this.requireTicket();
    const github = this.githubMode();
    store.step("4", "calisiyor");

    const baseBranch = github ? GITHUB_TARGET_BRANCH : "main";
    const repo = await scm.resolveRepo(this.application());
    store.log(
      "ok",
      github
        ? `✓ GitHub deposu çözüldü (GERÇEK): ${repo.project}/${repo.repo}`
        : `✓ ADO deposu çözüldü (sahte): ${repo.project}/${repo.repo}`,
    );
    const branch = github ? `feature/${ticketKey}` : `feature/${ticketKey}-pilot`;
    await scm.createBranch(repo, branch, github ? baseBranch : "refs/heads/main");
    store.log("ok", github ? `✓ dal açıldı (GERÇEK): ${branch}` : `✓ dal açıldı: ${branch}`);
    store.note("4", `dal: ${branch}`);
    this.repo = repo;
    this.branch = branch;

    this.workspace = await createWorkspace(this.deps.workspaceOptions ?? {});
    const profile = compiledProfileFor(this.deps.piiPolicy, this.runSettings.dataClass).profile;

    let feedback: string | null = null;
    let previousCode: CodeDraft | null = null;
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ENGINEER_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        store.step("4", "calisiyor", `düzeltme turu ${attempt}`);
        store.log("warn", `↻ mühendis düzeltme turu ${attempt}: ${lastError}`);
      }
      const draft = await this.think<CodeDraft>("engineer", "CodeDraft", CodeDraft, {
        gorev: "Aşağıdaki analize göre küçük ve çalışır bir modül + testini yaz.",
        dil: "tr",
        analiz: {
          amac: analysis.purpose,
          kabulKriterleri: analysis.acceptanceCriteria,
          testYaklasimi: analysis.testApproach,
        },
        dosyalar: { uygulama: IMPLEMENTATION_PATH, test: TEST_PATH },
        kurallar: [
          "Her iki dosya da ESM'dir (.mjs): require() KULLANMA, yalnız import kullan.",
          "implementation: saf ESM JavaScript modülü, dışa `export` ile açılır, yalnız node: yerleşiklerini kullanabilir.",
          `test: '${TEST_PATH}' dosyasının içeriği; uygulamayı "import { ... } from '../src/impl.mjs'" ile alır.`,
          "test dosyası \"import assert from 'node:assert/strict'\" kullanır ve başarılıysa konsola 'OK' yazar.",
          "Test kendi kendine yeterli olmalı; ağ, dosya sistemi, zamanlayıcı kullanma.",
          "Kodun ve testin içine e-posta adresi, telefon, TCKN, IBAN veya kart numarası YAZMA — örnek/sahte olanları bile. '@' işareti geçen metin kullanma.",
          "summary: 1-2 cümle Türkçe özet.",
          "Markdown kod bloğu (```) kullanma; alanlar düz metin olacak.",
        ],
        ...(feedback === null ? {} : { oncekiHata: feedback }),
        ...(previousCode === null ? {} : { oncekiKod: previousCode }),
      });

      const code: CodeDraft = {
        summary: draft.masked.summary,
        implementation: stripFences(draft.masked.implementation),
        test: stripFences(draft.masked.test),
      };
      previousCode = code;
      await this.workspace.write(IMPLEMENTATION_PATH, code.implementation);
      await this.workspace.write(TEST_PATH, code.test);
      store.log("ok", `✓ engineer: ${IMPLEMENTATION_PATH} + ${TEST_PATH} yazıldı`);
      store.note("4", draft.display.summary);
      store.step("4", "tamam");

      // ---- ⑤ scan (fail-closed)
      store.step("5", "calisiyor");
      const counts = scanForPii({ implementation: code.implementation, test: code.test }, profile);
      if (counts.occurrences > 0) {
        const types = Object.keys(counts.byType).join(", ");
        lastError = `üretilen kodda kişisel veri bulundu (${types}); temizlenmeli`;
        feedback = lastError;
        store.step("5", "hata", lastError);
        await this.record("SECURITY_SCAN_FAIL", { occurrences: counts.occurrences });
        store.log("err", `✗ tarama: ${lastError}`);
        continue;
      }
      await this.record("SECURITY_SCAN_PASS", { scanner: "pii", files: 2 });
      store.step("5", "tamam", "kişisel veri bulunmadı (0 bulgu)");
      store.log("ok", "✓ tarama: kişisel veri sızıntısı yok");

      // ---- ⑥ the test really runs
      store.step("6", "calisiyor");
      const run = await this.workspace.runTest();
      await this.record("TEST_RUN_COMPLETE", {
        passed: run.ok,
        exitCode: run.exitCode ?? -1,
        durationMs: run.durationMs,
      });
      if (!run.ok) {
        lastError = (run.stderr || run.stdout || "test çıkış kodu != 0").split("\n").slice(0, 6).join(" | ");
        feedback = lastError;
        store.step("6", "hata", lastError);
        store.log("err", `✗ test koştu ve DÜŞTÜ (${run.durationMs} ms): ${lastError}`);
        continue;
      }
      store.step("6", "tamam", `çıkış kodu 0 · ${run.durationMs} ms`);
      store.log(
        "ok",
        `✓ test gerçekten koştu: çıkış kodu 0 (${run.durationMs} ms) ${run.stdout ? `· ${run.stdout.split("\n")[0]}` : ""}`,
      );

      // On the github path the green code is pushed FOR REAL now: the PR in the
      // next step must have a real branch behind it. A push failure fails the
      // step CLOSED — no false "PR opened" (the exception propagates out of
      // start(), which records the run as failed and stops).
      if (github) await this.pushToGithub(code);

      return code;
    }

    throw new PilotStepError(
      `kod/tarama/test döngüsü ${MAX_ENGINEER_ATTEMPTS} turda yeşile dönmedi — son hata: ${lastError}`,
    );
  }

  /**
   * The REAL push (github path only). Mints a short-lived push credential from
   * the ScmPort (M31), then runs clone→branch→commit→push in the sandbox over
   * the injected exec runner. The token is handed to the workspace which feeds
   * it to git out-of-band (env-only `http.extraHeader`) — it never lands on an
   * argv, in `.git/config`, or in a log line here. `branch` was already created
   * on GitHub via the API in stepEngineering; the push updates that ref.
   *
   * Fails CLOSED: a `getPushCredential` refusal or any git error throws, and
   * the PR step never runs, so the workflow cannot claim a PR over an
   * unpushed branch.
   */
  private async pushToGithub(code: CodeDraft): Promise<void> {
    const { store, scm, github } = this.deps;
    const ticketKey = this.requireTicket();
    const repo = this.repo;
    const ws = this.workspace;
    if (repo === null || ws === undefined || ws === null) {
      throw new PilotStepError("push için depo/çalışma alanı hazır değil");
    }
    if (github === undefined) throw new PilotStepError("github yapılandırması eksik");

    // Short-lived credential (M31): the driver refuses a TTL over its ceiling
    // and refuses a credential that outlives the window (fail-closed).
    const credential = await scm.getPushCredential(repo, GITHUB_PUSH_TTL_SECONDS);
    store.log("dim", `→ kısa ömürlü push kimliği alındı (geçerlilik: ${credential.expiresAt})`);

    const commitSubject = `[AI] ${ticketKey} ${code.summary}`.slice(0, 72);
    const pushed = await ws.gitPush({
      remoteUrl: github.remoteUrl,
      branch: this.branch,
      baseBranch: GITHUB_TARGET_BRANCH,
      commitSubject,
      // M13: an AI-authored commit is attributed and co-signed.
      coAuthor: "Co-Authored-By: Maestro <maestro@ugurbank.example>",
      token: credential.token,
      authorName: "Maestro AI",
      authorEmail: "maestro@ugurbank.example",
    });
    this.pushedCommitSha = pushed.commitSha;
    store.log("ok", `✓ kod GERÇEK push edildi · commit ${pushed.commitSha.slice(0, 8)} · dal ${this.branch}`);
    // No dedicated push action exists in the FROZEN AuditAction enum; the pushed
    // commit sha is recorded on the PR_OPENED event in stepPullRequest instead.
  }

  /**
   * ⑦ pull request. On the github path the PR is opened FOR REAL against the
   * live repo (over the branch just pushed). The CI signal, however, still
   * arrives from the fake ADO Service Hook — real GitHub checks/Actions is C3,
   * not done here — so once the real PR is open its id is handed to the fake CI
   * publisher (`onRealPrOpened`) which emits a `build.complete` for that id.
   */
  private async stepPullRequest(draft: CodeDraft, analysis: AnalysisDoc): Promise<number> {
    const { store, scm } = this.deps;
    const ticketKey = this.requireTicket();
    const github = this.githubMode();
    const repo = this.repo;
    if (repo === null) throw new PilotStepError("depo çözülmeden PR açılamaz");
    store.step("7", "calisiyor");

    const { prId } = await scm.openPr(repo, {
      sourceBranch: this.branch,
      targetBranch: github ? GITHUB_TARGET_BRANCH : "main",
      title: `[AI] ${ticketKey} ${analysis.purpose.slice(0, 60)}`,
      description: `${draft.summary}\n\nMaestro pilot çalışması — ${ticketKey}`,
      draft: true,
    });
    store.log("ok", github ? `✓ PR #${prId} taslak olarak açıldı (GERÇEK GitHub)` : `✓ PR #${prId} taslak olarak açıldı (sahte ADO)`);
    await this.record("PR_OPENED", {
      prId,
      branch: this.branch,
      ...(this.pushedCommitSha ? { commitSha: this.pushedCommitSha } : {}),
    });

    await scm.activatePr(repo, prId);
    store.log("dim", `→ PR #${prId} taslaktan çıktı — build validation kuyruğa alındı`);

    // CI stays faked (C3 wires real GitHub checks): trigger the fake build for
    // the REAL PR id now that it is out of draft.
    if (github) this.deps.onRealPrOpened?.(prId, `refs/heads/${this.branch}`);

    const threads = await scm.listPrThreads(repo, prId);
    store.note("7", `PR #${prId} · açık inceleme yorumu: ${threads.length}`);

    const green = await this.awaitCi(prId);
    if (!green) {
      store.step("7", "hata", "CI kırmızı");
      throw new PilotStepError(`CI build'i başarısız döndü (PR #${prId})`);
    }
    store.step("7", "tamam", `CI yeşil · PR #${prId}`);
    return prId;
  }

  /** ⑧ human gate on the pull request (M51 gate "12") — polled on real Jira. */
  private async stepPrGate(prId: number): Promise<void> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    await work.addComment(
      ticketKey,
      doc(
        heading(3, "✅ PR hazır"),
        paragraph([text("Pull request "), strong(`#${prId}`), text(" açıldı, testler ve CI yeşil.")]),
        paragraph([text("Onay için bu ticket'a "), inlineCode("/approve"), text(" yorumu yazın.")]),
      ),
    );
    this.deps.onJiraChanged?.();
    await this.record("GATE_OPEN", { step: "12", prId });
    store.step("8", "onay");
    store.log("warn", `⏸ ikinci kapı açık — GERÇEK Jira'da PR #${prId} onayı bekleniyor`);
    const envelope = await this.awaitApproval("8");
    store.step("8", "tamam", `onaylayan: ${envelope.author}`);
    store.log("ok", `✓ PR onayı: ${envelope.author}`);
  }

  /** ⑨ merge (by a human, in ADO) + closure. */
  private async stepMerge(prId: number): Promise<void> {
    const { store, work } = this.deps;
    // Merge stays a human action in the fake (C2): even on the github path the
    // merge + status come from the fake merge-status port, not the real PR.
    const mergeStatus = this.deps.mergeStatus ?? this.deps.scm;
    const ticketKey = this.requireTicket();
    const repo = this.repo;
    if (repo === null) throw new PilotStepError("depo yok");
    store.step("9", "calisiyor");

    const merged = this.deps.completePullRequest(prId);
    store.log(
      "dim",
      merged
        ? "→ (sahte ADO) PR'ı bir insan 'Complete' ile birleştirdi — Maestro merge etmez"
        : "→ (sahte ADO) PR zaten birleşmişti",
    );

    // On the github path the merge-status port is the FAKE ADO driver; its
    // repo ref is ADO-shaped, not the github owner/repo `this.repo` carries.
    const statusRepo = this.deps.mergeStatus ? await mergeStatus.resolveRepo(APPLICATION) : repo;

    const deadline = Date.now() + 10_000;
    let status = await mergeStatus.getPrStatus(statusRepo, prId);
    while (status.state !== "completed" && Date.now() < deadline) {
      await sleep(this.deps.mergePollMs ?? 300);
      status = await mergeStatus.getPrStatus(statusRepo, prId);
    }
    if (status.state !== "completed") {
      throw new PilotStepError(`PR #${prId} birleşmedi (durum: ${status.state})`);
    }
    store.log("ok", `✓ merge doğrulandı · commit ${status.mergeSha?.slice(0, 8) ?? "?"}`);
    await this.record("PR_MERGED", { prId, mergeSha: status.mergeSha ?? null });

    await this.updateProgress("tamamlandı — PR birleşti");
    await work.addComment(
      ticketKey,
      doc(
        heading(3, "🎉 Tamamlandı"),
        paragraph(`${ticketKey} için PR #${prId} birleşti. Analiz, kod, test ve onay zinciri kayıt altında.`),
      ),
    );
    this.deps.onJiraChanged?.();
    await this.record("RUN_CLOSED", { prId });
    store.step("9", "tamam");
  }

  // ---------------------------------------------------- gate: comment polling

  /**
   * A gate. The demo waited on a webhook; the pilot POLLS the live ticket's
   * comments until a /approve or /reject from a group member arrives. The M105
   * rules (only a plain, never-edited top-level command counts) and de-dup live
   * in the driver + poll.ts; membership / SoD is checked HERE, fail-closed.
   */
  private async awaitApproval(step: string): Promise<CommandEnvelope> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    const approverGroup = this.runSettings.approverGroup;
    const signal = this.abort?.signal ?? new AbortController().signal;
    const seen = new Set<string>();

    for (;;) {
      let hit;
      try {
        hit = await pollForCommand({
          work,
          ticketKey,
          seen,
          accept: ["approve", "reject"],
          intervalMs: this.deps.commandPollMs ?? this.runSettings.commandPollMs,
          signal,
          ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
          onInvalid: (messageKey, command) =>
            store.log("warn", `! komut geçersiz: /${command} (${messageKey})`),
          onIgnored: (envelope) =>
            store.log("dim", `→ komut yok sayıldı bu kapıda: /${envelope.command.name} · ${envelope.author}`),
        });
      } catch (error) {
        if (error instanceof PollAbortedError) throw new PilotStepError("kapı iptal edildi (akış durdu)");
        throw error;
      }

      const envelope = hit.envelope;
      this.deps.onJiraChanged?.();

      if (envelope.command.name === "reject") {
        throw new PilotStepError(`kapı reddedildi: ${envelope.command.reason}`);
      }

      // approve → verify the author is in the approver group (M32/M51). SoD is
      // relaxed only by which group APPROVER_GROUP names (see config/RAPOR);
      // the membership check itself is never skipped.
      const member = await work.verifyMembership(envelope.author, approverGroup);
      if (!member) {
        store.log("err", `✗ ${envelope.author} ${approverGroup} grubunda değil — onay reddedildi`);
        await work.addComment(
          ticketKey,
          doc(paragraph(`❌ ${envelope.author} bu kapıyı onaylayamaz (${approverGroup} üyesi değil).`)),
        );
        this.deps.onJiraChanged?.();
        continue; // keep polling — a non-member comment does not open the gate
      }

      await this.record(
        "GATE_APPROVE",
        { step, group: approverGroup },
        corpAccountOf(envelope.author, this.runSettings.operatorAccount),
      );
      return envelope;
    }
  }

  // ---------------------------------------------------------- ADO webhook (fake)

  /** ADO Service Hook delivery: authenticated, allow-listed, then parsed. */
  async handleAdoWebhook(headers: Record<string, string>, body: unknown): Promise<void> {
    const { store, ci } = this.deps;
    const signal = await ci.parseBuildEvent({ headers, body });
    if (signal === null) {
      store.log("dim", "→ ado service hook · ilgisiz olay, yok sayıldı");
      return;
    }
    store.log(
      signal.status === "succeeded" ? "ok" : "err",
      `→ ado build.complete · PR #${signal.prId} · build ${signal.buildId} · ${signal.status}`,
    );
    await this.record("CI_RESULT", {
      prId: signal.prId,
      buildId: signal.buildId,
      status: signal.status,
    });
    const waiter = this.ciWaiter;
    if (waiter && waiter.prId === signal.prId) {
      this.ciWaiter = null;
      waiter.resolve(signal.status === "succeeded");
    }
  }

  // ------------------------------------------------------------- helpers

  /** One thinking-role call: masked on the way out, re-opened for the screen. */
  private async think<T>(
    role: LlmRole,
    schemaName: string,
    schema: z.ZodType<T>,
    input: unknown,
  ): Promise<{ masked: T; display: T }> {
    const outcome = await this.deps.llm.generateObject(
      { role, variantId: PILOT_VARIANT, dataClass: this.runSettings.dataClass, schemaName, input },
      schema,
    );
    if (outcome.status !== "ok") {
      throw new PilotStepError(
        outcome.status === "queued"
          ? `model kuyruğa alındı (kota) — ${outcome.resumeAt}`
          : `model çağrısı '${outcome.status}': ${outcome.messageKey}`,
      );
    }
    const unmask = outcome.unmask;
    return { masked: outcome.value, display: unmask ? unmask(outcome.value) : outcome.value };
  }

  private awaitCi(prId: number): Promise<boolean> {
    const timeoutMs = this.deps.ciTimeoutMs ?? 60_000;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ciWaiter = null;
        reject(new PilotStepError(`CI sinyali ${timeoutMs / 1000} sn içinde gelmedi`));
      }, timeoutMs);
      this.ciWaiter = {
        prId,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
  }

  private async updateProgress(message: string): Promise<void> {
    if (this.progressCommentId === null || this.ticketKey === null) return;
    await this.deps.work.updateComment(
      this.ticketKey,
      this.progressCommentId,
      doc(paragraph([strong("▶ Maestro durum:"), text(` ${message}`)])),
    );
    this.deps.onJiraChanged?.();
  }

  private async record(
    action: AuditAction,
    meta: Record<string, unknown>,
    actor = "maestro-worker",
  ): Promise<void> {
    const event = await this.deps.audit.append({
      actor,
      action,
      subject: this.requireTicket(),
      meta: { ...meta, runId: this.runId },
    });
    this.deps.store.update((state) => {
      state.audit.records = event.seq;
    });
  }

  /** Re-verify the hash chain from genesis; the pilot shows the answer as-is. */
  private async verifyAudit(): Promise<void> {
    const { store, audit } = this.deps;
    try {
      const result = await audit.verify();
      store.update((state) => {
        state.audit.verified = result.ok;
        state.audit.detail = result.ok ? null : JSON.stringify(result);
      });
      store.log(
        result.ok ? "ok" : "err",
        result.ok
          ? `✓ denetim zinciri doğrulandı — ${store.snapshot().audit.records} kayıt, hash zinciri kopuk değil`
          : "✗ denetim zinciri doğrulanamadı",
      );
    } catch (error) {
      store.log("err", `✗ denetim doğrulaması hata verdi: ${String(error)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The analysis, rendered as the Jira comment a reviewer actually reads. */
function analysisComment(analysis: AnalysisDoc): ReturnType<typeof doc> {
  const impacted = analysis.impactMatrix
    .filter((cell) => cell.impacted)
    .map((cell) => `${cell.appId}: ${cell.summary}`);
  return doc(
    heading(3, "📋 Analiz hazır"),
    paragraph([strong("Amaç: "), text(analysis.purpose)]),
    paragraph([strong("Kapsam: "), text(analysis.scope.included.join(" · "))]),
    paragraph([strong("Kabul kriterleri:")]),
    bulletList(analysis.acceptanceCriteria),
    paragraph([strong("Etkilenen uygulamalar: "), text(impacted.join(" | ") || "yalnız bu uygulama")]),
    paragraph([strong("Ekran/API: "), text(analysis.uiApiChanges)]),
    paragraph([strong("Test yaklaşımı: "), text(analysis.testApproach)]),
    paragraph([
      strong("Risk: "),
      text(`${analysis.riskTier} — ${analysis.riskReason} · azaltma: ${analysis.riskAndRollback.mitigation}`),
    ]),
    paragraph([text("Onay için bu ticket'a "), inlineCode("/approve"), text(" yorumu yazın.")]),
  );
}
