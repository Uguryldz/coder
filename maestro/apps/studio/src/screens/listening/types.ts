/**
 * Dinleme kuralları ekranının TEL TİPLERİ — `/studio/listening-rules` ve
 * komşu uçların cevap/gövde şekilleri, ekranın hiçbir parçasına bağlı olmadan.
 *
 * Form, tablo, deneme paneli ve tarama bandı ayrı dosyalarda; hepsi aynı
 * kuralı konuşuyor. Tipin tek yerde durması, "tabloda görünen alan formda
 * yok" türü ayrışmanın derleyicide yakalanması demek.
 */
import type { StatusMap } from "../common/status-map.ts";

export type FlowType = "analiz" | "duzeltme" | "gelistirme";

/**
 * Kuralın TETİKLEME TİPİ — BFF'in `MATCH_KINDS`i ve DB CHECK'i (0020, 0023).
 *
 * `assigned` hiçbir alanı karşılaştırmaz: kural, ticket bota verildiği için
 * ateşlenir. `matchValue`si sunucunun sabitlediği `*` literalidir; yalnız tekil
 * tetikleyici indeksi (proje, bot) başına bir kural tutsun diye taşınır,
 * ekranda gösterilmez ve karşılaştırılmaz.
 */
export type MatchKind = "status" | "issuetype" | "assigned" | "label";
export const MATCH_KINDS: readonly MatchKind[] = ["status", "issuetype", "assigned", "label"];
export const FLOW_TYPES: readonly FlowType[] = ["analiz", "duzeltme", "gelistirme"];

/** BFF'in `assigned` kural için sakladığı değer. */
export const ASSIGNED_MATCH_VALUE = "*";

/** BFF `RuleBody.priority` varsayılanı — formda boş bırakılınca bu gider. */
export const DEFAULT_PRIORITY = 100;

export interface ListeningRule {
  readonly ruleId: string;
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  readonly flowType: FlowType;
  /** Küçük sayı önce eşleşir (`flow-decision.ts`). */
  readonly priority: number;
  /** Pasif kural saklanır ama tarama onu okumaz. */
  readonly enabled: boolean;
  /** Analiz tarafının ajan varyantı; null → varsayılan ajan. */
  readonly analystVariantId?: string | null;
  /** Geliştirme tarafının ajan varyantı; null → varsayılan ajan. */
  readonly engineerVariantId?: string | null;
  /**
   * Akışın hangi anında ticket hangi Jira statüsüne taşınsın. null/yok =
   * VARSAYILAN, yalnız yorum: Maestro yorum yazar, statüye dokunmaz.
   */
  readonly statusMap?: StatusMap | null;
  /**
   * HANGİ STATÜDEKİ ticket'lar işlensin — giriş kapısı. `statusMap` çıktıdır
   * ("nereye taşıyayım"), bu giriştir ("neredeyse işleyebilirim").
   * null/boş = kısıt yok (0024 öncesi kuralların hâli; çalışır ama işaretlenir).
   */
  readonly allowedStatuses?: readonly string[] | null;
  /**
   * HANGİ ONAYLAR BEKLENSİN. `null` = seçim yok, risk seviyesine göre.
   * `{steps: []}` bundan FARKLI: "hiç kapı istemiyorum".
   */
  readonly gateSteps?: { readonly steps: readonly string[]; readonly ownerless?: boolean } | null;
}

/** `POST`/`PUT` gövdesi — kimlik hariç her alan (PUT tam değiştirmedir). */
export type RuleBody = Omit<ListeningRule, "ruleId">;

/** `GET /variants`in bu ekrana gereken dilimi: kimlik + rol. */
export interface VariantOption {
  readonly variantId: string;
  readonly role: string;
}

/** `GET /onboarding/jira-connections`in bir satırı. */
export interface JiraConnectionOption {
  readonly id: string;
  readonly displayName?: string;
  readonly botAccountId: string | null;
}

/**
 * DENEME TASLAĞI — taslağın yalnız ARAMAYI ilgilendiren yarısı;
 * `POST /studio/listening-rules/test`in gövdesi. Akış, öncelik ve ajanlar
 * JQL'e girmediği için yok.
 */
export interface ProbeDraft {
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  readonly allowedStatuses: readonly string[] | null;
}

/** Denemede görülen tek ticket — kuralın sorduğu dört alan, ticket metni YOK. */
export interface ProbeTicket {
  readonly key: string;
  readonly status: string | null;
  readonly issueType: string | null;
  readonly assignee: string | null;
  readonly labels: readonly string[];
  /** Bu ticket'ın zaten bir koşusu var — "0 alındı" yanılgısının tek çaresi. */
  readonly alreadyKnown: boolean;
}

export type ProbeResult =
  | {
      readonly ok: true;
      readonly jql: string;
      readonly matched: readonly ProbeTicket[];
      /** Eşleşme YOKKEN projedeki açık ticket'lar — karşılaştırma listesi. */
      readonly projectSample: readonly ProbeTicket[];
      readonly sampleJql: string | null;
    }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

/** Sunucunun adlandırdığı deneme sebepleri — `listening.probe.reason.*`. */
export const PROBE_REASONS: readonly string[] = [
  "unbound_project",
  "no_bot_account",
  "no_label",
  "bindings_unreadable",
  "search_failed",
  "probe_not_available",
];

/**
 * İki taslak AYNI aramayı mı üretir? `allowedStatuses` sırasız küme gibi
 * davranır — kutuları farklı sırada işaretlemek aynı JQL'i üretir.
 */
export function sameDraft(a: ProbeDraft, b: ProbeDraft): boolean {
  const set = (list: readonly string[] | null): string => [...(list ?? [])].sort().join("|");
  return (
    a.projectKey === b.projectKey &&
    a.assigneeAccountId === b.assigneeAccountId &&
    a.matchKind === b.matchKind &&
    a.matchValue === b.matchValue &&
    set(a.allowedStatuses) === set(b.allowedStatuses)
  );
}

/** `/studio/listening-status`un cevabı; gerekçe BFF rotasında. */
export interface SweepStatus {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly lastRunAt: string | null;
  readonly lastStarted: number;
  readonly rulesSearched: number;
  readonly lastError: string | null;
  /** Son turda otomatik yeniden başlatılan ölü koşu / insana devredilen ticket. Eski BFF'te yok. */
  readonly lastRestarted?: number;
  readonly lastHandedOver?: number;
}

/** Bir elle taramanın cevabı: ne aldı, turun sayıları. */
export interface SweepRunResult {
  readonly started: readonly string[];
  readonly error?: string;
  readonly status: SweepStatus | null;
}

/** Jira Data Center'ın İÇ tutamağı (`jirauser13506`) — JQL bununla arama yapamaz. */
export const DC_INTERNAL_KEY = /^jirauser\d+$/i;

/**
 * `<siteId>:<uuid>` biçimindeki 40 karakterlik kimlik hücreyi taşırır; baş
 * kısmı + üç nokta gösterilir, tamamı `title`da kalır.
 */
export function shortAccount(accountId: string): string {
  if (accountId.length <= 14) return accountId;
  return `${accountId.slice(0, 12)}…`;
}
