import { isModelSelected, MODEL_NOT_SELECTED } from "@maestro/db";
import type { ModelResolver, ResolvedModel } from "@maestro/llm-gateway";
import type { VariantVersionModelDelegate } from "./variant-model-reader.js";
import { PrismaVariantModelReader, type VariantRoleDelegate } from "./variant-model-reader.js";

/**
 * Panelde tanımlanan AJANIN modelini gerçek çağrıya bağlayan çözücü.
 *
 * ── HANGİ HATAYI KAPATIYOR ──────────────────────────────────────────────────
 * Operatörün şikayeti tek cümleydi: "modeller değişmiyor, varsayılan ajan
 * seçilmiyor". Şikayet DOĞRUYDU ve sebebi şuydu: Studio'daki "Ajan tanımları"
 * ekranı her varyant için bir model yazıyordu (`VariantVersion.model`), ama o
 * alanı okuyan TEK yer `apps/deploy/src/bin/pilot.ts` idi. Banka `bff.js` +
 * `worker.js` çalıştırıyor, pilot'u değil — ve worker `connectionModelFrom(db)`
 * ile yalnızca "Ayarlar & bağlantılar" ekranındaki TEK modele bağlanıyordu.
 * `run.variantId` zincir boyunca taşınıyor, log satırına yazılıyor, sonra
 * ATILIYORDU: model seçimine etkisi tam olarak sıfırdı.
 *
 * Yani panelde iki ajanı iki farklı modele bağlayan admin, ikisinin de aynı
 * modelle koştuğunu görüyordu ve ekranda bunu söyleyen hiçbir şey yoktu.
 *
 * ── NASIL ÇÖZÜYOR ───────────────────────────────────────────────────────────
 * Öncelik: VARYANT → BAĞLANTI PANELİ → (gateway'in kendi `.env` katmanı).
 *
 *   1. Çağrının varyantının yayınlanmış (en yeni) sürümünde bir model ADI varsa,
 *      SUNUCU bağlantı panelinden gelir, MODEL ADI varyanttan. İkisi ayrı
 *      sorulardır ve ayrı yerlerde cevaplanır: adres/anahtar/TLS/on-prem bir
 *      KURULUM gerçeğidir (bir bağlantı satırı), model adı ise bir AJAN
 *      tercihidir. Aynı vLLM sunucusunda iki farklı modeli iki ajana bağlamak —
 *      bankanın gerçek senaryosu — ancak böyle mümkün.
 *   2. Varyantın modeli yoksa ya da `MODEL_NOT_SELECTED` ise, bağlantı
 *      panelindeki model kullanılır — ama SESSİZCE DEĞİL: `onWarn` bir satır
 *      yazar ve satır ajanı adıyla anar. Operatörün açık şikayeti buydu;
 *      "sessizce yanlış modele düşmek" bu dosyada temsil edilemez.
 *   3. Bağlantı paneli de cevap veremiyorsa `null` döner ve karar gateway'in
 *      statik `.env` katmanına geçer — panel öncesi kurulumlar aynen çalışır.
 *
 * ── NEDEN VARYANT SUNUCUYU DEĞİL SADECE MODEL ADINI EZİYOR ──────────────────
 * `VariantVersion` tablosunda adres, anahtar, on-prem bayrağı YOK; yalnızca bir
 * model adı var. Varyanttan bir `ResolvedModel` UYDURMAK, o üç alanı tahmin
 * etmek demekti — ve `onPrem` bir tahmin olamaz: M18 gizli-veri kuralı tam
 * olarak o bayrağa dayanıyor, bir operatörün beyanı olmak zorunda. Bu yüzden
 * varyant yalnızca kendi bildiği alanı ezer; geri kalan her şey, testi yeşile
 * dönmüş bağlantı satırının kalır (test=çalışma simetrisi).
 *
 * ── HATA = HATA, YOKLUK = YOKLUK ────────────────────────────────────────────
 * Varyant okuması PATLARSA (Postgres erişilemez, tablo göçmemiş) hata YUTULUR
 * ve bağlantı paneline düşülür — ama yine `onWarn` ile. Gerekçe:
 * `connectionModelFrom` da tam olarak bunu yapıyor, ve bir ajan tercihi
 * uğruna, ortamın hâlâ cevaplayabildiği bir çağrıyı düşürmek doğru olmaz.
 * Fark şu ki, düşüş görünür: log satırı hangi ajanın hangi sebeple istediği
 * modeli alamadığını söyler.
 */

/** Uyarı satırının gittiği yer — enjekte edilir ki test onu okuyabilsin. */
export type WarnFn = (message: string) => void;

