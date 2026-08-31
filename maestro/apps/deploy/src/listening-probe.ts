import type { ListeningProbeResult, ProbeTicket } from "@maestro/bff";
import type { DiscoveryRule, IssueSearcher } from "./jira-discovery.js";
import { classifyingFieldsOf, diagnosticJqlFor, jqlFor } from "./jira-discovery.js";

/**
 * "KURALI TEST ET" — bir kural taslağını Jira'ya sorup ne getirdiğini göstermek.
 *
 * Operatörün kendi cümlesi: "kontrol ekranı ver, loga gerek yok, dinlemede
 * filtre ayarlamak için". Bugüne kadar yeni yazılmış bir kuralın doğru olup
 * olmadığını öğrenmenin tek yolu onu KAYDEDİP bir tur beklemek ve konteyner
 * log'unu okumaktı; bu, sunucuda kabuk gerektirdiği için kural yazma yetkisi
 * verilen kişinin kendi işini doğrulayamaması demekti.
 *
 * BU BİR PROVA. Hiçbir koşu başlatmaz, hiçbir satır yazmaz — `discoverOnce`ın
 * `runIntake` çağıran yarısı burada yok, bilerek. Ekranın tek çıktısı bilgi.
 *
 * ÜÇ ŞEY, TURUN KENDİSİYLE AYNI OLMAK ZORUNDA, yoksa bu ekran test ettiğini
 * iddia ettiği şeyden başkasını test etmiş olur:
 *   1. JQL, `jqlFor` ile üretilir — kopyalanmaz, çağrılır.
 *   2. `fields` yalnız dört sınıflandırma alanı; `summary`/`description`
 *      istenmez, yani bu yol da hiç ticket METNİ taşımaz.
 *   3. Kapsam, BAĞLI projelerle sınırlıdır. Bu platformun Jira servis hesabı
 *      çoğu bankada ADMIN'dir; bağlanmamış bir projeye "sadece deneme" diye
 *      sorgu atmak, Maestro'yu hiç duymamış bir ekibin ticket'larını okumak
 *      demektir. `discoverOnce`ın `boundProjects` kapısıyla aynı gerekçe, aynı
 *      kaynak.
 *
 * EŞLEŞME YOKSA projedeki açık ticket'lar aynı sütunlarla getirilir. Asıl değer
 * burada: operatör "kuralım issuetype = Görev diyor ama Jira'da hepsi Task
 * yazıyor" ya da "hiçbiri bota atanmamış" diyebilsin.
 */

/** Karşılaştırma listesinde ve eşleşme tablosunda gösterilen en fazla ticket. */
export const PROBE_SAMPLE = 10;

export interface ProbeOptions {
  /** JQL arayabilen sürücü; sunulmuyorsa uç zaten 503 döner. */
  readonly search: IssueSearcher;
  /** Operatörün gerçekten bağladığı, CANLI projeler — kapsamın dış sınırı. */
  readonly boundProjects: () => Promise<readonly string[]>;
  /** Koşusu olan ticket anahtarları; eşleşenlerin yanına işaret konur. */
  readonly known: () => Promise<readonly string[]>;
}

export async function probeListeningRule(
  options: ProbeOptions,
  draft: Pick<
    DiscoveryRule,
    "projectKey" | "assigneeAccountId" | "matchKind" | "matchValue" | "allowedStatuses"
  >,
): Promise<ListeningProbeResult> {
  /**
   * BAĞLI PROJE KAPISI, ARAMADAN ÖNCE.
   *
   * Fail-closed, iki yönde: liste OKUNAMAZSA da denenmez. "Süz" ile "süzme"
   * arasında ikincisini seçmek, admin bir servis hesabıyla bankanın herhangi
   * bir projesine sorgu göndermek demek — geçici olarak hiç denememek doğru
   * cevap.
   */
  let bound: ReadonlySet<string>;
  try {
    bound = new Set(await options.boundProjects());
  } catch {
    return { ok: false, reason: "bindings_unreadable" };
  }
  if (!bound.has(draft.projectKey)) {
    return { ok: false, reason: "unbound_project" };
  }

  /**
   * `jqlFor` null derse arama YAPILMAZ — bot hesabı olmayan bir kural için
   * hesapsız bir sorgu projedeki HERKESİN ticket'ını kapsardı. Turun kendisi de
   * bu kuralı atlar; deneme onunla aynı cevabı vermeli, yoksa panelde çalışıyor
   * görünen bir kural sahada hiç aranmaz.
   */
  const jql = jqlFor({ ...draft, enabled: true });
  if (jql === null) {
    return { ok: false, reason: draft.matchKind === "label" ? "no_label" : "no_bot_account" };
  }

  const known = new Set(await options.known().catch(() => []));
  const read = async (query: string): Promise<readonly ProbeTicket[]> => {
    const page = await options.search.searchIssues({
      jql: query,
      maxResults: PROBE_SAMPLE,
      // Kuralın kendi sorgusuyla BİREBİR aynı dört alan — ticket metni yok.
      fields: ["status", "issuetype", "assignee", "labels"],
    });
    return page.issues.map((issue) => probeTicketOf(issue, known));
  };

  let matched: readonly ProbeTicket[];
  try {
    matched = await read(jql);
  } catch (error) {
    /**
     * Jira'nın reddi ADLANDIRILMIŞ bir cevaptır, 500 değil: en sık sebebi
     * projede okuma izni olmayan bir servis hesabı, ve operatörün göreceği şey
     * genel bir hata kutusu değil o cümle olmalı.
     */
    return { ok: false, reason: "search_failed", detail: messageOf(error) };
  }

  /**
   * Eşleşme varken karşılaştırma listesi çekilmez: gereksiz ikinci bir sorgu,
   * ve ekranda cevabı olan bir soruya ikinci bir tablo.
   */
  if (matched.length > 0) {
    return { ok: true, jql, matched, projectSample: [], sampleJql: null };
  }

  const sampleJql = diagnosticJqlFor(draft.projectKey);
  try {
    return { ok: true, jql, matched, projectSample: await read(sampleJql), sampleJql };
  } catch {
    /**
     * Karşılaştırma listesi bir KOLAYLIK; alınamaması denemenin başarısız
     * olması değildir. Operatör yine de "0 eşleşme" ve ürettiği JQL'i görür,
     * ki asıl sorusunun yarısı zaten odur.
     */
    return { ok: true, jql, matched, projectSample: [], sampleJql };
  }
}

/**
 * Bir arama satırını ekranın sütunlarına çevirir.
 *
 * Alanlar `classifyingFieldsOf` ile okunur — webhook yolunun, turun ve bu
 * ekranın aynı Jira belgesini aynı gramerle okuması için. Aynı belge için iki
 * el yazması okuyucu, iki yüzeyin aynı ticket'ı farklı sınıflandırmasının
 * kestirme yoludur.
 */
function probeTicketOf(issue: unknown, known: ReadonlySet<string>): ProbeTicket {
  const key = typeof (issue as { key?: unknown })?.key === "string" ? (issue as { key: string }).key : "";
  const fields = classifyingFieldsOf(issue);
  return {
    key,
    status: fields.status ?? null,
    issueType: fields.issueType ?? null,
    assignee: fields.assignee ?? null,
    labels: fields.labels ?? [],
    alreadyKnown: known.has(key),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
