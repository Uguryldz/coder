# RAPOR — `@maestro/scanners` (Dalga 2)

M27 (gitleaks + semgrep + trivy, dijest-pinli imajlar, **fail-closed**, sonuçlar kanıt paketine),
M77 (opsiyonel kurum sürücüleri), M34 (kanıt paketi), M44 (eklenti/DI), M71 (`scan.block_level`).

## 1. Ne yapıldı

`packages/scanners` — ScanPort sürücüleri. Üretim kodu **1199 satır** (tavan 1200), en büyük dosya 117 satır.

| Dosya | İş |
|---|---|
| `src/image.ts` | **Dijest pinleme kapısı**: `<ad>@sha256:<64 hex>` dışındaki her referans reddedilir; dijest yanında dursa bile `:latest`/`:main`/`:edge`… gibi oynak etiketler reddedilir |
| `src/config.ts` | `ContainerScanConfig` (Zod), `SCAN_PORT`, `CORE_SCAN_TOOLS`, `SCAN_BLOCK_LEVEL_PARAM` |
| `src/runner.ts` | `ContainerRunner` arayüzü (enjekte edilir) + `Clock` |
| `src/tools.ts` | Araç başına komut satırı, "koştu sayılan" çıkış kodları, ayrıştırıcı bağlantısı |
| `src/parse/{gitleaks,semgrep,trivy}.ts` | Gerçek JSON şemalarının Zod karşılığı + `ScanFinding` eşlemesi |
| `src/severity.ts` | Seviye sıralaması, eşik (`blockLevel`) değerlendirmesi |
| `src/result.ts` | `ScanResult` üretimi; **tek hata yolu** = `outcome: "error"` |
| `src/container-driver.ts` | `ContainerScanPort` — fail-closed çekirdek |
| `src/optional/{http-scan,fortify,sonarqube,xray}.ts` | M77 sürücüleri |
| `src/evidence.ts` | M34 çıktısı: araç başına JSON + `scan/summary.md` + kapı kararı + `EvidenceFile` manifest girdisi |
| `src/register.ts` | `registerScanDrivers(registry, deps)` (M44) |

### Fail-closed nasıl garanti edildi (M27, en kritik kural)

- `run()` **hiçbir koşulda fırlatmaz**; başarısızlığın tek ifadesi `outcome: "error"`, o da `isScanBlocking`
  gereği bloke eder. `pass` yalnız şu üçü birden olursa döner: konteyner koştu + "tamamlandı" anlamına
  gelen bir çıkış kodu + tam olarak ayrıştırılabilen rapor.
- `error`'a düşen yollar: imaj çekilemedi/runner fırlattı · timeout · beklenmeyen çıkış kodu
  (rapor geçerli JSON olsa bile) · boş stdout · JSON olmayan/kesilmiş stdout · şemaya uymayan rapor ·
  aracın kendi bildirdiği hata (semgrep `errors[]`) · üretilen sonucun sözleşmeyi ihlal etmesi ·
  sürücünün başka bir araca sorulması · boş `workspacePath` · bayrak gibi okunabilecek `diffBaseRef`.
- **Eşik hiçbir zaman hatayı affetmez**: `blockLevel: "critical"` olsa da `error` bloke eder.
- **"Tarama koşmadı ama devam ettik" imkânsız**: `scanGateDecision()` zorunlu üçlüden **sonucu olmayan**
  aracı `missing` sayar ve akışı bloke eder; boş sonuç listesi de bloke. Sürücüyü bağlamayı unutmak
  kapıyı açmaz. (`test/fail-closed.test.ts`)
- Yapılandırma hataları (`ScanConfigError`) **fabrikada**, tarama başlamadan fırlar; çalışma anında
  sessiz bir varsayılana düşmez.

### Sonuçta hata sebebi nerede duruyor

`ScanResult`'ta mesaj alanı yok ve "hatalı ama bulgusuz" sonuç, kanıt paketinde "temiz geçti" ile
aynı görünürdü. Bu yüzden hata sebebi `ruleId: "maestro.scan-error"` (severity `critical`) sentetik
bir bulgu olarak yazılıyor — `maestro.` öneki hiçbir araç kuralıyla çakışmaz. Araç **stderr'i
varsayılan olarak sonuca girmez** (`includeStderrInError: false`): stderr eşleşen satırı yankılayabilir,
hata sonucu bir sır ifşa kanalı olmamalı.

## 2. Test özeti

`pnpm -F @maestro/scanners test` → **8 dosya, 104 test, hepsi yeşil**. Tümü çevrimdışı ve deterministik
(enjekte `ContainerRunner`, enjekte `fetch`, sabit saat).

