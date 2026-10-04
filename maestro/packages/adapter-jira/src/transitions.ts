import { JiraArgumentError, JiraResponseError } from "./errors.js";

/**
 * Statü GEÇİŞLERİNİN sürücüden bağımsız ortak dili.
 *
 * Bu modülde REST v2 (Data Center) ile REST v3 (Cloud) arasında hiçbir fark
 * OLMAYAN parçalar durur: geçiş listesinin ayrıştırılması, hedef statünün
 * adına göre seçilmesi ve Türkçe i-katlaması. Doğrulandı (Context7 →
 * developer.atlassian.com/server/jira/platform/rest/v11003, "api-group-issue"):
 * DC'nin `GET /rest/api/2/issue/{key}/transitions` yanıtı Cloud'unkiyle aynı
 * gövdeyi taşır — `{ transitions: [{ id, name, to: { id, name,
 * statusCategory: { key, name } } }] }` — ve `statusCategory.key` sözlüğü de
 * aynıdır (`new` / `indeterminate` / `done`). Bu yüzden ayrıştırıcıyı iki kez
 * yazmak, iki kopyanın zamanla ayrışmasından başka bir şey getirmezdi.
 *
 * Buraya taşınmadan önce bunların tamamı `cloud/return-flow.ts` içindeydi ve o
 * dosya HÂLÂ hepsini yeniden dışa aktarıyor: Cloud tarafının içe aktarımları,
 * paket yüzeyi ve testleri olduğu gibi kalsın diye (M111). Cloud'a özgü olan —
 * İADE / İNCELEMEDE / Done kategori seçicileri — orada kaldı, çünkü onlar bu
 * ortak sözleşmenin değil, Cloud akışlarının parçası.
 */

