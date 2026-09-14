import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bankaComposePath, ugurdockerComposePath } from "./paths.js";

/**
 * İKİ KURULUM PAKETİ AYNI ÜRÜNÜ KURAR.
 *
 * `deploy/banka/` müşteri kurulumudur (hava boşluklu, kendi CA'sı, imajlar
 * `docker load` ile taşınır); `deploy/ugurdocker/` geliştiricinin prova
 * ortamıdır (registry'den `pull`). BAZI farklar kasıtlı ve gereklidir: imaj
 * adresleri, örnek host adları, imaj temin yolu.
 *
 * Ama YIĞININ ŞEKLİ ayrışamaz. Bir düzeltme provada uygulanıp müşteriye
 * taşınmazsa, müşteri kurulumu o düzeltmeden yoksun kalır — ve bu genellikle
 * gürültüsüz olur: yığın açılır, yeşil görünür, arıza yalnızca çıktı
 * kalitesinde belli eder.
 *
 * Sahada ölçülen örnek, bu testin var olma sebebi: `/workspace` prova
 * ortamında kalıcı bir volume'e çevrildi ve sahipliği ayarlayan
 * `workspace-init` konteyneri eklendi; müşteri paketi tmpfs'te kaldı. Sonuç,
 * müşteri tarafında her yeniden başlatmada klonların silinmesiydi — analiz
 * boş bir dizini okuyup "kod karşılığı yok" diye SESSİZCE yarım çıkıyordu.
 *
 * Bu yüzden burada tek tek maddeler değil, ŞEKİL karşılaştırılır: servis
 * kümesi, servisler arası bağımlılıklar, volume kümesi ve volume sürücüleri.
 * Kasıtlı olarak ayrışan şeyler (imaj adresi, host adı) bilerek dışarıda.
 */

interface Compose {
  services: Record<
    string,
    {
      depends_on?: Record<string, { condition?: string }> | string[];
      volumes?: unknown[];
      user?: string;
      restart?: string;
    }
  >;
  volumes?: Record<string, { driver?: string; driver_opts?: Record<string, string> } | null>;
}

function load(path: string): Compose {
  return parse(readFileSync(path, "utf8"), { merge: true }) as Compose;
}

const banka = load(bankaComposePath());
const ugurdocker = load(ugurdockerComposePath());

/** `depends_on` iki biçimde yazılabilir; karşılaştırma için tek biçime indir. */
function dependencies(service: Compose["services"][string]): string[] {
  const raw = service.depends_on;
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : Object.keys(raw)).slice().sort();
}

describe("iki kurulum paketi aynı yığını kurar", () => {
  it("servis kümesi birebir aynıdır", () => {
    expect(Object.keys(banka.services).sort()).toEqual(Object.keys(ugurdocker.services).sort());
  });

  it("her servisin bağımlılıkları aynıdır", () => {
    for (const name of Object.keys(banka.services).sort()) {
      expect(dependencies(banka.services[name]!), name).toEqual(
        dependencies(ugurdocker.services[name]!),
      );
    }
  });

  it("volume kümesi aynıdır", () => {
    expect(Object.keys(banka.volumes ?? {}).sort()).toEqual(
      Object.keys(ugurdocker.volumes ?? {}).sort(),
    );
  });

  it("volume sürücüleri aynıdır — biri kalıcı, öteki tmpfs olamaz", () => {
    for (const name of Object.keys(banka.volumes ?? {}).sort()) {
      const b = banka.volumes?.[name] ?? null;
      const u = ugurdocker.volumes?.[name] ?? null;
      expect({ driver: b?.driver ?? null, opts: b?.driver_opts ?? null }, name).toEqual({
        driver: u?.driver ?? null,
        opts: u?.driver_opts ?? null,
      });
    }
  });
});

describe("çalışma alanı kalıcıdır ve sahibi ayarlanır", () => {
  /**
   * Bu üçü AYRILMAZ. Yalnız volume'den tmpfs kaldırılıp `workspace-init`
   * eklenmezse, root sahipli doğan volume'e uid 10001 yazamaz ve ilk klon
   * EACCES alır — yığın o zaman gerçekten patlar. Üçünü birlikte tutan tek
   * şey bu test.
   */
  for (const [label, compose] of [
    ["banka", banka],
    ["ugurdocker", ugurdocker],
  ] as const) {
    describe(label, () => {
      it("maestro-workspace tmpfs DEĞİLDİR — restart klonları silmez", () => {
        const volume = compose.volumes?.["maestro-workspace"] ?? null;
        expect(volume?.driver_opts?.["type"]).not.toBe("tmpfs");
        expect(JSON.stringify(volume ?? {})).not.toContain("tmpfs");
      });

      it("workspace-init vardır, root koşar ve bir kez çalışır", () => {
        const init = compose.services["workspace-init"];
        expect(init).toBeDefined();
        expect(init!.user).toBe("0:0");
        expect(init!.restart).toBe("no");
      });

      it("bff ve worker workspace-init'i BEKLER", () => {
        for (const name of ["bff", "worker"]) {
          const raw = compose.services[name]?.depends_on;
          expect(raw, `${name} depends_on`).toBeDefined();
          const condition = Array.isArray(raw)
            ? (raw.includes("workspace-init") ? "service_started" : undefined)
            : raw!["workspace-init"]?.condition;
          expect(condition, `${name} → workspace-init`).toBe("service_completed_successfully");
        }
      });
    });
  }
});
