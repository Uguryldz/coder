# RAPOR — `@maestro/llm-gateway`

Dalga 1 paketi: LLM Gateway — `LlmPort` gerçeklemesi (M16 · M17 · M18 · M19 · M55 · M44).
Yalnız `packages/llm-gateway/` altına dokunuldu; `contracts` ve `ports` **okundu, değiştirilmedi**.
`packages/config` de değiştirilmedi (yeni mesaj anahtarı talebi §5'te).

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/config.ts` | Zod'lu tüm gateway konfigü: 4 sürücü (ayrımlı birleşim), abonelik havuzu, rol/variant→model bağlamaları, veri sınıfı→sürücü rotaları, `onPremMissing` (M18), rate-limit + retry, `agentRole`/`agentDataClass`. `superRefine`: tanımsız sürücüye bağlanan binding, havuzu olmayan abonelik sürücüsü, konfigürasyonsuz `transport`, eksik veri sınıfı rotası → **kurulumda hata** (fail-closed) |
| `src/pool.ts` | **`SubscriptionPool` (M55, paketin kalbi)**: hesap başına 5h/weekly pencere takibi, pencere dolunca **tam periyot** ileri sarma + sıfırlama, kota-farkında seçim (en çok boşluk → en az yakında kullanılan → id), dolu/cooling/disabled hesabı pas geçme, **havuzun tamamı doluysa `{ok:false, resumeAt}`** (hata değil), `record()` ile kota yakma, `snapshot()` ile `SubscriptionAccount` şemasıyla doğrulanmış kota görünümü (M62) |
| `src/policy.ts` | `LlmPolicy`: veri sınıfı → izinli sürücü kümesi, rol+variant → model (tam variant önce, `*` sonra), `gizli` sınıfı **yalnız on-prem** (abonelik sürücüsü on-prem etiketlense bile asla), on-prem yoksa `degrade_ai_assist \| block \| masked_cloud` (varsayılan degrade). Binding yoksa `UnknownModelError` (M19: sessiz fallback yok) |
| `src/http.ts` | `TokenBucket` (atomik olmayan, süreç-içi; M19'un Redis'i Dalga 3'te) + `postJson`: enjekte fetch, sınırlı retry (429/5xx/taşıma hatası), `Retry-After` (saniye) `maxDelayMs` ile tavanlı, 4xx ve 401/403 **retry edilmez**, JSON olmayan gövde hatası, audit için 500 karakter kırpılmış hata gövdesi |
| `src/driver-types.ts` | Dört sürücünün ortak arayüzü (`LlmDriver.complete`), `DriverCall.credentialRef` (abonelik koltuğunun kendi kimliği), `DriverDeps` (secrets, bucket, retry, `signRequest`, `accessToken`) |
| `src/driver-anthropic.ts` | `anthropic-direct` **gerçek istemci**: `POST {baseUrl}/v1/messages`, `x-api-key` + `anthropic-version`, Messages gövdesi; paylaşılan `messagesBody()` / `parseMessagesResponse()` (metin blokları birleştirme, `cache_read`/`cache_creation` → `tokensIn` + `cachePct`) |
| `src/driver-openai.ts` | `openai-compat` **gerçek istemci** (on-prem vLLM şeridi): `POST {baseUrl}/v1/chat/completions`, bearer, system+user mesajları, `prompt_tokens_details.cached_tokens` → `cachePct`. On-prem olup olmadığı **konfigden** (`onPrem`), URL'den tahmin edilmiyor |
| `src/driver-cloud.ts` | `aws-bedrock` ve `google-vertex` **iskeletleri**: doğru uç (`/model/{id}/invoke`, `…:rawPredict`), doğru gövde (`anthropic_version`), VPC endpoint override; kimlik **enjekte** (`signRequest` = SigV4, `accessToken` = OAuth). Enjekte edilmemişse **imzasız istek atmak yerine `LlmConfigError`** |
| `src/structured.ts` | `generateObject` çekirdeği: şema adı + `z.toJSONSchema` + girdi ile prompt, yanıttan JSON çıkarma (fenced/önsözlü tolere), Zod doğrulama, **1 düzeltme turu** (somut hata listesiyle), ikinci turda da tutmazsa `LlmSchemaValidationError` — kısmi nesne asla dönmez |
| `src/session.ts` | `AgentSessionStore` + `AgentRunner` arayüzü: resumeToken üretimi (enjekte `newId`), oturum→sürücü/model/workspace sabitleme, tur sayacı, vendor oturum kolunu taşıma. Bilinmeyen token veya workspace değişimi → hata (sessizce yeni oturum yok) |
| `src/outcomes.ts` | `QueuedOutcome` / `DegradedOutcome` / `ObjectOutcome` / `SessionOutcome` + `asError()` |
| `src/gateway.ts` | `LlmGateway implements LlmPort`: politika → havuz → sürücü zinciri, maskeleme kapısı, kota `finally` içinde yakılır (**başarısız çağrı da kotayı harcar**), `LlmCallLog` üretimi (contracts şemasıyla `parse`, `usd: null`), `onCallLog` yayını, `poolSnapshot()` |
| `src/register.ts` | `registerLlmDrivers(registry, deps)` → `"llm"/"gateway"` (M44 DI; çekirdek bu modülü import etmez) |
| `src/messages.ts` | Yalnız **mesaj anahtarları** (M104) — pakette kullanıcıya dönük tek bir metin yok |

**Kuyruk sözleşmesi (M55'in özü):** `generateObjectOrQueue()` ve `agentSessionOrQueue()` havuz dolduğunda
**hata atmaz**, `{status:"queued", resumeAt, messageKey:"run.queued_quota"}` döner ve sağlayıcıya hiç
gitmez. Temporal bu değeri timer'a çevirir. Donmuş `LlmPort.generateObject/agentSession` imzaları bu
durumu taşıyamadığı için orada `SubscriptionQueuedError(resumeAt)` fırlatılır — bkz. talep #1.

## 2. Testler

`pnpm -F @maestro/llm-gateway test` → **9 dosya / 101 test yeşil.**

| Dosya | Test | Kapsam |
|---|---|---|
| `config.test.ts` | 6 | varsayılanlar, tanımsız sürücüye binding reddi, `transport` doğrulaması, her veri sınıfı için rota zorunluluğu, tipli hata |
| `pool.test.ts` | 14 | boşluğa göre seçim + rotasyon, koltuğun kendi kimliği/transport'u, dolu/cooling/disabled atlama, **havuz dolunca `resumeAt`**, "en son engel" kuralı (5h serbest ama weekly dolu), tam periyot ileri sarma, 5h sıfırlanırken weekly'nin yanmaya devam etmesi, %100 tavanı, sözleşme-geçerli snapshot, sürücü izolasyonu, çift hesap/bilinmeyen hesap |
| `policy.test.ts` | 11 | tam variant > `*`, binding yoksa hata, `gizli` on-prem'e gider, on-prem yoksa degrade / block / masked_cloud, GPU yokken (disabled) degrade, rota hiçbir şeye izin vermezse blok, **abonelik sürücüsü `gizli`'ye asla girmez** |
| `http.test.ts` | 13 | token-bucket burst + bekleme + doldurma, rate-limit beklemesi, 429 retry + `Retry-After` tavanı, maxAttempts tükenmesi, 5xx/taşıma retry'ı, 4xx ve 401/403 retry'sız, son denemeden sonra uyumama, enjekte random ile jitter, boş/JSON olmayan gövde, kırpılmış hata gövdesi |
| `drivers.test.ts` | 16 | anthropic istek/URL/başlık/gövde, metin bloğu birleştirme + `cachePct`, cache raporlanmayınca `null`, **koltuk kimliği override'ı**, system'siz gövde, metinsiz/şekilsiz yanıt reddi, proxy baseUrl; openai istek/parse/system'siz/`null` içerik reddi; bedrock imzasızsa **çağrı yapmadan** hata, imzalı uç + gövde, VPC override; vertex token'sız hata, rawPredict uç + bearer |
| `structured.test.ts` | 10 | ilk turda doğrulama, prompt içeriği, maskeli string girdi, fenced JSON, **düzeltme turu + hata listesinin prompt'a girmesi**, ikinci turda da tutmazsa hata, düzyazı yanıt = şema ıskası, token toplama, `extractJson` birim testleri |
| `session.test.ts` | 6 | token üretimi ve sabitleme, resume + vendor kolu, tur sayacı/`updatedAt`, bilinmeyen token reddi, workspace değişimi reddi, oturum izolasyonu |
| `gateway.test.ts` | 21 | abonelik→transport+kimlik, **sözleşme-geçerli `LlmCallLog` (`usd:null`, driver=`claude-sub`)**, havuz dolunca `queued` + sağlayıcıya gitmeme, **başarısız çağrının kotayı yakması**, `gizli` degrade, `gizli`→on-prem gerçek çağrı, masker yoksa masked_cloud reddi, maskelenmiş gövdenin ham veriyi taşımaması, bağlanmamış rol/bozuk istek, port imzalarının tipli hataya çevirmesi, agent oturumu delegasyonu + resume + kuyruk + runner yoksa hata + degrade, konfig kapısı, fetch yoksa kurulmama, kota snapshot'ı, `LlmPort` uyumu |
| `register.test.ts` | 4 | `"llm"/"gateway"` kaydı, fabrika anında konfig doğrulaması, çift kayıt reddi, enjekte bağımlılıkların uçtan uca bağlanması |

Tümü **çevrimdışı ve deterministik**: gerçek ağ yok (enjekte `fetch`), gerçek saat yok (enjekte `now`,
sahte clock), gerçek uyku yok (enjekte `sleep`, süreler assert ediliyor), rastgelelik enjekte (`random`),
id üretimi enjekte (`newId`). `Date.now()`/`Math.random()` üretim kodunda yalnız **varsayılan** olarak
duruyor, testlerde hiç kullanılmıyor.

Kapı komutları: `pnpm install` · `pnpm -F @maestro/llm-gateway typecheck` · `pnpm -F @maestro/llm-gateway test` ·
kökten `pnpm lint` → **hepsi yeşil**. Kökten `pnpm typecheck` (8 paket) ve `pnpm test` (16 görev, 
llm-gateway dahil) de yeşil.

**Boyut:** `src/` 1.445 ham satır / **1.117 kod satırı** (boş ve yorum satırları hariç) / 16 dosya,
en büyük dosya `gateway.ts` 249 satır (dosya başına 300 tavanı sağlandı). Ham satırın 328'i doküman
yorumu ve boşluk — kod satırı ölçüsüyle 1.200 tavanının altında, ham satır ölçüsüyle ~245 üstünde.
Yorumları kısaltmak yerine ev üslubunu (adapter-jira/adapter-ado) korudum; orkestratör ham satır
tavanını sıkı okursa `errors.ts` ve sürücü dosyalarındaki blok yorumlar tek satıra indirilebilir.

## 3. Varsayımlar (denetlenmesi gerekenler)

1. **Abonelik sürücüsü nasıl çağrı yapar?** M55 abonelik hesaplarını ayrı bir sürücü sınıfı yapıyor ama
   fiziksel taşıma katmanını tanımlamıyor. Modelim: her koltuk bir `transport` (API sürücüsü) + kendi
   `credentialRef`'i taşır; log'da sürücü `claude-sub` görünür, HTTP `anthropic-direct` üzerinden gider.
   Gerçek dünyada abonelik oturumu CLI/Agent SDK login'i olabilir — o zaman `transport` yerine Dalga 2
   runner'ı devreye girer, `AgentRunner.credentialRef` bu yüzden zaten arayüzde.
2. **Kota ölçümü tahminidir.** Sağlayıcılar pencere doluluğunu başlıkla raporlamadığı sürece kota
   `costPctPerCall` (pencere başına yüzde) ile ilerletiliyor: 5h penceresi weekly'den hızlı dolduğu için
   maliyet **pencere başına** tanımlı. Gerçek başlık/uç bulununca `SubscriptionPool`'a bir `sync(windows)`
   metodu eklemek yeterli (bilerek yazmadım — bkz. §6).
3. **Pencere başlangıcı süreç başlangıcıdır.** Havuz kurulduğunda tüm pencereler "şimdi + uzunluk"
   olarak açılır; süreç yeniden başlarsa kota takibi sıfırlanır. Kalıcılık DB işidir (`db` paketinde
   kota tablosu yok) — bkz. talep #4.
4. **`gizli` sınıfı için "cloud" tanımı = `onPrem !== true`.** Bir sürücüyü on-prem saymak tamamen
   konfig kararıdır; abonelik sürücüleri hiçbir koşulda on-prem sayılmaz (kodda sabit).
5. **`masked_cloud` maskeleyici olmadan çalışmaz.** `pii` paketi ayrı bir Dalga 1 paketi olduğu için
   gateway `deps.mask` bekler; enjekte edilmemişse **maskesiz göndermek yerine hata verir**.
6. **`degrade_ai_assist` kararı gateway'de uygulanmaz**, yalnız raporlanır (`{status:"degraded"}`).
   Work-mode'u `ai_assist`'e düşürmek workflow'un (Dalga 3) işi; gateway iş akışı durumu tutmaz.
7. **`usd` her zaman `null`.** Abonelikte maliyet kota (M55); API sürücülerinde fiyat tablosu M19'a göre
   konfigde yaşar ve bu pakette yok — uydurma dolar yazmaktansa `null` bırakıldı (bkz. §6).
8. **Retry deterministiktir**; `jitterRatio` varsayılanı 0, jitter istenirse enjekte `random` ile.
   Rate limit süreç-içidir; M19'un atomik Redis token-bucket'ı çok-replikalı BFF için Dalga 3'te gerekir.
9. **`Retry-After` yalnız saniye** olarak okunur (HTTP-date yok sayılır), `maxDelayMs` ile tavanlanır.
10. **Prompt iskeleti İngilizcedir** ve rol promptları içermez; rol/analiz promptları M43'e göre
    knowledge pack'te ve Dalga 3'te. AI çıktı dili (M71) buraya girdi olarak gelir.
11. **Sürücü fikstürleri kayıt değil, belgeye göre yazıldı** (kurum erişimi/anahtar yok): Anthropic
    Messages, OpenAI Chat Completions, Bedrock `invoke`, Vertex `rawPredict` şekilleri. Erişim gelince
    Aşama-0 duman testinde gerçek yanıtlarla değiştirilmeli (insa-plani §6).

## 4. Bağımlılıklar

**Yeni runtime bağımlılığı YOK.** Global `fetch` + `crypto.randomUUID` dışında hiçbir şey.

| Bağımlılık | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts`, `@maestro/ports` | runtime (workspace) | donmuş şemalar ve arayüzler |
| `zod` | runtime | konfig/yanıt/çıktı doğrulama; `z.toJSONSchema` ile şema promptu |
| `@types/node`, `typescript`, `vitest` | dev | paket sözleşmesindeki standart set |

`@maestro/test-kit` **eklenmedi**: bu pakette JSON fikstür dosyası yok (sürücü yanıtları testlerde
şema-doğrulamalı satır içi nesneler), `loadFixture` gereksizdi — kullanılmayan bağımlılık bırakmadım.

Vercel AI SDK (M17) **eklenmedi**: `generateObject` için tek ihtiyacımız şema + JSON doğrulama, o da
zod ile karşılanıyor; SDK eklemek 4 sürücüyü de onun provider modeline bağlardı ve abonelik/kuyruk
mantığını gizlerdi. Orkestratör M17'yi harfiyen isterse sürücü katmanı SDK ile değiştirilebilir —
`LlmDriver` arayüzü bu yüzden dar tutuldu.

## 5. Arayüz / karar talepleri (orkestratöre)

1. **`LlmPort.generateObject` kuyruk durumunu taşıyamıyor (en önemli talep).** M55 "çağrı hata vermez,
   kuyruğa girer" diyor ama port imzası `Promise<{object, log}>`. Bugün: kuyruk-farkında ikiz metotlar
   (`generateObjectOrQueue` / `agentSessionOrQueue`) union döner, port metotları `SubscriptionQueuedError`
   fırlatır. **Öneri:** port dönüşü `Promise<LlmOutcome<T>>` olsun (ok | queued+resumeAt | degraded).
   `ports`'a dokunmadım — kararı sen ver; değişirse gateway'de ~10 satır.
2. **`AgentSessionOptions` veri sınıfı ve variant taşımıyor.** Agent turu şu an `config.agentDataClass`
   (varsayılan `dahili`) ve `*` variant ile yönlendiriliyor. M18 gizli-sınıf kuralının yapan roller için
   de doğru işlemesi isteniyorsa `AgentSessionOptions`'a `dataClass` + `variantId` eklenmeli.
3. **`DriverFactory` yalnız `config` alıyor** (`(config: unknown) => P`), gateway'in `SecretPort`/fetch/
   clock/`AgentRunner` gibi çalışma zamanı ortaklarına ihtiyacı var. adapter-ado ile aynı çözüm:
   `registerLlmDrivers(registry, deps)` kayıt anında bağlıyor. Composition root'un llm deps'ini kayıt
   sırasında hazır etmesi gerekiyor; alternatif `DriverFactory` imzasını değiştirmek.
4. **Kota kalıcılığı DB'de yok.** Süreç yeniden başlayınca pencere kullanımı sıfırlanır ve gerçek kota
   aşılabilir. `db` şemasına `SubscriptionQuotaWindow` (accountId, kind, usedPct, resetsAt) tablosu +
   `SubscriptionPool`'a repository enjeksiyonu öneriyorum (Dalga 2/3 işi, tek dosyalık dokunuş).
5. **Yeni mesaj anahtarları gerekiyor (M104).** `packages/config/locales`'a **ben eklemedim**; kod
   yalnız anahtarı taşıyor. Önerilen çift:

   | key | tr | en |
   |---|---|---|
   | `llm.degraded_ai_assist` | `Gizli veri sınıfı için on-prem model yok — akış ai-assist moduna düşürüldü` | `No on-prem model for the confidential data class — the flow fell back to ai-assist` |
   | `llm.blocked_confidential` | `Gizli veri sınıfı politika gereği hiçbir modele gönderilemez` | `The confidential data class may not be sent to any model by policy` |

   Mevcut `run.queued_quota` ve `notify.quota_wait` anahtarları kuyruk durumu için yeterli; ikincisi
   bildirim paketinin işi olduğu için bu pakette **kullanılmadı** (ölü sabit bırakmamak için silindi).
6. **`LlmCallLog` maskeleme/PII alanı taşımıyor.** M19 "maskeli çağrı logu" diyor; şu an log yalnız
   sayaç taşıyor (prompt/yanıt hiç loglanmıyor — en güvenli varsayılan). Prompt örneği saklanacaksa
   `LlmCallLog`'a `maskedPromptRef` gibi bir alan + StoragePort gerekir.
7. **`LlmCallLog.runId`** için gateway `deps.runId()` bekliyor; workflow her run için gateway örneği mi
   kuracak, yoksa `GenerateObjectRequest`'e `runId` mi eklenecek? Bugün varsayılan `null`.

## 6. Bilerek eksik bırakılanlar

- **Bedrock SigV4 imzalama ve Vertex OAuth akışı**: sürücü iskeletleri uç/gövde/hata yolunu doğru
  kuruyor, kimlik üretimi enjekte ediliyor; enjekte edilmezse çağrı yapılmıyor. AWS/Google SDK'sı
  eklemek yeni runtime bağımlılığı demekti — orkestratör onayı olmadan eklemedim (M16 "konfigle açılır"
  hedefi için gereken her şey burada, eksik olan yalnız imza fonksiyonu).
- **Gerçek Agent SDK entegrasyonu (Dalga 2)**: `agentSession` sürücü seçimini, oturum kaydını,
  resumeToken akışını ve kota tüketimini yapar; **çalıştırmayı** `AgentRunner` arayüzüne delege eder.
  Runner enjekte edilmemişse `AgentRunnerNotWiredError`. `packages/execution` bu arayüzü gerçekleyecek.
- **Bütçe/fiyat tablosu ve dolar maliyeti (M19)**: fiyat tablosu konfig kararı, aylık bütçe tek doğruluk
  kaynağı olarak DB'de yaşamalı; bu pakete gömmek iki maliyet kaynağı yaratırdı. `usd: null`.
- **Redis atomik token-bucket (M4/M19)**: süreç-içi bucket yazıldı; çok-replikalı dağıtımda Redis Lua
  gerekecek — `TokenBucket` arayüzü aynı kalarak değiştirilebilir.
- **PII maskeleme çekirdeği (M20)**: `pii` paketi ayrı; gateway yalnız `deps.mask` kancasını ve
  fail-closed kapısını sağlar.
- **Prompt cache yönetimi (M38)**: sürücüler cache oranını **okur** ve log'a yazar; `cache_control`
  işaretlerini koymak rol promptlarıyla birlikte Dalga 3'te anlamlı.
- **Kota senkronizasyonu**: sağlayıcı başlıklarından gerçek pencere doluluğu okuma (§3.2).
