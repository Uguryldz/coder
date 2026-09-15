import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diskHeadroom,
  mirrorPathFor,
  poolBrake,
  poolRootFrom,
  readInventory,
  upsertMirror,
  writeInventory,
  type PoolInventory,
} from "../src/stores/repo-pool.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "havuz-"));
  temps.push(dir);
  return dir;
}

describe("havuz kökü çalışma alanının altındadır", () => {
  it("WORKSPACE_ROOT ayarlıysa onun altına kurulur", () => {
    expect(poolRootFrom({ WORKSPACE_ROOT: "/veri/alan" })).toBe("/veri/alan/repos");
  });

  it("ayarsızsa varsayılan çalışma alanının altına — İKİNCİ bir .env değişkeni YOK", () => {
    // `WORKSPACE_ROOT`un tanımsızken keşfi sessizce kapatması ölçülmüş bir
    // arızaydı. İkinci bir değişken eklemek o tuzağı çoğaltmak olurdu.
    expect(poolRootFrom({})).toBe("/workspace/repos");
    expect(poolRootFrom({ WORKSPACE_ROOT: "   " })).toBe("/workspace/repos");
  });
});

describe("ayna yolu — ADO'nun _git ayracı KORUNUR", () => {
  const poolRoot = "/workspace/repos";

  it("GitHub biçimi: owner/repo", () => {
    expect(mirrorPathFor({ poolRoot, host: "github.com", repo: "Uguryldz/maestro-platform" })).toBe(
      "/workspace/repos/github.com/Uguryldz/maestro-platform.git",
    );
  });

  it("ADO biçimi: proje/_git/repo — ayraç yol segmenti olarak kalır", () => {
    // `_git`i düşüren bir ayrıştırıcı, klonu sessizce yanlış adrese
    // yönlendiriyordu. Havuz yolu AYNI regex'ten türer, ikinci ayrıştırıcı yok.
    expect(mirrorPathFor({ poolRoot, host: "tfs.banka.local", repo: "BankaProje/_git/ekstre" })).toBe(
      "/workspace/repos/tfs.banka.local/BankaProje/_git/ekstre.git",
    );
  });

  it("host protokolü taşısa da yalnız ana adı kullanılır", () => {
    expect(mirrorPathFor({ poolRoot, host: "https://github.com", repo: "a/b" })).toBe(
      "/workspace/repos/github.com/a/b.git",
    );
  });

  it("host boşsa github.com varsayılır", () => {
    expect(mirrorPathFor({ poolRoot, host: "", repo: "a/b" })).toBe("/workspace/repos/github.com/a/b.git");
  });

  it.each([
    ["../../etc/passwd", "yukarı çıkan yol"],
    ["a/../../b", "gömülü .."],
    ["a", "tek segment"],
    ["a/b/c", "üç segment — _git değil"],
    ["", "boş"],
  ])("REDDEDER: %s (%s)", (repo) => {
    expect(() => mirrorPathFor({ poolRoot, host: "github.com", repo })).toThrow();
  });

  it("host dizin ağacında yukarı taşıyamaz", () => {
    expect(() => mirrorPathFor({ poolRoot, host: "../../kök", repo: "a/b" })).toThrow();
  });
});