| Dosya | Test | Kapsam |
|---|---|---|
| `test/image.test.ts` | 11 | dijest pinleme, oynak etiket reddi, şema varsayılanları |
| `test/severity.test.ts` | 7 | eşik mantığı, `isScanBlocking` ile tutarlılık |
| `test/parse.test.ts` | 22 | üç aracın gerçek çıktı şeması, sır sızdırmama, bozuk çıktı = istisna |
| `test/container-driver.test.ts` | 13 | komut satırı, mount/ağ/timeout, pass/fail eşiği |
| `test/fail-closed.test.ts` | 20 | **10 başarısızlık senaryosu**, `run()` fırlatmaz, eksik tarama bloke |
| `test/evidence.test.ts` | 11 | M34 dosyaları, özet, determinizm, `EvidenceFile` doğrulaması |
| `test/register.test.ts` | 9 | M44 kayıt, deps override, opsiyonel sürücü reddi |
| `test/optional.test.ts` | 11 | Fortify/SonarQube/Xray |

Kök kapıları: `pnpm lint`, `pnpm typecheck`, `pnpm test` — üçü de yeşil.

## 3. Fikstürlerin kaynağı (dürüst kayıt)

**Hiçbiri canlı araç koşumundan yakalanmadı.** Bu ortamda gitleaks/semgrep/trivy/SSC/SonarQube erişimi
yok; fikstürler araçların **belgelenmiş JSON çıktı şemalarına göre elle yazıldı** ve gerçek bir çıktıda
bulunacak yan alanlar (Fingerprint, Layer, textRange, paging, links…) bilerek korundu — ayrıştırıcılar
`looseObject` ile yazıldığı için bu alanlar sürüm yükseltmesinde taramayı hataya düşürmez.

| Fikstür | Kaynak | Not |
|---|---|---|
| `gitleaks-report.json` | gitleaks v8 rapor şeması (PascalCase; `RuleID`, `File`, `StartLine`, `Description`, `Fingerprint`…) | `Secret`/`Match` alanları maskeli yazıldı, kod bunları zaten okumuyor |
| `semgrep-results.json` | semgrep `--json` (`results[].extra.severity` + `extra.metadata.severity`, `is_ignored`) | biri metadata'lı (HIGH), biri metadata'sız (INFO), biri `is_ignored` |
| `semgrep-fatal.json` | semgrep `errors[]` (`level: "error"`, `type: "SourceParseError"`) | bulgusuz ama hatalı koşum |
| `trivy-fs.json` | trivy `--format json` (`Results[].Vulnerabilities[]`) | biri HIGH, biri UNKNOWN; ayrıca `Vulnerabilities` anahtarı hiç olmayan temiz hedef |
| `trivy-clean.json` | trivy'nin bulgu yokken `Results`'ı hiç yazmaması | |
| `fortify-issues.json` | Fortify SSC `/api/v1/.../issues` zarfı (`data`, `count`, `responseCode`) | **erişim gelince doğrulanacak** |
| `sonarqube-issues.json` | SonarQube `/api/issues/search` (`issues[]`, `component`, `severity`) | **erişim gelince doğrulanacak** |

**Erişim geldiğinde yapılacak:** her fikstür gerçek bir koşumun çıktısıyla değiştirilecek; şema
farkı çıkarsa ayrıştırıcı hata verir (sessiz geçmez), bu yüzden fark derhal görünür olur.

## 4. Kararlar ve varsayımlar

1. **`blockLevel` varsayılanı `"high"`** — görev "katı varsayılan" diyordu; `packages/db/src/params-defaults.ts`
   içindeki platform varsayılanı (`scan.block_level` = `high`, M71) ile **bilerek aynı tutuldu**. Sürücüye
   özel farklı bir varsayılan, "üreten ile tüketen farklı değer kullanıyor" hatasının ta kendisi olurdu.
   Eşik ne olursa olsun `error` bloke eder; `"info"` verilirse her bulgu bloke eder.
2. **gitleaks'in severity'si yoktur** — bulunan her sır `secretSeverity` ile derecelendirilir (varsayılan
   `critical`). Uydurma bir alan okunmadı.
3. **semgrep `rulesRef` zorunlu** — kural seti tarama anında indirilmez (`--config=auto` ağ ister).
   Verilmezse sürücü fabrikada reddeder. `--metrics=off` her koşumda geçilir.
4. **trivy `UNKNOWN` → `medium`** — `UNKNOWN`, "kimse derecelendirmemiş" demektir, "zararsız" değil;
   `info`'ya eşlemek her derecesiz zafiyeti her eşiğin altına park ederdi.
5. **semgrep bilinmeyen severity etiketi → `high`** — yeni bir etiket sessizce eşiğin altına düşmesin.
6. **trivy `Secrets` / `Misconfigurations` kapsam dışı** — sır taraması gitleaks'in işi (M27); yanlış
   pozitif çiftlemesi yerine tek kaynak. Gerekirse ayrı bir turda eklenir.
7. **Konteyner varsayılanı ağsız + salt-okunur mount.** Trivy DB aynası gereken kurumlar için
   `networkMode: "internal"` + `env` (ör. `TRIVY_DB_REPOSITORY`) var.
