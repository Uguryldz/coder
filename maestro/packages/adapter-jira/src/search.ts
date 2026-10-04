import { JiraArgumentError, JiraResponseError } from "./errors.js";
import type { JiraDcClient } from "./client.js";

/**
 * Issue search on Jira DATA CENTER — the path a ticket takes into the platform
 * when no webhook can be registered.
 *
 * ── Neden bu dosya var ────────────────────────────────────────────────────
 * `searchIssues` bugüne dek YALNIZ Cloud sürücüsünde vardı
 * (`cloud/search.ts`), ve `apps/deploy/src/jira-discovery.ts` bir sürücüyü tam
 * olarak o metodun VARLIĞIYLA yokluyor (`canSearch`). Sonuç, tamamen kapalı bir
 * bankada ölümcül bir boşluktu:
 *
 *  · DC'de webhook kaydedilemiyorsa ticket'lar `POST /webhooks/jira` ile
 *    GELMİYOR;
 *  · yorum yoklaması (`jira-poller.ts`) ancak ZATEN koşusu olan ticket'lara
 *    bakıyor (`openTickets` = `db.workflowRun`), yani hiç koşu yokken liste
 *    boş kalıyor ve hiçbir yeni ticket asla giremiyor;
 *  · tarama (`jira-discovery.ts`) ise DC'de `canSearch` false döndüğü için
 *    hiç başlamıyor.
 *
 * Üçü birden: kısır döngü. Panel yeşil, bağlantı yeşil, kurallar doğru,
 * ve HİÇBİR ticket asla akışa girmiyor — hiçbir yerde de hata görünmüyor.
 *
 * ── Neden bunu yapmak MÜMKÜN ──────────────────────────────────────────────
 * Data Center REST v2 JQL aramasını sunuyor: `GET /rest/api/2/search?jql=…`
 * (büyük sorgular için `POST /rest/api/2/search`). Atlassian'ın kendi Server/DC
 * dokümanı (developer.atlassian.com/server/jira/platform/jira-rest-api-examples
 * ve jira.11003 Postman koleksiyonu, Context7 ile doğrulandı) bu ucu
 * `startAt` / `maxResults` / `fields` / `validateQuery` parametreleriyle
 * tanımlıyor ve cevabın `issues` dizisi + `total` taşıdığını söylüyor.
 *
 * Yani DC'de arama YOK değil — yalnızca sürücüye YAZILMAMIŞTI.
 *
 * ── Cloud'dan farkları, ve neden ayrı bir dosya ───────────────────────────
 * Cloud'un `/rest/api/3/search` ucu KALDIRILDI ve yerine imleç sayfalamalı
 * (`nextPageToken`, `isLast`) `/search/jql` geldi; DC böyle bir geçiş
 * yaşamadı ve klasik `startAt`/`total` sayfalamasını sürdürüyor. İki ürünün
 * cevap ŞEKLİ farklı olduğu için tek bir ayrıştırıcı ikisine birden
 * hizmet edemez; ortak olan yalnızca `issues` dizisidir ve o da
 * `jira-discovery.ts`'in okuduğu tek alandır.
 */

const SEARCH_PATH = "/rest/api/2/search";

export interface DcSearchRequest {
  jql: string;
  maxResults?: number;
  /** Field names to return per issue; omitted → the server's navigable set. */
  fields?: string[];
  /** 0-based offset for the next page (`startAt` in DC's own vocabulary). */
  startAt?: number;
}

/**
 * One DC result page. `startAt`/`total` rather than Cloud's cursor: the classic
 * offset pagination DC never migrated away from.
 *
 * `isLast` is DERIVED here rather than read, because DC does not send it — the
 * caller should not have to know which product it is talking to in order to ask
 * "was that the last page?".
 */
export interface DcSearchPage {
  /** Raw issue payloads — map with `mapIssueToSnapshot` when the fields allow. */
  issues: unknown[];
  startAt: number;
  /** Total matches Jira reports for the query, across all pages. */
  total: number;
  isLast: boolean;
}

/**
 * Refuse JQL that restricts nothing.
 *
 * DC's endpoint, unlike Cloud's, would happily ACCEPT an unbounded query and
 * answer with every issue the service account can see — on a bank's Jira that
 * is a sweep across every project in the company, and the discovery loop would
 * then try to start a run for each one. The Cloud driver refuses the same shape
 * (`assertBoundedJql`) because the server refuses it; here the refusal is ours,
 * and it is a safety rule rather than a compatibility one.
 */
export function assertBoundedDcJql(jql: string): string {
  const trimmed = jql.trim();
  if (trimmed.length === 0 || /^order\s+by\b/iu.test(trimmed)) {
    throw new JiraArgumentError(
      "jql",
      `unbounded JQL is refused for ${SEARCH_PATH} — add a restriction such as 'project = X'`,
    );
  }
  return trimmed;
}

/**
 * Run one JQL search against Data Center.
 *
 * GET rather than POST: the discovery loop's queries are one `project = X AND
 * assignee in (…)` clause long and fit a query string comfortably, and a GET
 * keeps the request idempotent — `JiraDcClient` retries a throttled GET once
 * and deliberately refuses to retry a POST.
 */
export async function searchDcIssues(
  client: JiraDcClient,
  request: DcSearchRequest,
): Promise<DcSearchPage> {
  const jql = assertBoundedDcJql(request.jql);
  const raw = await client.get<unknown>(SEARCH_PATH, {
    jql,
    maxResults: request.maxResults,
    startAt: request.startAt,
    fields: request.fields && request.fields.length > 0 ? request.fields.join(",") : undefined,
  });

  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const issues = body?.["issues"];
  if (!Array.isArray(issues)) {
    throw new JiraResponseError("search", ["response carries no issues array"]);
  }

  // `startAt`/`total` are what DC documents, but a plugin-filtered or proxied
  // response has been seen to drop them. They are only used to answer "is there
  // another page", so a missing value degrades to "this is the last page"
  // rather than throwing — the issues themselves are the answer the caller came
  // for, and refusing them over a missing counter would turn a usable sweep
  // into no sweep at all.
  const startAt = typeof body?.["startAt"] === "number" ? (body["startAt"] as number) : (request.startAt ?? 0);
  const total = typeof body?.["total"] === "number" ? (body["total"] as number) : issues.length;

  return {
    issues,
    startAt,
    total,
    isLast: startAt + issues.length >= total,
  };
}
