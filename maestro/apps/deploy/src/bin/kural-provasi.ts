/**
 * UÇTAN UCA PROVA — gerçek kurallar, gerçek Jira, gerçek karar mantığı.
 * Ajana HİÇBİR ŞEY gitmez, koşu açılmaz, kayıt yazılmaz.
 *
 * Motorun kendi fonksiyonlarını çağırır: `jqlFor` (taramanın sorgusu),
 * `flowDecisionFor` (hangi kural kazanır), `planFor` (hangi adımlar koşar),
 * `gatesFor` (hangi kapılar açılır).
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { jqlFor } from "../jira-discovery.js";
import { flowDecisionFor } from "@maestro/bff";
import { planFor, gatesFor } from "@maestro/workflows";
import { APPROVAL_GATE_STEPS } from "@maestro/contracts";
import { findJiraConnection, jiraHeaders, jiraUrl } from "./jira-connection.js";

/** Aramanın döndürdüğü gövdenin bu provanın okuduğu dilimi. */
interface SearchBody {
  readonly issues?: readonly {
    readonly key: string;
    readonly fields?: {
      readonly status?: { readonly name?: string; readonly id?: string };
      readonly issuetype?: { readonly name?: string; readonly id?: string };
      readonly assignee?: { readonly accountId?: string };
      readonly labels?: readonly string[];
    };
  }[];
}

const db = createDb(process.env["DATABASE_URL"] ?? "");
const rows = await db.connection.findMany();
const jira = findJiraConnection(rows);
const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }), db.connectorSecret);
const token = await secrets.get(jira.secretRef);
const H: Record<string, string> = jiraHeaders(jira, token);

const rules = await db.listeningRule.findMany({ where: { enabled: true } });
console.log(`PROVA — ${rules.length} etkin kural · ajan çağrısı YOK\n`);

for (const r of rules) {
  /**
   * Satırı kuralın ŞEKLİNE çeviriyoruz. `matchKind` DB'de düz metin (CHECK
   * kısıtıyla korunuyor) ama motorun tipi dört değerli birleşim — dönüşümü
   * burada, TEK yerde yapıp motorun kendi fonksiyonlarına gerçek şekli
   * veriyoruz; prova motorla aynı tipleri konuşmazsa provanın anlamı kalmaz.
   */
  const rule = {
    ruleId: r.ruleId, projectKey: r.projectKey, assigneeAccountId: r.assigneeAccountId,
    matchKind: r.matchKind as "status" | "issuetype" | "assigned" | "label",
    matchValue: r.matchValue,
    flowType: r.flowType as "analiz" | "duzeltme" | "gelistirme",
    priority: r.priority, enabled: r.enabled,
    allowedStatuses: (r.allowedStatusesJson as readonly string[] | null) ?? null,
    statusMap: (r.statusMapJson as Record<string, string> | null) ?? null,
    gateSteps: (r.gateStepsJson as { steps: (typeof APPROVAL_GATE_STEPS)[number][]; ownerless?: boolean } | null) ?? null,
  };
  console.log(`━━ kural: ${rule.matchKind}="${rule.matchValue}" · akış=${rule.flowType} ━━`);

  // 1) Taramanın kuracağı sorgu
  const jql = jqlFor(rule);
  if (jql === null) { console.log("  ✗ JQL kurulamadı (bot hesabı yok)\n"); continue; }
  const res = await fetch(jiraUrl(jira, `/search/jql?jql=${encodeURIComponent(jql)}&fields=key,status,issuetype,assignee,labels&maxResults=20`), { headers: H });
  const body = (await res.json()) as SearchBody;
  const found = body.issues ?? [];
  console.log(`  1. Tarama    → ${found.length} ticket bulundu`);

  // 2) Her ticket için gerçek eşleşme kararı
  let matched = 0;
  const örnekler: string[] = [];
  for (const i of found) {
    const ticket = {
      projectKey: r.projectKey,
      status: i.fields?.status?.name ?? null,
      statusId: i.fields?.status?.id ?? null,
      issueType: i.fields?.issuetype?.name ?? null,
      issueTypeId: i.fields?.issuetype?.id ?? null,
      assignee: i.fields?.assignee?.accountId ?? null,
      labels: i.fields?.labels ?? null,
    };
    const d = flowDecisionFor([rule], ticket, undefined);
    if (d.flow !== null) { matched += 1; if (örnekler.length < 3) örnekler.push(i.key); }
  }
  console.log(`  2. Eşleşme   → ${matched}/${found.length} ticket kurala düştü${örnekler.length ? "  (" + örnekler.join(", ") + ")" : ""}`);

  // 3) Hangi adımlar koşar
  const plan = planFor(rule.flowType);
  const adımlar = [
    "2 tamlık", "2b soru", "3ö keşif", "3 analiz+plan",
    ...(plan.analysisGate ? ["4/5 analiz onayı"] : []),
    ...(plan.engineering ? ["6a kod", "6c doğrulama", "10b PR", "13 merge"] : ["13 teslim"]),
  ];
  console.log(`  3. Adımlar   → ${adımlar.join(" → ")}`);

  // 4) Hangi kapılar açılır (orta risk varsayımı)
  // DB `{steps:[…]}` saklıyor, workflow düz dizi alıyor — dönüşüm alım
  // yolunda yapılıyor (`resolveGateSteps`). Prova aynı şekli kurmalı.
  const seçili = rule.gateSteps === null || rule.gateSteps === undefined ? null : rule.gateSteps.steps ?? null;
  const kapılar = gatesFor("orta", seçili);
  // Motor kapıları İKİ AYRI yerde okuyor: analiz kapıları (4/5) analiz
  // dalında, kod kapıları (9/11/12) yalnız mühendislik dalında. Analiz
  // akışında mühendislik dalına HİÇ gidilmiyor, yani seçili olsalar da
  // açılmıyorlar — prova bunu ham liste gibi göstermemeli.
  const analizK = plan.analysisGate ? kapılar.filter((g) => g === "4" || g === "5") : [];
  const kodK = plan.engineering ? kapılar.filter((g) => g === "9" || g === "11" || g === "12") : [];
  const açık: readonly string[] = [...analizK, ...kodK];
  const ölü = kapılar.filter((g) => !açık.includes(g));
  console.log(`  4. Kapılar   → ${açık.length === 0 ? "hiçbiri (onaysız akar)" : açık.join(", ")}` +
    (ölü.length ? `   [seçili ama bu akışta açılmaz: ${ölü.join(", ")}]` : ""));

  // 5) Statü taşıma
  const sm = rule.statusMap;
  console.log(`  5. Statü     → ${sm === null ? "taşıma yok, yalnız yorum" : JSON.stringify(sm)}`);

  // 6) Hangi depo açılır
  const rm = r.repoMapJson;
  console.log(`  6. Depo      → ${rm === null || rm === undefined ? "proje bağlamasının varsayılanı" : JSON.stringify(rm).slice(0, 120)}\n`);
}
await db.$disconnect();