describe("envanter bir kayıt defteridir, havuzun kendisi değil", () => {
  it("yazılır ve geri okunur", async () => {
    const poolRoot = await tempDir();
    const inventory: PoolInventory = {
      mirrors: [
        {
          repo: "Uguryldz/maestro-platform",
          host: "github.com",
          clonedAt: "2026-09-15T00:00:00.000Z",
          fetchedAt: "2026-09-15T01:00:00.000Z",
          bytes: 21_000_000,
        },
      ],
    };
    await writeInventory(poolRoot, inventory);
    expect(await readInventory(poolRoot)).toEqual(inventory);
  });

  it("dosya yoksa BOŞ envanter — hata değil", async () => {
    // Envanterin kaybolması aynaları kaybetmez: havuz diskteki dizinlerden
    // ibaret. Burada fırlatmak, kurtarılabilir bir durumu arızaya çevirirdi.
    expect(await readInventory(await tempDir())).toEqual({ mirrors: [] });
  });

  it("bozuk JSON da boş envanter", async () => {
    const poolRoot = await tempDir();
    await writeInventory(poolRoot, { mirrors: [] });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(poolRoot, "havuz.json"), "{ bozuk", "utf8");
    expect(await readInventory(poolRoot)).toEqual({ mirrors: [] });
  });

  it("aynı depo iki kez eklenmez — güncellenir", () => {
    const first = upsertMirror(
      { mirrors: [] },
      { repo: "a/b", host: "github.com", clonedAt: "1", fetchedAt: "1", bytes: 1 },
    );
    const second = upsertMirror(first, {
      repo: "a/b",
      host: "github.com",
      clonedAt: "1",
      fetchedAt: "2",
      bytes: 2,
    });
    expect(second.mirrors).toHaveLength(1);
    expect(second.mirrors[0]?.fetchedAt).toBe("2");
  });

  it("aynı ad farklı HOST'ta ayrı aynadır", () => {
    const one = upsertMirror(
      { mirrors: [] },
      { repo: "a/b", host: "github.com", clonedAt: "1", fetchedAt: "1", bytes: 1 },
    );
    const two = upsertMirror(one, {
      repo: "a/b",
      host: "tfs.banka.local",
      clonedAt: "1",
      fetchedAt: "1",
      bytes: 1,
    });
    expect(two.mirrors).toHaveLength(2);
  });
});

describe("disk freni — koşuyu değil HAVUZU kısıtlar", () => {
  const head = (freeRatio: number): { freeBytes: number; totalBytes: number; freeRatio: number } => ({
    freeBytes: Math.round(400_000_000_000 * freeRatio),
    totalBytes: 400_000_000_000,
    freeRatio,
  });

  it.each([
    [0.62, "ok"],
    [0.2, "ok"],
    [0.12, "warn"],
    [0.05, "refuse-new"],
    [0.02, "refuse-all"],
  ])("boş oran %s → %s", (ratio, expected) => {
    expect(poolBrake(head(ratio))).toBe(expected);
  });

  it("ÖLÇÜLEMEYEN disk 'ok' sayılır — ölçemediğimiz şeye göre fren uydurulmaz", () => {
    // Fail-closed davranmak burada havuzu tamamen durdururdu; ve fren zaten
    // bir iyileştirme, bir güvenlik kapısı değil.
    expect(poolBrake(null)).toBe("ok");
  });

  it("boş alanın yarısını aşan bir ayna açılmaz", () => {
    const h = head(0.5); // 200 GB boş
    expect(poolBrake(h, 150_000_000_000)).toBe("refuse-new");
    expect(poolBrake(h, 50_000_000_000)).toBe("ok");
  });

  it("gerçek bir dizinde ölçüm çalışır", () => {
    const measured = diskHeadroom("/");
    expect(measured).not.toBeNull();
    expect(measured!.totalBytes).toBeGreaterThan(0);
    expect(measured!.freeRatio).toBeGreaterThan(0);
    expect(measured!.freeRatio).toBeLessThanOrEqual(1);
  });

  it("olmayan yol için null — ve null hiçbir şeyi durdurmaz", () => {
    expect(diskHeadroom("/boyle-bir-yol-yok-12345")).toBeNull();
  });
});

/**
 * GERÇEK GIT İLE — ayna kurulur, koşu ondan okur, ayna BOZULMAZ.
 *
 * Üç seçenek ölçülmüştü: `git worktree` aynanın obje deposuna yazıyor
 * (reddedildi), `clone --reference` koşuyu aynaya kalıcı bağımlı bırakıyor,
 * `clone file://` ise 0.085 sn'de bağımsız bir kopya veriyor. Bu blok
 * seçilenin gerçekten öyle davrandığını ölçer.
 */
