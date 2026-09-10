import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { caEnv, checkedOutBranch, prepareWorkspace, WorkspaceError } from "../src/stores/workspace-prepare.js";
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
