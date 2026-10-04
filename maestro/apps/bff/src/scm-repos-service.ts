import type { ConnectionKind } from "@maestro/contracts";
import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";

/**
 * Listing the repositories a stored SCM connection can reach (onboarding).
 *
 * The sibling of `connection-service.ts`'s live TEST: same discipline — the URL
 * is built from the connection's STORED `baseUrl`, the STORED token is presented
 * with the kind's header, and nothing the caller sent reaches the request. A
 * viewer cannot turn this into an SSRF or an exfiltration channel, and a failure
 * is reported as a secret-free catalog key, never a stack trace that could carry
 * the token in a URL or a header.
 *
 * This lives OUTSIDE the frozen `ScmPort`: that port resolves a KNOWN repo for
 * the workflow engine; listing an org's repos for the onboarding wizard is a new
 * read the port does not model, so it is a BFF service over the connector layer
 * rather than a port change (same reasoning that put the Jira-workflow reader
 * outside contracts).
 */

/** One repository as the wizard needs it: a stable id and a human full name. */
export interface ScmRepo {
  /** Provider id (GitHub node/number as string, ADO guid) — stable per repo. */
  readonly id: string;
  /** "owner/repo" (GitHub) or "project/repo" (ADO) — what the operator picks. */
  readonly fullName: string;
}

/** The outcome of a repo listing: the repos, or a secret-free failure key. */
export type ScmReposResult =
  | { readonly ok: true; readonly repos: readonly ScmRepo[] }
  | { readonly ok: false; readonly messageKey: string; readonly messageParams?: Record<string, string> };

