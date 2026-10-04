import { CONNECTION_KIND_SPECS, type ConnectionKind } from "@maestro/contracts";
import { isCloudModelName, isModelSelected } from "@maestro/db/variant-model";

/**
 * Bir varyantın MODEL SEÇİM LİSTESİ: bağlantı panelinde bugün servis edilen
 * model adları.
 *
 * ── HANGİ SORUNU KAPATIYOR ──────────────────────────────────────────────────
 * Operatör "Ayarlar & bağlantılar" ekranında model sunucusunu tanımlıyor, test
 * ediyor, yeşil görüyor. Sonra bir ajan tanımına geliyor ve model adını ELLE
 * yazması gerekiyordu — aynı adı, hatasız, hatırlayarak. Bir harf şaşarsa
 * bağlantı yeşil kalır ama o ajanın her koşusu ilk model çağrısında ölür,
 * çünkü `modelServedNote` yalnız BAĞLANTININ kendi `config.model` alanını
 * doğrular; varyantın yazdığı adı kimse doğrulamaz.
 *
 * Bu yüzden alan artık bir AÇILIR LİSTE: seçenekler bağlantılardan gelir, yani
 * yazım hatası diye bir ihtimal kalmaz. Serbest metin kaçış yolu duruyor ama
 * İKİNCİL — proxy'ler aynı sunucuda listelenmemiş modeller servis edebilir ve
 * hiç bağlantı tanımlanmamış bir kurulumda liste boştur; ikisinde de operatör
 * "Listede yok — elle gir" ile kutuya döner.
 *
 * ── NEDEN YENİ BİR UÇ YOK ───────────────────────────────────────────────────
 * `GET /studio/connections` bu bilginin tamamını zaten taşıyor: `kind`,
 * `enabled`, `isDefault` ve sır taşımayan `config` çantası (model adı orada).
 * Uç admin + tech-lead'e açık, varyant yazma eylemleri ise zaten admin-only —
 * yani bu ekranda listeyi görebilen herkes onu okumaya zaten yetkili. Yeni bir
 * uç aynı satırları ikinci bir yetki kapısının arkasından servis etmek olurdu:
 * bakılacak iki yer, ayrışabilecek iki cevap.
 */
/** `/studio/connections` satırının bu modülün okuduğu kadarı. */
export interface ConnectionModelRow {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly config: Readonly<Record<string, string>>;
}

/** Seçim listesindeki bir satır — hangi bağlantıdan geldiği DE söylenir. */
export interface ModelSuggestion {
  /** Bağlantının `config.model` alanındaki ad, kırpılmış. */
  readonly model: string;
  /** Modeli hangi bağlantının verdiği — operatör kaynağı görsün diye. */
  readonly connectionName: string;
}

/**
 * Bir `kind` model servis edebilir mi?
 *
 * Liste burada YENİDEN YAZILMADI: `CONNECTION_KIND_SPECS[kind].model` sözleşme
 * paketinin kendi cevabıdır ve sunucu tarafındaki `MODEL_CONNECTION_KINDS` ile
 * aynı üç türü (`openai_compat`, `openrouter`, `anthropic`) işaretler. Yeni bir
 * model türü eklendiğinde bu ekran onu kendiliğinden tanır.
 */
function servesModel(kind: string): boolean {
  const spec = CONNECTION_KIND_SPECS[kind as ConnectionKind] as
    | { readonly model?: boolean }
    | undefined;
  return spec?.model === true;
}

/** Satırın sır taşımayan config çantasındaki model adı, ya da null. */
function modelIdOf(config: Readonly<Record<string, string>>): string | null {
  const model = config["model"]?.trim() ?? "";
  return model === "" ? null : model;
}

/**
 * Bağlantı panelinin BUGÜN servis ettiği model adlarının tamamı.
 *
 * Sıra `pickModelRow` ile aynı: VARSAYILAN satır başa, kalanlar id sırasına
 * göre. İlk seçenek bu yüzden koşunun model seçilmediğinde düşeceği adla
 * birebir aynıdır — liste, sunucunun kararıyla aynı şeyi söyler.
 *
 * Aynı model adını iki bağlantı da servis ediyorsa ad TEK KEZ listelenir
 * (ilk — yani varsayılana en yakın — kaynağın adıyla): seçilen şey ad, kaynak
 * yalnız operatörün onu tanıması için yazılıyor; aynı adı iki kez göstermek
 * seçilecek iki farklı şey varmış gibi okunurdu.
 */
export function listConnectionModels(
  rows: readonly ConnectionModelRow[] | undefined,
): readonly ModelSuggestion[] {
  if (rows === undefined) return [];
  const usable = rows
    .filter((row) => row.enabled && servesModel(row.kind) && modelIdOf(row.config) !== null)
    .toSorted((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
  const seen = new Set<string>();
  const out: ModelSuggestion[] = [];
  for (const row of usable) {
    const model = modelIdOf(row.config);
    if (model === null || seen.has(model)) continue;
    seen.add(model);
    out.push({
      model,
      // Adı olmayan bir bağlantı için id'ye düşülür: seçenek kaynaksız sunulmaz.
      connectionName: row.displayName.trim() === "" ? row.id : row.displayName.trim(),
    });
  }
  return out;
}

/**
 * Bugün cevap veren model, ya da hiçbiri yoksa null.
 *
 * Seçim kuralı sunucudaki `pickModelRow` ile BİREBİR aynıdır — açık, model
 * türünde ve model adı yazılmış satırlar arasından VARSAYILAN kazanır, yoksa
 * id sırasına göre ilki. Aynı olmak zorundadır: burada gösterilen ad, koşunun
 * model seçilmediğinde gerçekten dialayacağı ad değilse liste bir yalandır.
 */
export function suggestModel(
  rows: readonly ConnectionModelRow[] | undefined,
): ModelSuggestion | null {
  return listConnectionModels(rows)[0] ?? null;
}

/**
 * Bir varyantın model adının panelde nasıl gösterileceği.
 *
 * Üç durum, çünkü operatörün yapacağı iş üçünde de farklı:
 *  · `ok` — seçilmiş, yerel görünen bir ad. Yapacak bir şey yok.
 *  · `unset` — hiç seçilmemiş (`secilmedi` ya da boş). Koşu bağlantıdaki
 *    modele düşer ve bunu uyararak yapar; yanlış değil ama EKSİK.
 *  · `cloud` — internetsiz kurulumda erişilemeyecek bulut adı. Bu ajanla
 *    başlatılan her koşu model çağrısında ölür.
 *
 * İki yargı da `@maestro/db/variant-model`'den gelir — `auditVariantModels`'in
 * ve `./ajan-modelleri.sh`'ın okuduğu AYNI iki fonksiyon. Panelin rozeti ile
 * sunucunun raporu bu yüzden ayrışamaz.
 */
export type VariantModelHealth = "ok" | "unset" | "cloud";

export function variantModelHealth(model: string, served?: ReadonlySet<string>): VariantModelHealth {
  if (!isModelSelected(model)) return "unset";
  // Served by a connection this platform has = reachable, whatever the name
  // says. The name heuristic below is for installs with NO such connection.
  if (served?.has(model.trim()) === true) return "ok";
  if (isCloudModelName(model)) return "cloud";
  return "ok";
}
