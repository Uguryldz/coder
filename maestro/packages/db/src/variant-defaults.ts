/**
 * The agent variants a fresh install starts with (M38).
 *
 * A clean database has NO variant rows, so `GET /variants` renders an empty
 * catalogue and the pilot has no DB record to resolve its analyst/engineer
 * model from — it would fall back to env forever. Seeding one variant per
 * thinking role gives a fresh install working agents an admin can then edit
 * from the UI (a new version with a different model or persona), which is the
 * whole point of the variant designer.
 *
 * The MODEL is a bootstrap default only: `seedDefaultVariants` reads the
 * bootstrap `PILOT_MODEL` env and plants it as version 1's model, and from then
 * on the DB is authoritative — the admin re-versions it from Studio and env is
 * never read again at flow time. Env vermeyen bir kurulumda (banka) o model
 * artık bir bulut adı DEĞİL, `MODEL_NOT_SELECTED` işaret değeridir — aşağıya
 * bakın. The persona is a short, honest default; the
 * real per-role prompt still lives in `packages/agent-roles` and is merged at
 * run time (M38), so this is a starting overlay, not the whole prompt.
 */

/** A default variant's identity and starting version-1 fields. */
export interface DefaultVariant {
  /** Lower-case dash-separated id, the `VarChar(64)` the table stores. */
  readonly variantId: string;
  /** The thinking role this variant configures (`LlmRoleE`). */
  readonly role: "analyst" | "engineer";
  /** The platform overlay (`Variant.name`). `default` = the institution-wide one. */
  readonly platform: string;
  /** A short starting persona overlay; the full prompt lives in agent-roles. */
  readonly persona: string;
}

/**
 * Model adı SEÇİLMEDİĞİNDE version 1'e yazılan İŞARET DEĞERİ — asla dialanmaz.
 *
 * ── NEDEN BULUT ADI DEĞİL ───────────────────────────────────────────────────
 * Burada eskiden `anthropic/claude-sonnet-4.5` yazıyordu. Banka kurulumu
 * TAMAMEN kurum içi ve internetsiz: o ad hiçbir zaman cevap veremez. Yine de
 * seed onu version 1'e yazıyordu, bu yüzden panelde ajanını tanımlayan
 * operatör "modeller değişmiyor" diyordu — aslında değişiyordu, ama altta
 * erişilemeyen bir buluta bağlı bir varsayılan duruyordu ve hata "bağlantı
 * kurulamadı" diye, yanlış yerde görünüyordu.
 *
 * ── NEDEN BOŞ STRING DE DEĞİL ───────────────────────────────────────────────
 * `""` de kabul edilemez: `VariantVersion.model` boş kalırsa `activeModel`
 * onu "yayınlanmış model yok" ile aynı sepete atar ve çağrı sessizce bağlantı
 * panelindeki modele düşer. İkisi AYNI ŞEY DEĞİL: biri "operatör henüz
 * seçmedi", diğeri "böyle bir varyant yok". Adı olan bir işaret değeri, ikisini
 * ayırt edilebilir ve LOGLANABİLİR yapar.
 *
 * ── NE OLUYOR ───────────────────────────────────────────────────────────────
 * Bu değeri taşıyan bir varyanta düşen çağrı MODEL SEÇMEZ; adıyla reddedilir
 * ya da (variant-model.ts'teki kurala göre) bağlantı paneline düşerken bunu
 * GÖRÜNÜR bir uyarı satırıyla yapar. Sessizce yanlış bir modele düşmek — bu
 * dosyanın kapattığı hatanın ta kendisi — hiçbir yolda mümkün değil.
 *
 * `.invalid` yerine düz bir ad: bu bir URL değil, bir model kimliği; sağlayıcıya
 * gitse bile "model not found" der ve operatör aradığı kelimeyi görür.
 */
export const MODEL_NOT_SELECTED = "secilmedi";