describe("ensureMirror — gerçek git", () => {
  async function sourceRepo(): Promise<string> {
    const dir = await tempDir();
    const sh = async (...args: string[]): Promise<void> => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("git", ["-C", dir, ...args], {
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" },
      });
    };
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["init", "-q", "-b", "main", dir]);
    await sh("config", "user.email", "t@t");
    await sh("config", "user.name", "t");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "README.md"), "havuz denemesi\n", "utf8");
    await sh("add", "-A");
    await sh("commit", "-qm", "ilk");
    return dir;
  }

  it("aynayı kurar, ikinci çağrı GÜNCELLER (yeniden klonlamaz)", async () => {
    const src = await sourceRepo();
    const poolRoot = await tempDir();
    const { ensureMirror } = await import("../src/stores/repo-pool.js");

    // `file://` kaynak: ağ yok, ama kod yolu gerçek git klonunun aynısı.
    const req = { poolRoot, host: "yerel.test", repo: "sahibi/depo" };
    const first = await ensureMirror({ ...req, sourceUrl: `file://${src}` } );
    expect(first.created).toBe(true);
    expect(first.bytes).toBeGreaterThan(0);

    const second = await ensureMirror({ ...req, sourceUrl: `file://${src}` } );
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("BOŞ depo ayna olarak KURULMAZ — kalıcı bir yanlış cevap bırakmaz", async () => {
    const empty = await tempDir();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["init", "-q", "-b", "main", empty]);
    const poolRoot = await tempDir();
    const { ensureMirror } = await import("../src/stores/repo-pool.js");

    await expect(
      ensureMirror({ poolRoot, host: "yerel.test", repo: "bos/depo", sourceUrl: `file://${empty}` } ),
    ).rejects.toThrow(/empty/u);

    // Ve yarım dizin bırakmaz.
    const { access } = await import("node:fs/promises");
    await expect(access(join(poolRoot, "yerel.test", "bos", "depo.git"))).rejects.toThrow();
  });
});

/**
 * KOŞU AYNADAN OKUR — ve aynayı BOZMAZ.
 *
 * Bu, havuzun var olma sebebinin kanıtı: koşu ağa çıkmadan kod alır, ve
 * aldıktan sonra aynaya hiçbir şey yazamaz. `git worktree` seçeneği tam bu
 * testte reddedilmişti — worktree'nin obje deposu aynanın kendisi olduğu için
 * koşunun attığı commit aynaya giriyordu.
 */
describe("koşu aynadan klonlanır", () => {
  it("ağa çıkmadan çalışma alanı açar ve ayna temiz kalır", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { writeFile } = await import("node:fs/promises");
    const sh = promisify(execFile);

    // Kaynak depo
    const src = await tempDir();
    await sh("git", ["init", "-q", "-b", "main", src]);
    await sh("git", ["-C", src, "config", "user.email", "t@t"]);
    await sh("git", ["-C", src, "config", "user.name", "t"]);
    await writeFile(join(src, "kod.txt"), "havuzdan geldi\n", "utf8");
    await sh("git", ["-C", src, "add", "-A"]);
    await sh("git", ["-C", src, "commit", "-qm", "ilk"]);

    // Ayna
    const poolRoot = await tempDir();
    const { ensureMirror } = await import("../src/stores/repo-pool.js");
    const mirror = await ensureMirror({
      poolRoot,
      host: "yerel.test",
      repo: "sahibi/depo",
      sourceUrl: `file://${src}`,
    });

    // Koşu: aynadan, JETONSUZ, ağsız
    const { prepareWorkspace } = await import("../src/stores/workspace-prepare.js");
    const root = await tempDir();
    const workspace = await prepareWorkspace({
      repo: "sahibi/depo",
      root,
      runId: "kosu-1",
      host: "yerel.test",
      mirrorPath: mirror.path,
    });

    // Kod geldi.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(workspace, "kod.txt"), "utf8")).toBe("havuzdan geldi\n");

    // Koşu commit atıyor — ayna BUNU GÖRMEMELİ.
    await sh("git", ["-C", workspace, "config", "user.email", "t@t"]);
    await sh("git", ["-C", workspace, "config", "user.name", "t"]);
    await writeFile(join(workspace, "yeni.txt"), "koşunun yazdığı\n", "utf8");
    await sh("git", ["-C", workspace, "add", "-A"]);
    await sh("git", ["-C", workspace, "commit", "-qm", "koşu"]);
    const { stdout: sha } = await sh("git", ["-C", workspace, "rev-parse", "HEAD"]);

    await expect(
      sh("git", ["-C", mirror.path, "cat-file", "-t", sha.trim()]),
    ).rejects.toThrow();

    // Ve koşu aynaya BAĞIMLI değil: alternates dosyası yok.
    const { access } = await import("node:fs/promises");
    await expect(access(join(workspace, ".git", "objects", "info", "alternates"))).rejects.toThrow();
  });
});
