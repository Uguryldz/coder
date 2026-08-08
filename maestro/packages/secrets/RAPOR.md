# RAPOR — `@maestro/secrets` (Dalga 1)

`SecretPort` (M80) iki sürücüsü: **vault** (HashiCorp Vault KV v2 + AppRole) ve **env-file** (dev).
Kod/yorum/test adları İngilizce (M59); bu rapor Türkçe.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/keys.ts` | Ortak anahtar dilbilgisi: `<mount>/<path>[#<field>]`. Segment kuralı path-traversal'ı (`..`, boş segment, boşluk) kapatır. `parseScope` kısa ömürlü kimlik kapsamı için aynı kuralı uygular. `envVarName` env-file eşlemesi. |
| `src/config.ts` | Zod yapılandırması: `VaultConfig`, `EnvFileConfig`, `ShortLivedConfig`. `allowedMounts` (en az 1 — boş liste joker DEĞİL), TTL tavanları, `SECRET_PORT`/`VAULT_DRIVER`/`ENV_FILE_DRIVER` sabitleri. |
| `src/errors.ts` | Tipli hatalar: `SecretNotFoundError` (404), `SecretPermissionDeniedError` (403 / mount izinsiz), `VaultSealedError` (501/503), `VaultHttpError`, `VaultResponseError`, `SecretTtlError`, `SecretExpiredError`, `SecretKeyError`, `SecretConfigError`. Hiçbiri yanıt gövdesi taşımaz. |
| `src/cache.ts` | Enjekte saat (`Clock`) + TTL'li bellek içi önbellek. Değerler `#private` alanda. |
| `src/vault-client.ts` | AppRole login, lease takibi, süre dolmadan `renew-self` ile yenileme (başarısızsa yeniden login), eşzamanlı isteklerde tek-uçuş (single-flight) login, KV/dinamik okuma, durum→hata eşlemesi. Enjekte `fetch`. |
| `src/vault-driver.ts` | `SecretPort` uygulaması: `get()` (KV v2 `data/` öneki, alan seçimi, önbellek) + `issueShortLived()` (M31). |
| `src/env-file-driver.ts` | Ortam değişkeni + opsiyonel dotenv dosyası. `issueShortLived` → `CapabilityNotSupportedError`. Üretimde **kurucuda** reddedilir. |
| `src/register.ts` | `registerSecretDrivers(registry)` — M44 DI; iki sürücü de `secret` portuna kayıtlı. |
| `fixtures/*.json` | Kayıtlı-biçim Vault yanıtları (login, renew, KV okuma, silinmiş KV, dinamik kimlik, 403/503 gövdeleri). Test hiçbir yanıt şeklini satır içinde uydurmuyor (§5 "halüsinasyon entegrasyon" maddesi). |

### Fail-closed davranışlar (M6 ruhu)
- `allowedMounts` dışındaki mount → **istek yapılmadan** `SecretPermissionDeniedError`.
- Bozuk anahtar/kapsam → **istek yapılmadan** `SecretKeyError`.
- Alan yoksa **veya boş string** ise → `SecretNotFoundError` (boş secret = yer tutucu = yok sayılır).
- `issueShortLived` TTL zorunlu, pozitif tam sayı, `maxTtlSeconds` tavanının üstü **reddedilir** (kırpılmaz — çağıran elindeki kimliğin ömrü hakkında yanılamaz).
- Vault'un verdiği lease, istenen TTL'nin yerine geçer; `lease_duration <= 0` → `SecretExpiredError`. Süresi dolmuş kimlik asla dönmez.
- `filePath` yapılandırılmış ama okunamıyorsa hata yükselir (sessizce boş kaynak yok).
- AppRole `roleId`/`secretId` yoksa istemci kurulmaz.
- Üretimde `env-file` sürücüsü kurulmaz (`SecretConfigError`), sadece fabrika yolunda değil **sınıf kurucusunda** — DI'yi atlayarak da kaçırılamaz.

### Sızıntı koruması
- Secret materyali (`role_id`, `secret_id`, client token, önbellekteki değerler) yalnız ECMAScript `#private` alanlarda; `JSON.stringify`, `Object.keys`, `util.inspect` bunları göremez.
- `toJSON()`/`toString()` her sınıfta açıkça yazıldı; yalnız adres/sürücü/izinli mount/önbellek sayısı döner.
- Hatalar **asla** yanıt gövdesi taşımaz (adapter-jira'daki `responseBody` alanı bilinçli olarak kopyalanmadı — Vault gövdesi tanım gereği secret'tır).
- `test/leak.test.ts` bunu 10 testle kanıtlar; kontrol yüzeyi `String()`, `JSON.stringify()`, `util.inspect()` ve `Error.stack`.

## 2. Test özeti

`pnpm -F @maestro/secrets test` → **8 dosya / 110 test yeşil**, tamamen çevrimdışı ve deterministik
(enjekte `fetch` + sabit saat; ağ yok, `sleep` yok, `Date.now()` yok).

| Dosya | Kapsam |
|---|---|
| `keys.test.ts` (16) | Dilbilgisi, varsayılan alan, 9 ret vakası (traversal dâhil), env değişkeni eşlemesi |
| `cache.test.ts` (4) | TTL içi isabet, sınırda ıskalama + tahliye, TTL=0, `clear` |
| `vault-client.test.ts` (21) | Login gövdesi/başlıkları, token yeniden kullanımı, tek-uçuş, namespace, lease takibi, **skew içinde renew**, renew reddi→login, renewable=false→login, 403/404 veri olarak, 501/503/500/429 eşlemesi, bozuk/boş gövde |
| `vault-driver.test.ts` (24) | KV `data/` yolu, varsayılan alan, önbellek TTL ve `invalidate`, 403/404/503, boş/eksik alan, mount izni, bozuk anahtar; issueShortLived: ttl query'si, lease önceliği, tavan reddi, `0/-1/1.5/NaN` reddi, kapsam traversal reddi, süresi dolmuş red, alan eksik, önbelleklenmeme |
| `env-file-driver.test.ts` (16) | Ortamdan okuma, yok/boş, mount izni, bozuk anahtar, özel önek, dosya kaynağı + ortam önceliği + tek okuma + `invalidate`, okunamayan dosya, `parseDotEnv`, `CapabilityNotSupportedError`, **üretim reddi (2 yol)** |
| `driver-invariance.test.ts` (10) | `describe.each` ile iki sürücüde aynı senaryolar: var → aynı değer; yok → `SecretNotFoundError`; izinsiz → `SecretPermissionDeniedError` (`reason: mount_not_allowed`); bozuk → `SecretKeyError`; her hata sorulan anahtarı adlandırır |
| `leak.test.ts` (10) | Sürücü/istemci/önbellek render'ı ve 500/bozuk-gövde/expiry/login-hatası/404 hataları secret içermiyor + "aşırı redaksiyon yok" karşı-testi |
| `register.test.ts` (9) | Kayıt, iki sürücünün çözümlenmesi, bilinmeyen sürücü reddi, varsayılanlar, geçersiz config'in tüm alanları raporlaması, tavanlar |

**Mutasyon denetimi** (testlerin gerçekten ısırdığını kanıtlamak için — §5 "test gerçek mi"): üç kasıtlı bozma yapıldı ve her biri
tam olarak ilgili testi düşürdü, sonra geri alındı:
`ttl > max` kontrolü kaldırıldı → 1 test kırmızı · `VaultClient.toJSON`'a token eklendi → leak testi kırmızı ·
üretim kapısı devre dışı bırakıldı → 2 test kırmızı. Geri alma sonrası 110/110 yeşil.

**Kapı durumu:** `pnpm install` ✔ · `pnpm -F @maestro/secrets typecheck` ✔ · `pnpm -F @maestro/secrets test` ✔ (110) · kökten `pnpm lint` ✔.
Üretim kodu **871 satır** (tavan 1200), en büyük dosya 195 satır (tavan 300). Yeni runtime bağımlılığı **yok**
(`zod` + `@maestro/contracts` + `@maestro/ports`; dotenv ayrıştırıcı ~20 satır olarak elle yazıldı, `dotenv` paketi eklenmedi).

## 3. Varsayımlar

1. **KV sürüm 2.** `get()` yolu `<addr>/v1/<mount>/data/<path>`, yanıt `{data:{data:{...}}}`. KV v1 kullanılacaksa sürücüye `kvVersion` yapılandırması eklenmeli (5 satırlık iş).
2. **Anahtar dilbilgisi** `<mount>/<path>[#<field>]`, alan varsayılanı `value`. `adapter-jira`'daki `tokenRef: "kv/jira/pat"` örneği bu dilbilgisiyle uyumlu: mount `kv`, path `jira/pat`, alan `value`. Ekipler alan adı vermek isterse `kv/jira/pat#token` yazar.
3. **Kısa ömürlü kimlik** dinamik bir secrets engine'den okunur: `<shortLived.mount>/<pathPrefix>/<scope>?ttl=<n>s`, yanıtta `lease_duration` ve `data.<field>`. Varsayılanlar `git`/`creds`/`token`/900 s. Kurumdaki gerçek engine (Vault Git secrets, LDAP, database, ya da özel bir yol) belli olunca **yalnız yapılandırma** değişir, kod değişmez.
4. **AppRole** kimlik doğrulama; `role_id`/`secret_id` çalışma zamanı bağımlılığı olarak (env/dosya/init container) kompozisyon kökünden enjekte edilir — yapılandırmada asla yazmaz. Secret-ID yenileme/response-wrapping platform tarafında (deploy) çözülecek.
5. **`NODE_ENV === "production"`** üretim işareti kabul edildi (`@maestro/config/env.ts` ile aynı).
6. **env-file değişken adı**: `MAESTRO_SECRET_<MOUNT>_<PATH>__<FIELD>` (büyük harf, alfanümerik olmayanlar `_`). Örn. `kv/jira/pat#token` → `MAESTRO_SECRET_KV_JIRA_PAT__TOKEN`.
7. 5xx'te **yeniden deneme yok** — dayanıklı retry Temporal'ın işi (adapter-jira ile aynı duruş).

## 4. Arayüz / bağımlılık talepleri (orkestratöre)

> `packages/contracts` ve `packages/ports` **hiç değiştirilmedi**. Aşağıdakiler talep, uygulama değil.

1. **`DriverFactory` çalışma-zamanı bağımlılıkları (tekrarlanan talep).** `DriverFactory<P> = (config: unknown) => P`
   imzasında `fetch`, saat, AppRole materyali için yer yok; `adapter-jira`'nın başlattığı `{...config, deps:{...}}`
   sözleşmesini aynen sürdürdüm. İki paket aynı boşluğu aynı şekilde yamadığına göre kalıcı çözüm
   `resolve(port, driver)(config, deps)` gibi ikinci bir parametre olabilir — tek elden karar.
2. **`SecretPort.get` düz `string` döndürüyor.** Paket içinde sızıntıyı kapattım ama değer porttan çıktığı an
   düz string olarak çağıranın log'una girebilir. İleride `ports`'a `SecretValue` sarmalayıcısı
   (`{ expose(): string; toString(): "[redacted]" }`) eklenirse koruma uçtan uca olur. Bugün gerekmiyor,
   Dalga 2'de runner/execution paketleri secret'ı taşımaya başlayınca değerlendirilmeli.
3. **`@maestro/config/env.ts`**: `VAULT_ADDR` var; `VAULT_ROLE_ID` / `VAULT_SECRET_ID` (veya bunların dosya yolları)
   ve `MAESTRO_SECRET_DRIVER` yok. Kompozisyon kökü kurulurken `EnvSchema`'ya eklenmeli ve üretimde zorunlu
   listeye girmeli — bu paket `config`'e dokunmadı.
4. **Lease iptali.** `ScmPort.getPushCredential(ttl)` bittiğinde kimliği erken iptal etmek isteyecek
   (`sys/leases/revoke`). Bunu eklemek `SecretPort`'a bir `revoke(handle)` yöntemi gerektirir; port dondurulmuş
   olduğu için yazmadım. Dalga 2'de `runners`/`execution` speci yazılırken karara bağlanmalı.

## 5. Bilerek eksik bırakılanlar

- **CyberArk / Azure Key Vault sürücüleri** — M80 "kurum ürünü belli olunca". Anahtar dilbilgisi ve
  `allowedMounts` kapısı ortak olduğundan yeni sürücü yalnız `get()` + kayıt satırı yazacak.
- **403'te zorla yeniden login + tek tekrar.** Token ortada iptal edilirse faydalı olurdu; ama gerçek bir
  yetki reddini maskeleyebileceği ve TTL takibi yaygın vakayı zaten kapattığı için yazılmadı.
- **Verilen kısa ömürlü kimliğin yenilenmesi/iptali** (yukarıda madde 4).
- **Response wrapping (`X-Vault-Wrap-TTL`)** ve **secret-id rotasyonu** — dağıtım (deploy) paketinin işi.
- **KV v1** ve **KV meta/list/write** işlemleri — `SecretPort` yalnız okuma sözleşmesi.
- `invalidate()` bugün yalnız testlerden çağrılıyor; rotasyon sinyali (M71 parametre değişimi) bağlandığında
  kompozisyon kökünden çağrılacak. Ölü yol saymamak için portun parçası değil, sürücüye özel yardımcı olarak bıraktım.
