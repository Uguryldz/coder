/**
 * MİNİ KEŞİF TESTİ — kodun gerçekten incelendiğini kanıtlar.
 *
 * OpenRouter'a HİÇ gitmez: keşif oturumu CLI koltuğunu (claude-sub) kullanır,
 * o da abonelikten çalışır. Yani kredi harcanmaz.
 *
 * Gerçek koşunun 3ö adımının yaptığının aynısı: klonu aç, salt-okunur ajan
 * oturumunda depoyu okut, bulguyu göster.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findJiraConnection, jiraHeaders, jiraUrl } from "./jira-connection.js";
const run = promisify(execFile);

const db = createDb(process.env["DATABASE_URL"] ?? "");
const ticket = process.argv[2] ?? "OPS-119";

const r = await db.workflowRun.findFirst({ where: { ticketKey: ticket } });
if (r === null) { console.log(`${ticket}: koşu yok`); await db.$disconnect(); process.exit(1); }
console.log(`${ticket} · adım ${r.step} · depo ${r.appId ?? "-"}`);
if (r.workspacePath === "") { console.log("✗ çalışma alanı BOŞ — klon açılmamış"); await db.$disconnect(); process.exit(1); }
console.log(`✓ klon: ${r.workspacePath}\n`);

// Ticket'ın gerçek metnini al — ajan bunu görecek
const rows = await db.connection.findMany();
const jira = findJiraConnection(rows);
const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }), db.connectorSecret);
const token = await secrets.get(jira.secretRef);
const H = jiraHeaders(jira, token);
const ir = await fetch(jiraUrl(jira, `/issue/${ticket}?fields=summary,description`), { headers: H });
const ib = (await ir.json()) as { fields?: { summary?: string; description?: unknown } };
const flat = (n: unknown): string => {
  if (typeof n !== "object" || n === null) return "";
  const o = n as Record<string, unknown>;
  if (o["type"] === "text") return String(o["text"] ?? "");
  const kids = Array.isArray(o["content"]) ? (o["content"] as unknown[]) : [];
  return kids.map(flat).join("") + (o["type"] === "paragraph" ? "\n" : "");
};
const özet = ib.fields?.summary ?? "";
const açıklama = flat(ib.fields?.description).trim();
console.log(`TALEP: ${özet}`);
console.log(`${açıklama.slice(0, 300)}\n`);

const görev = `Bu çalışma dizinindeki depoyu SALT OKUNUR incele. Hiçbir dosyayı değiştirme.

TALEP: ${özet}
${açıklama}

Çıktın kısa olsun, üç başlıkla:
1. DEPO — hangi teknoloji, kaç dosya, ana dizinler
2. GEREKSİNİM → KOD — her gereksinim için kod tabanındaki karşılığı: dosya:satır yaz, yoksa "yok" de. YALNIZ gerçekten okuduğun yolları yaz.
3. NE DEĞİŞECEK — bu iş yapılacaksa hangi dosyalar değişir, hangi yeni dosya gerekir`;

console.log("── AJAN OTURUMU (CLI koltuğu · OpenRouter'a gitmez) ──\n");
const bin = process.env["CLAUDE_BIN_PATH"] ?? "claude";
const t0 = Date.now();
try {
  const { stdout } = await run(bin, ["-p", görev, "--allowed-tools", "Read", "Grep", "Glob"], {
    cwd: r.workspacePath, timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
  });
  console.log(stdout.trim());
  console.log(`\n✓ ${Math.round((Date.now() - t0) / 1000)} sn · kredi harcanmadı`);
} catch (e) {
  console.log(`✗ oturum başarısız: ${String(e).slice(0, 300)}`);
}
await db.$disconnect();
