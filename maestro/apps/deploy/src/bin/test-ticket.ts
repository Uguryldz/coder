/**
 * UÇTAN UCA PROVA İÇİN GERÇEK BİR TICKET AÇAR.
 *
 * Depo eşlemesinin gerçekten çalıştığını kanıtlamanın tek yolu, kuralın
 * göreceği bir ticket'ı Jira'da AÇMAK ve klonun hangi depodan geldiğine
 * bakmaktır. Bunu elle yapmak her seferinde jeton çözmeyi, ADF gövdesi
 * kurmayı ve bot hesabını doğru yazmayı gerektiriyordu; üç kez yapıldı, üçünde
 * de ayrı bir yerde takıldı. Araç o üç adımı tek yere topluyor.
 *
 * Kullanım:
 *   test-ticket <etiket> "<özet>" ["<açıklama>"]
 *
 * Ticket her zaman `maestro-test` etiketini de taşır (kuralın tetikleyicisi)
 * ve bot hesabına atanır — yoksa tarama onu hiç görmez.
 *
 * ⚠ GERÇEK bir Jira ticket'ı açar. Ajan çağrısı yapmaz; onu tarama başlatır.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";

const label = process.argv[2];
const summary = process.argv[3];
const description = process.argv[4] ?? summary;
if (label === undefined || summary === undefined) {
  console.error('Kullanım: test-ticket <etiket> "<özet>" ["<açıklama>"]');
  process.exit(2);
}

const db = createDb(process.env["DATABASE_URL"] ?? "");
const conns = await db.connection.findMany();
const jira = conns.find((c) => c.kind === "jira_cloud");
if (jira === undefined || jira.secretRef === null) throw new Error("Jira Cloud bağlantısı ya da jetonu yok.");

const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const token = await secrets.get(jira.secretRef);
const cfg = (jira.configJson as Record<string, unknown> | null) ?? {};
const email = typeof cfg["email"] === "string" ? cfg["email"] : "";
const base = jira.baseUrl.replace(/\/+$/u, "");
const headers = {
  authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
  "content-type": "application/json",
  accept: "application/json",
};

/**
 * Bot hesabı ve proje, kuralın KENDİSİNDEN okunur — elle yazılan bir accountId
 * bir kez yanlış girildi ve ticket açıldı ama tarama onu hiç görmedi, çünkü
 * JQL `assignee in (...)` ile eliyordu. Kuralın kendi değeri kullanılırsa bu
 * tutarsızlık mümkün değil.
 */
const rule = await db.listeningRule.findFirst({ where: { enabled: true, matchKind: "label" } });
if (rule === null) throw new Error("Etikete bakan etkin bir dinleme kuralı yok.");

const body = {
  fields: {
    project: { key: rule.projectKey },
    issuetype: { name: "Görev" },
    assignee: { id: rule.assigneeAccountId },
    labels: [rule.matchValue, label],
    summary,
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: description }] }] },
  },
};

const res = await fetch(`${base}/rest/api/3/issue`, { method: "POST", headers, body: JSON.stringify(body) });
const out = (await res.json()) as { key?: string };
if (!res.ok) {
  console.error(`✗ Jira ticket'ı açılmadı: HTTP ${res.status} ${JSON.stringify(out).slice(0, 300)}`);
  await db.$disconnect();
  process.exit(1);
}
console.log(`✓ ${out.key} açıldı · proje=${rule.projectKey} · etiketler=[${rule.matchValue}, ${label}]`);
console.log(`  ${base}/browse/${out.key}`);

const map = rule.repoMapJson as { field?: string; entries?: { value: string; appId: string }[] } | null;
if (map?.entries !== undefined) {
  const hit = map.entries.find((e) => e.value.toLocaleLowerCase("tr") === label.toLocaleLowerCase("tr"));
  console.log(`  Eşleme beklentisi: ${hit === undefined ? "satır YOK → proje bağlamasının varsayılanı" : hit.appId}`);
}
await db.$disconnect();