/**
 * Kurulum sırasında version 1'e yazılacak bootstrap model.
 *
 * `PILOT_MODEL` env verilmişse o; verilmemişse — bankada durum bu, compose
 * `PILOT_MODEL` tanımlamıyor — `MODEL_NOT_SELECTED`. Yani kurulum bir model
 * UYDURMAZ; operatörü Studio'daki "Ajan tanımları" ekranından seçmeye zorlar,
 * ve seçilene kadar durum her yerde adıyla okunur.
 *
 * Arg olarak geçilir (burada okunmaz) ki seed saf bir fonksiyon kalsın ve
 * çevrimdışı test onu deterministik sürsün.
 */
export const DEFAULT_VARIANT_MODEL = MODEL_NOT_SELECTED;

/** Bir model adı gerçek bir seçim mi, yoksa "henüz seçilmedi" mi? */
export function isModelSelected(model: string | null | undefined): boolean {
  const trimmed = model?.trim() ?? "";
  return trimmed !== "" && trimmed !== MODEL_NOT_SELECTED;
}

/** The two thinking roles a fresh install ships a variant for. */
export const DEFAULT_VARIANTS: readonly DefaultVariant[] = [
  {
    variantId: "analyst-default",
    // Studio'da "Ajan tanımları" listesinde görünen ad — jr-admin ne olduğunu
    // adından anlasın: "default" değil, işini söyleyen bir etiket.
    platform: "Analiz ajanı (varsayılan)",
    role: "analyst",
    persona:
      "# Rolün\n" +
      "Sen kurumun ANALİZ ajanısın. Bir Jira talebini alır, kurumun analiz " +
      "şablonunu ve bilgi tabanındaki uyum kurallarını kullanarak, geliştiricinin " +
      "hiç soru sormadan işe başlayabileceği eksiksiz bir analiz belgesi " +
      "hazırlarsın.\n\n" +
      "# Nasıl çalışırsın\n" +
      "1. Talebi ve varsa ekleri, kabul kriterlerini oku.\n" +
      "2. Kurum analiz şablonundaki her bölümü doldur; boş bırakma.\n" +
      "3. Bilgi tabanındaki (uyum, güvenlik, PII) kuralları belgeye yansıt.\n" +
      "4. Etkilenen sistemleri, riskleri ve test edilecek noktaları açıkça yaz.\n\n" +
      "# Kırmızı çizgiler\n" +
      "- Emin olmadığın hiçbir şeyi UYDURMA. Eksik bilgi varsa bölümü " +
      "'NETLEŞTİRME GEREKLİ' diye işaretle ve tam olarak neyin sorulması " +
      "gerektiğini yaz.\n" +
      "- Gizli/PII veriyi belgeye açık yazma; maskele.\n" +
      "- Kısa ve doğrulanabilir yaz; süslü anlatımdan kaçın.",
  },
  {
    variantId: "engineer-default",
    platform: "Geliştirme ajanı (varsayılan)",
    role: "engineer",
    persona:
      "# Rolün\n" +
      "Sen kurumun GELİŞTİRME (mühendislik) ajanısın. ONAYLANMIŞ bir analizi " +
      "alır, onu repo politikasına saygılı, küçük ve gözden geçirilebilir bir kod " +
      "değişikliğine çevirir, testleri koşar ve bir PR açarsın.\n\n" +
      "# Nasıl çalışırsın\n" +
      "1. Yalnızca onaylı analizin kapsamındaki işi yap; kapsam dışına çıkma.\n" +
      "2. Değişikliği mümkün olan en küçük, anlaşılır parçalara böl.\n" +
      "3. Reponun kendi lint/build/test komutlarını çalıştır.\n" +
      "4. Ne yaptığını ve neden yaptığını PR açıklamasına net yaz.\n\n" +
      "# Kırmızı çizgiler\n" +
      "- Korumalı yollara (deny-list, .maestro.yaml) DOKUNMA.\n" +
      "- Testi GEÇMEYEN bir değişikliği asla teslim etme; geçmiyorsa dur ve " +
      "sebebini bildir.\n" +
      "- Analizde olmayan bir işi kendiliğinden ekleme; gerekiyorsa " +
      "'analiz güncellensin' diye geri bildir.",
  },
];
