/**
 * SCM BAĞLANTISINDA KAÇ DEPO GÖRÜNÜYOR — depo eşlemesi kutusunun kaynağı.
 *
 * Dinleme kuralındaki "uygulama (depo)" kutusu `Application` tablosuyla sınırlı
 * DEĞİLDİR: bağlantının erişebildiği TÜM depoları canlı okur, seçilen depo
 * kayıtlı değilse kural kaydedilirken projeye kaydedilir. Sahada bu iki küme
 * karıştırıldı ("100 depom var ama listede 2 tane çıkıyor"), çünkü hangisinin
 * nereden geldiği hiçbir yerde yazmıyordu.
 *
 * Bu araç iki kümeyi yan yana koyar: SCM'de görünen depolar ve bunlardan
 * hangilerinin `Application`'da kayıtlı olduğu.
 *
 * Yazma YOK, ajan çağrısı YOK.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { isScmConnectionKind, listScmRepos } from "@maestro/bff";

const db = createDb(process.env["DATABASE_URL"] ?? "");
const conns = await db.connection.findMany();
const scm = conns.filter((c) => isScmConnectionKind(c.kind));
if (scm.length === 0) throw new Error("SCM bağlantısı yok.");

const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const registered = new Set((await db.application.findMany()).map((a) => a.appId));

for (const connection of scm) {
  console.log(`━━ bağlantı: ${connection.id} (${connection.kind}) ━━`);
  if (connection.secretRef === null) {
    console.log("  ✗ jeton yok — okunamaz\n");
    continue;
  }
  const token = await secrets.get(connection.secretRef);
  const res = await listScmRepos({ ...connection, config: connection.configJson } as never, token, ((u: never, i: never) => fetch(u, i)) as never);
  if (!res.ok) {
    console.log(`  ✗ okunamadı: ${JSON.stringify(res)}\n`);
    continue;
  }
  const names = res.repos.map((r) => r.fullName).sort();
  const kayitli = names.filter((n) => registered.has(n));
  console.log(`  SCM'de görünen depo    : ${names.length}`);
  console.log(`  Application'da kayıtlı : ${kayitli.length}`);
  console.log(`  (kalan ${names.length - kayitli.length} depo da eşlemede SEÇİLEBİLİR — seçilince kaydedilir)\n`);
  for (const [i, n] of names.entries()) {
    console.log(`  ${String(i + 1).padStart(3)}. ${n}${registered.has(n) ? "   ✓ kayıtlı" : ""}`);
  }
  console.log();
}
await db.$disconnect();
