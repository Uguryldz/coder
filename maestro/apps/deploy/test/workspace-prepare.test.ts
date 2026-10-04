import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  caEnv,
  checkedOutBranch,
  cloneFailureDetail,
  DEFAULT_WORKSPACE_ROOT,
  prepareWorkspace,
  workspaceRootFrom,
  WorkspaceError,
} from "../src/stores/workspace-prepare.js";
const sh = promisify(execFile);

/**
 * The checkout step 3ö reads.
 *
 * These exercise the parts that do NOT need a network: the repository-name
 * guard, reuse of an existing checkout, and the refusal path. The clone itself
 * is one `git clone` call; what breaks in practice is the surrounding logic —
 * a retried activity re-cloning, or a malformed name reaching the command
 * line.
 */

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maestro-ws-"));
  made.push(dir);
  return dir;
}

describe("prepareWorkspace", () => {
  /**
   * AZURE DEVOPS'UN KENDİ BİÇİMİ KABUL EDİLİR.
   *
   * Sistemin geri kalanı bir ADO deposunu ZATEN `<proje>/_git/<repo>` diye
   * taşıyor (`read-onboarding.ts`, Studio'nun seçim kutusu, tanı raporu) ama
   * buradaki isim kontrolü yalnız iki segmentli şekli tanıyordu. Hata sessizdi
   * ve en kötü türdendi: `checkoutOrNull` yakalayıp `null` dönüyor, koşu
   * klonsuz devam ediyor, analiz kod tabanını hiç görmeden yazılıyordu.
   */
  it("accepts Azure DevOps' project/_git/repo form", async () => {
    const dir = await root();
    const error = await prepareWorkspace({
      repo: "BankaProje/_git/ekstre",
      root: dir,
      runId: "run-ado",
      host: "127.0.0.1:1",
      timeoutMs: 5_000,
    }).catch((cause: unknown) => cause);

    // Ağ yok, yani klon başarısız — ama BİÇİM yüzünden değil. Ayrım burada:
    // reddedilen bir ad "must be" der, denenip düşen bir klon "clone failed".
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toContain("clone failed");
    expect((error as WorkspaceError).message).not.toContain("must be");
  });

  it("still refuses names that could climb the directory tree", async () => {
    // Genişletme güvenliği bozmamalı: `_git` SABİT bir ayraç, serbest bir
    // üçüncü segment değil — serbest bırakmak `a/../b` gibi yolları da komut
    // satırına taşırdı.
    const dir = await root();
    for (const repo of ["../etc/passwd", "a/../b", "org/proje/repo", "x/_git/../y", "a//b"]) {
      const error = await prepareWorkspace({ repo, root: dir, runId: "run-bad" }).catch((c: unknown) => c);
      expect(error, repo).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).message, repo).toContain("must be");
    }
  });

  it("refuses a repository name that is not owner/repo", async () => {
    // The value reaches a command line. A name with a slash too many — or a
    // shell metacharacter — must be rejected before it gets there.
    for (const bad of ["maestro-pilot", "a/b/c", "own er/repo", "repo;rm -rf /", ""]) {
      await expect(prepareWorkspace({ repo: bad, root: await root(), runId: "r1" })).rejects.toBeInstanceOf(
        WorkspaceError,
      );
    }
  });

  it("reuses an existing checkout instead of cloning again", async () => {
    // Temporal re-runs an activity after a worker crash. Re-cloning would turn
    // every retry into a fresh network fetch of a repository already on disk.
    const dir = await root();
    const existing = join(dir, "run-1");
    await mkdir(join(existing, ".git"), { recursive: true });
    await writeFile(join(existing, "README.md"), "already here");

    const path = await prepareWorkspace({ repo: "owner/repo", root: dir, runId: "run-1" });

    expect(path).toBe(existing);
  });

  it("reports the repository when the clone fails, not the raw stderr", async () => {
    // A token travels in an `http.extraHeader`. The failure message must name
    // what could not be cloned without echoing the command that carried it.
    const dir = await root();
    const error = await prepareWorkspace({
      repo: "maestro-test/does-not-exist",
      root: dir,
      runId: "run-2",
      host: "127.0.0.1:1",
      timeoutMs: 5_000,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toContain("maestro-test/does-not-exist");
    expect((error as WorkspaceError).message).not.toContain("extraheader");
  });

  /**
   * BOŞ `NODE_EXTRA_CA_CERTS` KLONU BOZMAMALI.
   *
   * Bu dal `=== undefined` ile bakıyordu ve canlıda sessizce yanlış cevap
   * verdi: compose değişkeni `${NODE_EXTRA_CA_CERTS:-}` ile geçirir, yani hiç
   * tanımlanmamış bir değişken konteynere BOŞ DİZE olarak girer — `undefined`
   * olmaz. O zaman `GIT_SSL_CAINFO=""` yazılıyor, git var olmayan bir dosyayı
   * CA paketi sanıyor ve HER klon şununla düşüyordu:
   *
   *   fatal: unable to access '...': Problem with the SSL CA cert
   *
   * Kurumsal CA taşımayan olağan bir kurulumda klonun hiç çalışmamasının
   * sebebi buydu; hata sertifikayı işaret ettiği için yanlış yerde arandı.
   *
   * Test ağa çıkmaz: yerel bir depoyu `file://` ile klonlar. Ölçtüğü şey
   * TLS değil, `GIT_SSL_CAINFO`'nun boş değerle HİÇ yazılmaması — env'i
   * bozan bir değişiklik bu klonu da düşürür.
   */
  /**
   * BOŞ `NODE_EXTRA_CA_CERTS` KLONU BOZMAMALI.
   *
   * Bu dal `=== undefined` ile bakıyordu ve canlıda sessizce yanlış cevap
   * verdi: compose değişkeni `${NODE_EXTRA_CA_CERTS:-}` ile geçirir, yani hiç
   * tanımlanmamış bir değişken konteynere BOŞ DİZE olarak girer — `undefined`
   * olmaz. O zaman `GIT_SSL_CAINFO=""` yazılıyor, git var olmayan bir dosyayı
   * CA paketi sanıyor ve HER klon şununla düşüyordu:
   *
   *   fatal: unable to access '...': Problem with the SSL CA cert
   *
   * Kurumsal CA taşımayan olağan bir kurulumda klonun hiç çalışmamasının
   * sebebi buydu; hata sertifikayı işaret ettiği için yanlış yerde arandı.
   *
   * Test AĞA ÇIKMAZ ve `prepareWorkspace`'i çağırmaz — çünkü ölçülecek şey
   * git'in TLS davranışı değil, git'e VERİLEN ortam. Erişilemeyen bir host'ta
   * git CA'ya hiç bakmaz (ölçüldü: bağlantı hatası önce gelir), yani süreç
   * üzerinden ayırt edilemez. Ayırt edilebilen tek şey env'in kendisidir:
   * boş/boşluklu değerde `GIT_SSL_CAINFO` anahtarı HİÇ BULUNMAMALI, gerçek
   * bir yolda ise o yolu taşımalı.
   */
  describe("git ortamındaki CA yolu", () => {
    const withCa = <T,>(value: string | undefined, fn: () => T): T => {
      const before = process.env["NODE_EXTRA_CA_CERTS"];
      if (value === undefined) delete process.env["NODE_EXTRA_CA_CERTS"];
      else process.env["NODE_EXTRA_CA_CERTS"] = value;
      try {
        return fn();
      } finally {
        if (before === undefined) delete process.env["NODE_EXTRA_CA_CERTS"];
        else process.env["NODE_EXTRA_CA_CERTS"] = before;
      }
    };

    it("omits GIT_SSL_CAINFO when the variable is absent, empty or only spaces", () => {
      // Üçü de "kurumsal CA yok" demektir; hiçbiri git'e boş bir yol vermemeli.
      expect(withCa(undefined, caEnv)).toEqual({});
      expect(withCa("", caEnv)).toEqual({});
      expect(withCa("   ", caEnv)).toEqual({});
    });

    it("passes a real path through, trimmed", () => {
      expect(withCa("/etc/maestro/kurum-ca.pem", caEnv)).toEqual({ GIT_SSL_CAINFO: "/etc/maestro/kurum-ca.pem" });
      expect(withCa("  /etc/maestro/kurum-ca.pem  ", caEnv)).toEqual({ GIT_SSL_CAINFO: "/etc/maestro/kurum-ca.pem" });
    });
  });
});

