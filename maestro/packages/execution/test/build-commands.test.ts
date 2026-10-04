import { describe, expect, it } from "vitest";
import { buildCommandsFor } from "../src/build-commands.js";

/**
 * "Ajan vibe coding yapsın ama proje DERLENEBİLİR olsun."
 *
 * Doğrulama altyapısı zaten vardı — doğrulayıcı ajan derleme sonucunu
 * raporluyor ve kırmızıysa onaylamıyor. Ama komutlar koşu satırındaki
 * `verificationJson`dan geliyordu ve oraya HİÇBİR KOD YAZMIYORDU: canlıda
 * ölçüldü, 40 koşunun 40'ında alan boş. Kapı vardı, kapıdan geçecek şey
 * üretilmiyordu.
 *
 * Bu modül o boşluğu depodan dolduruyor — operatöre sorarak değil, çünkü bir
 * deponun nasıl derlendiği deponun kendi bilgisidir ve dosyalarında yazılıdır.
 */
describe("depodan derleme komutu", () => {
  it("pnpm deposu: kilit dosyasından yönetici, script'ten komut", () => {
    expect(
      buildCommandsFor({
        names: ["package.json", "pnpm-lock.yaml"],
        packageJson: { scripts: { build: "tsc" } },
      }),
    ).toEqual([
      { name: "bağımlılıklar", command: ["pnpm", "install", "--frozen-lockfile"] },
      { name: "derleme", command: ["pnpm", "run", "build"] },
    ]);
  });

  it("npm deposu `npm ci` kullanır — `install --frozen-lockfile` npm'de yok", () => {
    const [install] = buildCommandsFor({
      names: ["package.json", "package-lock.json"],
      packageJson: { scripts: { build: "x" } },
    });
    expect(install).toEqual({ name: "bağımlılıklar", command: ["npm", "ci"] });
  });

  it("yarn kilidi yarn'ı seçer", () => {
    const [install] = buildCommandsFor({
      names: ["package.json", "yarn.lock"],
      packageJson: { scripts: { build: "x" } },
    });
    expect(install?.command[0]).toBe("yarn");
  });

  it("`build` yoksa `typecheck`e düşer", () => {
    const commands = buildCommandsFor({
      names: ["package.json"],
      packageJson: { scripts: { typecheck: "tsc --noEmit" } },
    });
    expect(commands.at(-1)).toEqual({ name: "tip denetimi", command: ["npm", "run", "typecheck"] });
  });

  it("hiçbir script yoksa UYDURMAZ — yalnız bağımlılık kurulumu", () => {
    // `tsc --noEmit` denemek, TypeScript kurulu olmayan bir depoda
    // "bulunamadı" ile düşerdi: kodun hatası gibi görünen bir ortam hatası.
    const commands = buildCommandsFor({ names: ["package.json"], packageJson: { scripts: {} } });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command[0]).toBe("npm");
  });

  it.each([
    [["Solution.sln"], "dotnet"],
    [["Api.csproj"], "dotnet"],
    [["pom.xml"], "mvn"],
    [["build.gradle"], "./gradlew"],
    [["build.gradle.kts"], "./gradlew"],
    [["go.mod"], "go"],
    [["Cargo.toml"], "cargo"],
    [["pyproject.toml"], "python"],
    [["requirements.txt"], "python"],
  ])("%s → %s", (names, tool) => {
    expect(buildCommandsFor({ names })[0]?.command[0]).toBe(tool);
  });

  it("Java ve Gradle TEST ÇALIŞTIRMAZ — derleme isteniyor, çalıştırma değil", () => {
    // Test çalıştırmak bir bankada yan etki demek: veritabanına yazan bir
    // fixture, bir kuyruğa düşen mesaj. Derlemek yalnız "bu kod tutarlı mı"
    // sorusunu sorar.
    expect(buildCommandsFor({ names: ["pom.xml"] })[0]?.command).toContain("-DskipTests");
    expect(buildCommandsFor({ names: ["build.gradle"] })[0]?.command).toContain("-x");
  });

  it("TANINMAYAN yığın için komut UYDURULMAZ", () => {
    // Var olmayan bir betiği çalıştırıp "derleme kırmızı" demek, tanımadığımız
    // her projeyi bloklamak olurdu. Boş liste "derleme atlandı" demek ve bu
    // dürüst olan.
    expect(buildCommandsFor({ names: ["README.md", "LICENSE"] })).toEqual([]);
    expect(buildCommandsFor({ names: [] })).toEqual([]);
  });

  it("bozuk package.json çökertmez — bağımlılık kurulumu yine verilir", () => {
    for (const bad of [null, "metin", 42, { scripts: "nesne değil" }]) {
      expect(() => buildCommandsFor({ names: ["package.json"], packageJson: bad })).not.toThrow();
    }
  });
});
