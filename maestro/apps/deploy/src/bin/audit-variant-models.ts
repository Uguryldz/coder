import { auditVariantModels, createDb, MODEL_NOT_SELECTED } from "@maestro/db";
import { isEntrypoint } from "./lifecycle.js";

/**
 * Bakım komutu: ajan tanımlarındaki ERİŞİLEMEZ BULUT MODELLERİNİ raporlar ve
 * — açıkça istenirse — "seçilmedi"ye geri alır.
 *
 * Her iki kurulum paketindeki `ajan-modelleri.sh` bunu uygulama imajının
 * İÇİNDE çalıştırır (reset-admin.sh ile aynı desen, aynı gerekçe: Prisma
 * istemcisi imajın derli `node_modules`'ından gelir, sunucuya node/pnpm
 * kurulmaz).
 *
 * ── NEDEN AYRI BİR KOMUT ────────────────────────────────────────────────────
 * `seedDefaultVariants` var olan bir varyanta asla dokunmaz (M38/M83) ve bu
 * doğru: yayınlanmış bir sürümü bir kurulum betiğinin sessizce yeniden yazması
 * kabul edilemez. Ama o kural, eski bir sürümün tohumladığı bulut modellerini
 * de koruyor — internetsiz bir bankada hiçbir işe yaramayan adları. Denetimi
 * kurulumdan AYIRMAK, ikisini aynı anda doğru yapmanın tek yolu: kurulum
 * SÖYLER, operatör KARAR VERİR, bu komut UYGULAR.
 *
 * ── VARSAYILAN GÜVENLİ ──────────────────────────────────────────────────────
 * Argümansız çalıştırmak hiçbir şey YAZMAZ; yalnızca ne bulduğunu gösterir.
 * Yazma yalnızca `--duzelt` (veya `--fix`) ile olur, ve o zaman bile yalnızca
 * her varyantın ETKİN sürümünün model alanı değişir: eski sürümler olduğu gibi
 * kalır, çünkü v4'e sabitlenmiş bir koşu v4'ün ne dediğini okumaya devam
 * etmelidir (M83).
 *
 * Çıkış kodları, betiğin operatöre ne diyeceğini ayırt edebilsin diye:
 *   0 → temiz (bulgu yok) ya da düzeltme yapıldı
 *   3 → bulgu VAR ve yalnızca rapor istendi (düzeltme yapılmadı)
 */
export const EXIT_FINDINGS_PENDING = 3;

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} tanımlı değil`);
  return value;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const apply = argv.includes("--duzelt") || argv.includes("--fix");
  const url = required(process.env["DATABASE_URL"], "DATABASE_URL");

  const db = createDb(url);
  try {
    const result = await auditVariantModels(db, { apply });

    console.log(`Taranan ajan tanımı: ${String(result.scanned)}`);

    if (result.findings.length === 0) {
      console.log("✔ Erişilemez bulut modeline bağlı ajan tanımı YOK.");
      return 0;
    }

    console.log("");
    console.log(
      `Kurum içi (internetsiz) bir kurulumda ERİŞİLEMEYECEK ${String(result.findings.length)} ajan tanımı:`,
    );
    for (const finding of result.findings) {
      console.log(`  - ${finding.variantId} (etkin sürüm v${String(finding.version)}): ${finding.model}`);
    }

    if (!apply) {
      console.log("");
      console.log("Hiçbir şey DEĞİŞTİRİLMEDİ (bu yalnızca rapordur).");
      console.log("Düzeltmek için iki yol var:");
      console.log("  1) Panel: Ajan tanımları → ilgili ajan → yeni sürüm yayınla");
      console.log("     (kendi model sunucunuzun servis ettiği adı yazarsınız — en doğrusu budur)");
      console.log("  2) Toplu: bu komutu --duzelt ile çalıştırın; adlar");
      console.log(`     "${MODEL_NOT_SELECTED}" yapılır ve panelde seçim yapmanız beklenir.`);
      return EXIT_FINDINGS_PENDING;
    }

    console.log("");
    console.log(`✔ ${String(result.repaired.length)} ajan tanımı "${MODEL_NOT_SELECTED}" durumuna alındı:`);
    for (const variantId of result.repaired) console.log(`  - ${variantId}`);
    console.log("");
    console.log("SIRADAKİ İŞ: panelde Ajan tanımları ekranından her ajana kendi model");
    console.log("sunucunuzun servis ettiği model adını verin. Seçim yapılana kadar çağrılar");
    console.log("bağlantı panelindeki modelle yapılır ve bu, loglara ADIYLA yazılır.");
    return 0;
  } finally {
    await db.$disconnect();
  }
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
