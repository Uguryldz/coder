import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "./src/stores/encrypted-secret.js";
const db: any = createDb(process.env["DATABASE_URL"] ?? "");
const rows = await db.connection.findMany();
const jira = rows.find((c: any) => c.kind === "jira_cloud");
const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }), db.connectorSecret);
const token = await secrets.get(jira.secretRef);
const email = (jira.configJson as any)?.email ?? "";
const H: any = { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, accept: "application/json" };
const base = jira.baseUrl.replace(/\/+$/, "");

const r = await fetch(`${base}/rest/api/3/project/OPS/statuses`, { headers: H });
const b: any = await r.json();
const all = new Map<string, string>();
for (const t of Array.isArray(b) ? b : []) {
  for (const s of t.statuses ?? []) all.set(s.name, s.statusCategory?.name ?? "?");
}
console.log(`OPS projesindeki statüler (${all.size}):`);
for (const [n, c] of all) console.log(`   ${n.padEnd(24)} [${c}]`);

const rules = await db.listeningRule.findMany({ where: { projectKey: "OPS" } });
console.log(`\nOPS dinleme kuralları (${rules.length}):`);
for (const x of rules) {
  console.log(`   ${String(x.id).padEnd(26)} ${x.matchKind}="${x.matchValue}" akış=${x.flowType ?? "-"} etkin=${x.enabled}`);
  console.log(`      statüKapısı=${JSON.stringify(x.allowedStatusesJson)} statüTaşıma=${JSON.stringify(x.statusMapJson)} kapılar=${JSON.stringify(x.gateStepsJson)}`);
}
await db.$disconnect();
