/**
 * DEPO HAVUZU — organizasyonun kodunu indir, ömür boyu tut.
 *
 *   havuz durum              ne indi, ne kadar yer tutuyor, disk ne durumda
 *   havuz doldur [<önek>]    bağlantının gördüğü tüm depoları indir
 *   havuz guncelle           inen her aynayı `git fetch` ile tazele
 *   havuz unut <owner/repo>  BİR aynayı sil — tek silme yolu, ve operatörün
 *
 * Operatörün sözleşmesi "ben silene kadar kalsın" olduğu için otomatik silme
 * YOK: disk dolduğunda yeni ayna açılmaz (`poolBrake`), ama var olan hiçbir
 * ayna düşürülmez. Yer açmak `havuz unut` ile, bilerek yapılır.
 *
 * Yazma yalnız havuza; veritabanına ve Jira'ya dokunmaz, ajan çağırmaz.
 */
import { rm } from "node:fs/promises";
import { createDb } from "@maestro/db";
import { isScmConnectionKind, listScmRepos } from "@maestro/bff";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import {
  diskHeadroom,
  ensureMirror,
  mirrorPathFor,
  poolBrake,
  poolRootFrom,
  readInventory,
  upsertMirror,
  writeInventory,
} from "../stores/repo-pool.js";
import { cloneFailureDetail } from "../stores/workspace-prepare.js";

const command = process.argv[2] ?? "durum";
const argument = process.argv[3];
const poolRoot = poolRootFrom(process.env);

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * KLON HOST'U — bağlantının `baseUrl`inden TÜRETİLMEZ.
 *
 * Sahada ölçüldü: `baseUrl` API adresidir (`https://api.github.com`), klon
 * adresi değil (`github.com`). Ondan türetilen host `https://api.github.com/
 * owner/repo.git` üretiyor ve 57 deponun 57'si "unable to access" ile düştü.
 *
 * Üretimdeki klon yolu (`bin/bff.ts`, `bin/worker.ts`) bu soruyu `SCM_HOST`
 * ile cevaplıyor ve boşsa `prepareWorkspace` `github.com` varsayıyor. Havuz
 * AYNI kaynağı okur — ikinci bir türetme, ikinci bir ayrışma demek olurdu.
 */
function cloneHost(): string {
  const configured = process.env["SCM_HOST"]?.trim() ?? "";
  return configured === "" ? "github.com" : configured.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
}

const db = createDb(process.env["DATABASE_URL"] ?? "");

async function durum(): Promise<void> {
  const inventory = await readInventory(poolRoot);
  const headroom = diskHeadroom(poolRoot) ?? diskHeadroom("/");
  console.log(`━━ havuz: ${poolRoot} ━━`);
  if (headroom === null) {
    console.log("  disk: ÖLÇÜLEMEDİ (fren uygulanmaz)");
  } else {
    console.log(
      `  disk: ${gb(headroom.freeBytes)} boş / ${gb(headroom.totalBytes)} · ` +
        `%${(headroom.freeRatio * 100).toFixed(0)} · fren: ${poolBrake(headroom)}`,
    );
  }
  if (inventory.mirrors.length === 0) {
    console.log("  ayna YOK. `havuz doldur` ile indirin.");
    return;
  }
  const total = inventory.mirrors.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  console.log(`  ${inventory.mirrors.length} ayna · toplam ${gb(total)}\n`);
  for (const mirror of inventory.mirrors) {
    const size = mirror.bytes === null ? "?" : gb(mirror.bytes);
    const hata = mirror.lastError === undefined ? "" : `  ⚠ ${mirror.lastError}`;
    console.log(`  ${mirror.repo.padEnd(44)} ${size.padStart(9)}  tazelendi: ${mirror.fetchedAt}${hata}`);
  }
}

