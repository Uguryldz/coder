# @maestro/adapter-jira — builder raporu

WorkPort sürücüsü: **Jira Data Center / Server**, REST v2, PAT + webhook secret (M46/M102).

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/client.ts` | `JiraDcClient` — enjekte edilen token sağlayıcısıyla PAT bearer auth, enjekte edilen `baseUrl`, ince `fetch` sarmalayıcı; JSON in/out; 204/boş gövde → `void`; **tek** 429 geri çekilmesi (Retry-After saniye, `maxBackoffMs` ile sınırlı), ikinci 429 kesin hata. Başka retry yok — dayanıklı tekrar Temporal'ın işi. |
| `src/errors.ts` | Tipli hatalar: `JiraHttpError` (taban) · `JiraAuthError` 401 · `JiraForbiddenError` 403 · `JiraNotFoundError` 404 · `JiraRateLimitError` 429 (+`retryAfterMs`) · `JiraWebhookVerificationError` · `JiraResponseError` · `JiraArgumentError` · `JiraLinkFailedError` · `JiraConfigError`. |
| `src/mapping.ts` | REST issue JSON → `TicketSnapshot` (components/labels/parent/proje/kullanıcı eşlemesi). Yalnız stok alanlar okunur — `ISSUE_FIELDS` içinde tek bir `customfield_*` yok (M98). Çıktı `TicketSnapshot` şemasından geçirilir; şema hatası `JiraResponseError` olarak hangi alanın patladığını söyler. |
| `src/datetime.ts` | DC `+0300` (iki nokta yok) ve webhook epoch-millis biçimlerini `IsoDateTime` sözleşmesine normalize eder. |
| `src/adf.ts` | ADF modeli + `paragraph · heading · codeBlock · panel · bulletList · strong/inlineCode/link · doc` üreticileri; `toAdfDocument` (ADF ya da düz metin) ve `adfToWikiMarkup`. |
| `src/commands.ts` | `parseCommandLine` / `parseCommandBody` — yorumun İLK dolu satırı; `/approve · /reject <sebep> · /status · /ai-explain · /ai-start · /ai-assign <appId> · /mode-change <mod> · /ai-takeover`. Asla throw etmez. |
| `src/webhook.ts` | RAW gövde üzerinde HMAC-SHA256 (`node:crypto`), sabit zamanlı karşılaştırma, **fail-closed**; `parseWebhookEvent` (comment/issue/other) ve `commandFromWebhook` → `CommandEnvelope`. `signWebhookBody` fikstür imzalamak için. |
| `src/work-port.ts` | `JiraDcWorkPort implements WorkPort`: `getTicket · addComment · updateComment · setLabels · assign · createLinkedIssue · verifyMembership · parseCommand · verifyWebhook · transition`. |
| `src/config.ts` + `src/register.ts` | Zod'lu `JiraDcConfig` (`baseUrl`, `tokenRef`, `webhookSecretRef` + varsayılanlı `childIssueTypeName`/`linkTypeName`/`requestTimeoutMs`/`groupPageSize`) ve `registerJiraDrivers(registry)` → port `work`, sürücü `jira-dc`. |
| `fixtures/*.json` | `issue-get` · `webhook-comment-created` · `webhook-issue-created` · `group-members` · `issue-created-response` · `comment-created-response`. |

### M102 sınırları (izin seti) — kod bunun dışına çıkmıyor
Browse (`GET /issue`) · Add Comment (`POST/PUT .../comment`) · Edit Issue **yalnız label** (`PUT /issue/{key}` gövdesi tam olarak `{fields:{labels}}`) · Assign (`PUT .../assignee`) · Create + Link (`POST /issue`, `POST /issueLink`) · grup üyeliği (`GET /group/member`).
`transition()` **uygulanmadı**: `CapabilityNotSupportedError("WorkPort","transition")` fırlatır — DC'de workflow izni istenmiyor, ilerleme label/yorumla gösteriliyor.

## 2. Testler

`pnpm -F @maestro/adapter-jira test` → **7 dosya / 72 test, hepsi yeşil.** Tamamı çevrimdışı ve deterministik: ağ yok, `fetch` `test/helpers.ts` içindeki katı sahte ile enjekte ediliyor (beklenmeyen istek → test patlar), `sleep` enjekte edildiği için 429 geri çekilmesi anında.

- `client.test.ts` (10): auth başlığı, URL/query kurulumu, JSON gövde, 204/boş gövde, 401/403/404/500 eşlemesi, 429→retry→200, çift 429, Retry-After tavanı, boş baseUrl.
- `mapping.test.ts` (7): fikstür → `TicketSnapshot.parse` (sözleşmeden geçer), webhook içindeki issue, eksik alan raporu, kullanıcı kimliği fallback'i, tarih normalizasyonu, custom field yokluğu.
- `adf.test.ts` (7): üreticiler, düz metin sarma, ADF geçişi, hatalı gövde, wiki-markup çıktısının tam metni.
- `commands.test.ts` (11): sekiz komut, büyük/küçük harf, `/reject` sebebi, hatalı appId/mod, bilinmeyen komut, düz metin, çok satırlı gövde.
- `webhook.test.ts` (14): doğru imza, prefix'li/prefix'siz/büyük harf digest, yeniden serialize edilmiş gövde reddi, kurcalanmış gövde/yanlış secret/eksik başlık/bozuk digest/boş secret, Buffer gövde, olay sınıflandırma, `CommandEnvelope.parse`.
- `work-port.test.ts` (18): her port metodu istek gövdesiyle birlikte, label doğrulaması, fan-out + link, link hatasında öksüz key, üyelik (isim/key/e-posta, sayfalama, ret), webhook doğrulama, bilinmeyen komutta `null`, `transition` yetenek hatası.
- `register.test.ts` (5): registry kaydı, `SecretPort` üzerinden PAT çözümü, config doğrulama, SecretPort'suz kurulum reddi.

Fikstürler Jira DC REST v2'nin belgelenmiş yanıt şekillerine göre elle yazıldı (kayıt-tarzı); kurumsal erişim geldiğinde `insa-plani §6` uyarınca gerçek kayıtlarla değiştirilmeli.

## 3. Varsayımlar (doğrulanması gerekenler)

1. **DC yorumları wiki markup'tır.** REST v2 `comment.body` bir string'dir; ADF yalnız Cloud v3'te geçerli. Bu yüzden ADF **çekirdeğin kanonik biçimi** olarak kaldı, `adfToWikiMarkup` çıkışta render ediyor (M46: "wiki-markup/ADF farkları DC'ye göre"). İleride bir Cloud sürücüsü aynı belgeyi olduğu gibi POST eder. Modellenmeyen ADF düğümleri düz metne düşer — yorum asla kaybolmaz.
2. **Webhook imzası** `X-Hub-Signature: sha256=<hex>` başlığında, ham gövde üzerinden HMAC-SHA256 (`JIRA_SIGNATURE_HEADER` sabiti). BFF gövdeyi **parse etmeden önce** doğrulamalı; yeniden serialize edilen gövde imzayı bozar (test bunu kanıtlıyor).
3. **`assign(key, accountId)`** — DC'de atama `name` (kullanıcı adı) ile yapılır; port'un `accountId` adı Cloud paritesi için korundu, değer DC kullanıcı adı/anahtarı olarak gönderilir. `null` → atamayı kaldırır.
4. **`verifyMembership`** `GET /group/member?includeInactiveUsers=false` ile sayfalanır; kullanıcı adı/anahtar/e-posta/görünen ad üzerinden büyük-küçük harf duyarsız eşleşir. Pasif kullanıcı üye sayılmaz (M32 fail-closed). Grup yoksa `JiraNotFoundError` yükselir (sessiz `false` yerine — yanlış yapılandırma operasyon hatasıdır).
5. **`createLinkedIssue`** proje anahtarını parent key'inden türetir, issue tipi `childIssueTypeName` (varsayılan `Task`), link tipi `linkTypeName` (varsayılan `Relates`) — ikisi de config'ten, DC örneğine göre ayarlanmalı. Link adımı patlarsa `JiraLinkFailedError` **oluşan child key'i taşır**; çağıran telafi edebilir (yeniden create etmemeli).
6. **`/reject` sebebi ilk satırda** aranır (gramer "ilk satır" olduğu için). `/reject` + alt satırda gerekçe → `invalid`. Gerekirse gevşetilebilir; şu an spec'e sadık.
7. **`/mode-change`** hem `ai-assist` hem `ai_assist` kabul eder (maket tire yazıyor, sözleşme snake_case) — tire alt çizgiye normalize edilir. `/ai-assign` argümanı küçük harfe çevrilip `AppId` regex'iyle doğrulanır.
8. Rate limit: DC'de 429 nadirdir ama reverse proxy koyabilir; `Retry-After` yalnız saniye biçiminde okunur, HTTP-date yok sayılır.

### "Geçersiz komut" sonucu (spec'te istenen yapı)
`parseCommandLine` üç durumlu döner: `{status:"ok",command}` · `{status:"none"}` (yorum komut değil) · `{status:"invalid",command,messageKey,messageParams}`. `WorkPort.parseCommand` bunların yalnız `ok` olanında zarf döner, aksi halde **`null`** — hiçbir durumda throw etmez. `JiraDcWorkPort.parseCommandDetailed()` invalid bilgisini korur ki BFF kullanıcıya "komut hatalı" yanıtı yazabilsin (M14: sessiz varsayılan yok).

## 4. Bağımlılıklar

| Paket | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts` | runtime (workspace) | `TicketSnapshot`, `CommandEnvelope`, `ParsedCommand`, `TicketKey`, `AppId`, `WorkMode`, `IsoDateTime` — adaptör çıktısı sözleşmeden geçirilir. |
| `@maestro/ports` | runtime (workspace) | `WorkPort`, `SecretPort`, `PortRegistry`, `CapabilityNotSupportedError`. |
| `zod` ^4 | runtime | Zaten monorepo standardı; sürücü config doğrulaması ve şema parse'ı. |
| `@maestro/test-kit` | dev (workspace) | `loadFixture` — fikstürleri okumak için mevcut altyapı yeniden kullanıldı. |
| `@types/node`, `typescript`, `vitest` | dev | Paket sözleşmesi gereği. |

**Yeni harici runtime bağımlılığı YOK.** HTTP için global `fetch`, HMAC için `node:crypto` kullanıldı (jira.js / axios / node-fetch eklenmedi).

## 5. Arayüz talepleri (contracts/ports DONMUŞ — burada yalnız kayıt)

1. **`DriverFactory<P> = (config: unknown) => P` bağımlılık kanalı taşımıyor.** Sürücünün `SecretPort`'a (tokenRef/webhookSecretRef çözümü) ve testte enjekte edilebilir `fetch`'e ihtiyacı var. Geçici çözüm: factory girdisi `{...config, deps:{secrets, fetchImpl?, sleep?}}` şeklinde; `deps` yoksa `JiraConfigError` fırlatılır (sessizce kimliksiz istemci kurulmaz). **Talep:** `DriverFactory<P> = (config: unknown, deps: DriverDeps) => P` ya da `PortRegistry.register(..., factory, deps)`.
2. **`WorkPort` webhook doğrulama metodu içermiyor** — yorum satırında "drivers must verify webhook signatures with the RAW body" yazıyor ama tipte karşılığı yok. Şu an `JiraDcWorkPort.verifyWebhook(rawBody, signatureHeader)` somut sınıfta duruyor; BFF sürücüye somut tipiyle bağlanmak zorunda kalır. **Talep:** `verifyWebhook(rawBody: string | Uint8Array, headers: Record<string,string>): Promise<void>` port'a eklensin.
3. **`updateComment` port'ta yok.** M75 "tek düzenlenen durum yorumu" için gerekli; sürücüde uygulandı (`updateComment(key, commentId, body)`). **Talep:** port'a opsiyonel yetenek olarak eklensin.
4. **`parseCommand` yalnız `CommandEnvelope | null` döndürüyor**, "komut gibi görünen ama geçersiz" durumu kaybediyor. Sürücüde `parseCommandDetailed` ile korundu. **Talep:** dönüş tipi `CommandEnvelope | InvalidCommand | null` ya da ayrı bir metot.
5. **`TicketSnapshot` durum (status) alanı taşımıyor.** DC issue'sunda `fields.status.name` var ve intake/rapor için faydalı olabilir; şu an okunmuyor. Bilgi amaçlı not.

## 6. Gereken yeni katalog anahtarları (M104 — `packages/config` düzenlenmedi)

Mevcut ve kullanılan: `command.unknown` (`{commands}`), `command.reject_needs_reason`.
**Eklenmesi gereken (ikisi de tr+en):**

| Anahtar | Parametre | Önerilen tr | Önerilen en |
|---|---|---|---|
| `command.invalid_app_id` | `{value}` | `Geçersiz uygulama kodu: {value} — örnek: /ai-assign ugurweb` | `Invalid application id: {value} — example: /ai-assign ugurweb` |
| `command.invalid_mode` | `{value}`, `{modes}` | `Geçersiz work mode: {value}. Geçerli olanlar: {modes}` | `Invalid work mode: {value}. Valid modes: {modes}` |

Kod tarafında bunlar `COMMAND_MESSAGE_KEYS` altında sabit **anahtar** olarak duruyor; paket hiçbir kullanıcıya görünen metin üretmiyor.

## 7. Doğrulama

```
pnpm install                              # ✓ lockfile güncel
pnpm -F @maestro/adapter-jira typecheck   # ✓
pnpm -F @maestro/adapter-jira test        # ✓ 72 test
pnpm lint                                 # ✓ (kök eslint)
```
