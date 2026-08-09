# RAPOR — `apps/bff` (`@maestro/bff`, Dalga 3)

Fastify 5 BFF: Jira/ADO webhook uçları, auth'lu REST, Temporal başlat/sinyal kapısı (M7).
Tüm bağımlılıklar arayüzle enjekte edilir; paket hiçbir somut sürücüyü import etmez (M44).

## 1. Ne yazıldı

### Webhook uçları (RAW gövde, fail-closed)

| Uç | Davranış |
|---|---|
| `POST /webhooks/jira` | `WorkPort.verifyWebhook(raw, headers)` → hata = **401**. Doğrulama **gövde ayrıştırılmadan önce** koşar. |
| `POST /webhooks/ado` | `CiPort.parseBuildEvent({headers, body})` → hata = **401**, `null` = 202 "ignored". |

RAW gövde korunması: webhook rotaları kendi Fastify kapsülleme bağlamında
`removeAllContentTypeParsers()` + `addContentTypeParser("*", {parseAs:"buffer"})` ile kurulur.
Böylece JSON ayrıştırıcı yalnız REST tarafında kalır; imza **bayt üzerinden** doğrulanır ve
`JSON.parse`/`JSON.stringify` turundan geçmiş bir gövde bir daha asla doğrulanamaz
(`webhooks-jira.test.ts` bunu ayrıca test eder).

**Sıralama kararı (fail-closed):** imzasız + bozuk gövde **401** döner, 400 değil. Ayrıştırma
hatası ancak doğrulaması GEÇMİŞ bir teslimat için görülebilir. ADO tarafında gövde JSON olarak
ayrıştırılamazsa ham string olarak porta verilir — sürücü önce başlıktan kimlik doğrular.

**Temporal'a giriş:** `RunGateway.signalWithStart` (yeni ticket → yeni workflow, mevcut → sinyal;
aynı ticket'a çakışan iki teslimat iki koşu üretemez). Kapı kararı ve CI sonucu **`signal`** ile
gider — koşusu olmayan bir ticket için gelen karar/CI sinyali workflow **yaratmaz** (M14).

### Komut yolu (M105)

- Ayrıştırma `WorkPort.parseCommand`; gramer sürücüde. `/approve etmiyorum` ve
  `/approve\n<ek satır>` komut sayılmaz, düzenlenmiş yorum komut taşımaz — testler bunu
  **gerçek `@maestro/adapter-jira` ayrıştırıcısıyla** doğrular (kendi kendine doğru çıkan test yok).
- Yetki: `WorkPort.verifyMembership(author, ownerGroup)`. Grup `GateDirectory` üzerinden proje
  bazlı çözülür (M71), varsayılan set workflows'un `GATE_OWNER`'ı ile teste bağlıdır.
- **Kapı kararı yalnız insan kanalından (M32/M101):** Studio yolunda `ai-via:` oturumu 403;
  audit zinciri `GATE_APPROVE/REJECT` için insan olmayan aktörü zaten reddeder.
- Geçersiz/yetkisiz komutta kullanıcıya Jira yorumu yazılır (M14), metin katalog anahtarından (M104).
- Komut→sinyal haritası: `approve/reject → gateDecision` · `mode-change → modeChange` ·
  `ai-takeover → modeChange(human_lead)` · `ai-start`/`ai-assign → signalWithStart` ·
  `status → runState query` · `ai-explain → desteklenmiyor yanıtı` (aşağıya bkz.).

### REST (hepsi auth'lu)

