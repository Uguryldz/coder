import type { CommandSpec } from "./types.js";

/**
 * DEPODAN DERLEME KOMUTU TÜRETME — "ajan vibe coding yapsın ama derlensin".
 *
 * Operatörün şartı: iş bitince proje DERLENEBİLİR olmalı. Çalıştırmak değil,
 * derlemek — çalıştırmak bir bankada yan etki demektir (veritabanına yazan bir
 * migration, bir kuyruğa düşen mesaj), derlemek ise yalnız "bu kod tutarlı mı"
 * sorusunu sorar.
 *
 * ── NEDEN GEREKLİ ──────────────────────────────────────────────────────────
 *
 * Doğrulama altyapısı ZATEN VARDI: doğrulayıcı ajan derleme sonucunu
 * raporluyor (`engineering.ts` → `verdict.build`), kırmızıysa `approved`
 * false oluyor ve akış durmuyor. Ama komutlar koşu satırındaki
 * `verificationJson`dan geliyordu ve ORAYA HİÇBİR KOD YAZMIYORDU. Canlıda
 * ölçüldü: 40 koşunun 40'ında alan boş. Yani kapı vardı, kapıdan geçecek şey
 * hiç üretilmiyordu.
 *
 * ── NEDEN DOSYADAN, KURALDAN DEĞİL ─────────────────────────────────────────
 *
 * Komut operatöre sorulabilirdi ama sorulmamalı: bir deponun nasıl derlendiği
 * deponun kendi bilgisidir ve zaten dosyalarında yazılıdır. Operatöre sormak,
 * onu her depo için bir kez daha doğru cevap vermeye zorlamak olurdu — ve
 * yanlış cevap sessizce "derleme atlandı"ya düşerdi.
 *
 * Havuz sayesinde depo artık DİSKTE duruyor, yani dosyalara bakmak bedava.
 *
 * ── SIRA ve FAİL-SOFT ──────────────────────────────────────────────────────
 *
 * Hiçbir işaret bulunamazsa BOŞ liste döner ve akış bugünkü gibi sürer
 * (doğrulayıcı `build: skipped` der). Tanınmayan bir yığın için komut
 * UYDURMAK, var olmayan bir betiği çalıştırıp "derleme kırmızı" demek olurdu —
 * yani tanımadığımız her projeyi bloklamak.
 */

/** Deponun kök dizinindeki dosya adları — çağıran okur, bu modül saf kalır. */
export interface RepoFiles {
  readonly names: readonly string[];
  /** `package.json` içeriği, okunabildiyse — script adları oradan gelir. */
  readonly packageJson?: unknown;
}

function scriptsOf(packageJson: unknown): ReadonlySet<string> {
  const scripts = (packageJson as { scripts?: unknown } | null)?.scripts;
  if (typeof scripts !== "object" || scripts === null) return new Set();
  return new Set(Object.keys(scripts as Record<string, unknown>));
}

/**
 * Deponun dosyalarından derleme komutlarını türetir.
 *
 * Bir yığın için birden çok komut dönebilir (önce bağımlılık kurulumu, sonra
 * derleme): ikisi ayrı adımlar ve biri düşerse hangisinin düştüğü görünür
 * olmalı — tek satırda birleştirmek o ayrımı kaybettirirdi.
 */
export function buildCommandsFor(files: RepoFiles): readonly CommandSpec[] {
  const has = (name: string): boolean => files.names.includes(name);

  // ── Node / TypeScript ────────────────────────────────────────────────────
  if (has("package.json")) {
    const scripts = scriptsOf(files.packageJson);
    // Paket yöneticisi kilit dosyasından okunur: yanlış yöneticiyle kurulum,
    // kilit dosyasını yok sayıp farklı sürümler çeker.
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const install: CommandSpec =
      pm === "npm"
        ? { name: "bağımlılıklar", command: ["npm", "ci"] }
        : { name: "bağımlılıklar", command: [pm, "install", "--frozen-lockfile"] };
    // `build` yoksa `tsc --noEmit` denenmez: script'i olmayan bir depoda
    // TypeScript kurulu olmayabilir ve komut "bulunamadı" ile düşerdi — kodun
    // hatası gibi görünen bir ortam hatası.
    if (scripts.has("build")) {
      return [install, { name: "derleme", command: [pm, "run", "build"] }];
    }
    if (scripts.has("typecheck")) {
      return [install, { name: "tip denetimi", command: [pm, "run", "typecheck"] }];
    }
    return [install];
  }

  // ── .NET ─────────────────────────────────────────────────────────────────
  if (files.names.some((n) => n.endsWith(".sln") || n.endsWith(".csproj"))) {
    return [{ name: "derleme", command: ["dotnet", "build", "--nologo"] }];
  }

  // ── Java ─────────────────────────────────────────────────────────────────
  // `-DskipTests`/`-x test`: DERLEME isteniyor, çalıştırma değil. Testler
  // ayrı bir karardır ve yan etkisi olabilir.
  if (has("pom.xml")) {
    return [{ name: "derleme", command: ["mvn", "-B", "-DskipTests", "compile"] }];
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    return [{ name: "derleme", command: ["./gradlew", "--no-daemon", "-x", "test", "assemble"] }];
  }

  // ── Python ───────────────────────────────────────────────────────────────
  // Python derlenmez; `compileall` sözdizimi kontrolüdür ve bu bağlamda
  // "derlenebilir mi" sorusunun en yakın karşılığı.
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    return [{ name: "sözdizimi denetimi", command: ["python", "-m", "compileall", "-q", "."] }];
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  if (has("go.mod")) {
    return [{ name: "derleme", command: ["go", "build", "./..."] }];
  }

  // ── Rust ─────────────────────────────────────────────────────────────────
  if (has("Cargo.toml")) {
    return [{ name: "derleme", command: ["cargo", "build", "--locked"] }];
  }

  // Tanınmayan yığın: komut UYDURULMAZ. Boş liste "derleme atlandı" demek, ve
  // bu, var olmayan bir betiği çalıştırıp kırmızı yakmaktan dürüsttür.
  return [];
}
