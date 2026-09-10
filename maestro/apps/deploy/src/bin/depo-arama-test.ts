/**
 * TICKET METNİYLE DEPO ARAMA — GERÇEKTEN ÇALIŞIYOR MU.
 *
 * Arama zinciri üç kademelidir (`repo-search-service.ts`) ve hangisinin
 * cevap verdiği kurulumdan kuruluma değişir: ADO Code Search bir eklentidir,
 * dosya ağacı yalnız ADO'da vardır, ad eşleşmesi her yerde çalışır. "Arama
 * çalışıyor mu" sorusunun cevabı bu yüzden tek kelime değil — HANGİ kademe,
 * KAÇ aday, hangi sırayla.
 *
 * Bu araç o zinciri gerçek bağlantıyla koşturur ve her kademenin ne döndüğünü
 * yazar. Ticket açmaz, koşu başlatmaz, kredi harcamaz, hiçbir şey klonlamaz.
 *
 * Kullanım:
 *   depo-arama-test "ticket metni"  [proje]
 */
import { createDb } from "@maestro/db";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { isScmConnectionKind, listScmRepos, searchRepos, searchTermsFrom, matchByName } from "@maestro/bff";

const text = process.argv[2];
const project = process.argv[3];
if (text === undefined || text.trim() === "") {
  console.error('Kullanım: depo-arama-test "<ticket metni>" [proje]');
  process.exit(2);
}

const db = createDb(process.env["DATABASE_URL"] ?? "");
const conns = await db.connection.findMany();
const scm = conns.find((c) => c.enabled !== false && isScmConnectionKind(c.kind));
if (scm === undefined) throw new Error("Kod deposu bağlantısı yok — arama yapılamaz.");

const secrets = new EncryptedSecretStore(
  resolveMasterKey({ envValue: process.env["CONNECTOR_MASTER_KEY"], isProduction: false }),
  db.connectorSecret,
);
const token = scm.secretRef === null ? null : await secrets.get(scm.secretRef).catch(() => null);
const connection = { ...scm, config: scm.configJson } as never;
const http = ((u: never, i: never) => fetch(u, i)) as never;

console.log(`bağlantı : ${scm.id} (${scm.kind})`);
console.log(`metin    : ${text}`);
console.log(`proje    : ${project ?? "(hepsi)"}\n`);

// 1) Terimler — aramanın gerçekte ne aradığı.
const terms = searchTermsFrom(text);
console.log(`━━ 1. ARANACAK TERİMLER (${terms.length}) ━━`);
console.log(`  ${terms.join(", ")}`);
console.log(`  (dolgu kelimeler ve salt rakamlar elendi)\n`);

// 2) Aday depolar — aramanın baktığı küme.
const listed = await listScmRepos(connection, token, http).catch(() => ({ ok: false as const }));
const repos = listed.ok ? listed.repos.map((r) => r.fullName) : [];
console.log(`━━ 2. ADAY DEPOLAR ━━`);
console.log(`  bağlantıda görünen: ${repos.length}`);
if (project !== undefined) {
  const inProject = repos.filter((r) => r.split("/")[0] === project);
  console.log(`  "${project}" projesinde: ${inProject.length}`);
}
console.log();

// 3) Zincirin kendisi.
console.log("━━ 3. ARAMA ━━");
const result = await searchRepos(connection, token, { text, ...(project === undefined ? {} : { project }), repos }, http);
if (!result.ok) {
  console.log(`  ✗ arama cevap veremedi: ${result.messageKey}`);
  await db.$disconnect();
  process.exit(1);
}
const kademe = {
  "code-search": "ADO Code Search (içerik araması — en isabetli)",
  "file-tree": "dosya ağacı (yollar okundu — eklenti gerekmez)",
  "repo-names": "depo adı (son çare)",
}[result.source];
console.log(`  kademe : ${kademe}`);
console.log(`  aday   : ${result.hits.length}\n`);

if (result.hits.length === 0) {
  console.log("  Hiçbir depo eşleşmedi — koşu proje bağlamasının deposuna düşer.");
} else {
  for (const [i, hit] of result.hits.slice(0, 10).entries()) {
    const örnek = hit.files.length === 0 ? "" : `  ← ${hit.files.slice(0, 2).join(", ")}`;
    console.log(`  ${String(i + 1).padStart(2)}. ${hit.repo.padEnd(40)} ${String(hit.matches).padStart(4)} eşleşme${örnek}`);
  }
}

// 4) Motorun VERECEĞİ karar — beraberlik kuralı dahil.
console.log("\n━━ 4. KOŞUNUN SEÇECEĞİ DEPO ━━");
const best = result.hits[0];
const second = result.hits[1];
if (best === undefined) {
  console.log("  (yok) — proje bağlamasının deposu kullanılır.");
} else if (second !== undefined && second.matches === best.matches) {
  console.log(`  (yok) — BERABERLİK: "${best.repo}" ve "${second.repo}" aynı puanda (${best.matches}).`);
  console.log("  Arama hangisi olduğunu bilmiyor; seçim yapılmaz ve proje bağlamasına düşülür.");
  console.log("  Yanlış depoyu emin gibi sunmaktansa hiç sunmamak yeğdir.");
} else {
  console.log(`  → ${best.repo}  (${best.matches} eşleşme, kademe: ${result.source})`);
}
await db.$disconnect();