`GET /runs` · `GET /runs/:ticket` (Temporal `runState` query) ·
`POST /runs/:ticket/signals/:name` · `GET /params` · `PUT /params/:key` · `POST /killswitch` ·
`GET /killswitch` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/session`.

- Sinyal ucu **beyaz liste**: `gateDecision`, `clarificationAnswered`, `modeChange`.
  `ciResult` **dışarıda** — build kararı yalnız imzalı Service Hook'tan gelir ve kökenini taşır
  (M106); giriş yapmış herkesin yeşil CI üretebilmesi kabul edilemez. `killSwitch` **dışarıda** —
  kendi ucu, kendi rol kontrolü, kendi audit aksiyonu var. `prChangesRequested` **dışarıda** —
  PR yorumu ADO olayıdır (M13/12b), Studio düğmesi uyduramaz.
- Kapı kararında onaylayan **oturumdan** alınır, gövdeden asla (`signatureSeq` ve `actorUserId`
  gövdeye yazılırsa yok sayılır — testli).
- `PUT /params/:key`: `guarded` parametre **tek imzayla uygulanmaz**. Birinci kişi öneri bırakır
  (202 `pending`), **farklı** ikinci kişi **aynı değeri** onaylayınca uygulanır (200 `applied`).
  Aynı kişinin ikinci basışı hâlâ `pending`; farklı değerle onay 409. Değer karşılaştırması
  `canonicalize` ile yapılır (anahtar sırası fark yaratmaz).
- `POST /killswitch`: rol `admin` + insan kanalı + audit. `all` seviyesinde koşan tüm workflow'lara
  `killSwitch` sinyali gider; `intake_only` yalnız yeni işi durdurur; `off` geri açar.

### Kimlik (M8)

- `IdentityProvider` sürücü arayüzü + `LocalIdentityProvider` (bcrypt). AD/LDAP sürücüsü **yazılmadı**,
  arayüz aynı: `authenticate(username, password)` — hash dışarı sızmaz, bu yüzden LDAP bind aynı
  imzaya oturur.
- Parola politikası: min 12, büyük/küçük/rakam/simge, kullanıcı adı içeremez, **maks 72 bayt**
  (bcrypt 72 bayttan sonrasını sessizce yok sayar — "kabul edildi" ile "kontrol ediliyor" aynı
  cümle kalsın diye). Politika **hesap açılışında** uygulanır (`provision`), girişte değil.
- Oturum: 256-bit token, **mutlak 8 saat** (kayan değil), süre dolunca kayıt silinir.
- Bilinmeyen hesapta da bir bcrypt karşılaştırması yakılır (zamanlama farkı ayrılan çalışanı ele vermesin).
- Rol/grup üyeliği `UserDirectory`'den; kapı yetkisi ayrıca `WorkPort.verifyMembership`'ten.

### Denetim (M33)

Her yazma yolu `@maestro/audit` zincirine kayıt düşer: `RUN_STARTED`, `GATE_APPROVE`,
`GATE_REJECT`, `MODE_CHANGED`, `ASSIGN_APP`, `CLARIFICATION_ANSWERED`, `CI_RESULT`,
`PARAM_CHANGED`, `KILL_SWITCH`. Aktör biçimi `user@corp`; AI aracı `ai-via:<user>`
(`sessionActor`). Jira'nın çıplak kullanıcı adı `config.actorDomain` ile nitelenir.

**`signatureSeq` = audit zincirindeki sıra.** Kapı kararı önce zincire yazılır, dönen `seq`
imza numarası olur: imza denetçinin göremediği bir sayaçtan değil, zincirin kendisinden gelir.

### Sağlık / yapılandırma

`/healthz` (canlılık, bağımlılığa dokunmaz) · `/readyz` (workflow motoru + kill-switch deposu;
başarısızsa 503). İkisi de auth'suz — probe'un kimlik bilgisi yoktur ve ikisi de iş verisi taşımaz.
Yapılandırma `@maestro/config`'ten: `buildServer` açılışta `loadEnv()` çağırır (production'da eksik
bağlantı değeri = başlamaz, M6) ve **mesaj kataloğunu doğrular** (M104 — render edemediği cümleyi
borçlu olan servis trafiği kabul etmemeli).

### Referans gerçeklemeler

`InMemoryParamStore` (sürüm sürekliliğini zorlar), `InMemoryKillSwitchStore`,
`StaticJiraProjectBindings`, `StaticGateDirectory`, `InMemoryUserDirectory`,
`InMemorySessionStore` — `packages/audit`'in `InMemoryAuditStore`'u ile aynı ruhta: kuralları
gerçek deponun uygulaması gereken sıkılıkta uygular, testler ve dev-compose kullanır.

## 2. Test özeti

`pnpm -F @maestro/bff test` → **13 dosya, 145 test, hepsi yeşil.** Kök `pnpm run gate` **tamamen
yeşil** (44 turbo görevi). Tüm testler çevrimdışı: Fastify `inject`, sahte Temporal geçidi,
gerçek `AuditChain` + `InMemoryAuditStore`, gerçek `@maestro/adapter-jira` ayrıştırıcıları.

Özellikle istenen davranışlar:

| İstenen | Test |
|---|---|
| imzasız webhook 401 | `webhooks-jira.test.ts` (imzasız · yanlış sır · imzasız+bozuk gövde de 401) |
| yeniden serileştirilmiş gövde imzayı geçemez | `webhooks-jira.test.ts` "re-serialised after signing" |
| `/approve etmiyorum` onay SAYILMAZ | `jira-commands.test.ts` — sinyal yok, audit yok, kullanıcıya sebep yazıldı |
| yetkisiz kişi kapı kapatamaz | `jira-commands.test.ts` (Jira) + `runs.test.ts` (Studio, ayrıca `ai-via:` 403) |
| guarded parametre tek imzayla değişmez | `params.test.ts` (tek imza · aynı kişi iki kez · farklı değer 409) |
| kill-switch açıkken yeni intake reddedilir | `killswitch.test.ts` (`intake_only` ve `all`, kapatınca yeniden kabul) |

Ek olarak: her REST ucu token'sız ve sahte token'la 401 döner (rota listesi testte sabit, yeni uç
korumasız geçemez); sinyal adları `@maestro/workflows`'tan **gerçek import**la karşılaştırılır
(v1'in üreten/tüketen anahtar uyuşmazlığı sınıfça kapalı); `GATE_OWNER` eşleşmesi de testli.

## 3. Talepler

### 3a. Katalog anahtarları (config DÜZENLENMEDİ — M104 gereği burada)

`packages/config/locales/{tr,en}.json` içine eklenmeli. Eklenene kadar `buildServer` üretimde
`MissingCatalogKeysError` ile **açılmaz** (bilinçli fail-closed; testler kataloğu enjekte eder).

| Anahtar | tr | en |
|---|---|---|
| `command.accepted` | `{command} komutu alındı.` | `Command {command} accepted.` |
| `command.no_run` | `{ticket} için çalışan bir Maestro akışı yok.` | `There is no running Maestro flow for {ticket}.` |
| `command.no_open_gate` | `{ticket} şu anda açık bir onay kapısında değil.` | `{ticket} is not standing at an open approval gate.` |
| `command.run_status` | `{ticket} · adım: {step} · durum: {status}` | `{ticket} · step: {step} · status: {status}` |
| `command.unsupported` | `{command} komutu bu sürümde desteklenmiyor.` | `The {command} command is not supported in this release.` |

### 3b. Port / kontrat talepleri (contracts+ports'a DOKUNULMADI)

1. **`WorkPort.parseCommandDetailed`** (veya `parseCommand`'ın zengin dönüşü). Port yalnız
   `CommandEnvelope | null` veriyor; "komut değil" ile "bozuk komut" ayrımı yapılamıyor, oysa
   M105/M14 bozuk komutta kullanıcıya yazmayı **zorunlu** kılıyor. Şu an sürücüde zaten var olan
   `parseCommandDetailed` **yapısal olarak** tespit ediliyor (`commandDiagnosticsOf`) — sürücü
   import edilmiyor. Sürücü bu yeteneği sunmazsa BFF olayı yalnız sayabiliyor (testli).
   → Yeteneği porta almak doğrusu.
2. **`WorkPort.parseEvent(rawBody)`** — doğrulanmış teslimattan `{kind, ticketKey, labels}`.
   Şu an `WorkEventReader` olarak DI ile alınıyor (kompozisyon kökü sürücüden bağlar).
   Intake, ticket anahtarını ve etiketleri başka türlü öğrenemiyor.
3. **`AuditAction`'a `maestro-bff` sistem aktörü veya eşdeğeri.** `packages/audit` yalnız
   `maestro-worker` / `maestro-runner` kabul ediyor; webhook kökenli sistem kayıtları (intake,
   CI sonucu) şu an `maestro-worker` olarak yazılıyor. M33'ün "tek yazar worker'dır" kuralıyla
   görev talimatının "her yazma ucu zincire yazar" kuralı burada çakışıyor — talimat uygulandı,
   karar orkestratörde.
4. **`AuditAction`'a `USER_PASSWORD_CHANGED`** yok. Bu yüzden self-servis parola değiştirme ucu
   **yazılmadı**; politika hesap açılışında (`LocalIdentityProvider.provision`) uygulanıyor.
5. **`/ai-explain` için workflow sinyali yok.** `packages/workflows/src/signals.ts` içinde karşılığı
   olmadığından komut "desteklenmiyor" yanıtı alıyor (sessiz yutma yok). Sinyal eklenirse tek
   `case` ile bağlanır.
6. **Clarification cevabı (2b) Jira yorumundan alınamıyor.** Düz yorum metnine ulaşmak port
   yeteneği gerektiriyor (madde 2 ile aynı kök). Studio yolu (`clarificationAnswered`) çalışıyor.

### 3c. Bağımlılık gerekçeleri

| Paket | Gerekçe |
|---|---|
| `fastify` ^5 | M7'nin kendisi. Eklenti eklenmedi (auth/rate-limit/CORS gerekmedi). |
| `bcryptjs` ^3 | M8 bcrypt diyor. Yerel `bcrypt` **native** eklentidir; BFF imajı çok aşamalı ve sertleştirilmiş, içinde derleyici yok — pure-JS gerçekleme derleme zinciri istemez, testler çevrimdışı kalır. API bcrypt ile uyumlu. Hash'leme tek dosyada (`auth/password.ts`) kapalı; başka bir KDF'ye geçiş tek sınıf. |
| `@maestro/adapter-jira` (devDependency) | **Yalnız testlerde**: imza ve komut grameri gerçek sürücüyle sınanır, yoksa M105 testleri totolojik olurdu. Üretim kodunda import edilmez. |
| `@maestro/workflows` (devDependency) | Yalnız sinyal/query adı ve `GATE_OWNER` denkliği testi için. |

### 3d. Bilinçli kapsam sınırı

- **Kompozisyon kökü (`main.ts`) yazılmadı.** Sürücü bağlama (Jira/ADO/Temporal/Prisma/Vault)
  "somut sürücüyü import ETME" kuralıyla bu paketin içinde yapılamaz; ayrıca param/kullanıcı/
  binding depolarının DB gerçeklemeleri henüz yok. Paket `buildServer(deps)` verir; bağlama
  Dalga 4 / `deploy` kalemidir. Kökün sağlaması gerekenler: `WorkPort`, `WorkEventReader`,
  `CiPort`, `RunGateway` (Temporal), `AuditChain`, `SessionStore`, `IdentityProvider`,
  `UserDirectory`, `JiraProjectBindings`, `GateDirectory`, `ParamStore`, `KillSwitchStore`.
- **`/mcp` ucu (M101) yazılmadı** — `packages/mcp-servers` kalemi. BFF tarafındaki karşılığı
  (`ai-via:<user>` aktörü, kapı kararında delegasyon reddi) hazır ve testli.
- Speküle edilmeyen ama eklenen iki küçük uç: `GET /auth/session` ve `GET /killswitch` — Studio'nun
  oturumu ve kill-switch durumunu göstermesi için gerekli, ikisi de auth'lu ve salt okunur.
