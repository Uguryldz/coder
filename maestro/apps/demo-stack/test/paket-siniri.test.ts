import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_APPS, DEMO_BINDINGS } from "../src/seed/platform.js";

/**
 * PAKET SINIRI DOSYA SİSTEMİ YOLUYLA AŞILMAZ.
 *
 * Prova yığını GERÇEK Postgres depolarıyla koşar — sahte bir bellek deposuyla
 * değil, çünkü o zaman provada geçen bir şey sahada düşebilirdi. Yani
 * `apps/demo-stack`in `apps/deploy`e ihtiyacı meşrudur.
 *
 * Meşru olmayan, ona NASIL ulaştığıydı: `../../../deploy/src/stores/users.js`
 * biçiminde yirmi ayrı göreli yol, ve `package.json`da bildirilmemiş bir
 * bağımlılık. İkisi de aynı sorunun iki yüzü — paket yöneticisi bu kenarı
 * göremez, ve `stores/` içindeki bir yeniden adlandırma başka bir uygulamayı
 * sessizce kırar.
 */
describe("demo-stack, deploy'a paket olarak bağlanır", () => {
  const ROOT = new URL("../", import.meta.url).pathname;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("hiçbir dosya başka bir uygulamanın içine göreli yolla girmez", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from "((?:\.\.\/)+[^"]*)"/gu)) {
        // `src/` dışına çıkan her göreli yol sınırı aşıyor demektir.
        if (match[1]!.includes("/deploy/") || match[1]!.includes("/bff/")) {
          offenders.push(`${file.slice(ROOT.length)} → ${match[1]}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("kullandığı her @maestro paketi package.json'da BİLDİRİLİR", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const used = new Set<string>();
    for (const file of sourceFiles(join(ROOT, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/from "(@maestro\/[^"/]+)/gu)) {
        used.add(match[1]!);
      }
    }
    const missing = [...used].filter((pkg) => !declared.has(pkg)).sort();
    expect(missing, `bildirilmemiş: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * TOHUM VERİSİ KENDİ İÇİNDE TUTARLIDIR.
 *
 * Bir uygulamanın kendi söylediği Jira projesi ile o projeye bağlı olduğu
 * kayıt ayrışırsa, prova yığını SAHADA OLAMAYACAK bir durumu taşır — ve o
 * durumda geçen bir test hiçbir şey kanıtlamaz.
 */
describe("prova tohumu tutarlıdır", () => {
  it("her bağlı uygulamanın jiraProjectKey'i bağlamasıyla aynıdır", () => {
    for (const binding of DEMO_BINDINGS) {
      if (binding.appId === null) continue;
      const app = DEMO_APPS.find((a) => a.appId === binding.appId);
      expect(app, `bağlamada olmayan uygulama: ${binding.appId}`).toBeDefined();
      expect(app!.jiraProjectKey, `${binding.appId} → ${binding.projectKey}`).toBe(
        binding.projectKey,
      );
    }
  });

  it("jiraProjectKey taşıyan her uygulamanın projesi gerçekten bağlıdır", () => {
    const bound = new Set(DEMO_BINDINGS.map((b) => b.projectKey));
    for (const app of DEMO_APPS) {
      if (app.jiraProjectKey === null) continue;
      expect(bound.has(app.jiraProjectKey), `${app.appId} → ${app.jiraProjectKey}`).toBe(true);
    }
  });

  it("bir Jira projesine birden çok depo bağlanabilir (M102)", () => {
    const perProject = new Map<string, string[]>();
    for (const app of DEMO_APPS) {
      if (app.jiraProjectKey === null) continue;
      perProject.set(app.jiraProjectKey, [
        ...(perProject.get(app.jiraProjectKey) ?? []),
        app.appId,
      ]);
    }
    // Prova bu durumu TAŞIMALI, yoksa çok-depolu bir sahayı hiç denememiş olur.
    const shared = [...perProject.values()].filter((apps) => apps.length > 1);
    expect(shared.length, "hiçbir proje birden çok depo taşımıyor").toBeGreaterThan(0);
  });
});
