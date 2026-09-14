import { describe, expect, it } from "vitest";

/**
 * ── BOŞ DEPO İLE ERİŞİLEMEYEN DEPO AYRI CEVAPLARDIR ────────────────────────
 *
 * Klon provası boş bir sonuçta tek bir sebep söylüyordu: "jetonun bu depoya
 * erişemediği hallerde görülür". O, ölçülen İLK vakaydı (bir organizasyon
 * deposu, org izni yok).
 *
 * Sonra 40 depo tarandı ve ikincisi çıktı: `Uguryldz/frp` boş klonlandı, ama
 * GitHub'ın cevabı `409 Git Repository is empty` idi — depo gerçekten boştu
 * (`size: 0`), jetonla ilgisi yoktu. Operatöre "jetona izin verin" demek o
 * vakada OLMAYAN bir iş gösteriyordu.
 *
 * İkisini ayıran şey git'in kendi davranışı ve canlıda ölçüldü:
 *
 *   boş depo  → `warning: You appear to have cloned an empty repository.`
 *               klon BAŞARILI (çıkış 0)
 *   erişimsiz → `fatal: could not read Username for 'https://github.com'`
 *               klon DÜŞER
 *
 * Bu test o iki çıktının AYRI kaldığını tutuyor: biri "başarılı ama boş",
 * öteki "hiç açılmadı". Karıştıkları gün, mesaj yine yanlış işi gösterir.
 */
describe("boş depo ile erişilemeyen depo", () => {
  /** Git'in boş bir depoyu klonladığında yazdığı satır (canlıda ölçüldü). */
  const EMPTY_REPO_STDERR = "Cloning into '/tmp/frp'...\nwarning: You appear to have cloned an empty repository.";
  /** Git'in erişemediği bir depoda yazdığı satır (canlıda ölçüldü). */
  const NO_ACCESS_STDERR =
    "Cloning into '/tmp/wendoc'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled";

  it("tells them apart by whether git FAILED, not by what came down", () => {
    // Boş depo: `warning`, `fatal` YOK — süreç başarılı biter.
    expect(EMPTY_REPO_STDERR).toContain("empty repository");
    expect(EMPTY_REPO_STDERR).not.toContain("fatal:");

    // Erişimsiz: `fatal` VAR — süreç düşer ve çağıran `catch`e gider.
    expect(NO_ACCESS_STDERR).toContain("fatal:");
    expect(NO_ACCESS_STDERR).not.toContain("empty repository");
  });

  /**
   * Kilit sonuç: erişimsiz depo boş-klon dalına HİÇ ULAŞMAZ. O yüzden o dalın
   * mesajı "jetona izin verin" olamaz — oraya ulaşan her klon, erişilebilen
   * ama içi boş bir depodur.
   */
  it("keeps the no-access case out of the empty-clone branch entirely", () => {
    const reachesEmptyBranch = (stderr: string): boolean => !stderr.includes("fatal:");
    expect(reachesEmptyBranch(EMPTY_REPO_STDERR), "boş depo bu dala ulaşmalı").toBe(true);
    expect(reachesEmptyBranch(NO_ACCESS_STDERR), "erişimsiz depo bu dala ulaşmamalı").toBe(false);
  });
});