/**
 * KLON KÖKÜ ELLE TANIMLANMAZ.
 *
 * Bu yol bir dönem yalnız `.env`'den okunuyordu ve tanımsızken keşif SESSİZCE
 * kapalıydı: koşu klon açmıyor, analiz kod tabanını hiç görmeden yazılıyor,
 * bunu söyleyen tek satır yok. Oysa tanımlanacak bir şey yoktu — her kurulum
 * bff ve worker'a `/workspace` birimini zaten bağlıyor, tam da klonlar için.
 *
 * `.env` artık yalnızca ÜSTÜNE YAZMAK için: birimini başka yere bağlamış bir
 * kurulum kendi yolunu söyler, geri kalan hiçbir şey yazmaz.
 */
describe("klon kökü", () => {
  it("falls back to the volume every install already mounts", () => {
    expect(workspaceRootFrom({})).toBe(DEFAULT_WORKSPACE_ROOT);
    // Compose değişkeni `${WORKSPACE_ROOT:-}` ile geçirir: tanımsız bir
    // değişken konteynere BOŞ DİZE olarak girer, `undefined` olmaz. Boş ile
    // yok aynı şeydir ve ikisi de varsayılana düşmelidir.
    expect(workspaceRootFrom({ WORKSPACE_ROOT: "" })).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(workspaceRootFrom({ WORKSPACE_ROOT: "   " })).toBe(DEFAULT_WORKSPACE_ROOT);
  });

  it("lets an install that mounted the volume elsewhere say so", () => {
    expect(workspaceRootFrom({ WORKSPACE_ROOT: "/veri/klonlar" })).toBe("/veri/klonlar");
    expect(workspaceRootFrom({ WORKSPACE_ROOT: "  /veri/klonlar  " })).toBe("/veri/klonlar");
  });
});

