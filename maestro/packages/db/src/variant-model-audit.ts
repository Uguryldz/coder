import { isModelSelected, MODEL_NOT_SELECTED } from "./variant-defaults.js";

/**
 * Kurulmuş bir veritabanındaki ajan tanımlarını ERİŞİLEMEZ BULUT MODELİ için
 * tarayan (ve istenirse onaran) saf mantık.
 *
 * ── HANGİ HATAYI KAPATIYOR ──────────────────────────────────────────────────
 * `variant-defaults.ts` artık bir bulut adı tohumlamıyor: yeni bir kurulum
 * `MODEL_NOT_SELECTED` ile başlar. Ama `seedDefaultVariants` var olan bir
 * varyanta ASLA DOKUNMAZ (M38/M83) — ve bu kural, tam da bu durumda ters
 * çalışır: 1.0.14 imajını KURULU bir yığının üzerine geçiren operatörün
 * veritabanında, eski sürümün `anthropic/claude-sonnet-4.5` ile tohumladığı
 * satırlar aynen durur. Yeni imaj onları düzeltmez, çünkü düzeltmemesi
 * gerektiği söylenmiştir. Operatör panelde hâlâ bulut modeli görür.
 *
 * ── NEDEN OTOMATİK EZMİYORUZ ────────────────────────────────────────────────
 * "Erişilemez model" bir TAHMİNDİR, bir gerçek değil. Kurumun kendi vLLM
 * sunucusuna `anthropic/claude-sonnet-4.5` adıyla bir model koyması tamamen
 * mümkündür (proxy'ler bunu sık yapar), ve o operatörün bilerek yazdığı adı
 * sessizce silmek VERİ KAYBIDIR. Öte yandan tohumun BIRAKTIĞI ad kimsenin
 * seçimi değildir. İkisini ayıran tek dürüst ölçüt niyettir, ve niyeti
 * veritabanından okuyamayız — bu yüzden bu dosya varsayılan olarak SADECE
 * RAPORLAR; onarım ancak `apply` ile, operatörün açık talebiyle olur.
 *
 * ── NE ONARIYOR ─────────────────────────────────────────────────────────────
 * Onarım "sil" değil "geri al"dır: model adı `MODEL_NOT_SELECTED` yapılır, yani
 * "operatör henüz seçmedi" durumuna döner. `variantAwareModelFrom` bu değeri
 * ADIYLA tanır, çağrıyı bağlantı panelindeki modelle yapar ve bunu GÖRÜNÜR bir
 * uyarı satırıyla söyler. Yani onarım sonrası sistem sessizce yanlış bir yere
 * gitmez; ne olduğunu söyleyerek çalışır.
 *
 * Ve onarım GEÇMİŞİ YENİDEN YAZMAZ: yalnızca her varyantın ETKİN (en yeni)
 * sürümü güncellenir. Eski sürümler değişmez, çünkü v4'e sabitlenmiş bir koşu
 * v4'ün ne dediğini okumaya devam etmek zorundadır (M83).
 */

/**
 * Erişilemez sayılan bulut sağlayıcı model adları — ÖNEK eşleşmesiyle.
 *
 * Liste bilerek KISA ve somut: yalnızca bu ürünün kendi seed'lerinin ve demo
 * verisinin geçmişte yazdığı sağlayıcılar. "İçinde nokta olan her ad buluttur"
 * gibi bir sezgi, kurumun `mistral-7b-instruct-v0.2` adlı yerel modelini de
 * yakalardı — yanlış pozitif, operatörün güvenini bitiren şeydir.
 *
 * Eşleşme hem çıplak adı (`claude-opus-5`) hem sağlayıcı önekli biçimi
 * (`anthropic/claude-sonnet-4.5`) yakalar, çünkü ikisi de bu depoda geçmişte
 * tohumlandı.
 */
const CLOUD_MODEL_PREFIXES: readonly string[] = [
  "anthropic/",
  "openai/",
  "claude-",
  "gpt-",
  "gemini-",
  "bedrock/",
  "azure/",
];

