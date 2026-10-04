/**
 * `@maestro/db/variant-model` — ajan model adı hakkındaki SAF yargılar, hem
 * sunucunun hem tarayıcının okuyabileceği biçimde.
 *
 * ── NEDEN AYRI BİR GİRİŞ NOKTASI ────────────────────────────────────────────
 * Studio'nun "Ajan tanımları" listesi, sunucudaki denetimin ("bu model bulut
 * adı mı? seçilmiş mi?") tam olarak aynı cevabını vermek zorunda: panelde
 * temiz görünen bir satır `./ajan-modelleri.sh` raporunda bulgu çıkıyorsa,
 * ikisinden biri operatöre yalan söylüyordur ve hangisi olduğu belli değildir.
 * Kuralı ekrana KOPYALAMAK tam da bu ayrışmayı üretir.
 *
 * Paketin kök barreli (`./index.ts`) tarayıcıya giremez: `client.ts` üzerinden
 * `@prisma/client`'ı çeker. Ama bu iki dosya — `variant-defaults.ts` ve
 * `variant-model-audit.ts` — hiçbir şey import etmez ya da yalnız birbirini
 * import eder; içlerinde Node yoktur. Bu yüzden onların SAF yüzeyi buradan,
 * kendi alt yolundan servis edilir; `@maestro/config/i18n` alt yolunun
 * `env.ts`'i bundle dışında tutmasıyla aynı disiplin.
 *
 * Buraya Prisma'ya, `node:`'a ya da bir delegeye dokunan hiçbir şey EKLENMEZ —
 * eklenirse Studio'nun derlemesi kırılır, ki doğru geri bildirim odur.
 */

export { MODEL_NOT_SELECTED, DEFAULT_VARIANT_MODEL, isModelSelected } from "./variant-defaults.js";
export { isCloudModelName } from "./variant-model-audit.js";