describe("environment branch", () => {
  it("refuses a branch name that is not a plain git ref before touching the network", async () => {
    for (const bad of ["-x", "a b", "../main", "$(rm)"]) {
      await expect(
        prepareWorkspace({ repo: "maestro-test/repo", root: await root(), runId: "r1", branch: bad }),
      ).rejects.toBeInstanceOf(WorkspaceError);
    }
  });

  it("reads the branch a checkout is on, and null for a directory that is not a repository", async () => {
    const dir = await root();
    const repo = join(dir, "r1");
    await mkdir(repo, { recursive: true });
    await sh("git", ["-C", repo, "init", "-q", "-b", "develop"]);
    await sh("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "ilk"]);
    expect(await checkedOutBranch(repo)).toBe("develop");
    expect(await checkedOutBranch(dir)).toBeNull();
  });
});

/**
 * KLON HATASININ GEREKÇESİ MESAJIN İÇİNDEDİR — VE JETON İÇİNDE DEĞİLDİR.
 *
 * İki şey aynı anda doğru olmalı ve bir dönem yalnız biri doğruydu:
 *
 *  1. Ham stderr olduğu gibi geçemez: klon komut satırı `Authorization: Basic
 *     <jeton>` taşır ve git bunu yankılayabilir. Sızarsa jeton loglara, koşu
 *     defterine ve denetim kaydına yazılır.
 *  2. Ama sebep de kaybolamaz. Yutulduğunda geriye "clone failed for X"
 *     kalıyordu — "depo yok", "jeton yetkisiz", "CA bozuk" ve "boş depo"
 *     hallerini tek cümlede birleştiren, teşhis edilemez bir mesaj. Gerekçeyi
 *     açan kod vardı ama YALNIZ iki teşhis aracında; koşu yolu `String(error)`
 *     yazıyordu ve operatör arızanın olduğu koşuda hiçbir şey göremiyordu.
 *
 * Çözüm susmak değil MASKELEMEKTİ, ve maskelemenin tek bir kopyası olmalı.
 */
describe("klon hatası: sebep görünür, sır görünmez", () => {
  const JETON = "Z2hwX2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MTIzNA==";

  it("git'in gerekçesi mesajın İÇİNDEDİR — cause'u açmak gerekmez", () => {
    const error = new WorkspaceError("clone failed for owner/repo", {
      stderr: "remote: Repository not found.\nfatal: repository not found",
    });
    // Koşu yolu `String(error)` yazar; sebep orada olmalı.
    expect(String(error)).toContain("Repository not found");
    expect(String(error)).toContain("clone failed for owner/repo");
  });

  it("dört ayrı arıza dört ayrı cümle verir — hepsi 'clone failed' değil", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["remote: Repository not found.", "Repository not found"],
      ["fatal: Authentication failed for 'https://host/x.git'", "Authentication failed"],
      ["fatal: unable to access: SSL certificate problem: unable to get local issuer", "SSL certificate"],
      ["warning: You appear to have cloned an empty repository.", "empty repository"],
    ];
    const messages = cases.map(([stderr]) =>
      String(new WorkspaceError("clone failed for owner/repo", { stderr })),
    );
    for (const [index, [, expected]] of cases.entries()) {
      expect(messages[index]).toContain(expected);
    }
    // Ve dördü birbirinden AYIRT EDİLEBİLİR olmalı — asıl iddia bu.
    expect(new Set(messages).size).toBe(cases.length);
  });

  it("Basic başlığındaki jeton DAMGALANIR", () => {
    const error = new WorkspaceError("clone failed for owner/repo", {
      stderr: `fatal: could not read Authorization: Basic ${JETON}`,
    });
    expect(String(error)).not.toContain(JETON);
    expect(String(error)).toContain("Basic ***");
  });

  it("URL içine gömülü jeton DAMGALANIR", () => {
    for (const stderr of [
      `fatal: unable to access 'https://x-access-token:${JETON}@github.com/o/r.git/'`,
      `fatal: unable to access 'https://kullanici:${JETON}@git.banka.local/o/r.git/'`,
    ]) {
      const message = String(new WorkspaceError("clone failed for owner/repo", { stderr }));
      expect(message, stderr).not.toContain(JETON);
    }
  });

  it("gerekçe yoksa mesaj eskisi gibi kalır", () => {
    expect(String(new WorkspaceError("clone failed for owner/repo"))).toBe(
      "WorkspaceError: clone failed for owner/repo",
    );
  });

  it("çok satırlı stderr kırpılır — log satırı defteri boğmaz", () => {
    const stderr = Array.from({ length: 40 }, (_, i) => `satır ${i}`).join("\n");
    const message = String(new WorkspaceError("clone failed for owner/repo", { stderr }));
    expect(message).toContain("satır 0");
    expect(message).not.toContain("satır 30");
  });

  it("maskeleme tek kaynaktan — cloneFailureDetail aynı kuralı uygular", () => {
    expect(cloneFailureDetail({ stderr: `Basic ${JETON}` })).toBe("Basic ***");
    expect(cloneFailureDetail(undefined)).toBe("");
  });
});
