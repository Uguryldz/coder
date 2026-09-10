/**
 * BİR DEPO GERÇEKTEN İNİYOR MU — motorun KENDİ klonlama koduyla.
 *
 * "Repo indiriliyor mu" sorusu sahada üç kez soruldu ve üçünde de cevabı ancak
 * bir koşuyu baştan sona çalıştırıp beklemekle bulabildik. Oysa koşu, klon
 * adımına gelmeden ÖNCE model çağrısı yapan adımlarda takılabiliyor (kredi
 * bitmesi, model seçilmemiş olması) — o zaman "indirme çalışmıyor" görünüyor
 * ama sorun indirmede değil.
 *
 * Bu araç o iki soruyu ayırır: klonlama zincirini TEK BAŞINA, model çağrısı
 * olmadan koşturur. `prepareWorkspace` gerçek koşunun çağırdığı fonksiyonun ta
 * kendisidir; jeton `SCM_TOKEN_REF`'ten aynı şekilde çözülür ve konteynerden
 * DIŞARI ÇIKMAZ.
 *
 * Kullanım:  depo-indir-test <owner/repo> [dal]
 *
 * Model çağrısı YOK, kredi harcanmaz, Jira'ya yazılmaz.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { prepareWorkspace, checkedOutBranch } from "../stores/workspace-prepare.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
const run = promisify(execFile);

/**
 * Bayraklar konumsal argümanlardan AYRILIR.
 *
 * `depo-indir-test <repo> --sakla` çağrısı `--sakla`yı dal adı sanıp
 * "not a plain git ref" ile düşüyordu: dal kontrolü doğru çalışıyordu ama
 * yanlış şeye bakıyordu. Bayrakları önce eleyip geriye kalanı konumsal
 * okumak, bu sınıfın tamamını kapatır.
 */
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const repo = args[0];
const branch = args[1]?.trim() ?? "";
if (repo === undefined) {
  console.error("Kullanım: depo-indir-test <owner/repo> [dal]");
  process.exit(2);
}

const root = process.env["WORKSPACE_ROOT"]?.trim() ?? "";
if (root === "") {
  console.error("✗ WORKSPACE_ROOT tanımlı DEĞİL — koşular klon açamaz, analiz depoyu görmeden yapılır.");
  console.error("  Bu, indirme zincirinin kopuk olduğu tek noktadır ve kodla değil ORTAMLA düzelir.");
  process.exit(3);
}
console.log(`WORKSPACE_ROOT = ${root}`);

const db = createDb(process.env["DATABASE_URL"] ?? "");
const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const tokenRef = process.env["SCM_TOKEN_REF"]?.trim() ?? "";
if (tokenRef === "") console.log("⚠ SCM_TOKEN_REF boş — yalnız herkese açık depolar inebilir.");
const token = tokenRef === "" ? undefined : await secrets.get(tokenRef);
const scmHost = process.env["SCM_HOST"]?.trim() ?? "";

const runId = `indirme-testi-${Date.now()}`;
console.log(`Klonlanıyor: ${repo}${branch === "" ? "" : ` (dal: ${branch})`} …`);
const started = Date.now();
let path: string;
try {
  path = await prepareWorkspace({
    repo,
    root,
    runId,
    ...(branch === "" ? {} : { branch }),
    ...(scmHost === "" ? {} : { host: scmHost }),
    ...(token === undefined ? {} : { token }),
  });
} catch (error) {
  console.error(`✗ KLON BAŞARISIZ: ${String(error)}`);
  /**
   * `prepareWorkspace` ham stderr'i BİLEREK yutar: git komut satırında jeton
   * taşıyan bir Authorization başlığı var ve stderr onu yankılayabilir. Ama o
   * zaman geriye "clone failed" kalıyor, ki bu "depo yok", "jeton yetkisiz" ve
   * "ağ kapalı" hallerini tek cümlede birleştirir — teşhis edilemez.
   *
   * Burada `cause` açılıp MASKELENEREK yazılıyor: jetonun kendisi ve Basic
   * başlığı sabit bir damgayla değiştiriliyor, kalan metin (git'in gerçek
   * gerekçesi) görünür kalıyor.
   */
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    const ham = String((cause as { stderr?: unknown }).stderr ?? cause);
    const temiz = ham
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gu, "Basic ***")
      .replace(/x-access-token:[^@\s]*/gu, "x-access-token:***")
      .replace(/:\/\/[^@\s]*@/gu, "://***@");
    console.error(`  git diyor ki: ${temiz.trim().split("\n").slice(0, 6).join("\n  ")}`);
  }
  await db.$disconnect();
  process.exit(1);
}
const saniye = ((Date.now() - started) / 1000).toFixed(1);

/** Klonun GERÇEKTEN istenen depo olduğunu origin'den doğrula — ad benzerliği yetmez. */
const { stdout: origin } = await run("git", ["-C", path, "remote", "get-url", "origin"], { timeout: 10_000 });
const { stdout: sayım } = await run("sh", ["-c", `find ${JSON.stringify(path)} -type f -not -path '*/.git/*' | wc -l`], { timeout: 60_000 });
const { stdout: head } = await run("git", ["-C", path, "log", "-1", "--format=%h %s"], { timeout: 10_000 });
const { stdout: üst } = await run("sh", ["-c", `ls ${JSON.stringify(path)} | head -12`], { timeout: 10_000 });

console.log(`\n✓ KLON AÇILDI (${saniye} sn)`);
console.log(`  yol    : ${path}`);
console.log(`  origin : ${origin.trim().replace(/:\/\/[^@]*@/u, "://***@")}`);
console.log(`  dal    : ${(await checkedOutBranch(path)) ?? "-"}`);
console.log(`  HEAD   : ${head.trim()}`);
console.log(`  dosya  : ${sayım.trim()}`);
console.log(`  üst dizin:\n${üst.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}`);

if (process.argv.includes("--sakla")) {
  console.log(`\n(klon SAKLANDI: ${path})`);
} else {
  await rm(path, { recursive: true, force: true });
  console.log(`\n(klon silindi — saklamak için --sakla)`);
}
await db.$disconnect();
