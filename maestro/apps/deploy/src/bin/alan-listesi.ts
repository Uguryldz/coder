/**
 * DEPO EŞLEMESİNDE HANGİ ALANLAR SEÇİLEBİLİR — ve seçilemiyorsa NEDEN.
 *
 * Dinleme kuralındaki "depoyu ticket'taki bir alana göre seç" kutusu Jira'nın
 * TÜM alanlarını göstermez; `normalizeFieldList` bir eleme yapar. Eleme sahada
 * iki kez yanlış anlaşıldı ("alanım listede yok, sistem bozuk"), çünkü elenen
 * alanın NEDEN elendiği hiçbir yerde yazmıyordu.
 *
 * Bu araç o kapıyı şeffaf yapar: bağlantıdaki her alanı çeker, `normalizeFieldList`
 * ile aynı kararı verir ve elenen her alanın yanına GEREKÇESİNİ yazar.
 *
 * Yazma YOK, ajan çağrısı YOK.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { normalizeFieldList } from "@maestro/adapter-jira";

interface RawField {
  readonly id?: string;
  readonly name?: string;
  readonly custom?: boolean;
  readonly schema?: { readonly type?: string; readonly custom?: string };
}



const db = createDb(process.env["DATABASE_URL"] ?? "");
const conns = await db.connection.findMany();
const jira = conns.find((c) => c.kind === "jira_cloud" || c.kind === "jira_dc");
if (jira === undefined) throw new Error("Jira bağlantısı yok.");
if (jira.secretRef === null) throw new Error("Jira bağlantısının jetonu yok.");

const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const token = await secrets.get(jira.secretRef);
const cfg = (jira.configJson as Record<string, unknown> | null) ?? {};
const email = typeof cfg["email"] === "string" ? cfg["email"] : "";
const base = jira.baseUrl.replace(/\/+$/u, "");
const auth =
  jira.kind === "jira_cloud"
    ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
    : `Bearer ${token}`;

const res = await fetch(`${base}/rest/api/3/field`, { headers: { authorization: auth, accept: "application/json" } });
if (!res.ok) throw new Error(`Jira alan listesi okunamadı: HTTP ${res.status}`);
const raw = (await res.json()) as RawField[];

const kept = normalizeFieldList(raw);
const keptIds = new Set(kept.map((f) => f.id));

console.log(`Jira'daki toplam alan: ${raw.length}`);
console.log(`Depo eşlemesinde SEÇİLEBİLİR: ${kept.length}\n`);

console.log("━━ SEÇİLEBİLİR ALANLAR ━━");
for (const f of kept) {
  console.log(`  ${f.custom ? "özel " : "sistem"} · ${f.name.padEnd(32)} ${f.id}${f.type === null ? "" : `  (${f.type})`}`);
}

console.log("\n━━ ELENENLER ve GEREKÇESİ ━━");
for (const entry of raw) {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (id === "" || name === "" || keptIds.has(id)) continue;
  const custom = entry.custom === true || id.startsWith("customfield_");
  const customType = entry.schema?.custom ?? null;
  const reason = !custom
    ? "sistem alanı: her ticket'ta değişen sayaç/zaman damgası ya da eşlenecek ayrık değeri olmayan serbest metin"
    : `Jira'nın kendi iç alanı (${customType ?? "tip bilinmiyor"})`;
  console.log(`  ${name.padEnd(32)} ${id.padEnd(24)} → ${reason}`);
}
await db.$disconnect();
