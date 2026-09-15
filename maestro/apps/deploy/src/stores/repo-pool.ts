import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { REPO_NAME, WorkspaceError, caEnv, workspaceRootFrom } from "./workspace-prepare.js";

const run = promisify(execFile);

/**
 * KALICI DEPO HAVUZU — organizasyonun kodu, ömür boyu, tek makinede.
 *
 * Operatörün şartı: "tüm organizasyonu indir, 35 repo varsa hepsini. İnen kod
 * o makinede ÖMÜR BOYU kalsın, ben silene kadar."
 *
 * Bugüne kadar klon KOŞU BAŞINA açılıyordu (`/workspace/<runId>`) ve koşuya
 * bağlıydı. Kalıcı disk vardı ama "proje havuzu" kavramı yoktu: aynı depo her
 * koşuda yeniden ağdan iniyordu.
 *
 * ── AYNA BARE, KOŞU KOPYA ──────────────────────────────────────────────────
 *
 * Havuz her depoyu `--mirror` (bare, tüm dallar) olarak tutar; koşular oradan
 * `file://` ile sığ klon alır. Üç seçenek ÖLÇÜLDÜ:
 *
 *  · `git worktree` — REDDEDİLDİ. Worktree'nin obje deposu AYNANIN KENDİSİDİR:
 *    bir mühendislik adımı commit atarsa objeler aynaya yazılır. Ölçüldü,
 *    yazdı. "Koşu aynayı bozmamalı" şartını ihlal ediyor.
 *  · `clone --reference` — çalışır ama koşu aynadan KALICI olarak bağımlı
 *    kalır (`objects/info/alternates`); ayna silinirse koşu sessizce bozulur.
 *  · `clone file://<ayna>` — SEÇİLEN. Ölçüldü: 0.085 sn, ayna temiz kaldı,
 *    alternates yok, koşu bağımsız, ve ağa hiç çıkılmıyor.
 *
 * `file://` şeması bilinçli: düz yol verilirse git hardlink kurar ve koşu ile
 * ayna aynı inode'ları paylaşır. Protokolü zorlamak kopyayı gerçek kopya yapar.
 *
 * ── SIĞ DEĞİL, TAM AYNA ────────────────────────────────────────────────────
 *
 * Ayna `--depth 1` DEĞİL: havuzun amacı "dal seçilebilsin, tekrar tekrar ağa
 * çıkılmasın". Sığ bir ayna `--branch <x>` isteyen bir koşuya cevap veremez ve
 * her seferinde ağa çıkar — havuzun varlık sebebini ortadan kaldırır.
 */

/** Havuzun kökü: çalışma alanının altında, `repos/`. */
export function poolRootFrom(source: Record<string, string | undefined>): string {
  return join(workspaceRootFrom(source), "repos");
}

/**
 * Bir deponun aynasının yolu: `<havuz>/<host>/<owner>/<repo>.git`.
 *
 * Host segmenti ŞART: `SCM_HOST` değiştirilebiliyor ve iki farklı host'ta aynı
 * `owner/repo` bulunabilir. ADO'nun `_git` ayracı yol segmenti olarak aynen
 * korunur — ayrıştırma `REPO_NAME` ile yapılır, İKİNCİ BİR AYRIŞTIRICI
 * YAZILMAZ: `_git`i düşüren ölçülmüş arıza (workspace-prepare.ts) dizin
 * şemasında yeniden doğmasın.
 */
