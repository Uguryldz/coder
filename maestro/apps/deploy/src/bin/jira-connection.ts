/**
 * TEŞHİS ARAÇLARININ JIRA BAĞLANTISI — TEK KAYNAKTAN.
 *
 * `apps/deploy/src/bin/` altındaki araçlar (kural provası, mini test, uçtan
 * uca prova, alan listesi, alan değerleri, test ticket) panelde tanımlı Jira
 * bağlantısını bulup ona istek atıyor. Her biri bunu kendi kopyasıyla
 * yapıyordu ve kopyalar ayrışmıştı — üç ayrı sınıfta, üçü de Data Center
 * kurulumunu vuruyordu:
 *
 *  1. SEÇİM. `kural-provasi`, `mini-test` ve `test-ticket` yalnız
 *     `jira_cloud` arıyordu. Data Center'a kurulmuş bir sahada bu araçlar
 *     "Jira bağlantısı yok" diye durur — oysa bağlantı vardır, türü
 *     `jira_dc`'dir. Banka kurulumları tipik olarak Data Center'dır, yani
 *     teşhis araçları tam da en çok gerektikleri yerde çalışmıyordu.
 *
 *  2. KİMLİK DOĞRULAMA. Cloud, `email:token` ikilisini Basic ile ister;
 *     Data Center bir PAT'i Bearer ile ister. Araçların bir kısmı her iki
 *     durumda da Basic kuruyordu — DC'de her çağrı 401 döner.
 *
 *  3. API SÜRÜMÜ. Cloud `/rest/api/3`, Data Center `/rest/api/2` konuşur.
 *     `alan-listesi` auth'u doğru kuruyor ama yolu `3`e sabitliyordu; DC'de
 *     alan listesi hiç gelmez.
 *
 * Üçü de aynı kökten: bağlantının TÜRÜ okunuyor ama sonuçları tek tek elle
 * uygulanıyordu. Burada bir kez uygulanıyor.
 *
 * `packages/adapter-jira` bu ayrımı zaten doğru biliyor; bu modül üretim
 * yolunu değiştirmez, yalnız teşhis araçlarını aynı bilgiye bağlar.
 */

export type JiraKind = "jira_cloud" | "jira_dc";

/** Panelde saklanan bağlantı satırının bu modüle yeten kadarı. */
export interface ConnectionRow {
  readonly kind: string;
  readonly baseUrl: string;
  readonly secretRef: string | null;
  readonly configJson: unknown;
  readonly enabled?: boolean;
}

export interface JiraConnection {
  readonly kind: JiraKind;
  /** Sondaki eğik çizgiler atılmış taban adres. */
  readonly baseUrl: string;
  readonly secretRef: string;
  /** Cloud'da zorunlu, DC'de boş. */
  readonly email: string;
  readonly cloud: boolean;
}

export function isJiraKind(kind: string): kind is JiraKind {
  return kind === "jira_cloud" || kind === "jira_dc";
}

/**
 * Panelde tanımlı Jira bağlantısını bulur. Etkin (`enabled`) olanlar önce
 * gelir: saha bir bağlantıyı kapatıp yenisini eklediğinde araç kapalı olanı
 * seçip anlaşılmaz bir 401 vermemeli.
 *
 * Bulamazsa neden bulamadığını söyler. "Jira bağlantısı yok" ile "bağlantı
 * var ama jetonu yok" farklı arızalardır ve operatörün ikisi için yapacağı
 * şey farklıdır.
 */
export function findJiraConnection(rows: readonly ConnectionRow[]): JiraConnection {
  const candidates = rows.filter((row) => isJiraKind(row.kind));
  if (candidates.length === 0) {
    throw new Error(
      "Panelde tanımlı Jira bağlantısı yok (jira_cloud ya da jira_dc). Panel → Ayarlar > Bağlantılar.",
    );
  }
  const row = candidates.find((c) => c.enabled !== false) ?? candidates[0]!;
  if (row.secretRef === null) {
    throw new Error(
      `Jira bağlantısı (${row.kind}) var ama jetonu yok. Panel → Ayarlar > Bağlantılar > jetonu girin.`,
    );
  }
  const config = (row.configJson as Record<string, unknown> | null) ?? {};
  const email = typeof config["email"] === "string" ? config["email"] : "";
  const cloud = row.kind === "jira_cloud";
  if (cloud && email === "") {
    throw new Error(
      "Jira Cloud bağlantısında e-posta yok; Cloud `email:token` ikilisiyle doğrulanır ve e-postasız her çağrı 401 döner.",
    );
  }
  return {
    kind: row.kind as JiraKind,
    baseUrl: row.baseUrl.replace(/\/+$/u, ""),
    secretRef: row.secretRef,
    email,
    cloud,
  };
}

/**
 * Cloud `email:token` ikilisini Basic ile, Data Center bir PAT'i Bearer ile
 * ister. Yanlış olanı göndermek 401 verir ve 401 "jeton yanlış" gibi okunur —
 * oysa jeton doğrudur, şema yanlıştır.
 */
export function jiraAuthHeader(connection: JiraConnection, token: string): string {
  return connection.cloud
    ? `Basic ${Buffer.from(`${connection.email}:${token}`).toString("base64")}`
    : `Bearer ${token}`;
}

export function jiraHeaders(connection: JiraConnection, token: string): Record<string, string> {
  return { authorization: jiraAuthHeader(connection, token), accept: "application/json" };
}

/** Cloud `/rest/api/3`, Data Center `/rest/api/2`. */
export function jiraApiBase(connection: JiraConnection): string {
  return connection.cloud ? "/rest/api/3" : "/rest/api/2";
}

/** `jiraUrl(conn, "/issue/OPS-1?fields=summary")` → tam adres, doğru sürümle. */
export function jiraUrl(connection: JiraConnection, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${connection.baseUrl}${jiraApiBase(connection)}${suffix}`;
}
