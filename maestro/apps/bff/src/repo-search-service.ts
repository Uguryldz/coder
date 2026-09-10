import type { ConnectionRecord } from "./connection-store.js";
import type { ConnectorFetch } from "./connection-service.js";
import { isScmConnectionKind } from "./scm-repos-service.js";

/**
 * TICKET HANGİ DEPOYU İLGİLENDİRİYOR — KODA SORARAK.
 *
 * Depo eşlemesi bugüne kadar operatöre "hangi depo" diye soruyordu: ticket'taki
 * bir alanın değerini bir depoya elle bağlıyordunuz. Bu, on depolu bir projede
 * işler. Kırıldığı yer sahada söylendi: bir Azure DevOps projesinde ONLARCA
 * depo var ve ticket'ın hangisini ilgilendirdiğini KİMSE bilmiyor — ne
 * operatör, ne kural.
 *
 * Burası o soruyu kodun kendisine sorar: ticket'ın metnindeki ayırt edici
 * terimler projedeki tüm depolarda aranır, en çok eşleşen depo seçilir.
 *
 * ── İKİ YOL, ÇÜNKÜ TEK YOL HER KURULUMDA YOK ────────────────────────────────
 *
 * 1. ADO'nun Code Search API'si (`almsearch.dev.azure.com`) gerçek içerik
 *    araması yapar ve en isabetli cevabı verir. Ama bu bir EKLENTİDİR: kurulu
 *    olmayan bir organizasyonda uç 404 döner. Kurulu olup olmadığını sormak
 *    yerine YOKLUYORUZ — operatörün bilmediği bir şeyi sormak, cevabı tahmin
 *    ettirmekten farksız.
 *
 * 2. Eklenti yoksa depo ADLARI ile eşleştirilir. Çok daha kaba, ama bir
 *    "ekstre-servis" deposunu "ekstre" geçen bir ticket'la buluşturur ve
 *    hiçbir şey yapmamaktan iyidir.
 *
 * Hangi yolun çalıştığı sonuçta ADIYLA döner; analiz belgesi bunu yazar, çünkü
 * "bu depo neden seçildi" sorusunun cevabı operatörün ilk soracağı şeydir.
 */

export interface RepoSearchHit {
  /** `proje/depo` — klonun beklediği biçim. */
  readonly repo: string;
  /** Kaç eşleşme bulundu; sıralama bunun üzerine kurulur. */
  readonly matches: number;
  /** Eşleşmenin geldiği örnek dosya yolları (en çok üç tane). */
  readonly files: readonly string[];
}

export type RepoSearchSource = "code-search" | "file-tree" | "repo-names";

export type RepoSearchResult =
  | { ok: true; source: RepoSearchSource; hits: readonly RepoSearchHit[]; terms: readonly string[] }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

/**
 * Ticket metninden ARANACAK terimler.
 *
 * Ticket metni doğrudan aranamaz: "Ekstre ekranında bakiye yanlış görünüyor"
 * cümlesini aramak hiçbir şey bulmaz. Aranan şey, o cümlenin içindeki AYIRT
 * EDİCİ kelimelerdir.
 *
 * Elenenler iki kümedir. Türkçe ve İngilizce'nin dolgu kelimeleri (`ve`, `bir`,
 * `için`, `the`, `with`) her depoda geçer, yani hiçbir şeyi ayırt etmez — ve
 * arama sonuçlarını gürültüyle doldururlar. İki harften kısa parçalar da öyle.
 *
 * Sıra korunuyor ve tekrarlar eleniyor: ilk terimler genellikle başlıktan
 * gelir ve en ayırt edici olanlardır.
 */
const STOP_WORDS = new Set([
  // Türkçe
  "ve", "ile", "bir", "bu", "şu", "o", "için", "gibi", "daha", "çok", "az", "var", "yok",
  "olan", "olarak", "ancak", "ama", "veya", "ya", "de", "da", "ki", "mi", "mı", "mu", "mü",
  "ise", "göre", "kadar", "sonra", "önce", "üzerinde", "içinde", "hata", "sorun", "lütfen",
  "ekranda", "ekran", "sayfa", "kullanıcı", "sistem", "yeni", "eski", "değil", "gerek",
  // İngilizce
  "the", "and", "for", "with", "this", "that", "from", "have", "has", "was", "were", "are",
  "not", "but", "all", "any", "can", "will", "should", "would", "when", "where", "which",
  "page", "screen", "user", "system", "issue", "bug", "error", "please", "need", "new",
]);