/** Bir issue'nun mevcut statüsünden çıkan tek bir geçiş, hedefiyle birlikte. */
export interface AvailableTransition {
  id: string;
  name: string;
  /** Hedef statü id'si. */
  toStatusId: string;
  /** Hedef statü adı (yerelleştirilmiş, ör. "Yapılacaklar"). */
  toStatusName: string;
  /** Hedef statü KATEGORİ anahtarı (`new` | `indeterminate` | `done`). */
  toCategoryKey: string;
  /** Hedef statü KATEGORİ adı (`To Do` | `In Progress` | `Done`). */
  toCategoryName: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * `GET /issue/{key}/transitions` yanıtını, her hedefin kategorisiyle birlikte
 * normalize et; böylece çağıran, kırılgan yerelleştirilmiş bir ad yerine
 * kategoriye göre de hedef seçebilir. `transitions` dizisi taşımayan bir gövde
 * GÜRÜLTÜLÜ biçimde patlar — sessizce boş liste dönmek "bu issue hiçbir yere
 * gidemiyor" gibi okunur ve gerçek bir API/izin sorununu gizler.
 */
export function parseAvailableTransitions(raw: unknown): AvailableTransition[] {
  const body = record(raw);
  const transitions = body?.["transitions"];
  if (!Array.isArray(transitions)) {
    throw new JiraResponseError("issue transitions", ["response carries no transitions array"]);
  }
  const out: AvailableTransition[] = [];
  for (const entry of transitions) {
    const transition = record(entry);
    if (!transition) continue;
    const id = nonEmptyString(transition["id"]);
    const name = nonEmptyString(transition["name"]);
    const to = record(transition["to"]);
    const toStatusId = to ? nonEmptyString(to["id"]) : null;
    if (id === null || name === null || to === null || toStatusId === null) continue;
    const toStatusName = nonEmptyString(to["name"]) ?? "";
    const category = record(to["statusCategory"]);
    const toCategoryKey = (category ? nonEmptyString(category["key"]) : null) ?? "";
    const toCategoryName = (category ? nonEmptyString(category["name"]) : null) ?? "";
    out.push({ id, name, toStatusId, toStatusName, toCategoryKey, toCategoryName });
  }
  return out;
}

/** POSTlanmadan önce geçiş id'sini doğrula. */
export function requireTransitionId(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new JiraArgumentError("transitionId", "empty");
  return id;
}

/**
 * Statü adlarını karşılaştırmadan ÖNCE Türkçe'nin dört yüzlü i'sini
 * (i · ı · İ · I) TEK bir harfe katla.
 *
 * Canlı OPS iş akışı inceleme sütununu büyük harfle bağırıyor — kayıtlı
 * geçişlerde `to.name === "İNCELEMEDE"` yazarken çağıran (ve Studio yapılandırması)
 * "İncelemede" yazıyor. Düz `toLowerCase()` "İ"yi "i̇" (i + birleşen nokta)
 * olarak bırakır, ikisi asla eşleşmez; tek başına `toLocaleLowerCase("tr")` de
 * daha iyi değildir, çünkü "I"yı "ı"ya eşler ve bu kez noktasızı noktalıdan
 * ayırır. Her iki durumda da sitenin gerçekten sunduğu bir statü "böyle bir
 * geçiş yok" diye okunur ve ticket sessizce yerinde kalır.
 *
 * Bu yüzden i ailesi AÇIKÇA katlanır, sonra küçültülür, sonra NFC'ye
 * normalize edilir; böylece ayrışmış bir "İ" (I + U+0307) önceden birleşmiş
 * olanla eşit karşılaştırılır — insanın yazdığı ile Jira'nın sakladığı
 * arasındaki gerçek bir fark. Sonuç, ana makinenin yerel ayarına asla bağlı
 * değildir; ICU varsayılanı Türkçe olmayan bir sunucuda güvenli kılan da budur.
 * @maestro/agent-roles içindeki `fold()` ile aynı deyim; bu paket kasten rol
 * paketine bağımlılık taşımadığı için bağımlılık yerine kopyalandı.
 */
const I_FOLD: Record<string, string> = { İ: "i", I: "i", ı: "i", i: "i" };

export function foldStatusName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[İIıi]/gu, (c) => I_FOLD[c] ?? c)
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Issue'yu `statusName` statüsüne indiren geçişi, sıralı iki geçişte bul —
 * önce HEDEF statünün adı, sonra geçişin kendi adı.
 *
 * Sıra süs değil. Canlı OPS iş akışında ikisi gerçekten farklıdır: 31 id'li
 * geçişin adı "In Review" ama issue'yu "İNCELEMEDE" statüsüne taşır; 21 id'li
 * geçiş "Devam Ediyor" adını taşır ve "Devam Ediyor" statüsüne gider. Çağıran,
 * ticket'ın nerede SONLANMASINI istediğini söyler; dolayısıyla dürüst anahtar
 * hedeftir. Geçiş adını eşlemek, düğmesini hedefe göre adlandıran ama hedefi
 * harfiyen yazmayan siteler için yalnızca nezaket yedeğidir.
 *
 * İki geçiş de eşleşmezse `null` — "bu iş akışı böyle bir hareket sunmuyor";
 * çağıran bunu fırlatmaz, raporlar (politika uyar-ve-devam et, koşuyu
 * düşürmek değil).
 */
export function selectTransitionByStatusName(
  transitions: readonly AvailableTransition[],
  statusName: string,
): AvailableTransition | null {
  const wanted = foldStatusName(statusName);
  if (wanted.length === 0) return null;
  for (const transition of transitions) {
    if (foldStatusName(transition.toStatusName) === wanted) return transition;
  }
  for (const transition of transitions) {
    if (foldStatusName(transition.name) === wanted) return transition;
  }
  return null;
}

/**
 * `fields=status` okumasından issue'nun mevcut statü ADI. Site adsız yanıt
 * verdiyse null döner: bilinmeyen "zaten oradayız" demek değildir, o yüzden
 * çağıran tahmine dayanıp kısa devre yapmak yerine geçiş aramaya devam eder.
 */
export function currentStatusNameOf(raw: unknown): string | null {
  const status = record(record(record(raw)?.["fields"])?.["status"]);
  const name = status?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

/** `transitionToStatus`ın hiç fırlatmayan sözleşmesi: her sonuç bir gerekçe. */
export type TransitionOutcomeReason =
  | "already"
  | "no_transition"
  | "forbidden"
  | "read_failed"
  | "transition_failed"
  | "bad_key"
  | "bad_status_name";

export interface TransitionOutcome {
  moved: boolean;
  reason?: TransitionOutcomeReason;
}
