import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decisionLogSink } from "../src/bin/bff.js";

/**
 * Alım kararı dökümünü yazan uç.
 *
 * İki davranış ölçülüyor, çünkü ikisi de sahada bir kez yanlış yapıldığında
 * sessizce yanlış olur: (1) dizin verilmediğinde HİÇBİR dosya yazılmamalı —
 * sessizce bir yere dosya biriktirmek disk dolduran sürprizdir; (2) yazma
 * başarısız olduğunda çağıran DÜŞMEMELİ — bir teşhis satırı, teşhis ettiği
 * ticket alımını düşüremez.
 */

/** Yazmanın bitmesini bekler: sink ateşle-unut, testin görmesi lazım. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("decisionLogSink", () => {
  it("her zaman tek satırlık özeti log'a yazar", () => {
    const lines: string[] = [];
    decisionLogSink(undefined, (message) => lines.push(message))("[karar] OPS-41: alındı", "# döküm");
    expect(lines).toEqual(["[karar] OPS-41: alındı"]);
  });

  it("dizin verilmediyse dosya YAZMAZ", async () => {
    const lines: string[] = [];
    decisionLogSink("", (message) => lines.push(message))("[karar] OPS-41: alındı", "# döküm");
    await settle();
    // Tek çıktı log satırı; dosya sistemine hiç dokunulmadı.
    expect(lines).toHaveLength(1);
  });

  it("dizin verildiyse dökümü .md olarak yazar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "karar-"));
    decisionLogSink(dir, () => undefined)("[karar] OPS-41: alındı", "# Alım kararı — OPS-41");
    await settle();

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^OPS-41-\d+\.md$/u);
    expect(await readFile(join(dir, files[0]!), "utf8")).toBe("# Alım kararı — OPS-41");
  });

  /**
   * Ticket anahtarı dışarıdan gelen bir değer ve burada bir DOSYA YOLUNA
   * dönüşüyor. Yol ayracı taşıyan bir anahtar, dizinin dışına yazmayı
   * deneyebilirdi; ad yalnız güvenli karakterlerden kurulur.
   */
  it("dosya adını ticket anahtarından güvenli biçimde türetir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "karar-"));
    decisionLogSink(dir, () => undefined)("[karar] ../../kotu: alındı", "# döküm");
    await settle();

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).toMatch(/^kotu-\d+\.md$/u);
  });

  it("yazılamayan dizinde çağıranı DÜŞÜRMEZ ve sebebi bir kez söyler", async () => {
    // Dizin olarak bir DOSYA veriliyor: `mkdir` bunu ENOTDIR ile reddeder,
    // ve bu, sahadaki "yol yanlış / bağlama salt-okunur" vakasının taşınabilir
    // karşılığı — izinlere ya da root olmamaya dayanmadan aynı dalı sürer.
    const base = await mkdtemp(join(tmpdir(), "karar-"));
    const notADir = join(base, "dosya");
    await writeFile(notADir, "ben bir dosyayım");

    const lines: string[] = [];
    const sink = decisionLogSink(notADir, (message) => lines.push(message));

    expect(() => sink("[karar] OPS-41: alındı", "# döküm")).not.toThrow();
    expect(() => sink("[karar] OPS-42: alındı", "# döküm")).not.toThrow();
    await settle();

    // İki karar satırı + TEK uyarı: her ticket'ta tekrarlanan bir hata satırı
    // log'u, teşhis edilecek şeyin kendisini gömerdi.
    const warnings = lines.filter((line) => line.includes("döküm dosyası yazılamadı"));
    expect(warnings).toHaveLength(1);
  });
});
