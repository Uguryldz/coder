/**
 * UÇTAN UCA PROVA — MODEL VARMIŞ GİBİ, MODELE GİTMEDEN.
 *
 * "Sistem çalışmıyor" sorusunun cevabı bugüne kadar bir koşuyu baştan sona
 * izlemeyi gerektiriyordu, ve koşu model çağrısında takılırsa ondan SONRAKİ
 * halkalar hiç denenmiyordu. Sahada tam olarak bu oldu: klon, keşif ve depo
 * seçimi onarıldı ama hiçbiri tetiklenmedi, çünkü koşu adım 2'de ölüyordu.
 *
 * Bu araç zinciri model çağrısı OLMADAN koşturur — her halkayı gerçek kodla,
 * gerçek Jira ve gerçek depoyla sınar, yalnız modelin yerine sabit bir cevap
 * koyar. Böylece "model olsaydı ne olurdu" sorusu, modele para ödemeden ve
 * kotaya dokunmadan cevaplanır.
 *
 * SINANAN HALKALAR
 *   1. Tarama      — JQL gerçek Jira'ya sorulur
 *   2. Eşleşme     — gerçek kural mantığı, gerçek ticket alanları
 *   3. Depo seçimi — eşleme / kod araması / bağlama zinciri
 *   4. Envanter    — seçilen appId kayıtlı mı
 *   5. Klon        — depo GERÇEKTEN indirilir
 *   6. Okuma       — kod gerçekten okunur (CLI koltuğu ya da dosya özeti)
 *
 * Yazma YOK: koşu açılmaz, Jira'ya yazılmaz, kredi harcanmaz. Açtığı klonu
 * siler.
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { prepareWorkspace, workspaceRootFrom } from "../stores/workspace-prepare.js";
import { isScmConnectionKind, listScmRepos, searchRepos } from "@maestro/bff";
import { jqlFor } from "../jira-discovery.js";
import { flowDecisionFor } from "@maestro/bff";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

interface SearchBody {
  readonly issues?: readonly {
    readonly key: string;
    readonly fields?: {
      readonly summary?: string;
      readonly status?: { readonly name?: string; readonly id?: string };
      readonly issuetype?: { readonly name?: string; readonly id?: string };
      readonly assignee?: { readonly accountId?: string };
      readonly labels?: readonly string[];
    };
  }[];
}

const db = createDb(process.env["DATABASE_URL"] ?? "");
const conns = await db.connection.findMany();
const jira = conns.find((c) => c.kind === "jira_cloud" || c.kind === "jira_dc");
if (jira?.secretRef == null) throw new Error("Jira bağlantısı ya da jetonu yok.");
const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const jiraToken = await secrets.get(jira.secretRef);
const email = ((jira.configJson as Record<string, unknown> | null)?.["email"] as string | undefined) ?? "";
const base = jira.baseUrl.replace(/\/+$/u, "");
const H = { authorization: `Basic ${Buffer.from(`${email}:${jiraToken}`).toString("base64")}`, accept: "application/json" };

const scm = conns.find((c) => c.enabled !== false && isScmConnectionKind(c.kind));
const scmToken = scm?.secretRef == null ? null : await secrets.get(scm.secretRef).catch(() => null);
const scmConn = scm === undefined ? null : ({ ...scm, config: scm.configJson } as never);
const http = ((u: never, i: never) => fetch(u, i)) as never;
const root = workspaceRootFrom(process.env);

const apps = new Set((await db.application.findMany()).map((a) => a.appId));
const bindings = await db.jiraProjectBinding.findMany();
const rules = await db.listeningRule.findMany({ where: { enabled: true } });

console.log(`UÇTAN UCA PROVA — ${rules.length} etkin kural · MODEL ÇAĞRISI YOK · yazma YOK\n`);

let toplam = 0;
let tam = 0;

for (const r of rules) {
  const rule = {
    ruleId: r.ruleId, projectKey: r.projectKey, assigneeAccountId: r.assigneeAccountId,
    matchKind: r.matchKind as "status" | "issuetype" | "assigned" | "label",
    matchValue: r.matchValue, flowType: r.flowType as "analiz" | "duzeltme" | "gelistirme",
    priority: r.priority, enabled: r.enabled,
    allowedStatuses: (r.allowedStatusesJson as readonly string[] | null) ?? null,
    statusMap: null, gateSteps: null,
  };
  console.log(`━━ kural: ${rule.matchKind}="${rule.matchValue}" · akış=${rule.flowType} ━━`);

  const jql = jqlFor(rule);
  if (jql === null) { console.log("  ✗ JQL kurulamadı (bot hesabı yok)\n"); continue; }
  const res = await fetch(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key,summary,status,issuetype,assignee,labels&maxResults=5`, { headers: H });
  const found = ((await res.json()) as SearchBody).issues ?? [];
  console.log(`  1. Tarama    → ${found.length} ticket`);

  for (const issue of found) {
    toplam += 1;
    const f = issue.fields ?? {};
    const ticket = {
      projectKey: r.projectKey,
      status: f.status?.name ?? null, statusId: f.status?.id ?? null,
      issueType: f.issuetype?.name ?? null, issueTypeId: f.issuetype?.id ?? null,
      assignee: f.assignee?.accountId ?? null, labels: f.labels ?? null,
    };
    const decision = flowDecisionFor([rule], ticket, undefined);
    if (decision.flow === null) { console.log(`  · ${issue.key}: kurala DÜŞMEDİ`); continue; }

    // ── 3. Depo seçimi: eşleme → arama → bağlama, alım zinciriyle aynı sıra ──
    const map = r.repoMapJson as { field?: string; entries?: { value: string; appId: string }[] } | null;
    let appId: string | null = null;
    let nasil = "";
    if (map?.field === "*") { appId = map.entries?.[0]?.appId ?? null; nasil = "kural (sabit)"; }
    else if (map?.field != null && map.field !== "?" && map.entries != null) {
      const text = (f.labels ?? []).join(", ");
      const hit = map.entries.find((e) => text.toLocaleLowerCase("tr").includes(e.value.toLocaleLowerCase("tr")));
      if (hit !== undefined) { appId = hit.appId; nasil = `kural (alan: ${map.field})`; }
    }
    if (appId === null && scmConn !== null) {
      const listed = await listScmRepos(scmConn, scmToken, http).catch(() => ({ ok: false as const }));
      const repos = listed.ok ? listed.repos.map((x) => x.fullName) : [];
      const sr = await searchRepos(scmConn, scmToken, { text: f.summary ?? issue.key, repos }, http);
      if (sr.ok && sr.hits.length > 0) {
        const best = sr.hits[0]!; const second = sr.hits[1];
        if (second === undefined || second.matches !== best.matches) { appId = best.repo; nasil = `kod araması (${sr.source})`; }
        else nasil = "arama BERABERLİK → seçim yok";
      }
    }
    if (appId === null) {
      const b = bindings.find((x) => x.projectKey === r.projectKey);
      appId = ((b?.defaultsJson as Record<string, unknown> | null)?.["appId"] as string | undefined) ?? null;
      if (appId !== null) nasil = nasil === "" ? "proje bağlaması (varsayılan)" : `${nasil} → bağlama`;
    }
    if (appId === null) { console.log(`  · ${issue.key}: DEPO YOK — koşu açılmaz`); continue; }

    // ── 4. Envanter ──
    if (!apps.has(appId)) { console.log(`  · ${issue.key}: ${appId} envanterde YOK → koşu açılmaz`); continue; }

    // ── 5. Klon ──
    const runId = `prova-${issue.key}`;
    let path: string;
    try {
      path = await prepareWorkspace({ repo: appId, root, runId, ...(scmToken === null ? {} : { token: scmToken }) });
    } catch (e) {
      console.log(`  · ${issue.key}: ${appId} ← ${nasil}\n      ✗ KLON: ${String(e).slice(0, 110)}`);
      continue;
    }

    // ── 6. Okuma: kod GERÇEKTEN okunuyor mu ──
    let dosya = 0; let ornek = "";
    try {
      const { stdout } = await run("git", ["-C", path, "ls-files"], { timeout: 30_000, maxBuffer: 8e6 });
      const skip = /(^|\/)(node_modules|dist|build|target|vendor|\.git)\/|\.(png|jpe?g|gif|svg|ico|pdf|zip|jar|class|lock)$/iu;
      const files = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !skip.test(l));
      dosya = files.length;
      const first = files.find((x) => /\.(ts|js|java|cs|py|go|rb|php)$/iu.test(x)) ?? files[0];
      if (first !== undefined) {
        const text = await readFile(join(path, first), "utf8").catch(() => "");
        ornek = `${first} → ${(text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 56)}`;
      }
    } catch { /* okuma başarısız: dosya 0 kalır */ }
    await rm(path, { recursive: true, force: true });

    const ok = dosya > 0;
    if (ok) tam += 1;
    console.log(`  · ${issue.key}: ${appId} ← ${nasil}`);
    console.log(`      ${ok ? "✓" : "✗"} klon+okuma: ${dosya} dosya${ornek === "" ? "" : `  ${ornek}`}`);
  }
  console.log();
}

console.log("─".repeat(64));
console.log(`SONUÇ: ${tam}/${toplam} ticket için zincir UÇTAN UCA tamam (kod okundu).`);
console.log("Model çağrısı yapılmadı; bu adımdan sonrası modele bağlıdır.");
await db.$disconnect();