export function mirrorPathFor(input: {
  readonly poolRoot: string;
  readonly host: string;
  readonly repo: string;
}): string {
  if (!REPO_NAME.test(input.repo)) {
    throw new Error(`repository must be "owner/repo" or "project/_git/repo", got "${input.repo}"`);
  }
  const host = input.host.trim() === "" ? "github.com" : input.host.trim().replace(/^https?:\/\//u, "");
  if (host.includes("/") || host.includes("..")) {
    throw new Error(`invalid host for pool path: "${input.host}"`);
  }
  return join(input.poolRoot, host, `${input.repo}.git`);
}

/** Bir aynanın envanterdeki satırı. */
export interface MirrorRecord {
  readonly repo: string;
  readonly host: string;
  /** İlk indirme anı (ISO). */
  readonly clonedAt: string;
  /** Son başarılı `fetch` anı (ISO); hiç yapılmadıysa `clonedAt`. */
  readonly fetchedAt: string;
  /** Diskteki yaklaşık boyut (bayt); ölçülemediyse `null`. */
  readonly bytes: number | null;
  /** Son hata — varsa; maskelenmiş, jeton taşımaz. */
  readonly lastError?: string;
}

export interface PoolInventory {
  readonly mirrors: readonly MirrorRecord[];
}

const INVENTORY_FILE = "havuz.json";

export async function readInventory(poolRoot: string): Promise<PoolInventory> {
  try {
    const raw = await readFile(join(poolRoot, INVENTORY_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const mirrors = (parsed as { mirrors?: unknown }).mirrors;
    return { mirrors: Array.isArray(mirrors) ? (mirrors as MirrorRecord[]) : [] };
  } catch {
    // Dosya yok ya da bozuk: boş envanter. Havuz DİSKTEKİ dizinlerden ibaret,
    // envanter yalnız bir kayıt defteri — kaybolması aynaları kaybetmez.
    return { mirrors: [] };
  }
}

export async function writeInventory(poolRoot: string, inventory: PoolInventory): Promise<void> {
  await mkdir(poolRoot, { recursive: true });
  await writeFile(join(poolRoot, INVENTORY_FILE), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

/** Envantere bir aynayı ekler ya da günceller (repo+host anahtarıyla). */
export function upsertMirror(inventory: PoolInventory, record: MirrorRecord): PoolInventory {
  const rest = inventory.mirrors.filter((m) => !(m.repo === record.repo && m.host === record.host));
  return { mirrors: [...rest, record].sort((a, b) => a.repo.localeCompare(b.repo)) };
}

/**
 * ── DİSK FRENİ ─────────────────────────────────────────────────────────────
 *
 * Fren havuzu kısıtlar, KOŞUYU DEĞİL. Dolu bir disk yüzünden hiçbir ticket
 * işlenmemesi, frenin engellemeye çalıştığı arızadan büyük bir arıza olurdu.
 *
 * Ve EN ESKİ AYNAYI ASLA OTOMATİK DÜŞÜRMEZ. Operatörün sözleşmesi "ben silene
 * kadar kalsın"; otomatik tahliye onu sessizce bozar ve bir sonraki koşu ağa
 * çıkıp yeniden indirir — yani disk baskısı altında sistem en çok ağ trafiği
 * üretir. Daha kötüsü: analiz ve tarama adımları boş/eksik bir çalışma alanını
 * "bulgu yok" diye okuyabiliyor; yer açmak için ayna düşürmek, o adımlara
 * sessiz bir yalan söyleme yoludur.
 */
export type PoolBrake = "ok" | "warn" | "refuse-new" | "refuse-all";

export interface DiskHeadroom {
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly freeRatio: number;
}

/** Diskin boş alanını ölçer; ölçemezse `null` — ve `null` "ok" sayılır. */
export function diskHeadroom(path: string): DiskHeadroom | null {
  try {
    const stat = statfsSync(path);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    if (totalBytes <= 0) return null;
    return { freeBytes, totalBytes, freeRatio: freeBytes / totalBytes };
  } catch {
    return null;
  }
}

/**
 * Freni verir. `headroom === null` ise `"ok"`: ÖLÇEMEDİĞİMİZ bir şeye göre
 * fren uydurmak, freni hiç koymamaktan kötüdür — ve bu kurulumda havuzu
 * tamamen durdururdu.
 */
export function poolBrake(headroom: DiskHeadroom | null, estimatedBytes = 0): PoolBrake {
  if (headroom === null) return "ok";
  if (headroom.freeRatio < 0.03) return "refuse-all";
  if (headroom.freeRatio < 0.08) return "refuse-new";
  // İstenen aynanın tahmini boyutu boş alanın yarısını aşıyorsa yeni ayna yok:
  // yarıda kalan bir klon diski doldurup hiçbir işe yaramaz.
  if (estimatedBytes > 0 && estimatedBytes > headroom.freeBytes / 2) return "refuse-new";
  if (headroom.freeRatio < 0.15) return "warn";
  return "ok";
}

/**
 * Jetonu KOMUT SATIRINA KOYMADAN veren git argümanları.
 *
 * Jeton `http.<host>/.extraheader` ile `-c` üzerinden geçer: `-c` geçicidir,
 * `.git/config`e YAZILMAZ. Bu ayrım havuzda koşu klonundan daha kritik — koşu
 * dizini geçiciydi, ayna ÖMÜR BOYU kalıyor. `origin` jetonsuz tutulur; jeton
 * her işlemde yeniden verilir.
 *
 * Basic, Bearer değil: GitHub jetonu HTTP Basic'in PAROLA yarısı olarak okur
 * (`x-access-token:<pat>`); `Bearer` yok sayılır ve git kullanıcı adı sormaya
 * düşer — "could not read Username" diye, eksik kimlik bilgisi gibi görünen
 * ama yanlış BİÇİMLENMİŞ bir kimlik bilgisi hatası.
 */
function authArgs(host: string, token: string | undefined): string[] {
  if (token === undefined || token.trim() === "") return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://${host}/.extraheader=Authorization: Basic ${basic}`];
}

const GIT_ENV = (): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_TERMINAL_PROMPT: "0",
  ...caEnv(),
});

export interface MirrorRequest {
  readonly poolRoot: string;
  readonly host: string;
  readonly repo: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  /**
   * Klonlanacak KAYNAK adresi — verilmezse `https://<host>/<repo>.git`.
   *
   * Testler yerel bir depoyu `file://` ile veriyor: ağ olmadan, ama kod yolu
   * gerçek klonun aynısı. Üretimde de bir kurulum aynayı başka bir aynadan
   * beslemek isteyebilir (hava boşluklu sahada USB'den gelen bir kopya).
   */
  readonly sourceUrl?: string;
}

export interface MirrorResult {
  readonly path: string;
  /** `true` ise ayna bu çağrıda İLK KEZ kuruldu. */
  readonly created: boolean;
  readonly bytes: number | null;
}

/** Aynada gerçekten commit var mı — `git clone` boş depoda da çıkış 0 verir. */
async function hasCommits(path: string): Promise<boolean> {
  try {
    /*
     * `--verify` ŞART. Onsuz `rev-parse HEAD` boş bir depoda da ÇIKIŞ 0 verir
     * ve çözemediği adı ("HEAD") olduğu gibi yazar — ölçüldü. Yani kontrol
     * sessizce her zaman "commit var" derdi, ve boş bir ayna ömür boyu
     * kurulurdu: koşuya "bu depoda kod yok" diye kalıcı bir yanlış cevap.
     */
    await run("git", ["-C", path, "rev-parse", "--verify", "HEAD"], {
      timeout: 15_000,
      env: GIT_ENV(),
    });
    return true;
  } catch {
    return false;
  }
}

async function isMirror(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, "HEAD"))).isFile();
  } catch {
    return false;
  }
}