async function doldur(prefix: string | undefined): Promise<void> {
  const conns = (await db.connection.findMany()).filter((c) => isScmConnectionKind(c.kind));
  if (conns.length === 0) throw new Error("SCM bağlantısı yok — Panel → Ayarlar > Bağlantılar.");
  const secrets = new EncryptedSecretStore(
    resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
    db.connectorSecret,
  );

  let inventory = await readInventory(poolRoot);
  let indirilen = 0;
  let atlanan = 0;

  for (const connection of conns) {
    const host = cloneHost();
    console.log(`━━ bağlantı: ${connection.id} (${connection.kind}) · ${host} ━━`);
    if (connection.secretRef === null) {
      console.log("  ✗ jeton yok — atlandı\n");
      continue;
    }
    const token = await secrets.get(connection.secretRef);
    const listed = await listScmRepos(
      { ...connection, config: connection.configJson } as never,
      token,
      ((u: never, i: never) => fetch(u, i)) as never,
    );
    if (!listed.ok) {
      console.log(`  ✗ depo listesi okunamadı: ${JSON.stringify(listed)}\n`);
      continue;
    }
    const repos = listed.repos
      .map((r) => r.fullName)
      .filter((name) => prefix === undefined || name.startsWith(prefix));
    console.log(`  ${repos.length} depo${prefix === undefined ? "" : ` (önek: ${prefix})`}\n`);

    for (const repo of repos) {
      // Fren HER depo öncesi yeniden ölçülür: indirdikçe disk doluyor.
      const brake = poolBrake(diskHeadroom(poolRoot) ?? diskHeadroom("/"));
      if (brake === "refuse-all" || brake === "refuse-new") {
        console.log(`  ⛔ disk freni (${brake}) — kalan depolar indirilmedi.`);
        console.log("     Yer açmak için: havuz unut <owner/repo>");
        break;
      }
      if (brake === "warn") console.log("  ⚠ disk azalıyor.");

      const at = new Date().toISOString();
      try {
        const result = await ensureMirror({ poolRoot, host, repo, token });
        inventory = upsertMirror(inventory, {
          repo,
          host,
          clonedAt: result.created ? at : (inventory.mirrors.find((m) => m.repo === repo)?.clonedAt ?? at),
          fetchedAt: at,
          bytes: result.bytes,
        });
        await writeInventory(poolRoot, inventory);
        indirilen += 1;
        const nasil = result.created ? "indirildi" : "tazelendi";
        console.log(`  ✓ ${repo.padEnd(44)} ${nasil}${result.bytes === null ? "" : ` · ${gb(result.bytes)}`}`);
      } catch (error) {
        atlanan += 1;
        const sebep = cloneFailureDetail((error as { cause?: unknown }).cause) || String(error);
        inventory = upsertMirror(inventory, {
          repo,
          host,
          clonedAt: at,
          fetchedAt: at,
          bytes: null,
          lastError: sebep.slice(0, 300),
        });
        await writeInventory(poolRoot, inventory);
        console.log(`  ✗ ${repo.padEnd(44)} ${sebep.slice(0, 120)}`);
      }
    }
    console.log("");
  }
  console.log(`━━ bitti: ${indirilen} ayna hazır, ${atlanan} atlandı ━━`);
}

async function guncelle(): Promise<void> {
  const inventory = await readInventory(poolRoot);
  if (inventory.mirrors.length === 0) {
    console.log("Ayna yok — `havuz doldur` ile indirin.");
    return;
  }
  const conns = (await db.connection.findMany()).filter((c) => isScmConnectionKind(c.kind));
  const secrets = new EncryptedSecretStore(
    resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
    db.connectorSecret,
  );
  let updated = inventory;
  for (const mirror of inventory.mirrors) {
    const connection = conns.find(() => cloneHost() === mirror.host);
    const token =
      connection?.secretRef == null ? undefined : await secrets.get(connection.secretRef).catch(() => undefined);
    const at = new Date().toISOString();
    try {
      const result = await ensureMirror({ poolRoot, host: mirror.host, repo: mirror.repo, token });
      updated = upsertMirror(updated, { ...mirror, fetchedAt: at, bytes: result.bytes });
      console.log(`  ✓ ${mirror.repo}`);
    } catch (error) {
      const sebep = cloneFailureDetail((error as { cause?: unknown }).cause) || String(error);
      updated = upsertMirror(updated, { ...mirror, lastError: sebep.slice(0, 300) });
      console.log(`  ✗ ${mirror.repo}: ${sebep.slice(0, 120)}`);
    }
    await writeInventory(poolRoot, updated);
  }
}

async function unut(repo: string | undefined): Promise<void> {
  if (repo === undefined) throw new Error("Kullanım: havuz unut <owner/repo>");
  const inventory = await readInventory(poolRoot);
  const found = inventory.mirrors.filter((m) => m.repo === repo);
  if (found.length === 0) {
    console.log(`Havuzda böyle bir ayna yok: ${repo}`);
    return;
  }
  for (const mirror of found) {
    await rm(mirrorPathFor({ poolRoot, host: mirror.host, repo: mirror.repo }), {
      recursive: true,
      force: true,
    });
    console.log(`  ✓ silindi: ${mirror.host}/${mirror.repo}`);
  }
  await writeInventory(poolRoot, { mirrors: inventory.mirrors.filter((m) => m.repo !== repo) });
}

try {
  if (command === "durum") await durum();
  else if (command === "doldur") await doldur(argument);
  else if (command === "guncelle") await guncelle();
  else if (command === "unut") await unut(argument);
  else {
    console.error(`Bilinmeyen komut: ${command}`);
    console.error("Kullanım: havuz durum | doldur [<önek>] | guncelle | unut <owner/repo>");
    process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
