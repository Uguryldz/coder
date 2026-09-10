import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Getting a repository onto disk so an agent session can read it.
 *
 * Step 3ö opens a session whose working directory is `RunContext.workspacePath`
 * (`packages/workflows/src/impl/analysis.ts`), and nothing in the workflow ever
 * put a repository there: the column was written empty and the session would
 * have opened on an empty path. That is why the analyst has always been
 * repo-blind — not a missing model capability, a missing checkout.
 *
 * Read-only by design. This release analyses; it does not write code, so the
 * clone is shallow, single-branch and never pushed from. A deployment that
 * enables the engineering turn needs branch and push handling on top, which is
 * the ScmPort's job rather than this one's.
 *
 * The token reaches git through a header in the URL-less form
 * (`http.extraHeader`), never on the argv: `ps` is readable by every user on
 * the host, and a PAT in a process listing is a PAT in an incident report.
 */

export interface CloneRequest {
  /** `owner/repo`, as the Application record carries it. */
  readonly repo: string;
  /** Where checkouts live. One directory per run underneath it. */
  readonly root: string;
  /** Run id — the directory name, so two runs never share a working tree. */
  readonly runId: string;
  /** Host of the SCM. Defaults to github.com. */
  readonly host?: string;
  /** Bearer token for a private repository; omitted for a public one. */
  readonly token?: string | undefined;
  readonly timeoutMs?: number;
  /** Branch to check out (the rule's environment branch); absent = the repo's default. */
  readonly branch?: string;
}

/** A git branch name we are willing to put on a command line. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/** The branch a checkout is on (`git rev-parse --abbrev-ref HEAD`), or null when unreadable. */
export async function checkedOutBranch(path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000 });
    const name = stdout.trim();
    return name === "" || name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}

export class WorkspaceError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Clone (or reuse) the run's checkout and return its path.
 *
 * Reuse matters for a retried activity: Temporal re-runs an activity after a
 * worker crash, and re-cloning a repository that is already on disk would turn
 * every retry into a fresh network fetch. An existing directory with a `.git`
 * in it is taken as the checkout this run already made.
 */
/**
 * Klonun CA ortamı — BOŞ DİZE "YOK" DEMEKTİR, "boş bir yol" DEĞİL.
 *
 * Bu karar bir dönem `=== undefined` ile veriliyordu ve canlıda sessizce
 * yanlış cevap verdi: compose değişkeni `${NODE_EXTRA_CA_CERTS:-}` biçiminde
 * geçirir, yani hiç tanımlanmamış bir değişken konteynere BOŞ DİZE olarak
 * girer — `undefined` olmaz. O zaman `GIT_SSL_CAINFO=""` yazılıyor ve git'e
 * "CA paketin şu dosyada" demiş oluyoruz: var olmayan bir dosyada. Sistemin
 * kendi CA paketi kullanıma girmiyor ve her klon şununla düşüyor:
 *
 *   fatal: unable to access '...': Problem with the SSL CA cert
 *                                   (path? access rights?)
 *
 * Kurumsal CA taşımayan, tamamen olağan bir kurulumda klonun HİÇ çalışmaması
 * bundandı — hata sertifika kurulumunu işaret ettiği için yanlış yerde arandı.
 *
 * Ayrı bir fonksiyon olmasının sebebi ölçülebilirlik: erişilemeyen bir host'ta
 * git CA'ya hiç bakmaz (bağlantı hatası önce gelir), yani bu karar süreç
 * üzerinden sınanamaz. Buradan sınanır.
 */
/**
 * KLON KÖKÜ — ELLE TANIMLANMASI GEREKMEZ.
 *
 * Bu yol bir dönem YALNIZCA `.env`'den okunuyordu ve tanımsızken keşif sessizce
 * kapalıydı: koşu klon açmıyor, analiz kod tabanını hiç görmeden yazılıyor,
 * bunu söyleyen tek satır yok. Sahada aylarca böyle çalıştı ve operatörün
 * gördüğü tek şey "analiz depoyla ilgisiz" oldu.
 *
 * Oysa tanımlanacak bir şey YOKTU: her kurulum bff ve worker'a `/workspace`
 * adında bir birim zaten bağlıyor (`docker-compose.yml`, `x-workspace-volumes`)
 * — tam da klonlar için, doğru uid ile. `.env`'e o yolu bir kez daha yazdırmak,
 * kurulumun zaten bildiği bir şeyi operatöre sordurmaktı.
 *
 * Artık varsayılan odur. `.env` yalnızca ÜSTÜNE YAZMAK için vardır: birimini
 * başka yere bağlamış bir kurulum kendi yolunu söyler, geri kalan hiçbir şey
 * yazmaz. Depoya erişecek jeton da elle verilmez; `SCM_TOKEN_REF` boşsa panelde
 * kayıtlı kod deposu bağlantısının kendi jetonu kullanılır (bkz. `bin/bff.ts`).
 */
export const DEFAULT_WORKSPACE_ROOT = "/workspace";