/**
 * Aynayı VAR EDER: yoksa `--mirror` klonlar, varsa `fetch --prune` ile
 * günceller.
 *
 * BOŞ AYNA KURULMAZ. `git clone` erişilemeyen ya da boş bir depoda çıkış 0
 * verip dizin bırakabilir — ölçülmüş bir arıza. Koşu başına bu yanlış cevap bir
 * kez veriliyordu; KALICI bir ayna onu ömür boyu verirdi. Commit yoksa dizin
 * silinir ve hata fırlatılır, böylece envantere "boş depo" yazılabilir.
 */
export async function ensureMirror(request: MirrorRequest): Promise<MirrorResult> {
  const path = mirrorPathFor(request);
  const host = request.host.trim() === "" ? "github.com" : request.host.trim().replace(/^https?:\/\//u, "");
  const env = GIT_ENV();
  const timeout = request.timeoutMs ?? 600_000;

  /*
   * Var olan ayna GÜNCELLENİR — ama yalnız GERÇEKTEN bir ayna ise.
   *
   * `HEAD` dosyasının varlığı yetmez: commit'i olmayan bir dizin de `HEAD`
   * taşır. Böyle bir dizini "ayna" sayıp `fetch` dalına girmek, boş bir aynayı
   * ömür boyu korumak olurdu — ve boş ayna, koşuya "bu depoda kod yok" diye
   * kalıcı bir yanlış cevap verir.
   */
  if ((await isMirror(path)) && (await hasCommits(path))) {
    try {
      await run("git", [...authArgs(host, request.token), "-C", path, "fetch", "--prune"], {
        timeout,
        env,
      });
    } catch (cause) {
      throw new WorkspaceError(`mirror fetch failed for ${request.repo}`, cause);
    }
    return { path, created: false, bytes: await mirrorBytes(path) };
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await run(
      "git",
      [
        ...authArgs(host, request.token),
        "-c",
        "credential.helper=",
        "clone",
        "--mirror",
        request.sourceUrl ?? `https://${host}/${request.repo}.git`,
        path,
      ],
      { timeout, env },
    );
  } catch (cause) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw new WorkspaceError(`mirror clone failed for ${request.repo}`, cause);
  }

  if (!(await hasCommits(path))) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw new WorkspaceError(`repository is empty: ${request.repo}`);
  }
  return { path, created: true, bytes: await mirrorBytes(path) };
}

/** Aynanın diskteki boyutu; ölçülemezse `null` (envanterde bilgi, karar değil). */
async function mirrorBytes(path: string): Promise<number | null> {
  try {
    const { stdout } = await run("du", ["-sb", path], { timeout: 60_000 });
    const bytes = Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "", 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
