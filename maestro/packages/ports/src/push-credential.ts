import { IsoDateTime } from "@maestro/contracts";

/**
 * M31 — KISA ÖMÜRLÜ PUSH KİMLİK BİLGİSİ POLİTİKASI, TEK KAYNAKTAN.
 *
 * Bu politika bir dönem İKİ YERDE yaşıyordu: `adapter-ado/src/credential.ts`
 * ve `adapter-github/src/credential.ts`. İki dosya birebir aynıydı — ölçüldü,
 * tek fark hata sınıfı (`AdoResponseError` / `GithubResponseError`) ve scope
 * önekiydi. Üçüncü bir yansıma da `packages/secrets/src/vault-driver.ts`
 * içinde yorum olarak duruyordu ("Mirrors EXPIRY_SKEW_SECONDS in adapter-ado").
 *
 * Kopyanın kendisi küçüktü (~50 satır); tehlikeli olan NE OLDUĞUYDU. Bu bir
 * güvenlik kararı: bir ajanın depoya yazabilmek için aldığı jetonun ömrünü
 * sınırlıyor. İki yerde yaşayan bir güvenlik kuralı, birinde sıkılaştırılıp
 * ötekinde unutulan bir kuraldır — ve unutulan taraf sessizce sınırsız bir
 * push jetonu basmaya devam eder. Bankacılık kod tabanında kabul edilemez.
 *
 * `packages/ports`ta duruyor çünkü burası saf arayüz katmanı: tek bağımlılığı
 * `@maestro/contracts` ve her iki adapter zaten ona bağlı. Hiçbir sürücü
 * import edilmiyor, M44 clean-room DI korunuyor.
 *
 * Hata FIRLATMA işi çağırana bırakılıyor (`fail` geri çağrısı): her sürücünün
 * kendi hata sınıfı var ve o sınıf sürücünün bilgisi — bu modülün değil.
 */

/**
 * İstenen TTL ile kimlik bilgisinin kendi son kullanma anı arasında hoş
 * görülen kayma: jetonu basan taraf ile bu süreç milisaniye hassasiyetinde
 * aynı saati paylaşmıyor.
 */
export const EXPIRY_SKEW_SECONDS = 60;

/**
 * İSTENEN TTL denetimi (M31).
 *
 * "Kısa ömürlü" olmak, kimlik bilgisinin olduğu kadar İSTEĞİN de özelliği:
 * on yıllık bir TTL, jetonu basan tarafa hiç gidilmeden reddedilir — böylece
 * uzun ömürlü bir push jetonu ilk baştan basılmaz.
 *
 * `fail` çağıranın kendi hata sınıfıyla atar; bu modül hangi sürücünün
 * konuştuğunu bilmez ve bilmemelidir.
 */
export function assertTtlWithinCeiling(
  ttlSeconds: number,
  maxPushTtlSeconds: number,
  fail: (messages: string[]) => never,
): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    fail([`invalid ttlSeconds: ${ttlSeconds}`]);
  }
  if (ttlSeconds > maxPushTtlSeconds) {
    fail([`ttlSeconds ${ttlSeconds} exceeds the ${maxPushTtlSeconds}s ceiling (M31)`]);
  }
}

/**
 * BASILAN kimlik bilgisinin denetimi: değer var olmalı, son kullanma anı
 * gerçek bir ISO damgası olmalı, şu an hâlâ yaşıyor olmalı ve istenen
 * pencerenin İÇİNDE ölmelidir.
 *
 * Bunların herhangi biri tutmuyorsa bu bir uyarı değil, bir başarısızlıktır:
 * sınırsız bir push jetonu, M31'in var olma sebebinin ta kendisi.
 *
 * Dizi döner, atmaz — çağıran onu kendi hata sınıfına sarar.
 */
export function issuedCredentialIssues(
  issued: { secret: string; expiresAt: string } | undefined,
  ttlSeconds: number,
  nowMs: number,
): string[] {
  const issues: string[] = [];
  if (typeof issued?.secret !== "string" || issued.secret.length === 0) {
    issues.push("issuer returned an empty secret");
  }
  if (!IsoDateTime.safeParse(issued?.expiresAt).success) {
    issues.push(`issuer returned a non-ISO expiresAt: ${String(issued?.expiresAt)}`);
    return issues;
  }
  const expiry = Date.parse(issued!.expiresAt);
  if (expiry <= nowMs) {
    issues.push(`issuer returned an already-expired credential: ${issued!.expiresAt}`);
  } else if (expiry - nowMs > (ttlSeconds + EXPIRY_SKEW_SECONDS) * 1000) {
    issues.push(`issued credential outlives its ${ttlSeconds}s ttl (expires ${issued!.expiresAt})`);
  }
  return issues;
}