/** `.env` ne diyorsa o, yoksa kurulumun zaten bağladığı birim. */
export function workspaceRootFrom(source: Record<string, string | undefined>): string {
  const configured = source["WORKSPACE_ROOT"]?.trim() ?? "";
  return configured === "" ? DEFAULT_WORKSPACE_ROOT : configured;
}

export function caEnv(): Record<string, string> {
  const ca = process.env["NODE_EXTRA_CA_CERTS"]?.trim() ?? "";
  return ca === "" ? {} : { GIT_SSL_CAINFO: ca };
}

/**
 * BİR SEGMENT: harf/rakamla başlar, git yolunda güvenli karakterlerle sürer.
 *
 * Baştaki karakterin sınırlanması kasıtlı: `.` ile başlayan bir segment `..`
 * olabilir ve klon yolunu dizin ağacında yukarı taşırdı. Aynı gerekçe
 * `REPO_SEGMENT`te (scm-repos-service) de var ve bu ikisi ayrışmamalı.
 */
const PATH_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";

/**
 * DEPO ADININ İKİ MEŞRU ŞEKLİ — ve ikincisi uzun süre REDDEDİLİYORDU.
 *
 * GitHub/GitLab bir depoyu `owner/repo` diye adlandırır. Azure DevOps ise
 * `<proje>/_git/<repo>` der, ve sistemin geri kalanı depoyu ZATEN bu şekilde
 * taşıyor (`read-onboarding.ts`, Studio'nun seçim kutusu, tanı raporu). Ama
 * buradaki kontrol yalnız iki segmentli şekli tanıyordu:
 *
 *   ✓ Uguryldz/maestro-pilot
 *   ✗ BankaProje/_git/ekstre      ← ADO'nun kendi biçimi
 *
 * Sonuç sessizdi ve en kötü türdendi: `prepareWorkspace` fırlatıyor,
 * `checkoutOrNull` (bin/bff.ts) hatayı yakalayıp `null` dönüyor, koşu klonsuz
 * devam ediyor ve analiz kod tabanını HİÇ görmeden yazılıyor. Operatörün
 * gördüğü tek şey "analiz depoyla ilgisiz" oluyordu.
 *
 * `_git` ayracı sabit yazılıyor, serbest bir üçüncü segment olarak değil: ADO
 * yolunun ayracı odur ve serbest bırakmak, `a/b/c` gibi anlamı olmayan
 * yolların da komut satırına ulaşmasına izin verirdi.
 */
const REPO_NAME = new RegExp(`^${PATH_SEGMENT}\\/(?:_git\\/)?${PATH_SEGMENT}$`, "u");

export async function prepareWorkspace(request: CloneRequest): Promise<string> {
  const { repo, root, runId } = request;
  if (!REPO_NAME.test(repo)) {
    throw new WorkspaceError(`repository must be "owner/repo" or "project/_git/repo", got "${repo}"`);
  }
  const path = join(root, runId);
  const branch = request.branch?.trim() ?? "";
  if (branch !== "" && (!BRANCH_NAME.test(branch) || branch.includes(".."))) {
    throw new WorkspaceError(`branch name "${branch}" is not a plain git ref`);
  }

  if (await isCheckout(path)) return path;

  await mkdir(root, { recursive: true });
  // A half-finished clone from a killed attempt is not a checkout; clear it
  // rather than letting git refuse "destination path already exists".
  await rm(path, { recursive: true, force: true });

  const host = request.host ?? "github.com";
  const args = [
    // No credential prompts, ever: a clone that cannot authenticate must fail
    // in seconds rather than block an activity until its timeout.
    "-c",
    "credential.helper=",
    /**
     * Basic, not Bearer.
     *
     * GitHub's git-over-HTTPS endpoint reads a personal access token as the
     * PASSWORD half of HTTP Basic auth (`x-access-token:<pat>`); a `Bearer`
     * header is ignored and git then falls back to prompting, which fails as
     * "could not read Username for https://github.com" — a message that reads
     * like a missing credential rather than a wrongly-shaped one. Azure DevOps
     * and GitHub Enterprise accept the same form.
     */
    ...(request.token === undefined
      ? []
      : [
          "-c",
          `http.https://${host}/.extraheader=Authorization: Basic ${Buffer.from(
            `x-access-token:${request.token}`,
          ).toString("base64")}`,
        ]),
    "clone",
    "--depth",
    "1",
    "--single-branch",
    ...(branch === "" ? [] : ["--branch", branch]),
    `https://${host}/${repo}.git`,
    path,
  ];

  try {
    await run("git", args, {
      timeout: request.timeoutMs ?? 120_000,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GIT_TERMINAL_PROMPT: "0",
        ...caEnv(),
      },
    });
  } catch (cause) {
    // The message may carry the header; report the repository and the reason
    // shape, never the raw stderr.
    throw new WorkspaceError(`clone failed for ${repo}`, cause);
  }
  return path;
}

async function isCheckout(path: string): Promise<boolean> {
  try {
    const info = await stat(join(path, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}
