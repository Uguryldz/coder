# @maestro/adapter-jira — builder raporu

WorkPort sürücüsü: **Jira Data Center / Server**, REST v2, PAT + webhook secret (M46/M102).

> **Tur 2 (düzeltme turu).** Bağımsız doğrulayıcı paketi KALDI ile döndürdü; bloklayıcı
> bulguların hepsi kapatıldı, kanıtları **§8**'de bulgu bazında listeli. Bu turda değişen
> davranışlar: argümansız komutlar (`/approve` başta) artık yorumda TEK BAŞINA durmak
> zorunda · düzenlenmiş yorumlar komut üretmiyor · üyelik eşleşmesi `displayName`
> kullanmıyor · boş PAT ve çözülemeyen üyelik sayfası artık sessiz değil, hata.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/client.ts` | `JiraDcClient` — enjekte edilen token sağlayıcısıyla PAT bearer auth, enjekte edilen `baseUrl`, ince `fetch` sarmalayıcı; JSON in/out; 204/boş gövde → `void`; **boş PAT'te istek gönderilmez** (`JiraConfigError`); **tek** 429 geri çekilmesi (Retry-After saniye, `maxBackoffMs` ile sınırlı), ikinci 429 kesin hata; **POST hiç tekrarlanmaz** (idempotent değil). Başka retry yok — dayanıklı tekrar Temporal'ın işi. |
| `src/errors.ts` | Tipli hatalar: `JiraHttpError` (taban) · `JiraAuthError` 401 · `JiraForbiddenError` 403 · `JiraNotFoundError` 404 · `JiraRateLimitError` 429 (+`retryAfterMs`) · `JiraWebhookVerificationError` · `JiraResponseError` · `JiraArgumentError` · `JiraLinkFailedError` · `JiraMembershipUnresolvedError` · `JiraConfigError`. |
| `src/mapping.ts` | REST issue JSON → `TicketSnapshot` (components/labels/parent/proje/kullanıcı eşlemesi). Yalnız stok alanlar okunur — `ISSUE_FIELDS` içinde tek bir `customfield_*` yok (M98). Çıktı `TicketSnapshot` şemasından geçirilir; şema hatası `JiraResponseError` olarak hangi alanın patladığını söyler. |
| `src/datetime.ts` | DC `+0300` (iki nokta yok) ve webhook epoch-millis biçimlerini `IsoDateTime` sözleşmesine normalize eder. |
| `src/adf.ts` | ADF modeli + `paragraph · heading · codeBlock · panel · bulletList · strong/inlineCode/link · doc` üreticileri; `toAdfDocument` (ADF ya da düz metin) ve `adfToWikiMarkup`. **Metin düğümleri kaçışlanır** (`{ } [ ] \|`), link href'i temizlenir, `{code}` bloğunda makro çiti kırılır — ticket metni/model çıktısı wiki markup enjekte edemez. |
| `src/commands.ts` | `parseCommandLine` / `parseCommandBody` — komut yorumun İLK dolu satırında; `/approve · /reject <sebep> · /status · /ai-explain · /ai-start · /ai-assign <appId> · /mode-change <mod> · /ai-takeover`. **Argümansız komutlar (`approve · status · ai-explain · ai-start · ai-takeover`) yorumda tek başına durmalı**; satırda ya da alt satırlarda ek metin varsa `invalid` + `command.takes_no_argument`. Asla throw etmez. |
| `src/webhook.ts` | RAW gövde üzerinde HMAC-SHA256 (`node:crypto`), sabit zamanlı karşılaştırma, **fail-closed**; `parseWebhookEvent` (comment/issue/other, `edited` bayrağıyla) ve `commandFromWebhook` → `CommandEnvelope`. **Yalnız düzenlenmemiş `comment_created` komut üretir.** `signWebhookBody` fikstür imzalamak için. |
| `src/work-port.ts` | `JiraDcWorkPort implements WorkPort`: `getTicket · addComment · updateComment · setLabels · assign · createLinkedIssue · verifyMembership · parseCommand · verifyWebhook · transition`. |
| `src/config.ts` + `src/register.ts` | Zod'lu `JiraDcConfig` (`baseUrl`, `tokenRef`, `webhookSecretRef` + varsayılanlı `childIssueTypeName`/`linkTypeName`/`requestTimeoutMs`/`groupPageSize`) ve `registerJiraDrivers(registry)` → port `work`, sürücü `jira-dc`. |
| `fixtures/*.json` | `issue-get` · `webhook-comment-created` · `webhook-issue-created` · `group-members` · `issue-created-response` · `comment-created-response`. |

### M102 izin seti — kod nerede duruyor (DÜZELTME)

M102'nin saydığı izinler: Browse + Add Comment + Edit Issue (label) + Assign + Create/Link Issue.
Sürücünün bunlara karşılık gelen uçları: `GET /issue` · `POST .../comment` · `PUT /issue/{key}`
(gövde tam olarak `{fields:{labels}}`) · `PUT .../assignee` · `POST /issue` + `POST /issueLink`.
`transition()` **uygulanmadı**: `CapabilityNotSupportedError("WorkPort","transition")` fırlatır —
DC'de workflow izni istenmiyor, ilerleme label/yorumla gösteriliyor. Özel alan/ekran/eklenti
değişikliği yok (M98).

> **Raporun ilk turdaki "M102 dışına çıkmıyor" iddiası YANLIŞTI.** İki uç M102 listesinde
> karşılığı olmayan izin gerektiriyor ve **kurum izin listesine eklenmeli**:
>
> | Uç | Nerede | Jira DC'de gerektirdiği izin | Neden gerekli |
> |---|---|---|---|
> | `GET /rest/api/2/group/member` | `verifyMembership` | **"Browse users and groups" — GLOBAL izin** (proje izni değil) | M32 SoD / M51 kapı yetkisinin tek dayanağı; grup üyeliği başka türlü doğrulanamıyor |
> | `PUT /rest/api/2/issue/{key}/comment/{id}` | `updateComment` | **"Edit Own Comments"** (yorumu `maestro-svc` yazdığı için "Own" yeterli; başkasının yorumu düzenlenmiyor) | M75 tek düzenlenen "▶ Maestro durum" yorumu; yoksa yorum spam'i |
>
> Karar orkestratörde: ya bu iki izin kurum listesine eklenir, ya da M32/M75 için alternatif
> tasarım gerekir (üyelik için ayrı bir dizin servisi / ilerleme için yeni yorum akışı).
> **masterplan.md bu paket tarafından değiştirilmedi.**

## 2. Testler

`pnpm -F @maestro/adapter-jira test` → **7 dosya / 90 test, hepsi yeşil** (tur 1: 72; düzeltme
turunda +18). Tamamı çevrimdışı ve deterministik: ağ yok, `fetch` `test/helpers.ts` içindeki katı
sahte ile enjekte ediliyor (beklenmeyen istek → test patlar), `sleep` enjekte edildiği için 429
geri çekilmesi anında.

- `client.test.ts` (12): auth başlığı, URL/query kurulumu, JSON gövde, 204/boş gövde, 401/403/404/500 eşlemesi, 429→retry→200, çift 429, Retry-After tavanı, boş baseUrl, **boş PAT'te istek gönderilmemesi (O-5)**, **429 alan POST'un tekrarlanmaması**.
- `mapping.test.ts` (7): fikstür → `TicketSnapshot.parse` (sözleşmeden geçer), webhook içindeki issue, eksik alan raporu, kullanıcı kimliği fallback'i, tarih normalizasyonu, custom field yokluğu.
- `adf.test.ts` (10): üreticiler, düz metin sarma, ADF geçişi, hatalı gövde, wiki-markup çıktısının tam metni, **metin kaçışı**, **`{code}` çit kırma**, **link href temizliği**.
- `commands.test.ts` (15): sekiz komut, büyük/küçük harf, `/reject` sebebi, hatalı appId/mod, bilinmeyen komut, düz metin, çok satırlı gövde, **`/approve` + ek metin (aynı satır ve alt satır) reddi (K-1)**, **tüm argümansız komutlar için tek-başına kuralı**, argümanlı komutların satır sonunu almaya devam etmesi.
- `webhook.test.ts` (18): doğru imza, prefix'li/prefix'siz/büyük harf digest, yeniden serialize edilmiş gövde reddi, kurcalanmış gövde/yanlış secret/eksik başlık/bozuk digest/boş secret, Buffer gövde, olay sınıflandırma, `CommandEnvelope.parse`, **`comment_updated` komut üretmemesi (K-2)**, **`created !== updated` yorumun komut sayılmaması**, **düzenlenmemiş yorumun `edited:false` olması**, **`/approve` + ek metin reddi**.
- `work-port.test.ts` (23): her port metodu istek gövdesiyle birlikte, label doğrulaması, fan-out + link, link hatasında öksüz key, üyelik (isim/key/e-posta, sayfalama, ret), webhook doğrulama, bilinmeyen komutta `null`, `transition` yetenek hatası, **displayName ile eşleşmeme (O-1)**, **pasif üyenin atlanması (O-2)**, **çözülemeyen sayfa bean'i ve sayfa bütçesi aşımında hata (O-6)**, **port üzerinden K-1/K-2 reddi**.
- `register.test.ts` (5): registry kaydı, `SecretPort` üzerinden PAT çözümü, **varsayılanların gerçekten assert edildiği config testi**, config doğrulama, SecretPort'suz kurulum reddi.

Fikstürler Jira DC REST v2'nin belgelenmiş yanıt şekillerine göre elle yazıldı (kayıt-tarzı); kurumsal erişim geldiğinde `insa-plani §6` uyarınca gerçek kayıtlarla değiştirilmeli.

## 3. Varsayımlar (doğrulanması gerekenler)

1. **DC yorumları wiki markup'tır.** REST v2 `comment.body` bir string'dir; ADF yalnız Cloud v3'te geçerli. Bu yüzden ADF **çekirdeğin kanonik biçimi** olarak kaldı, `adfToWikiMarkup` çıkışta render ediyor (M46: "wiki-markup/ADF farkları DC'ye göre"). İleride bir Cloud sürücüsü aynı belgeyi olduğu gibi POST eder. Modellenmeyen ADF düğümleri düz metne düşer — yorum asla kaybolmaz.
2. **Webhook imzası** `X-Hub-Signature: sha256=<hex>` başlığında, ham gövde üzerinden HMAC-SHA256 (`JIRA_SIGNATURE_HEADER` sabiti). BFF gövdeyi **parse etmeden önce** doğrulamalı; yeniden serialize edilen gövde imzayı bozar (test bunu kanıtlıyor).
3. **`assign(key, accountId)`** — DC'de atama `name` (kullanıcı adı) ile yapılır; port'un `accountId` adı Cloud paritesi için korundu, değer DC kullanıcı adı/anahtarı olarak gönderilir. `null` → atamayı kaldırır.
4. **`verifyMembership`** `GET /group/member?includeInactiveUsers=false` ile sayfalanır; yalnız **kullanıcı adı (`name`), kullanıcı anahtarı (`key`) ve e-posta** üzerinden büyük-küçük harf duyarsız eşleşir — `displayName` KULLANILMAZ (benzersiz değil, LDAP'tan gelir, değişir). Pasif kullanıcı üye sayılmaz: sunucu parametresine ek olarak `active === false` olan üye yerel olarak da atlanır (M32 fail-closed). Grup yoksa `JiraNotFoundError`, üyelik kararı verilemiyorsa `JiraMembershipUnresolvedError` yükselir — hiçbir belirsizlik sessiz `false`'a dönüşmez.
5. **`createLinkedIssue`** proje anahtarını parent key'inden türetir, issue tipi `childIssueTypeName` (varsayılan `Task`), link tipi `linkTypeName` (varsayılan `Relates`) — ikisi de config'ten, DC örneğine göre ayarlanmalı. Link adımı patlarsa `JiraLinkFailedError` **oluşan child key'i taşır**; çağıran telafi edebilir (yeniden create etmemeli).
6. **`/reject` sebebi ilk satırda** aranır (gramer "ilk satır" olduğu için). `/reject` + alt satırda gerekçe → `invalid`. Gerekirse gevşetilebilir; şu an spec'e sadık. Argümanlı komutlarda (`/reject`, `/ai-assign`, `/mode-change`) alt satırlar hâlâ serbest metindir; **argümansız komutlarda değil** — bkz. §8/K-1.
7. **`/mode-change`** hem `ai-assist` hem `ai_assist` kabul eder (maket tire yazıyor, sözleşme snake_case) — tire alt çizgiye normalize edilir. `/ai-assign` argümanı küçük harfe çevrilip `AppId` regex'iyle doğrulanır.
8. Rate limit: DC'de 429 nadirdir ama reverse proxy koyabilir; `Retry-After` yalnız saniye biçiminde okunur, HTTP-date yok sayılır. **429 alan POST tekrarlanmaz** (yorum/issue/link yaratma idempotent değil; tekrar çift yorum riski). GET/PUT/DELETE için tek geri çekilme aynen duruyor.
9. **Webhook komut kaynağı yalnız `comment_created`.** Düzenlenen yorum (`comment_updated`, ya da `created !== updated` olan bir created teslimi) komut üretmez; `parseWebhookEvent` bunları hâlâ `kind:"comment"` + `edited:true` olarak sınıflandırır ki BFF isterse sayaç tutabilsin. Gerekçe §8/K-2.
10. **`/approve` yorumun tamamı olmalı.** Onay veren kişi komutu tek başına yazar; açıklama ayrı yoruma gider. Kullanıcıya dönen mesaj `command.takes_no_argument` bunu zaten söylüyor ("komutu tek başına yazın"). **Fikstür `webhook-comment-created.json` bu kurala uyacak şekilde güncellendi** (gövde artık düz `/approve`).
11. **Wiki markup kaçışı.** Yorum metni (ticket açıklaması, model çıktısı) güvenilmez kabul edilir: `{ } [ ] |` kaçışlanır, link href'inden çit kırabilecek karakterler atılır, `{code}` bloğunun içindeki `{code`/`{panel`/`{noformat`/`{quote`/`{color}` dizileri bir boşlukla bölünür (blok içinde backslash kaçışı işlemez). Kod örneği içindeki gerçek bir Jira makrosu bu yüzden bir boşluk kazanır — bilinçli takas.

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
2. ~~**`WorkPort` webhook doğrulama metodu içermiyor**~~ — **KAPANDI**: orkestratör port'a `verifyWebhook(rawBody, headers)` ekledi, sürücü imzayı ona uyarladı (başlık araması büyük/küçük harf duyarsız).
3. ~~**`updateComment` port'ta yok**~~ — **KAPANDI**: orkestratör port'a ekledi (`updateComment(key, commentId, body)`). İzin notu için bkz. §1 M102 düzeltmesi.
4. **`parseCommand` yalnız `CommandEnvelope | null` döndürüyor**, "komut gibi görünen ama geçersiz" durumu kaybediyor. Sürücüde `parseCommandDetailed` ile korundu. **Talep:** dönüş tipi `CommandEnvelope | InvalidCommand | null` ya da ayrı bir metot. **Bu artık daha kritik**: K-1 sonrası `/approve etmiyorum` gibi bir yorum `null` dönüyor; BFF `parseCommandDetailed` çağırmazsa onaylayan kişi neden hiçbir şey olmadığını öğrenemez (M14).
5. **`TicketSnapshot` durum (status) alanı taşımıyor.** DC issue'sunda `fields.status.name` var ve intake/rapor için faydalı olabilir; şu an okunmuyor. Bilgi amaçlı not.
6. **`WorkPort.parseCommand(rawBody)` isim tuzağı.** Parametre `rawBody` deniyor ama metot **parse edilmiş webhook nesnesini** bekliyor (ham gövde string'i verilirse sessizce `null` döner — "komut yok" ile ayırt edilemez). Sürücü tarafında düzeltilemez, port donmuş. **Talep:** parametre adı `payload` olsun ya da tip `unknown` yerine açıkça `WebhookPayload`. O güne kadar BFF sırası: `verifyWebhook(rawBody, headers)` → `JSON.parse(rawBody)` → `parseCommand(payload)`.

## 6. Katalog anahtarları (M104 — `packages/config` bu paket tarafından düzenlenmedi)

Paket hiçbir kullanıcıya görünen metin üretmez; hepsi `COMMAND_MESSAGE_KEYS` altında sabit
**anahtar**. Kullanılan anahtarlar ve durumları:

| Anahtar | Parametre | Durum |
|---|---|---|
| `command.unknown` | `{commands}` | Dalga 0'dan beri katalogda |
| `command.reject_needs_reason` | — | Dalga 0'dan beri katalogda |
| `command.invalid_app_id` | `{value}` | Orkestratör tr+en ekledi ✓ |
| `command.invalid_mode` | `{value}`, `{modes}` | Orkestratör tr+en ekledi ✓ |
| `command.takes_no_argument` | `{command}` (örn. `/approve`) | Orkestratör tr+en ekledi ✓ — K-1 bunu kullanıyor |

## 7. Doğrulama

```
pnpm install                              # ✓ lockfile güncel
pnpm -F @maestro/adapter-jira typecheck   # ✓
pnpm -F @maestro/adapter-jira test        # ✓ 7 dosya / 90 test
pnpm lint                                 # ✓ (kökten eslint)
pnpm typecheck                            # ✓ (kökten turbo, 10 paket)
```

## 8. Doğrulayıcı bulgularının kapatılması (tur 2)

| # | Bulgu | Ne yapıldı | Kanıtlayan test |
|---|---|---|---|
| **K-1** | `/approve` satırının artık metni sessizce yutuluyordu → yanlış onay | `commands.ts`: argümansız komut kümesi (`approve · status · ai-explain · ai-start · ai-takeover`) tanımlandı. `parseCommandLine` bu komutlarda satırda argüman görürse `invalid` + `command.takes_no_argument` (`{command:"/approve"}`) döner; `parseCommandBody` ayrıca **alt satırlarda** dolu metin varsa aynı sonucu verir — yani argümansız komut yorumun tamamı olmak zorunda. Argümanlı komutlarda (`/reject`, `/ai-assign`, `/mode-change`) ilk-satır grameri değişmedi. | `commands.test.ts`: "refuses an /approve that carries extra text on the same line" (`/approve etmiyorum, reddediyorum` · `/approve değil` · `/approve ama sonra`), "refuses an /approve followed by prose on another line" (`/approve\n\nAma önce güvenlik testi bitsin.` · `/approve\n/reject AC-3 yok`), "applies the stand-alone rule to every argument-free command", "still lets argument commands take the rest of their line" · `webhook.test.ts`: "does not approve when the /approve line carries extra text (K-1)" · `work-port.test.ts`: "refuses an approval smuggled behind extra text or an edit" |
| **K-2** | `comment_updated` başkası adına onay üretiyordu (M32 SoD atlanıyordu) | `webhook.ts`: `JiraWebhookEvent.comment` artık `edited` bayrağı taşıyor (`comment_updated` ⇒ true; `created !== updated` ⇒ true). `commandFromWebhook` **yalnız düzenlenmemiş `comment_created`** olayından komut üretir, diğerlerinde `{envelope:null, invalid:null}`. Sınıflandırma korundu (BFF sayaç tutabilsin), komut kaynağı olmaktan çıkarıldı. | `webhook.test.ts`: "ignores a comment_updated event even when it carries a command" (`updateAuthor: kotu.niyetli`), "ignores a created delivery whose comment has already been edited", "marks an untouched comment as not edited" · `work-port.test.ts`: "refuses an approval smuggled behind extra text or an edit" |
| **O-1** | `verifyMembership` `displayName` ile eşleşiyordu | `work-port.ts / identifiersOf`: eşleşme yalnız `name`, `key`, `emailAddress` üzerinden; `displayName` ve gereksiz `userIdOf(user)` çağrısı çıkarıldı (`userIdOf` importu da düştü). | `work-port.test.ts`: "never matches a member on the display name" (`{name:"selin.arslan", displayName:"Mert Demir"}` + `verifyMembership("mert demir")` → `false`) |
| **O-2** | Pasif kullanıcı yalnız sunucu parametresine güvenilerek eleniyordu | `work-port.ts / isActiveMember`: üyede `active === false` ise atlanır; `includeInactiveUsers=false` sorgusu ek savunma olarak duruyor. | `work-port.test.ts`: "skips members the payload marks inactive" (`{name:"ayrilmis.calisan", active:false}` → `false`) |
| **O-5** | Boş PAT sessizce anonim istek üretiyordu | `client.ts / send`: token boş/whitespace (ya da string değilse) `JiraConfigError` — istek **hiç gönderilmez**. Webhook sırrındaki fail-closed davranışın karşılığı. | `client.test.ts`: "refuses to send a request when the PAT resolves to nothing" (`""`, `"   "`, `undefined`; `stub.calls` boş kalıyor) |
| **O-6** | Üyelik sayfalamasında sessiz deny | `work-port.ts`: yeni `JiraMembershipUnresolvedError` (`incomplete_page_bean` \| `too_many_pages`). `hasMorePages` sayfa bean'inde ne `isLast` (boolean) ne `total` (number) bulursa hata fırlatır; `MAX_GROUP_PAGES` (40) tükendiğinde de `false` yerine hata fırlatılır. Yön hâlâ fail-closed ama artık sessiz değil. | `work-port.test.ts`: "raises instead of denying when a page bean cannot be reasoned about", "raises instead of denying when the group outgrows the page budget" (40 istek sonrası hata) |
| **Test kalitesi** | `register.test.ts` "applies the documented defaults" hiçbir default assert etmiyordu | Test artık `JiraDcConfig.parse(...)` çıktısını tam olarak assert ediyor (`Task` · `Relates` · `15_000` · `50`) **ve** varsayılan `groupPageSize`'ın tele çıktığını (`maxResults=50`) doğruluyor. | `register.test.ts`: "applies the documented defaults" |

### Düşük öncelikli bulgular — bu turda kapatıldı

| Bulgu | Ne yapıldı | Kanıtlayan test |
|---|---|---|
| Wiki markup kaçışı yoktu (`{code}`, `[metin\|http://…]` enjeksiyonu) | `adf.ts`: metin düğümlerinde `{ } [ ] \|` backslash ile kaçışlanır; `link()` href'inden `[ ] { } \|` ve boşluk atılır; `{code}` bloğu içeriği literal olarak render edilir ve `{code`/`{noformat`/`{panel`/`{quote`/`{color` dizileri bir boşlukla bölünür (blok içinde kaçış işlemediği için tek yol bu). Böylece ticket metni ya da model çıktısı Maestro'nun kendi kapı yorumunu taklit edemez. | `adf.test.ts`: "escapes macro and link openers in text it did not build", "keeps an injected fence from closing a code block early", "does not let a crafted link href break out of the link" |
| 429 retry'ı POST'ta da yapılıyordu (çift yorum riski) | `client.ts`: POST 429 alırsa geri çekilme yok, doğrudan `JiraRateLimitError`. GET/PUT/DELETE için tek geri çekilme aynen. Tekrar kararı Temporal'ın (kendi idempotency anahtarıyla). | `client.test.ts`: "does not retry a throttled POST — a duplicate comment is worse than a failure" (1 istek, 0 sleep) |
| `parseCommand(rawBody)` isim tuzağı | Port donmuş olduğu için kodda düzeltilemedi; §5/6'da arayüz talebi olarak kayda geçti + BFF'in izlemesi gereken sıra yazıldı. | — (arayüz talebi) |

### Bu turda değişen davranışlar — çağıranların bilmesi gerekenler

1. `/approve` (ve diğer argümansız komutlar) artık **yorumun tamamı** olmalı. BFF, `parseCommand` `null`
   dönünce `parseCommandDetailed().invalid` ile `command.takes_no_argument` mesajını kullanıcıya
   yazmalı — yoksa onaylayan kişi neden hiçbir şey olmadığını anlayamaz (M14).
2. Düzenlenmiş yorumlar komut üretmez. Bir TL yorumunu düzelterek onay veremez; yeni yorum yazmalı.
   Maketteki "Jira komut seti" yardım metni bunu söylemeli.
3. `fixtures/webhook-comment-created.json` gövdesi `/approve` (eskiden `/approve` + açıklama satırı).
