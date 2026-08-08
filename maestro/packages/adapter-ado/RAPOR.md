# RAPOR — `@maestro/adapter-ado`

Dalga 1 paketi: ADO çift-mod adaptörü (`ScmPort` + `CiPort` sürücüleri, M11-M13, M48/M49).
Yalnız `packages/adapter-ado/` altına dokunuldu; `contracts` ve `ports` **okundu, değiştirilmedi**.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/config.ts` | Zod'lu sürücü konfigü (`mode: server \| services`), **api-version tablosu** (Server `6.0` / Services `7.1`, opsiyonel override), mod-bazlı `_apis` kök URL üretimi |
| `src/client.ts` | `AdoClient` — çift-mod URL, PAT basic auth (enjekte `TokenProvider`), enjekte `fetch`, tipli hata eşleme |
| `src/errors.ts` | `AdoError` ağacı: `AdoConfigError` · `AdoHttpError` · `AdoAuthError` · `AdoNotFoundError` · `AdoResponseError` · `AdoWebhookAuthError` |
| `src/schemas.ts` | Tükettiğimiz ADO yanıtlarının Zod şemaları (loose: bilinmeyen alanlar serbest, okunan alanlar zorunlu) |
| `src/branch.ts` | M49 dal sözleşmesi: `feature/<TICKET-KEY>-*` → ticket key; `refs/pull/<id>/merge` → PR id; ref/branch normalizasyonu; `GitSha` doğrulama |
| `src/scm.ts` | `AdoScmDriver` — `resolveRepo` (ApplicationRecord → repo GET ile doğrulama) · `createBranch` (base SHA veya dal adından tip çözümü + zero-object ref update) · `getPushCredential` (enjekte `SecretIssuer` pass-through) · `openPr` (`draft` → `isDraft`) · `activatePr` · `listPrThreads` (thread status eşleme) · `replyThread` · `getPrStatus` (draft/active/completed/abandoned + `lastMergeCommit` → `GitSha \| null`) |
| `src/ci.ts` | `AdoCiDriver.parseBuildEvent` — Service Hook `build.complete` → `CiResultSignal`; build dışı olay/PR dışı build/ticket key'siz dal → `null` |
| `src/webhook.ts` | Service Hook paylaşılan-sır kontrolü: basic auth başlığı, sabit-zamanlı karşılaştırma (`node:crypto`), **fail-closed** |
| `src/register.ts` | `registerAdoDrivers(registry, deps)` → `"scm"/"ado"` ve `"ci"/"ado"`; konfig kayıt anında Zod ile doğrulanır |
| `test/fixtures/*.json` | repo GET · refs list · refs update (başarılı + `success:false` reddi) · PR create (draft) / get (active, completed, abandoned) · threads list (aktif/fixed/wontFix/sistem/silinmiş/status'suz) · thread comment created · `build.complete` (services + server) · PR'sız CI build · ticket key'siz build · build dışı olay (`git.push`) |

## 2. Testler

`pnpm -F @maestro/adapter-ado test` → **7 dosya / 80 test yeşil.**

| Dosya | Test | Kapsam |
|---|---|---|
| `config.test.ts` | 10 | iki modun URL kökü, api-version pinleme, override reddi, çok segmentli collection, hatalı konfig |
| `client.test.ts` | 10 | Server/Services URL, query, PAT basic auth, her istekte token, 401/403/404 eşleme, **203 sign-in sayfası → auth hatası**, 204/boş gövde |
| `branch.test.ts` | 8 | M49 ticket key çıkarımı (+ negatifler: `main`, `release/*`, `hotfix/*`, küçük harf), PR merge ref, SHA doğrulama |
| `scm.test.ts` | 23 | sekiz `ScmPort` metodu fikstürlere karşı; istek gövdesi/URL/method assert'leri; `success:false` ref update reddi; bozuk `lastMergeCommit` reddi; thread eşleme + filtreleme; server modunda aynı akış |
| `ci.test.ts` | 16 | services + server `build.complete`; null yolları (build dışı, PR'sız, ticket key'siz, geçersiz zarf); `partiallySucceeded/canceled` → `failed`; resourceVersion 1.0 `status` alanı; zaman damgası fallback'leri ve zone'suz damganın UTC okunması; bozuk resource'ta **sessizlik yerine hata** |
| `webhook.test.ts` | 9 | eksik/bozuk/yanlış kimlik reddi, boş kullanıcı adı biçimi, sır tanımsızsa çalışmayı reddetme, sırrın hata mesajına sızmaması |
| `register.test.ts` | 4 | iki portun kaydı, kayıt anında konfig doğrulama, token provider'ın uçtan uca bağlanması, çift kayıt reddi |

Tümü **çevrimdışı ve deterministik**: enjekte edilen sahte `fetch` fikstür döndürür, ağ yok, saat yok.
Çıktılar `@maestro/contracts` şemalarıyla doğrulanıyor (`CiResultSignal`, `GitSha`, `IsoDateTime`, `ApplicationRecord`).

Kapı komutları: `pnpm install` · `pnpm -F @maestro/adapter-ado typecheck` · `pnpm -F @maestro/adapter-ado test` · `pnpm lint` → **hepsi yeşil** (kökten `pnpm typecheck` + `pnpm test` de yeşil).

## 3. Varsayımlar (denetlenmesi gerekenler)

1. **Fikstürler kayıt değil, belgeye göre yazıldı.** Kurum erişimi yok; şekiller Azure DevOps REST (Server 2022 "TFS" + Services) ve Service Hooks dokümante edilmiş payload'larından türetildi. Erişim geldiğinde Aşama-0 duman testinde gerçek yanıtlarla değiştirilmeli (insa-plani §6).
2. **api-version:** Server `6.0`, Services `7.1` — tek tablo (`ADO_API_VERSIONS`), uç bazlı istisna yok. Bir uç farklı sürüm isterse `apiVersion` override'ı var.
3. **Kimlik doğrulama her iki modda da PAT basic auth.** M11 metninde Services için "Entra ID service principal" yazıyor; pakette bearer/OAuth akışı **yok** (spec PAT dedi). Bkz. talep #1.
4. **`build.complete` → sinyal yalnız PR validation build'lerinde üretilir.** PR id sırası: `triggerInfo["pr.number"]` → `refs/pull/<id>/merge`. Ticket key sırası: `triggerInfo["pr.sourceBranch"]` → `sourceBranch` → `sourceGetVersion`. İkisinden biri yoksa `null` (olayı yok say) — yanlış key uydurmak yanlış workflow'a sinyal gönderirdi.
5. **Fail-closed CI eşlemesi:** `succeeded` dışındaki her sonuç (`partiallySucceeded`, `canceled`, tanınmayan) → `failed`.
6. **Thread status eşlemesi:** `active`/`pending`/`unknown`/(alan yok) → `active`; `fixed` → `fixed`; `closed`/`wontFix`/`byDesign` → `closed`. Bilinmeyeni "açık" saymak 12b döngüsünü erken kapatmamak içindir.
7. **Sistem thread'leri elenir** (`commentType: "system"` — oy/politika güncellemeleri) ve silinmiş thread/yorumlar atılır; geriye insan yorumu kalmayan thread listelenmez.
8. **`replyThread` `parentCommentId: 1` kullanır** — ADO'da bir thread'in ilk yorumu daima `id: 1`'dir, cevap o köke bağlanır.
9. **`getPushCredential` ADO'ya çağrı yapmaz**; enjekte edilen `SecretIssuer`'ın ürettiği kısa ömürlü kimliği geçirir ve `expiresAt`'i `IsoDateTime` ile doğrular. Scope anahtarı sabit: `ado/<project>/<repo>/push`.
10. **Service Hooks payload imzalamaz** (Jira'daki gibi HMAC yok). Tek kimlik doğrulama basic auth + TLS + IP allowlist; bu yüzden `verifyServiceHookAuth` fail-closed ve sır boşsa çalışmayı reddediyor.
11. **Zaman damgaları:** ADO 7 haneli saniye kesiri gönderir; zone'suz gelen on-prem damgası **UTC** kabul edilir (makinenin yerel saatine göre kaymasın diye), çıktı `toISOString()` ile normalize edilir.
12. **203 Non-Authoritative Information** yanıtı (sign-in HTML'i) auth hatası sayılır — `response.ok` true olduğu için yakalanmazsa JSON parse hatasıyla yanıltırdı.
13. `resolveRepo` kayıttaki repo'yu **GET ile doğrular**; Application Registry'deki yazım hatası burada patlar, üç adım sonra push sırasında değil.

## 4. Bağımlılıklar

**Yeni runtime bağımlılığı YOK.** Sadece global `fetch` + `node:crypto` + `Buffer`.

| Bağımlılık | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts`, `@maestro/ports` | runtime (workspace) | donmuş arayüzler ve şemalar |
| `zod` | runtime | monorepo'da zaten standart; yanıt/konfig doğrulama |
| `@types/node`, `typescript`, `vitest` | dev | paket sözleşmesindeki standart set |
| `@maestro/test-kit` | dev (workspace) | ortak `loadFixture` düzeni — fikstürler tek kalıptan okunuyor |

## 5. Arayüz / karar talepleri (orkestratöre)

1. **Services modunda Entra ID.** M11 "service principal" diyor; bugün sürücü PAT basic auth kullanıyor. İstenirse `config.authScheme: "pat" | "bearer"` + `TokenProvider`'ın bearer token dönmesi yeterli — `AdoClient`'ta tek satırlık başlık değişimi, `contracts`/`ports` etkilenmez. Karar senin.
2. **`CiResultSignal` repo/proje taşımıyor.** Bugün korelasyon `ticketKey` + `prId` ile. Farklı projelerde aynı PR id'si mümkün olduğundan, workflow'un sinyalin kendi repo'suna ait olduğunu doğrulaması için `CiResultSignal`'e opsiyonel `adoProject`/`adoRepo` (veya `buildDefinitionId`) eklenmesi öneriliyor. **Arayüz değişikliği — dokunmadım.**
3. **`PrThread.status` üç değerli.** `wontFix` ile `closed` aynı kovaya düşüyor; 12b döngüsünde "reddedildi ama kapandı" ayrımı gerekirse `PrThread`'e ham status alanı eklenmeli.
4. **Webhook kimlik doğrulaması port arayüzünde yok.** `CiPort` yalnız `parseBuildEvent` içeriyor; `assertServiceHookAuth` paketten ayrıca export ediliyor ve **bff'in çağırması gerekiyor**. Unutulursa uç kimliksiz kalır — entegrasyon kapısında bu çağrının varlığı kontrol edilmeli (ya da `CiPort`'a `verifyWebhook` eklenmeli).
5. **`PortRegistry.DriverFactory` yalnız `config` alıyor**; sürücünün ihtiyaç duyduğu `resolveToken`/`issueSecret`/`fetch` bu yüzden `registerAdoDrivers(registry, deps)` ile kayıt anında bağlanıyor. Bu, composition root'un ADO deps'ini kayıt sırasında hazır etmesini gerektirir — kabul edilebilir görünüyor, aksi halde `DriverFactory` imzası değişmeli.
6. **`ScmPort.getPushCredential` dönüşü `{ token, expiresAt }`**, `SecretPort.issueShortLived` dönüşü `{ secret, expiresAt }`. İsim farkı sürücüde çevriliyor; ileride tek isimde birleşmesi okunabilirliği artırır (zorunlu değil).