/**
 * Varyantı olmayan çağrıların `variantId` yerine taşıdığı değer.
 *
 * `agentSession` çağıranı olmayabilir (`AgentSessionOptions.variantId` sözleşmesi
 * "`*` when the caller has none" diyor) ve `LlmPolicy` de aynı yıldızı fallback
 * satırı için kullanıyor. Yıldız bir varyant KİMLİĞİ değildir; onu tabloda
 * aramak her seferinde boş dönecek bir sorgudur, o yüzden hiç sorulmaz.
 */
const ANY_VARIANT = "*";

export interface VariantModelResolverOptions {
  /**
   * Kurulum gerçeklerini (adres, anahtar, on-prem, TLS) veren taban çözücü —
   * pratikte `connectionModelFrom(db)`. Varyant yalnızca bunun `model` alanını
   * ezer; `null` dönerse ezilecek bir şey yok demektir.
   */
  readonly base: ModelResolver;
  /** Varyant sürümlerini okuyan depo. Yoksa çözücü tamamen `base` gibi davranır. */
  readonly variants?: PrismaVariantModelReader;
  readonly onWarn?: WarnFn;
}

/**
 * Aynı uyarıyı her çağrıda basmamak için: satır, SÖYLEDİĞİ ŞEY DEĞİŞTİĞİNDE
 * yazılır. Her istekte bir satır, tam da söylemek istediği şeyi gömerdi —
 * gateway'in `#announceSource`'u da aynı sebeple böyle yapıyor.
 */
function dedupe(warn: WarnFn): WarnFn {
  let last: string | null = null;
  return (message) => {
    if (last === message) return;
    last = message;
    warn(message);
  };
}

/**
 * Varyant-farkında `resolveModel` üret.
 *
 * `bff.ts` ve `worker.ts` AYNI fabrikadan geçer: iki süreç modeli farklı
 * çözerse, adminin panelde yeşile döndürdüğü ajan, run'ın konuştuğu ajan olmaz.
 * `connectionModelFrom`'un tek fabrika olmasının gerekçesi neyse, bunun da o.
 */
export function variantAwareModelFrom(options: VariantModelResolverOptions): ModelResolver {
  const warn = dedupe(options.onWarn ?? ((message: string) => console.warn(message)));

  return async (variantId?: string): Promise<ResolvedModel | null> => {
    const base = await options.base(variantId);

    const id = variantId?.trim() ?? "";
    if (id === "" || id === ANY_VARIANT || options.variants === undefined) return base;

    let variantModel: string | null;
    try {
      variantModel = await options.variants.activeModel(id);
    } catch (error) {
      warn(
        `[maestro] llm: '${id}' ajanının modeli okunamadı (${String(error)}) — ` +
          "bağlantı panelindeki model ile devam ediliyor. Ajan tanımındaki model bu çağrıda UYGULANMADI.",
      );
      return base;
    }

    const model = variantModel?.trim() ?? "";
    if (!isModelSelected(model)) {
      warn(
        `[maestro] llm: '${id}' ajanı için Studio'da bir model seçilmemiş` +
          `${model === MODEL_NOT_SELECTED ? ` ("${MODEL_NOT_SELECTED}")` : ""} — ` +
          "çağrı bağlantı panelindeki modelle yapılıyor. Doğru model için: " +
          "Ajan tanımları → ilgili ajan → yeni sürüm yayınla.",
      );
      return base;
    }

    if (base === null) {
      /**
       * Ajanın modeli var ama DİALANACAK BİR SUNUCU yok: panelde etkin bir
       * model bağlantısı tanımlanmamış. Buradan bir adres uydurulamaz, o yüzden
       * karar gateway'in statik katmanına bırakılır — `.env` bir uç adı
       * veriyorsa çağrı oradan gider, vermiyorsa `ModelNotConfiguredError` ile
       * ADIYLA reddedilir. Uyarı, o reddin gerçek sebebini söyler: eksik olan
       * ajan değil, bağlantı.
       */
      warn(
        `[maestro] llm: '${id}' ajanı "${model}" modelini istiyor ama panelde etkin bir ` +
          "model bağlantısı (adres) yok — Ayarlar & bağlantılar ekranından ekleyin.",
      );
      return null;
    }

    if (base.model !== model) {
      warn(
        `[maestro] llm: '${id}' ajanı "${model}" modeliyle çalışıyor ` +
          `(sunucu ${base.baseUrl}; bağlantı panelinin "${base.model}" modeli bu ajan için geçersiz).`,
      );
    }

    // Adres/anahtar/on-prem/TLS bağlantı satırının; yalnızca model adı ajanın.
    return { ...base, model };
  };
}

/** `PrismaVariantModelReader`'ı delegeden kuran kısayol — çağrı yerlerini kısaltır. */
export function variantModelReaderFrom(db: {
  variantVersion: VariantVersionModelDelegate;
  variant?: VariantRoleDelegate;
}): PrismaVariantModelReader {
  return new PrismaVariantModelReader(db.variantVersion, db.variant);
}
