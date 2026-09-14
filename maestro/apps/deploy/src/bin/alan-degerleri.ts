/**
 * BİR ALANIN DEĞERLERİ GERÇEKTEN LİSTELENİYOR MU — ve hangi kaynaktan.
 *
 * Depo eşlemesinde "değer" kutusunun serbest metin olmaması isteniyor: operatör
 * yazmasın, listeden seçsin. Servis dört kaynağı sırayla dener (createmeta →
 * editmeta → alan bağlam seçenekleri → son 200 ticket'tan örnekleme) ve
 * hangisinin cevap verdiğini `source` olarak döner.
 *
 * Bu araç her seçilebilir alan için o zinciri koşturur ve sonucu yazar: kaç
 * değer geldi, hangi kaynaktan. Boş çıkan alan, kutunun o alanda serbest metne
 * düşeceği alandır — hangi alanların öyle olduğunu TAHMİN etmek yerine ÖLÇER.
 *
 * Yazma YOK, ajan çağrısı YOK.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { listJiraFields, listJiraFieldValues } from "@maestro/bff";
import { findJiraConnection } from "./jira-connection.js";

const projectKey = process.argv[2] ?? "OPS";

const db = createDb(process.env["DATABASE_URL"] ?? "");
const conns = await db.connection.findMany();
const jira = findJiraConnection(conns);

const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const token = await secrets.get(jira.secretRef);
/**
 * Prisma satırı `configJson` taşır, servis ise `config` okur (ConnectionRecord).
 * Ham satırı doğrudan geçirmek e-postayı boş bırakır ve Cloud'da Basic auth
 * kullanıcı adı boş gider: çağrı 200 döner ama YALNIZCA anonim görülebilen
 * alanları taşır — 52 alanlık bir Jira'da tek satır. Sessiz bir yarım cevap,
 * hata değil; bu yüzden dönüştürme burada açıkça yapılıyor.
 *
 * E-posta `findJiraConnection`tan geliyor: Cloud'da varlığı orada zorunlu
 * tutuluyor, yani buraya boş ulaşamaz.
 */
const connection = { ...jira, config: { email: jira.email } } as never;

const fieldsResult = await listJiraFields(connection, token, ((u: never, i: never) => fetch(u, i)) as never, projectKey);
if (!fieldsResult.ok) throw new Error(`Alan listesi okunamadı: ${JSON.stringify(fieldsResult)}`);
const fields = fieldsResult.fields;

console.log(`Proje ${projectKey} · ${fields.length} seçilebilir alan\n`);

console.log("alan".padEnd(34) + "değer".padEnd(8) + "kaynak");
console.log("─".repeat(64));

const bos: string[] = [];
for (const f of fields) {
  const res = await listJiraFieldValues(connection, projectKey, f.id, token, ((u: never, i: never) => fetch(u, i)) as never);
  const count = res.ok ? res.values.length : 0;
  const src = res.ok ? (res.source ?? "?") : "OKUNAMADI";
  console.log(`${f.name.slice(0, 32).padEnd(34)}${String(count).padEnd(8)}${src}`);
  if (count === 0) bos.push(f.name);
}

console.log("\n" + "─".repeat(64));
if (bos.length === 0) {
  console.log("✓ HER alanda değer listelendi — hiçbir alanda serbest metne düşülmüyor.");
} else {
  console.log(`⚠ ${bos.length} alanda değer gelmedi (kutu serbest metne düşer): ${bos.join(", ")}`);
}
await db.$disconnect();
