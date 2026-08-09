# @maestro/workflows — Dalga 3 aktivite gerçeklemeleri (RAPOR)

Dal: `wave3/workflows-activities` · Kapsam: `MaestroActivities` arayüzünün gerçeklenmesi,
Temporal worker kompozisyon kökü ve zaman-atlatmalı workflow testleri.

**Orkestratörün yazdığı dört dosyaya (`src/gates.ts`, `src/signals.ts`, `src/activities.ts`,
`src/ticket-workflow.ts`) dokunulmadı** — `git diff main` bu dört dosya için boş.

---

## 1. Ne yazıldı

### `src/impl/` — aktivite gerçeklemeleri

| Dosya | İçerik |
|---|---|
| `deps.ts` | `ActivityDeps` ve dikişler: `RunContextStore`, `GateStore`, `ParamReader`, `DirectoryReader`, `AgentTurnRunner`, `IdempotencyGuard`, `Translate`. Hepsi **arayüz** — hiçbir somut sürücü import edilmiyor (M44). |
| `record.ts` | Her aktivitenin bıraktığı üç iz: defter (`appendJournal`, M82 maskeleme sınırından geçer), hash-zincirli denetim kaydı (M33), bildirim (`routeNotification`, M45/M104). Susturulan olay defterde "susturuldu" olarak görünür — sessizce kaybolmaz. |
| `outcome.ts` | `LlmOutcome`'ın dört ucu (M18/M55/M97): `ok` → değer; `queued` → **yeniden denenebilir** `ApplicationFailure` + `nextRetryDelay` (Temporal bekler); `degraded` → work mode `ai_assist`'e düşer, akış sürer; `blocked` → insana devir + **kalıcı** hata. `switch` tüketici (beşinci durum derlemeyi kırar). |
| `intake.ts` | `resolveWorkMode`, `matchApplication` (M99 üç kademe: kural → AI önerisi (eşik 0.5, kapıda doğrulanır) → `null` = akış durur), `runIntake`, `askClarification`. |
| `analysis.ts` | `discoverRepo` (3ö: salt-okunur ajan oturumu, `resumeToken` saklanır — M30), `writeAnalysis` (AnalysisDoc şeması + **M83 şablon sürümü** ve **M59 dil** kontrolü, risk **belgeden**), `publishAnalysis`, `fanOutChildren` (M100 etki matrisi). |
| `gate.ts` | `openGate` (idempotent — çapa oynamaz), `recordGateDecision` (dizinden üyelik doğrulaması; onay **insan aktöre** yazılır — M32/M101), `escalateGate` (M88 merdiveni; **tek kaynak DB'deki `escalation.ladder`**), `journal`, `handOverToHuman`. |
| `engineering.ts` | `runEngineering` (`@maestro/execution` turu; `resumeToken` **workflow'unki** kazanır), `reviewDiff`/`reviewTests`/`designTests`, `runTests`. |
| `scan.ts` | `runScans` — çekirdek üçlü, **fail-closed**; sürücü **istisna atarsa bile** `error` sonucu üretilir (aktivite hata verip 3 denemede koşuyu düşürseydi tarama kaydı hiç oluşmazdı). |
| `delivery.ts` | `openPullRequest`, `activatePullRequest`, `verifyCiOrigin` (**M106**), `mergePullRequest` (yalnız `completed` PR'ın merge sha'sı), `buildEvidencePackage` (**audit zinciri önce doğrulanır**, kırıksa paket üretilmez), `closeTicket`. |
| `idempotency.ts` | `InMemoryIdempotency` — süreç içi tekrar-koruması; **başarısızlık hatırlanmaz** (yeniden deneme zaten amaç). |
| `index.ts` | `createActivities(deps): MaestroActivities` — arayüzün tek bağlama noktası. |

**Idempotentlik**: her yazan aktivite `IdempotencyGuard.once(key, fn)` üzerinden geçer.
Anahtar `runId` + aktivite + ayırt edici. Testlerde iki kez çağrılan aktiviteler tek yorum,
tek etiket, tek denetim kaydı üretiyor.

### `src/worker.ts` — kompozisyon kökü

`resolvePorts(registry, selection)` her portu **isimle** çözer; `PORT_NAMES` sabitleri sürücü
paketlerinden **import edilmez** (M44), ama `test/worker.test.ts` bu paketlerin kendi
sabitleriyle karşılaştırır — sürüklenme derlemede değil testte yakalanır.
`createMaestroWorker` workflow paketini `workflowsPath()` ile ayrı sandbox'ta bundle eder;
`runMaestroWorker` SIGINT/SIGTERM'de `shutdown()` çağırır ve **handler'ları temizler**
(bırakılsa aynı süreçteki bir sonraki worker'ı kapatırdı). `shutdownGraceTime: 5 dakika`.

---

## 2. Zaman-atlatmalı testlerde ne kanıtlandı

`@temporalio/testing`'in `TestWorkflowEnvironment`'ı + gerçek `ticketWorkflow` bundle'ı +
sahte aktiviteler. **111 test, 9 dosya, tamamı yeşil; tüm paket ~33 sn.**

| Kanıt | Test |
|---|---|
| Risk kademesine göre **doğru kapı seti** açılıyor; kademe dışı kapı hiç açılmıyor (otomatik onay değil) | `workflow-gates` × 4 |
| **16 gün bekleyen kapı**: 384 saatlik hatırlatıcı tetiklendi, **otomatik onay yok**, kapıyı yalnız insan kapattı — gerçek süre ~9 sn | `workflow-gates` |
| Hatırlatıcılar yalnız açık kapıda; kapanınca duruyor | `workflow-gates` + `gate-activities` |
| **Yanlış grup / doğrulanmamış onay / SoD ihlali** → kapı **kapanmıyor**, açık kalıyor, sebep defterde ve ticket'ta | `workflow-gates` × 3 |
| **Kill-switch `all`** → akış duruyor **ama açık kapı terk edilmiyor** (kapı cevaplandıktan sonra duruyor) | `workflow-gates` |
| `human_only` → hiç kapı açmadan devir (M73) | `workflow-gates` |
| **Analiz reddi** → adım 3'e dönüş → analiz yeniden yazılıyor → yeniden onay | `workflow-loops` |
| **Tarama bloke** (`fail` ve `error`) → 6a'ya dönüş, **3 turdan sonra insana devir** (M54) | `workflow-loops` × 2 |
| **Yabancı CI sinyali reddediliyor** ve akış beklemeye devam ediyor (M106) | `workflow-loops` |
| **CI kırmızı** → aynı oturumla düzeltme (`resumeToken` aynen taşınıyor — M30) | `workflow-loops` |
| **PR reddi** → 12b → aynı oturum → yeniden onay | `workflow-loops` |
| Korumalı yol ihlali **ilk turda** devir (M52); onaylamayan gözden geçiren 3 turda devir | `workflow-loops` × 2 |

Aktivite birim testleri (`intake`, `analysis`, `gate-activities`, `engineering`, `delivery`,
`worker`): 82 test — M99 kural önceliği ve deterministik eşitlik bozumu, M83/M59 belge
reddi, M55 kuyruk/M18 blok/M97 degrade dalları, M88 merdiven adımlarının **tam bir kez**
tetiklenmesi, M106'nın dört ret nedeni, M34 kanıt paketinin zincir doğrulaması,
idempotentlik ve M44 port çözümü.

---

## 3. Testlerin çevrimdışılığı — bir kayıt

Testler ağ çağrısı yapmıyor: tüm aktiviteler sahte, workflow kaynaktan bundle ediliyor.
**Tek istisna**: `@temporalio/testing`'in zaman-atlatmalı sunucusu varsayılan olarak
`cached-download` ile ilk çalıştırmada ikiliyi internetten indiriyor. Hava boşluklu CI için
`test/harness.ts` içindeki `createTestEnv()` **`MAESTRO_TEST_SERVER`** ortam değişkenini
okuyup diskteki ikiliyi kullanıyor (`executable: { type: "existing-path" }`). CI imajına
bu ikilinin konması gerekiyor — **operasyon maddesi, kod maddesi değil.**

---

## 4. Arayüz talepleri (orkestratör karar verir)

1. **`proxyActivities` retry bütçesi kotayı taşımıyor.** `ticket-workflow.ts` `maximumAttempts: 3`
   diyor. M55'te kota beklemesi aktiviteyi *yeniden denenebilir* hatayla bitiriyor
   (`nextRetryDelay` = kotanın açılma anı), ama 3 denemede pencere açılmazsa koşu düşüyor.
   Öneri: kota hatası için ayrı bir proxy (`maximumAttempts: 0` = sınırsız) ya da
   `retry.nonRetryableErrorTypes` dışında kalan `LlmQuotaWait` için ayrı politika.
2. **`recordGateDecision` bir verdict döndürmeli.** Bugün `Promise<void>`. Dizin üyeliği
   tutmayan bir karar (sinyalin iddia ettiği grup ≠ gerçek üyelik) ancak *kalıcı hata*
   atarak reddedilebiliyor ve bu koşuyu düşürüyor. `Promise<GateRejection>` dönseydi
   workflow kapıyı açık tutup kişiye sebebi bildirebilirdi — `canCloseGate` ile aynı desen.
3. **`writeAnalysis` degrade dalı.** M97'de "yapan rol ai-assist'e düşer" akışı sürdürüyor;
   ama analiz belgesi olmadan 4/5 kapıları açılamıyor. Bugün `AiAssistRequired` kalıcı
   hatasıyla duruyoruz. İnsanın analizi yazmasını bekleyecek bir adım (2b benzeri bir
   `human_wait`) gerekiyorsa bu `ticket-workflow.ts` değişikliğidir.
4. **`handOverToHuman` aktivite içinden çağrılamıyor.** `blocked`/M52 dallarında devrin yan
   etkilerini (defter + denetim + bildirim) `outcome.handOver` içinde yapıp sonra hata
   atıyoruz; workflow'un `status = "handover"` ataması bu yolda gerçekleşmiyor.
5. **`ScmPort`/`CiPort` sürücü kaydı yok.** `@maestro/adapter-ado` `PortRegistry`'ye kayıt
   olmuyor (sürücüleri ek bağımlılık istiyor), bu yüzden `PORT_NAMES.scm` için sürücü
   paketinden karşılaştırılacak bir sabit yok. ADO paketine `registerAdoDrivers(registry, deps)`
   eklenirse `worker.test.ts`'teki sürüklenme testi `scm`/`ci`'yi de kapsar.
6. **`ticketWorkflowContinue` gerçek `continueAsNew` değil.** Ret döngüsünde workflow kendini
   özyinelemeli çağırıyor; testler bu davranışı olduğu gibi pinliyor (kapı iki kez açılıyor).
   `continueAsNew`'e geçilirse `workflow-loops` testlerindeki "iki kez açıldı" iddiaları
   `continueAsNew` sonrası yeni koşuya taşınmalı.

## 5. Bağımlılıklar

Yeni **harici** runtime bağımlılığı yok. Eklenenler: `@temporalio/common` ve
`@temporalio/worker` (zaten depoda), ve workspace paketleri `@maestro/{audit, execution,
memory, notify, publish, scanners, storage, ports}`. Test-only: `@maestro/{pii, adapter-jira,
llm-gateway, secrets, test-kit}` — `adapter-jira`/`llm-gateway`/`secrets` **yalnız**
port-adı sürüklenme testi için, `src/` içinden hiçbiri import edilmiyor.

`@maestro/db` **kullanılmadı**: parametreler (`escalation.ladder`, `notify.routing`,
publish hedefleri, routing kuralları) `ParamReader` dikişinden okunuyor; Prisma'yı
kompozisyon kökünün üstüne çıkarmamak için. DB'ye bağlama işi worker'ı ayağa kaldıran
uygulamanın (Dalga 3 `bff`/`apps/worker`).

## 6. Dosya/satır durumu

Tüm dosyalar ≤ 300 satır (en büyüğü `src/impl/engineering.ts`, 246). Üretim kodu
`src/impl/*` + `src/worker.ts` ≈ 1265 satır; testler ≈ 1500. Paket, inşa planındaki
"~1200 satır üretim kodu" tavanının biraz üstünde — 23 aktivitenin tamamı burada olduğu
için bölmedim; istenirse `impl/` iki pakete ayrılabilir (`workflow-activities-core` /
`-delivery`).