/** Bir model adı, internetsiz bir kurulumda erişilemeyecek bir bulut adı mı? */
export function isCloudModelName(model: string | null | undefined): boolean {
  const trimmed = model?.trim().toLowerCase() ?? "";
  if (trimmed === "" || trimmed === MODEL_NOT_SELECTED) return false;
  return CLOUD_MODEL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Bulut modeli taşıdığı tespit edilen tek bir varyantın etkin sürümü. */
export interface CloudModelFinding {
  readonly variantId: string;
  /** Etkin (en yeni) sürümün numarası. */
  readonly version: number;
  /** O sürümde yazan, erişilemez olduğu düşünülen model adı. */
  readonly model: string;
}

export interface VariantModelAuditResult {
  /** Taranan varyant sayısı — "0 bulgu" ile "hiç varyant yok"u ayırır. */
  readonly scanned: number;
  /** Bulut modeli taşıyan etkin sürümler. */
  readonly findings: readonly CloudModelFinding[];
  /** `apply` ile gerçekten güncellenen varyantlar (rapor kipinde boş). */
  readonly repaired: readonly string[];
}

/** Denetimin okuduğu satır. */
export interface AuditVariantVersionRow {
  variantId: string;
  version: number;
  model: string;
}

/**
 * Denetimin dokunduğu delege dilimi — yapısal, ki çevrimdışı test onu Postgres
 * olmadan sürsün (bu paketteki her seed/store ile aynı disiplin).
 */
export interface VariantModelAuditDb {
  variantVersion: {
    findMany(args: {
      orderBy: { version: "desc" };
      select: { variantId: true; version: true; model: true };
    }): Promise<AuditVariantVersionRow[]>;
    update(args: {
      where: { variantId_version: { variantId: string; version: number } };
      data: { model: string };
    }): Promise<unknown>;
  };
}

export interface VariantModelAuditOptions {
  /**
   * `false` (varsayılan) yalnızca RAPORLAR — hiçbir satır yazılmaz.
   * `true` bulunan etkin sürümlerin modelini `MODEL_NOT_SELECTED` yapar.
   */
  readonly apply?: boolean;
}

/**
 * Her varyantın ETKİN sürümünü tarar; `apply` ile bulut modellerini
 * "seçilmedi"ye geri alır.
 *
 * Idempotent: onarımdan sonra tekrar çalıştırmak sıfır bulgu verir, çünkü
 * `MODEL_NOT_SELECTED` bir bulut adı değildir.
 */
export async function auditVariantModels(
  db: VariantModelAuditDb,
  options: VariantModelAuditOptions = {},
): Promise<VariantModelAuditResult> {
  const rows = await db.variantVersion.findMany({
    orderBy: { version: "desc" },
    select: { variantId: true, version: true, model: true },
  });

  // Sürümler azalan sırada geldiği için her varyantın İLK görülen satırı onun
  // etkin sürümüdür — `PrismaVariantCatalog` ve `PrismaVariantModelReader` ile
  // birebir aynı "en yeni = etkin" kuralı (M38).
  const active = new Map<string, AuditVariantVersionRow>();
  for (const row of rows) {
    if (!active.has(row.variantId)) active.set(row.variantId, row);
  }

  const findings: CloudModelFinding[] = [];
  for (const row of active.values()) {
    if (!isModelSelected(row.model)) continue;
    if (!isCloudModelName(row.model)) continue;
    findings.push({ variantId: row.variantId, version: row.version, model: row.model.trim() });
  }
  findings.sort((left, right) => left.variantId.localeCompare(right.variantId));

  if (options.apply !== true) {
    return { scanned: active.size, findings, repaired: [] };
  }

  const repaired: string[] = [];
  for (const finding of findings) {
    await db.variantVersion.update({
      where: { variantId_version: { variantId: finding.variantId, version: finding.version } },
      data: { model: MODEL_NOT_SELECTED },
    });
    repaired.push(finding.variantId);
  }

  return { scanned: active.size, findings, repaired };
}