/** How to list repos for one connection kind: a path + header + a body reader. */
interface RepoSource {
  path: string;
  header(token: string): Record<string, string>;
  parse(body: unknown): readonly ScmRepo[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The repo source per SCM kind. Only `github` and `ado` list; anything else has
 * no source (the caller refuses it before reaching here). Header schemes mirror
 * `connection-service.ts`'s `probeFor` exactly — GitHub bearer, ADO Basic with an
 * empty username.
 */
/**
 * KOD DEPOSU TAŞIYAN BAĞLANTI TÜRLERİ — TEK KAYNAK.
 *
 * Bu liste dört ayrı yerde elle yazılmıştı ve dördünde de `"azure_devops"`
 * diyordu. Sözleşmedeki tür ise `"ado"` (packages/contracts/src/connection.ts).
 * Yani hiçbir eşleşme tutmuyordu: ADO kurulumunda klon jetonu panelden
 * OKUNAMIYOR, tanı raporu "jeton yok" diyor ve depo listesi boş kalıyordu —
 * üçü de sessizce, çünkü bir tür adının tutmaması hata üretmez, yalnızca
 * filtreyi boşa düşürür.
 *
 * `scmRepoSource` zaten hangi türün depo listeleyebildiğinin tek doğru
 * cevabıdır; liste ondan TÜRETİLİYOR, yanına ikinci bir kopya yazılmıyor.
 */
export const SCM_CONNECTION_KINDS: readonly ConnectionKind[] = ["github", "ado"];

/** Bu bağlantı kod deposu taşıyor mu — jeton ve liste okumaları bunu sorar. */
export function isScmConnectionKind(kind: string): boolean {
  return (SCM_CONNECTION_KINDS as readonly string[]).includes(kind);
}

export function scmRepoSource(kind: ConnectionKind): RepoSource | null {
  switch (kind) {
    case "github":
      return {
        // Owner + collaborator + org repos, most-recently-updated first, one page.
        path: "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        header: (token) => ({ authorization: `Bearer ${token}`, "user-agent": "maestro" }),
        parse: (body) => {
          if (!Array.isArray(body)) return [];
          return body.flatMap((entry): ScmRepo[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const record = entry as Record<string, unknown>;
            const fullName = str(record["full_name"]);
            const id = record["id"];
            if (fullName === undefined || id === undefined) return [];
            return [{ id: String(id), fullName }];
          });
        },
      };
    case "ado":
      return {
        path: "/_apis/git/repositories?api-version=7.1",
        header: (token) => ({ authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}` }),
        parse: (body) => {
          // ADO wraps the list in `{ value: [...] }`; each repo carries a
          // `project.name` and its own `name`, joined as "project/repo".
          const value = (body as { value?: unknown } | null)?.value;
          if (!Array.isArray(value)) return [];
          return value.flatMap((entry): ScmRepo[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const record = entry as Record<string, unknown>;
            const id = record["id"];
            const name = str(record["name"]);
            const project = str((record["project"] as { name?: unknown } | undefined)?.name as string);
            if (id === undefined || name === undefined) return [];
            const fullName = project === undefined ? name : `${project}/${name}`;
            return [{ id: String(id), fullName }];
          });
        },
      };
    default:
      return null;
  }
}

/**
 * List the repositories reachable by a stored connection, using its stored token.
 *
 * `token` is resolved by the caller from the connection's `secretRef` (never
 * passed in from a request). A connection whose kind cannot list, or that has no
 * token, or that the provider rejects, yields a secret-free `ok:false` — the
 * wizard shows a clear state rather than a broken dropdown.
 */
export async function listScmRepos(
  connection: ConnectionRecord,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<ScmReposResult> {
  const source = scmRepoSource(connection.kind);
  if (source === null) {
    return { ok: false, messageKey: "onboard.scm.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) {
    return { ok: false, messageKey: "onboard.scm.no_token" };
  }

  const base = connection.baseUrl.replace(/\/+$/, "");
  // GitHub answers 100 repositories per page and a bank's organisation has
  // more; the repository the operator wants must not be on a page nobody
  // fetched. Follow `page=N` until a short page, up to MAX_PAGES.
  const paged = connection.kind === "github";
  const repos: ScmRepo[] = [];
  for (let page = 1; page <= (paged ? MAX_PAGES : 1); page += 1) {
    const url = `${base}${source.path}${paged ? `&page=${String(page)}` : ""}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", ...source.header(token) },
      });
    } catch {
      return { ok: false, messageKey: "onboard.scm.unreachable" };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        messageKey: "onboard.scm.http_error",
        messageParams: { status: String(response.status) },
      };
    }
    let batch: readonly ScmRepo[];
    try {
      batch = source.parse(await response.json());
    } catch {
      return { ok: false, messageKey: "onboard.scm.bad_response" };
    }
    repos.push(...batch);
    if (!paged || batch.length < PAGE_SIZE) break;
  }
  const seen = new Set<string>();
  return { ok: true, repos: repos.filter((r) => (seen.has(r.fullName) ? false : (seen.add(r.fullName), true))) };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * A repository's BRANCH names, for the repo-map row's "target branch" field.
 *
 * ── NEDEN LİSTE, NEDEN SERBEST METİN DEĞİL ───────────────────────────────────
 * Dal adı bugüne kadar operatörün elle yazdığı bir metindi, ve yanlış yazılmış
 * bir ad hiçbir kapıda yakalanmıyordu: kural kaydediliyor, koşu açılıyor ve
 * hata ancak KLONLAMA anında, `git clone --branch <yok-böyle-dal>` ile
 * patlıyordu — yani ticket işlenmeye başladıktan sonra. Operatörün deponun
 * dallarını ezbere bilmesini beklemek de gerçekçi değil.
 *
 * Depo adı ÇAĞIRANDAN geliyor (ekranda seçilen satırın deposu), bu yüzden
 * `owner/repo` biçimi burada DOĞRULANIR: bir yol parçası enjekte edilemesin,
 * `..` ile başka bir uca gidilemesin. Bu, bu dosyanın diğer okumalarındaki
 * "hiçbir çağıran verisi isteğe girmez" kuralının tek istisnası ve bu yüzden
 * dar tutuluyor.
 */
export type ScmBranchesResult =
  | { readonly ok: true; readonly branches: readonly string[] }
  | { readonly ok: false; readonly messageKey: string; readonly messageParams?: Record<string, string> };

/**
 * `owner/repo` (GitHub) or `project/repo` (ADO) — two plain segments.
 *
 * Each segment must START with a letter or digit. A bare `[A-Za-z0-9._-]+`
 * accepted `../etc` — the dot is a legal name character, so `..` passed as a
 * segment and the encoded path would have walked up a level. The lead-character
 * rule is what makes traversal unrepresentable rather than merely unlikely.
 */
const REPO_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const REPO_FULL_NAME = new RegExp(`^${REPO_SEGMENT}\\/${REPO_SEGMENT}$`);

/** Branch listing per kind; `null` when the kind cannot list branches. */
function branchSource(kind: ConnectionKind, fullName: string): { path: string; header(token: string): Record<string, string>; parse(body: unknown): readonly string[] } | null {
  switch (kind) {
    case "github": {
      const [owner, repo] = fullName.split("/");
      return {
        path: `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/branches?per_page=100`,
        header: (token) => ({ authorization: `Bearer ${token}`, "user-agent": "maestro" }),
        parse: (body) => (Array.isArray(body) ? body.flatMap((e) => {
          const name = str((e as Record<string, unknown> | null)?.["name"]);
          return name === undefined ? [] : [name];
        }) : []),
      };
    }
    case "ado": {
      const [project, repo] = fullName.split("/");
      return {
        // `filter=heads/` keeps tags out; ADO returns refs, so the prefix is stripped below.
        path: `/${encodeURIComponent(project!)}/_apis/git/repositories/${encodeURIComponent(repo!)}/refs?filter=heads/&api-version=7.1`,
        header: (token) => ({ authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}` }),
        parse: (body) => {
          const value = (body as { value?: unknown } | null)?.value;
          if (!Array.isArray(value)) return [];
          return value.flatMap((e) => {
            const name = str((e as Record<string, unknown> | null)?.["name"]);
            return name === undefined ? [] : [name.replace(/^refs\/heads\//, "")];
          });
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The branches of one repository, sorted with the usual default names first.
 *
 * Fail-soft by contract: a repository the token cannot see, a kind that does
 * not list, or a provider error all yield `ok:false` with a secret-free key —
 * the screen then falls back to a free-text box rather than blocking the row.
 */
export async function listScmBranches(
  connection: ConnectionRecord,
  fullName: string,
  token: string | null,
  fetchImpl: ConnectorFetch,
): Promise<ScmBranchesResult> {
  const name = fullName.trim();
  if (!REPO_FULL_NAME.test(name)) return { ok: false, messageKey: "onboard.scm.bad_repo_name" };
  const source = branchSource(connection.kind, name);
  if (source === null) {
    return { ok: false, messageKey: "onboard.scm.not_listable", messageParams: { kind: connection.kind } };
  }
  if (token === null) return { ok: false, messageKey: "onboard.scm.no_token" };

  const base = connection.baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}${source.path}`, {
      method: "GET",
      headers: { accept: "application/json", ...source.header(token) },
    });
  } catch {
    return { ok: false, messageKey: "onboard.scm.unreachable" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, messageKey: "onboard.scm.http_error", messageParams: { status: String(response.status) } };
  }
  let branches: readonly string[];
  try {
    branches = source.parse(await response.json());
  } catch {
    return { ok: false, messageKey: "onboard.scm.bad_response" };
  }
  if (branches.length === 0) return { ok: false, messageKey: "onboard.scm.no_branches" };
  // The branch an operator wants is almost always the default one, and on a
  // repo with fifty release branches it would otherwise sit mid-list.
  const lead = ["main", "master", "develop", "development"];
  const sorted = [...new Set(branches)].sort(
    (a, b) =>
      (lead.indexOf(a) === -1 ? lead.length : lead.indexOf(a)) - (lead.indexOf(b) === -1 ? lead.length : lead.indexOf(b)) ||
      a.localeCompare(b, "tr"),
  );
  return { ok: true, branches: sorted };
}