export function searchTermsFrom(text: string, limit = 8): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}_.-]+/u)) {
    const word = raw.trim();
    if (word.length < 3) continue;
    const lower = word.toLocaleLowerCase("tr");
    if (STOP_WORDS.has(lower)) continue;
    // Salt rakam bir terim değildir: ticket numaraları, tarihler, tutarlar.
    if (/^[0-9.]+$/u.test(word)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

interface CodeSearchBody {
  readonly count?: number;
  readonly results?: readonly {
    readonly path?: string;
    readonly repository?: { readonly name?: string };
    readonly project?: { readonly name?: string };
  }[];
}

/**
 * ADO Code Search uç noktası — organizasyon adı bağlantının adresinden türer.
 *
 * Arama farklı bir hostta yaşar (`almsearch.dev.azure.com`), aynı jetonla.
 * `null` dönerse bu bağlantıdan arama uç noktası kurulamıyor demektir.
 */
function codeSearchUrl(baseUrl: string): string | null {
  const match = /^https:\/\/dev\.azure\.com\/([^/]+)/u.exec(baseUrl.trim().replace(/\/+$/u, ""));
  const org = match?.[1];
  if (org === undefined || org === "") return null;
  return `https://almsearch.dev.azure.com/${org}/_apis/search/codesearchresults?api-version=7.1`;
}

/**
 * Projedeki depolarda ticket'ın terimlerini ara.
 *
 * `project` verilirse arama o projeyle SINIRLANIR — bir ADO organizasyonunda
 * onlarca proje olabilir ve komşu projenin deposunu klonlamak, yanlış cevabı
 * hiç cevap vermemekten kötü hâle getirir.
 */
export async function searchRepos(
  connection: ConnectionRecord,
  token: string | null,
  request: { readonly text: string; readonly project?: string; readonly repos?: readonly string[] },
  fetchImpl: ConnectorFetch,
): Promise<RepoSearchResult> {
  if (!isScmConnectionKind(connection.kind)) {
    return { ok: false, messageKey: "onboard.scm.not_searchable", messageParams: { kind: connection.kind } };
  }
  const terms = searchTermsFrom(request.text);
  if (terms.length === 0) return { ok: false, messageKey: "repo_search.no_terms" };

  if (connection.kind === "ado") {
    const url = codeSearchUrl(connection.baseUrl);
    if (url !== null && token !== null) {
      const hits = await adoCodeSearch(url, token, terms, request.project, fetchImpl);
      if (hits !== null) return { ok: true, source: "code-search", hits, terms };
      // 404 = eklenti kurulu değil. Ad eşleşmesine düşülür; bu bir arıza değil,
      // bu kurulumun sunduğu en iyi cevaptır.
    }
  }

  const repos = request.repos ?? [];
  if (repos.length === 0) return { ok: false, messageKey: "repo_search.unavailable" };

  /**
   * ── EKLENTİ YOKSA: DOSYA AĞACI ─────────────────────────────────────────
   *
   * Depo ADINA bakmak tek başına çok zayıf: bir ticket'ın terimleri depo
   * adında geçmek zorunda değil ("bakiye hesabı yanlış" ile `odeme-servis`
   * deposu hiç eşleşmez, oysa kod oradadır).
   *
   * ADO'nun `items` uç noktası HER kurulumda vardır — Code Search gibi bir
   * eklenti değil, git API'sinin kendisi. Deponun dosya YOLLARINI verir ve
   * yollar sınıf/paket/modül adlarını taşır: `src/Bakiye/BakiyeHesap.cs`
   * ticket'ın "bakiye" terimiyle eşleşir, depo adı eşleşmese bile.
   *
   * İçerik araması kadar isabetli değil (dosyanın İÇİ okunmuyor) ama depo
   * adına bakmaktan kat kat iyi ve hiçbir eklenti gerektirmiyor.
   *
   * Ağaçlar PARALEL okunur ama depo sayısı sınırlanır: onlarca depolu bir
   * projede her ağacı çekmek alımı dakikalarca bekletirdi. Sınır dışında
   * kalan depolar ad eşleşmesiyle yine değerlendirilir, yani kimse elenmez.
   */
  if (connection.kind === "ado" && token !== null) {
    const byTree = await adoFileTreeSearch(connection.baseUrl, token, terms, repos, fetchImpl);
    if (byTree !== null && byTree.length > 0) return { ok: true, source: "file-tree", hits: byTree, terms };
  }

  return { ok: true, source: "repo-names", hits: matchByName(repos, terms), terms };
}

/** Bir turda ağacı okunacak en fazla depo — alımı bekletmemek için. */
const TREE_SCAN_LIMIT = 40;

/**
 * Depoların dosya YOLLARINDA ticket'ın terimlerini ara.
 *
 * `null` = hiçbir ağaç okunamadı (yetki yok, uç cevap vermedi). Boş dizi =
 * okundu ve eşleşme yok; ikisi ayrı cevaplardır ve çağıran ilkinde ad
 * eşleşmesine düşer.
 */
async function adoFileTreeSearch(
  baseUrl: string,
  token: string,
  terms: readonly string[],
  repos: readonly string[],
  fetchImpl: ConnectorFetch,
): Promise<readonly RepoSearchHit[] | null> {
  const base = baseUrl.trim().replace(/\/+$/u, "");
  const headers = { authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, accept: "application/json" };
  const lowered = terms.map((term) => term.toLocaleLowerCase("tr"));

  const scanned = await Promise.all(
    repos.slice(0, TREE_SCAN_LIMIT).map(async (full): Promise<RepoSearchHit | null> => {
      const slash = full.indexOf("/");
      if (slash <= 0) return null;
      const project = full.slice(0, slash);
      const repo = full.slice(slash + 1);
      const url =
        `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}` +
        `/items?recursionLevel=Full&api-version=7.1`;
      let body: { value?: readonly { path?: string }[] };
      try {
        const response = await fetchImpl(url, { method: "GET", headers });
        if (response.status < 200 || response.status >= 300) return null;
        body = (await response.json()) as { value?: readonly { path?: string }[] };
      } catch {
        return null;
      }
      let matches = 0;
      const files: string[] = [];
      for (const item of body.value ?? []) {
        const path = item.path;
        if (path === undefined || path === "") continue;
        const lowerPath = path.toLocaleLowerCase("tr");
        // Bir dosya kaç terim taşıyorsa o kadar sayılır: iki terim birden
        // taşıyan bir yol (`src/kredi/LimitHesap.cs`) tekini taşıyandan
        // gerçekten daha güçlü bir işarettir.
        const hitCount = lowered.filter((term) => lowerPath.includes(term)).length;
        if (hitCount === 0) continue;
        matches += hitCount;
        if (files.length < 3) files.push(path);
      }
      return matches === 0 ? null : { repo: full, matches, files };
    }),
  );

  const hits = scanned.filter((hit): hit is RepoSearchHit => hit !== null);
  // Hiçbir ağaç okunamadıysa (hepsi null ve hiç eşleşme yok) `null` dönmek
  // gerekir ki çağıran ad eşleşmesine düşsün. Ama okunup eşleşme bulunamadığı
  // hâlde de dizi boştur — ikisi burada ayrılamaz, o yüzden boş dizi de
  // "cevap veremedim" sayılıp ad eşleşmesine bırakılıyor.
  return hits.length === 0 ? null : hits.sort((a, b) => b.matches - a.matches || a.repo.localeCompare(b.repo));
}

/**
 * `null` = arama kullanılamıyor (eklenti yok, yetki yok, uç cevap vermedi).
 * Boş dizi = arama çalıştı ve HİÇBİR ŞEY bulamadı; ikisi ayrı cevaplardır.
 */
async function adoCodeSearch(
  url: string,
  token: string,
  terms: readonly string[],
  project: string | undefined,
  fetchImpl: ConnectorFetch,
): Promise<readonly RepoSearchHit[] | null> {
  // Terimler OR ile aranır: ticket'ın her kelimesini birden taşıyan bir dosya
  // beklemek, çoğu ticket'ta sıfır sonuç demektir. Sıralamayı eşleşme SAYISI
  // yapar, yani çok terim taşıyan depo zaten öne çıkar.
  const body = {
    searchText: terms.join(" OR "),
    $top: 200,
    filters: project === undefined || project === "" ? {} : { Project: [project] },
  };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  let parsed: CodeSearchBody;
  try {
    parsed = (await response.json()) as CodeSearchBody;
  } catch {
    return null;
  }

  const byRepo = new Map<string, { matches: number; files: string[] }>();
  for (const result of parsed.results ?? []) {
    const repoName = result.repository?.name;
    if (repoName === undefined || repoName === "") continue;
    const projectName = result.project?.name;
    const full = projectName === undefined || projectName === "" ? repoName : `${projectName}/${repoName}`;
    const row = byRepo.get(full) ?? { matches: 0, files: [] };
    row.matches += 1;
    if (row.files.length < 3 && result.path !== undefined) row.files.push(result.path);
    byRepo.set(full, row);
  }
  return [...byRepo.entries()]
    .map(([repo, row]) => ({ repo, matches: row.matches, files: row.files }))
    .sort((a, b) => b.matches - a.matches || a.repo.localeCompare(b.repo));
}

/**
 * Eklentisiz kurulumun cevabı: depo ADI ticket'ın bir terimini taşıyor mu.
 *
 * Kaba ama boş değil — "ekstre-servis" deposu "ekstre" geçen bir ticket'la
 * buluşur. Eşleşme sayısı kaç terimin tuttuğudur, yani iki terim taşıyan depo
 * bir terim taşıyanın önüne geçer.
 */
export function matchByName(repos: readonly string[], terms: readonly string[]): readonly RepoSearchHit[] {
  const lowered = terms.map((term) => term.toLocaleLowerCase("tr"));
  const hits: RepoSearchHit[] = [];
  for (const repo of repos) {
    // Yalnız depo adı karşılaştırılır, proje adı DEĞİL: proje adı o projedeki
    // her depoda aynıdır ve hepsini eşit puanlar — yani hiçbir şey ayırt etmez.
    const name = (repo.split("/").pop() ?? repo).toLocaleLowerCase("tr");
    const matches = lowered.filter((term) => name.includes(term)).length;
    if (matches > 0) hits.push({ repo, matches, files: [] });
  }
  return hits.sort((a, b) => b.matches - a.matches || a.repo.localeCompare(b.repo));
}