8. **Özet dosyası dil-bağımsız** — `scan/summary.md` sütunları sözleşme alan adları (`tool`, `outcome`,
   `imageDigest`, severity adları). Kullanıcıya dönük cümle üretmiyoruz; o M104 kataloğunun işi
   (`evidence.ready` gibi anahtarlar kanıt paketi kurucusunda kullanılacak).
9. **Yeni runtime bağımlılığı yok** — yalnız `zod` + `@maestro/contracts` + `@maestro/ports`; sha256 için
   `node:crypto`. contracts/ports'a dokunulmadı.

## 5. Talepler (orkestratör kararı gerekiyor)

1. **Konteyner koşumu için port arayüzü.** `RunnerPort.runSession` (`packages/ports/src/runner.ts`) bu iş
   için kullanılamadı: (a) `RunJob`'ta **imaj alanı yok** — dijest-pinli imaj ifade edilemiyor,
   (b) `RunResult` yalnız `stdoutTail` döndürüyor — kesilmiş bir rapor bizde ayrıştırma hatası olur,
   yani her büyük tarama `error`'a düşerdi. Bu yüzden pakette **kendi `ContainerRunner` arayüzü** tanımlandı
   (yalnız tip; kod yok). **Talep:** `@maestro/runners` bu arayüzü karşılayan bir uygulama dışa versin
   (dijest-pinli tek-atım konteyner + tam stdout), ya da ileride `RunnerPort`'a eşdeğer bir metot eklensin.
   Uydurma bir eşleme yazmamak için adaptör bilerek yazılmadı.
2. **`ScanResult.imageDigest` konteyner-olmayan sürücülere uymuyor.** Alan zorunlu ve `NonEmpty`;
   Fortify/SonarQube'un imajı yok. Şimdilik köken dizesi yazılıyor (`fortify-ssc:projectVersion/42`,
   `sonarqube:ugurpay`). **Öneri:** sözleşmede alan `provenance` olarak genelleşsin veya
   `imageDigest` opsiyonel + `provenance` eklensin. (Sözleşme DONUK olduğu için değiştirilmedi.)
3. **`ScanResult`'ta hata sebebi alanı yok.** Şimdilik `maestro.scan-error` sentetik bulgusu kullanılıyor
   (§1). Sözleşmeye opsiyonel bir `note`/`error` alanı eklenirse bu geçici çözüm kaldırılır.
4. **Xray hangi ürün?** M77 Xray'i **test yönetimi** başlığında sayıyor ("Xray/Zephyr"), ama `ScanTool`
   enum'unda `xray` bir tarayıcı olarak duruyor — bu JFrog Xray'e benziyor. İki ürünün API'si, kimlik
   doğrulaması ve gövdesi tamamen farklı. Tahminle istemci yazmak, "hiç taramadan `pass` dönebilen"
   bir entegrasyon üretirdi; bu yüzden `createXrayScanPort` **yapılandırılsa bile**
   `CapabilityNotSupportedError` fırlatıyor. Karar gelince 30 satırlık bir sürücüyle kapanır.

## 6. Erişim gelince doğrulanacaklar

- **gitleaks komutu:** `detect --no-git --report-format json --report-path /dev/stdout` kullanılıyor.
  v8.19+ `gitleaks dir` alt komutunu öneriyor (`detect` hâlâ çalışıyor). Ayrıca `/dev/stdout`'a rapor
  yazımı kurumdaki imajda doğrulanmalı; gerekirse `extraArgs` ile ya da tek satırlık bir değişiklikle
  dosyaya yazıp okuma modeline geçilir. Çıkış kodları: `0` temiz, `1` sızıntı, diğerleri hata.
- **semgrep `errors[].level`** değerleri sürüme göre değişebiliyor; `warn`/`warning`/`info` dışındaki
  her seviye ölümcül sayılıyor (fail-closed yönü). Kurumdaki sürümde gürültü yaratırsa liste ayarlanır.
- **Fortify SSC:** uç (`/api/v1/projectVersions/{id}/issues`), `Authorization: FortifyToken <token>`
  şeması ve `data[]` alan adları (`issueName`, `friority`, `fullFileName`, `lineNumber`, `engineCategory`)
  **erişim gelince doğrulanacak**. Uygulanan akış **rapor çekme**dir: taramayı mevcut Fortify hattı
  (ScanCentral / fpr yükleme) başlatır, Maestro proje sürümünün bulgu listesini okur. Taramayı Maestro'nun
  tetiklemesi istenirse ayrı bir tur gerekir (kapsam dışı bırakıldı, uydurma uç yazılmadı).
- **SonarQube:** `Authorization: Bearer <token>` SonarQube 9.x+ içindir; daha eski sunucular token'ı
  Basic kullanıcı adı olarak bekler. Kurum sürümü öğrenilince tek satırlık değişiklik.
- Her iki opsiyonel sürücü de **https zorunlu** tutuyor (kimlik bilgisi bu bağlantıda gidiyor);
  kurumda TLS sonlandırma farklıysa bu kural gözden geçirilir.
