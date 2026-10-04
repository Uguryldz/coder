# Orkestra v2 — Banka Sürümü Mimari Plan (TASLAK — tartışma için)

> **Durum:** v2.0 TASLAK — mimari tartışma dokümanı. Kod yazımı başlamadı, başlamayacak (onay gelene kadar).
> **Tarih:** 2026-08-04
> **Bağlam:** v1 taslağın (bkz. [`../projectplan.md`](../projectplan.md), K1–K49) tam kod analizi yapıldı; bu doküman o analizin sonuçları + yeni hedef ortam (finans kuruluşu, Jira destekli SDLC, Azure DevOps repo) üzerine kuruludur.
> **Diyagramlar:** [`diagrams/`](diagrams/) — v2-system, v2-flow, v2-llm, v2-ado, v2-runner, v2-hafiza

---

## 0. Yönetici Özeti

- **Ne:** Jira ticket → AI destekli analiz/geliştirme/test → Azure DevOps'ta PR. İnsan onay kapıları, denetim izi ve veri sınırı kontrolü ile — bir finans kuruluşunun iç SDLC'si için.
- **v1'den temel fark:**
  1. **Yürütme motoru değişti** — el yapımı "prompt + JSON kazıma" ajan boru hattı yerine: düşünen roller = tek LLM çağrısı (native structured output), yapan roller = sandbox içinde **Claude Agent SDK** oturumu (kod gerçekten yazılır, testler gerçekten koşar).
  2. **SCM değişti** — Bitbucket-first yerine **Azure DevOps-first**, port/adaptör mimarisiyle generic.
  3. **LLM erişimi hibrit** — tek `LlmPort` arkasında hem cloud (Claude) hem on-prem model; yönlendirme politikayla (rol + veri sınıfı).
  4. **Banka sertleştirmesi** — SoD (görevler ayrılığı), kanıt paketi, SIEM'e audit, egress proxy, gerçek Vault.
- **Ortam:** Docker Compose ile başlar; OpenShift/Kubernetes'e geçiş mimari olarak hazır tutulur (aşama 3+).

---

## 1. v1 Analizinin Özeti (neden yeniden mimari)

v1 kodu (~16.5k satır) tek uçuşta, entegrasyon testi olmadan yazılmıştı. Parçalar tek tek makul, birbirine bağlanmamış:

| Kırık sınıfı | Örnekler |
|---|---|
| Akış kırıkları | 4 work mode'dan 3'ü ölü (prId sinyali yok); CI gate hiç tetiklenmiyor (ID/key karışıklığı); Studio knowledge'ı ajanlara ulaşmıyor (Setting vs MinIO); güvenlik taraması çağrılmıyor; workflow durumu DB'ye yazılmıyor |
| Güvenlik kırıkları | Auth'suz CRUD API (tüm secret'lar okunabilir); HMAC ham gövde yerine re-serialize JSON; `isAuthorized()` daima true; sandbox: öldürmeyen timeout, limit yok, açık egress, docker.sock |
| LLM kırıkları | Eski model ID'leri; 3× yanlış Opus fiyatı; desteklenmeyen `temperature` → gerçek modda 400; test-runner sonuç uyduruyor |
| Test gerçeği | 245 satır test (~%1.5), workflow/sandbox/API sıfır test |

**Sonuç:** onarmak değil, çekirdeği yeniden kurmak; sağlam parçaları (Jira istemcisi+ADF, PII çekirdeği, audit zinciri fikri, Studio iskeleti, sandbox sertleştirme profili) elden geçirip taşımak.

**Ders (süreç):** v1'in "otonom tek uçuş" protokolü (eski §14) bu kırıkların ana nedeni. v2'de **dikey dilim + her aşamada çalışır demo** zorunlu (bkz. §9).

---

## 2. Gereksinimler

### 2.1 Fonksiyonel
- Jira DC ticket → intake → analiz → insan onayları → kod değişikliği → test → ADO'da PR → CI (build validation) → merge desteği.
- 4 work mode (full-auto / ai-assist / human-lead / human-only) ve insan↔AI devir sinyalleri (v1 tasarımı korunur).
- Agent Studio: variant + knowledge pack + golden ticket eval yönetimi.
- Jira yorum komut seti (`/approve`, `/reject`, `/cancel`, `/mode-change`, …) — **yetki doğrulamalı**.

### 2.1.1 Hedef uygulama portföyü (çoklu platform — MVP kapsam belirleyici)

| Uygulama | Stack | Derleme/test ortamı |
|---|---|---|
| **ugurpay** | Next.js | Linux container (node) |
| **ugurweb** | React | Linux container (node) |
| **ugurmobil (iOS)** | Xcode / Swift | **macOS runner** — konteynıra sığmaz |
| **ugurmobil (Android)** | Kotlin / Gradle | Linux container (Android SDK) |
| **ugurmasaüstü** | C# (.NET) | **Windows runner** — WPF/WinForms Linux'ta derlenmez |

Sonuç: tek tip Linux sandbox varsayımı (v1) yetersiz — **runner matrisi** gerekir (§3.3).

### 2.1.2 Uzun süreli akış ve bağlam sürekliliği
- Bir ticket herhangi bir kapıda **15-20 gün bekleyebilir**; workflow durumu ve ajan bağlamı kaybolmadan kaldığı yerden devam etmeli.
- Ajanın "chat geçmişi" ticket bazında **kalıcı**: analiz → geliştirme → review döngüleri arasında ve günler sonra dönüşte, ajan önceki konuşmaların/kararların tamamının bilinciyle çalışır (bu tasarım oturumundaki gibi ardışık iş sürdürme).
- Sandbox/masaüstü runner ortamlarında **veri cache'i**: bağımlılıklar ve ticket çalışma alanı her dönüşte sıfırdan kurulmaz (§3.4).

### 2.2 Bankaya özgü fonksiyonel olmayan gereksinimler
- **SoD:** Üreten kimlik ≠ onaylayan ≠ merge eden. AI = ayrı servis hesabı; kapı onayları Jira/AD grup üyeliğinden doğrulanır.
- **Kanıt paketi:** Her workflow sonunda tek arşivlenebilir paket: analiz, diff, test raporu, tarama sonuçları, onay zinciri, maliyet. Change/denetim kaydına eklenebilir.
- **Veri sınırı:** Hangi veri sınıfının hangi LLM arka ucuna gidebileceği politika ile (bkz. §5). Kurum dışına çıkış tek noktadan (egress proxy).
- **Denetim:** Hash-zincirli, tek yazarlı audit log; SIEM export (syslog/CEF veya dosya). PII maskeli hali arşivlenir.
- **İşletim:** Docker Compose (tek/çift VM), sonra OpenShift/K8s. Yedekleme/geri dönüş prosedürü dokümante ve test edilmiş.
- **Ölçek hedefi (pilot):** 1-2 takım, ~10-30 ticket/gün; mimari 100+ eşzamanlıya çıkabilir (Temporal + role-based queue, v1 K37 korunur).

---

## 3. Hedef Mimari (bkz. `diagrams/orkestra-v2-system`)

```
KURUM İÇİ AĞ
  Jira DC ── webhook ──► API/BFF ──► Temporal ──► Worker havuzu
  Azure DevOps ◄── PR/branch ─────────────────────────┘ │
      │  Service Hooks (PR, build) ──► API/BFF          │
      ▼                                                 ▼
  [branch policy + build validation = CI gate]     Runner Servisi ──► ephemeral sandbox
                                                        │                (Agent SDK burada koşar)
  Studio (Next.js) ──► API/BFF (tek veri düzlemi)       ▼
  Postgres · Redis · Storage (S3/PG) · Vault              LLM GATEWAY (LlmPort)
                                                   ├─► Egress Proxy ─► Claude API / Bedrock (maskeli)
                                                   └─► on-prem vLLM (GPU, hassas veri)
```

Bileşen sorumlulukları:

| Bileşen | Sorumluluk | v1'den fark |
|---|---|---|
| **API/BFF** | Webhook alımı (Jira + ADO), Temporal start/signal, Studio'nun TEK veri kapısı, kimlik doğrulama | Auth'suz ikinci CRUD katmanı yok; raw-body HMAC; fail-closed |
| **Temporal çekirdek workflow** | Adım durumu, insan kapıları, SLA, retry, sinyaller | Durum event-sourced `StepEvent` tablosuna da yazılır (dashboard/denetim aynı kaynaktan) |
| **Worker** | Düşünen ajan çağrıları + orkestrasyon aktiviteleri | docker.sock YOK |
| **Runner Servisi** | Sandbox yaşam döngüsü (yarat/izle/öldür), kaynak limitleri, dep cache mount | Yeni servis — Docker yetkisi yalnız burada, dar API ile |
| **Sandbox** | Agent SDK oturumu: repo klon, kod yazımı, test koşumu, branch push | v1 sertleştirme profili + mem/CPU/pids limiti + gerçek öldüren timeout + egress yalnız proxy'ye |
| **LLM Gateway (`LlmPort`)** | Model yönlendirme (politika), rate limit, bütçe, prompt cache, maliyet muhasebesi, çağrı logu | Hibrit: Anthropic uyumlu + OpenAI uyumlu (vLLM) arka uçlar |
| **Studio** | Variant/knowledge/eval + workflow izleme + onay ekranı (opsiyonel, Jira'ya ek) | DB'ye doğrudan değil, BFF üzerinden |
| **Vault** | Tüm secret'lar, kısa ömürlü git kimlikleri | v1'de dokümante ama yoktu; v2'de gerçekten var |

### 3.1 Port/adaptör katmanı

- **`WorkPort`** (iş kaydı): Jira DC adaptörü (v1'in `packages/jira`'sı taşınır — en sağlam parçaydı). İleride ADO Boards/Jira Cloud.
- **`ScmPort`** (repo/PR): **Azure DevOps adaptörü (yeni, MVP)** + Bitbucket DC (v1'den taşınır, ikincil). Arayüz: repo çözümle, branch aç, push kimliği al, PR aç/güncelle, PR thread oku/yaz, PR status bildir.
- **`CiPort`** (pipeline): ADO **build validation** modeli — CI'ı biz tetiklemeyiz; branch policy tetikler, biz Service Hook ile sonucu dinler Temporal'a sinyalleriz.
- **`LlmPort`**: §5.
- Tüm webhook'lar normalize iç olay şemasına çevrilir; korelasyon anahtarı her yerde **Jira issue key** (v1'in ID/key hatası sınıfça kapanır).

### 3.2 Azure DevOps kapsamı (bkz. `diagrams/orkestra-v2-ado`)

| Konu | Karar/kapsam |
|---|---|
| API | ADO REST (Server 2022+: 7.x; Services: 7.1+). Sürüm farkı adaptör konfigürasyonunda — Server/Services ikisi de desteklenir. **Açık soru: kurumda hangisi?** |
| Kimlik | Server: PAT (AI servis hesabına ait, dar scope: Code R/W, PR R/W). Services: Entra ID service principal. Vault'tan, kısa ömürlü kullanım. |
| Repo eşleme | `RoutingRule` genişler: Jira project/component → ADO project/repo/pipeline. v1'deki hardcoded `"repo"` placeholder'ın çözümü. |
| PR akışı | REST ile PR aç (draft başlar, insan kapısından sonra active); açıklama = analiz özeti + kanıt paketi linki; `[AI]` prefix + attribution (v1 K26 korunur). |
| CI gate | Branch policy **build validation** → pipeline otomatik koşar → `build.complete` Service Hook → Temporal sinyali. Kırmızıysa 6a'ya dönüş. |
| PR yorum döngüsü | PR thread'leri (`pullrequest.comment` hook) → "changes requested" sinyali → 6a. v1'de hiç implement edilmemişti; ADO thread status API'siyle temiz yapılır. |
| Branch koruması | Policy: min 1 insan reviewer (SoD), force-push kapalı (v1 K31), AI her zaman rebase. |
| Webhook güvenliği | ADO Service Hooks temel auth/başlık destekler; kendi tarafımızda ek HMAC/secret başlık + IP kısıtı; **fail-closed**. |

### 3.3 Çoklu Platform Yürütme — Runner Matrisi (bkz. `diagrams/orkestra-v2-runner`)

v1'in "Windows build makinesi + MCP köprüsü" fikri genelleştirilir: her platformda aynı **Orkestra Runner Agent** koşar; Runner Servisi işi platform profiline göre doğru havuza yollar.

| Driver | Ortam | Kapsadığı uygulamalar | Yaşam döngüsü |
|---|---|---|---|
| `docker-linux` | Ephemeral container (sertleştirilmiş) | ugurpay, ugurweb, ugurmobil-android | Container iş başına; workspace volume kalıcı (§3.4) |
| `agent-macos` | Mac mini havuzu (fiziksel/MDM'li) | ugurmobil-ios (xcodebuild + simulator) | Makine kalıcı; **iş başına ephemeral kullanıcı/workspace**, iş sonu temizlik |
| `agent-windows` | Windows Server VM havuzu | ugurmasaüstü (MSBuild · dotnet · vstest) | Makine kalıcı; iş başına ephemeral workspace |

Tasarım ilkeleri:
- **Bağlantı yönü dışarı doğru:** mac/win runner'lar platforma *outbound* bağlanır (gRPC/WebSocket); içeri port açılmaz — banka ağında onayı kolay. (v1'deki "worker MCP istemcisi → Windows MCP sunucusu" fikrinin ters çevrilmiş, güvenli hali.)
- **Agent SDK oturumu runner'ın üzerinde koşar** (kodun derlendiği/test edildiği yerde); dışarı yalnız LLM Gateway'e çıkar. Böylece iOS/C# işlerinde de "yapan" ajan gerçek build/test döngüsüyle çalışır.
- Repo profili `.orkestra.yaml`'a taşınır: `platform: linux-node | linux-android | macos-xcode | windows-dotnet` + komutlar. RoutingRule → repo → platform → havuz.
- mac/win runner'larda konteynır izolasyonu yok; telafi: ephemeral workspace + dar yerel kullanıcı + EDR/MDM + aynı egress proxy kuralları. (Kabul edilen risk — açık soruya eklendi.)
- Kapasite: her havuz için ayrı semafor (v1 CapacityPool genelleşir).

### 3.4 Cache Mimarisi — 3 katman (bkz. `diagrams/orkestra-v2-runner`)

v1'de dep-cache yazılmış ama hiç bağlanmamıştı; v2'de cache birinci sınıf tasarım öğesi:

| Katman | İçerik | Anahtar | Ömür |
|---|---|---|---|
| **1. Bağımlılık cache** | node_modules/npm store · Gradle · CocoaPods/SwiftPM + DerivedData · NuGet | `repo + lockfile hash` | Lockfile değişene kadar; LRU tahliye |
| **2. Ticket çalışma alanı** | Klon + branch + build çıktıları + **Agent SDK session dosyaları** | `ticket key` | Ticket açık kaldıkça (15-20 gün bekleme dahil); ticket kapanınca/cancel'da silinir (K41 genişler) |
| **3. Bilgi/prompt cache** | Knowledge pack · prompt caching (LLM Gateway) | `variant + knowledge hash` | Knowledge değişene kadar |

- Linux'ta named volume, mac/win'de yerel cache dizini — aynı anahtar şeması.
- 15 gün sonra dönüş: yeni ephemeral container/workspace kullanıcı açılır ama **katman 2 mount edilir** → klon + install + önceki çalışma anında hazır.
- Güvenlik: katman 2 kod içerir → runner diskinde şifreli, erişim iş bazlı; temizlik audit'e yazılır.

### 3.5 Depolama: `StoragePort` (BYOS — MinIO sabit bağımlılık olmaktan çıktı)

Dış değerlendirmeden kabul edilen öneri (K67): MinIO **mimari bağımlılık değil, olası uçlardan biri**.

- **`StoragePort` arayüzü:** put/get/list/delete + ön-imzalı link. İki sürücü: **S3-uyumlu** (varsayılan) ve **Postgres BLOB** (küçük kurulum: journal + kanıt paketi gibi düşük hacimli nesneler için, ayrı depolama ürünü işletmeden).
- **Banka gerçeği:** kurumda büyük olasılıkla S3-uyumlu kurumsal nesne depolama zaten var (Dell ECS / NetApp StorageGRID / Ceph); OpenShift'e geçişte **ODF/Ceph RGW** S3'ü doğal sağlar → StoragePort değişmeden çalışır.
- **Lisans notu (ölçülü):** MinIO AGPLv3'tür; ağ üzerinden değiştirilmemiş servis olarak kullanmak kodumuza AGPL bulaştırmaz, ancak birçok kurum hukuk ekibi AGPL'i kategorik reddeder — *iç kullanımda bile* onay sürtünmesi yaratabilir. Dev/demo varsayılanı olarak MinIO veya SeaweedFS (Apache-2.0) kalabilir; ürün hiçbirine kilitlenmez.
- Journal kayıtları ve StepEvent zaten Postgres'te; StoragePort yalnız **büyük artefaktlar** (kanıt paketi, knowledge içerikleri, koşum raporları) içindir. pgvector bu mimaride gereksiz (semantik arama ihtiyacı yok; knowledge zaten dosya olarak ajana verilir) — v2+ konusu.

---

## 4. Yürütme Katmanı: Ajan Rolleri v2

Roller kavramsal olarak korunur, yürütme **iki sınıfa** ayrılır:

| Rol | Sınıf | Yürütme | Model (varsayılan) |
|---|---|---|---|
| intake | Düşünen | Tek LLM çağrısı, native structured output | küçük/hızlı (Haiku sınıfı) |
| analyst | Düşünen | Tek çağrı; girdisi ticket + repo bağlamı (Agent SDK ile hazırlanan kısa keşif özeti) | en güçlü (Opus/Fable sınıfı) |
| **engineer** (eski developer) | **Yapan** | Sandbox'ta **Claude Agent SDK oturumu**: repo'yu keşfeder, kodu yazar, lint/build/unit koşar, branch push eder. Çıktı: diff + koşum raporu | en güçlü |
| dev-reviewer | Düşünen | Gerçek diff + koşum raporu üzerinde structured review | güçlü |
| test-designer | Düşünen | Gherkin senaryolar + negatif kapsam | güçlü |
| test-reviewer | Düşünen | Kapsam/piramit denetimi (4-göz) | orta (Sonnet sınıfı) |
| **test-engineer** (eski test-runner) | **Yapan** | Sandbox'ta Agent SDK: senaryoları test koduna çevirir, **gerçekten koşar**, gerçek coverage/flaky raporu | orta |

- v1'in en tehlikeli kusuru (test sonuçlarını LLM'in uydurması) yapısal olarak imkânsızlaşır: rapor sandbox koşumundan gelir.
- v1 K30 (tree-sitter AST skeleton) **iptal** — Agent SDK repo keşfini kendisi yapar.
- Zod I/O kontratları (v1 K15) düşünen roller için korunur; artık API'nin structured output özelliğiyle garanti edilir, regex-JSON kazıma yok.
- Knowledge Pack + variant + prompt caching (v1 K13/K14) korunur; **tek içerik deposu StoragePort** (v1'deki Setting/MinIO kopukluğu kapanır). Agent SDK oturumlarında knowledge, çalışma dizinine dosya olarak indirilir (CLAUDE.md benzeri).
- **Variant seti uygulama portföyüne göre güncellenir:** `web` (ugurpay/ugurweb) · `mobile-ios` · `mobile-android` · `desktop` (ugurmasaüstü) · `backend`. v1'in mobile/web/backend üçlüsü yerine platform gerçeğine uyan beşli.

---

## 5. Hibrit LLM Erişimi (bkz. `diagrams/orkestra-v2-llm`)

Tek `LlmPort`; arkasında iki arka uç ailesi:

1. **Cloud — Claude:** doğrudan Anthropic API **veya** AWS Bedrock/GCP Vertex (kurum tercihi; ikisi de aynı adaptörle). Egress yalnız proxy üzerinden, PII maskesi zorunlu, ZDR/veri işleme sözleşmesi ön şart.
2. **On-prem — açık model:** GPU üzerinde **vLLM** (OpenAI uyumlu API) + güncel açık kodlama modeli (seçim PoC ile; Qwen-Coder / DeepSeek sınıfı). Hassas veri sınıfı ve/veya air-gap senaryosu için.

**Yönlendirme politikası** (konfigürasyon, kod değil):
```yaml
routing:
  default: cloud-claude
  rules:
    - if: data_class == "gizli"          # ör. müşteri verisi içeren ticket
      then: onprem
    - if: role in ["intake"]             # ucuz işler
      then: cloud-haiku | onprem-small
  fallback: onprem        # cloud erişilemezse (opsiyonel, kalite düşer uyarısıyla)
```

Gateway sorumlulukları: token bucket rate limit (atomik, Lua script — v1'in yarış hatası kapanır), per-workflow + aylık bütçe (tek doğruluk kaynağı), maliyet muhasebesi (fiyat tablosu **konfig dosyasında**, kodda değil; bilinmeyen model = hata, sessiz fallback değil), çağrı logu (maskeli), prompt cache yönetimi.

**Not — Agent SDK bağımlılığı:** Agent SDK oturumları Claude modelleriyle çalışır. On-prem-yalnız veri sınıfında "yapan" roller için iki seçenek: (a) o repo/veri sınıfında ai-assist moduna düşmek (AI önerir, insan uygular), (b) on-prem model için basitleştirilmiş tool-loop (v2+, maliyetli). MVP kararı: (a). **Bu, uyum ekibiyle konuşulacak en kritik başlık.**

---

## 6. Workflow v2 (bkz. `diagrams/orkestra-v2-flow`)

v1'in 15 adım iskeleti korunur; değişen noktalar:

- **6a Geliştirme:** Agent SDK oturumu (engineer). Sandbox self-check (lint/build/unit) oturumun içinde.
- **6b Güvenlik taraması:** gitleaks + semgrep + trivy **gerçekten çağrılır**, sonuç kapıdır (fail-closed: tarayıcı çalışmazsa adım kırmızı — v1'de sessizce yeşildi). İmajlar dijest ile sabitlenir.
- **10 Test koşumu:** test-engineer oturumu; gerçek koşum.
- **10b CI gate:** ADO build validation + Service Hook sinyali.
- **12b PR yorum döngüsü:** ADO PR thread'leri ile **implement edilir** (v1'de yoktu).
- **Yeni son adım — 13 Kanıt paketi:** tüm artefaktlar tek pakette StoragePort arşivine; Jira'ya özet + link.
- Tüm kapılarda: onay verenin Jira/AD grubu doğrulanır + SoD kontrolü (4-göz, v1 K-kararı korunur ama artık kimlik doğrulamalı).
- Work mode'lar: insan yollarındaki "PR açıldı" bilgisi **ScmPort webhook → Temporal sinyali** ile gelir (v1'in ölü `state.prId` beklemesi kapanır).

### 6.1 Uzun Bekleme ve Ticket Hafızası (bkz. `diagrams/orkestra-v2-hafiza`)

**Bekleme modeli — v1'den kritik fark:** v1'de kapılar 48 saatte otomatik REJECT ediyordu. v2'de insan kapıları **süresiz bekler** (Temporal durable timer — 15-20 gün doğal durumdur): kademeli hatırlatıcı (24h Jira yorumu → 72h Slack → 7g backup/delegasyon eskalasyonu), ama otomatik ret YOK. Zaman aşımı politikası kapı bazında konfigürasyondur. Uzun ömürlü workflow hijyeni: `continueAsNew` ile history sınırı yönetilir.

**Ticket hafızası — üç bileşen:**
1. **Ticket Defteri (journal):** append-only kayıt — her ajan çıktısı, insan kararı/yorumu, PR thread'i, tarama sonucu, alınan teknik kararlar. StoragePort + DB index. Kanıt paketinin de hammaddesi.
2. **Yaşayan Özet:** her adım sonunda ucuz modelle güncellenen kompakt bağlam özeti ("şu ana kadar ne yapıldı, hangi kararlar alındı, açık konular"). Ajanlara her çağrıda verilir — 20 günlük ham geçmişi taşımadan süreklilik.
3. **Agent SDK oturum sürekliliği:** yapan rollerin session dosyaları ticket çalışma alanında (cache katman 2) saklanır. Dönüşte aynı oturum **resume** edilir; workspace uçmuşsa yeni oturum journal özeti + workspace cache ile bootstrap edilir. Sonuç: ajan 15 gün sonra "dün bıraktığı gibi" devam eder — bu tasarım sohbetindeki süreklilik modeli, ürünün kendisine uygulanır.

Review/CI ret döngülerinde de aynı mekanizma: her 6a dönüşü önceki oturumun devamıdır (v1: her dönüşte sıfırdan sandbox + bağlamsız yeni çağrı).

---

## 7. Güvenlik Mimarisi (banka sertleştirmesi)

| Katman | Kontrol |
|---|---|
| Webhook | Raw-body HMAC (Fastify raw body parser), fail-closed her ortamda, replay koruması (timestamp+nonce), IP allowlist |
| API/BFF | Tüm uçlar auth'lu (Studio oturumu veya servis token'ı); girişte Zod şema; mass-assignment yok |
| Onay kapıları | Jira grup üyeliği + SoD matrisi; komut idempotency (v1 K48) |
| Sandbox | Runner servisi (docker.sock worker'da değil); mem/CPU/pids limitleri; gerçek öldüren timeout (exec kill); egress yalnız proxy (registry + ScmPort + LLM gateway); secrets kısa ömürlü, dosya tabanlı, push kimliği credential-helper ile |
| Egress | Tek çıkış: allow-list proxy (ör. squid/envoy); tüm dış çağrılar loglu |
| Secret | Vault (gerçek): app token'ları + dinamik kısa ömürlü kimlikler; compose'ta default secret YOK — eksikse başlamaz (v1'in `change-me` sınıfı kapanır) |
| Audit | Tek yazarlı (yalnız worker aktivitesi) hash-zincir; günlük anchor (zincir başı imzalanıp ayrı yere yazılır); SIEM export |
| PII | LLM sınırında maske; artefakt deposuna **maskeli** hali; reverse-map yalnız Jira'ya dönen kullanıcı-görünür metinde, alan bazlı |
| İmajlar | Dijest-pinli; SBOM + trivy taraması CI'da |

---

## 8. Teknoloji ve Kütüphane Önerileri (2026 güncel)

| Alan | v1 | v2 önerisi | Not |
|---|---|---|---|
| Runtime | Node 22 | **Node 24 LTS** | Aktif LTS |
| Monorepo | pnpm + Turborepo | Aynı (pnpm 10) | Değişmez |
| Orkestrasyon | Temporal TS SDK | Aynı, güncel 1.x | Doğru karardı; `TestWorkflowEnvironment` ilk günden |
| API | Fastify 4 | **Fastify 5** + raw-body | |
| Şema | Zod 3 | **Zod 4** | Structured output şemalarıyla birlikte |
| ORM | Prisma | Prisma (güncel) | Devamlılık; Drizzle'a geçiş değer katmaz |
| UI | Next.js 15 + Refine + shadcn | Aynı, güncel sürümler; NextAuth → **Auth.js v5**; banka AD/LDAP veya OIDC (Keycloak) aşama 2 | |
| LLM (düşünen) | @anthropic-ai/sdk + regex JSON | **Vercel AI SDK** (`generateObject` + Zod) — provider soyutlaması: Anthropic + Bedrock/Vertex + OpenAI-uyumlu (vLLM) tek API'den; model ID'leri konfigde | Hibrit LLM şartının (K55) doğal kütüphane karşılığı; regex-JSON kazıma tarihe karışır |
| LLM (yapan) | — (el yapımı boru hattı) | **Claude Agent SDK** (sandbox içinde headless) | v1'in repo-map/patch-apply/test-runner derdi düşer |
| On-prem LLM | — | **vLLM** + açık kodlama modeli (PoC ile seçilir) | OpenAI-uyumlu uç |
| Sandbox | dockerode (worker içinde) | dockerode **runner servisinde**; v2+: gVisor/Kata değerlendirmesi K8s geçişiyle | |
| Tarama | gitleaks/semgrep/trivy `:latest` | Aynı araçlar, **dijest-pinli**, fail-closed | |
| Gözlem | — | OpenTelemetry + Prometheus/Grafana (aşama 3); LLM çağrı logu gateway'de | LangFuse v2'de değerlendirilir (v1 kararı korunur) |

### 8.1 Alternatif Değerlendirme Kaydı (2026-08 — "vazgeçecek olsak tam zamanı" turu)

Sıfırdan kurulum fırsatıyla her kilit taş yeniden sorgulandı; sonuçlar (detaylı fayda/zarar tartışması ayrı yapıldı):

| Bileşen | Değerlendirilen | Karar |
|---|---|---|
| Orkestrasyon | Temporal · Restate · DBOS · Camunda 8 · pg-boss+XState (custom) | **Temporal KALIR.** 15-20 günlük insan-kapılı akış + sinyal + `TestWorkflowEnvironment` + UI olgunluğunda rakipsiz; Restate/DBOS operasyonel olarak daha hafif ama sinyal/insan-kapısı deseni ve banka-olgunluk referansları zayıf. Custom = v1 faciasının davetiyesi. |
| Düşünen ajan katmanı | raw @anthropic-ai/sdk · **Vercel AI SDK** · Mastra · LangGraph JS | **Vercel AI SDK'ye GEÇİLDİ (K65).** Hibrit LLM şartını tek API'yle çözer (`generateObject` + Zod, 15+ provider + OpenAI-uyumlu vLLM). Mastra/LangGraph = Temporal ile orkestrasyon duplikasyonu (v1 §13 kararı geçerli). |
| Yapan ajan katmanı | Claude Agent SDK · kendi tool-loop · OpenHands | **Claude Agent SDK KALIR.** Kendi loop'u = v1'in repo-map/patch derdine dönüş; OpenHands Python + ayrı runtime yükü. |
| Sandbox izolasyonu | Docker(hardened) · +gVisor · Firecracker (E2B self-host) · Daytona | **MVP: hardened Docker + dockerode; Aşama 3: gVisor (runsc) runtime (K54 devamı).** Daytona Haziran 2026'da closed-source oldu — elendi. Firecracker/E2B self-host: en güçlü izolasyon ama bare-metal/K8s + işletim yükü; K8s geçişinde yeniden değerlendirilecek. |
| Araç erişimi | Doğrudan API adaptörleri · **MCP** | **MCP-first (K66):** Jira/ADO/workspace yetenekleri, Agent SDK oturumlarına **MCP server** olarak sunulur (resmi TS MCP SDK); çekirdek portlar TS adaptör olarak kalır, MCP bunların üstüne ince katman. v1'in "Windows MCP köprüsü" sezgisinin standartlaşmış hali. |
| Ticket çalışma alanı | Yerel volume + StoragePort senkron · git-tabanlı · ZFS/restic snapshot | **Volume + StoragePort senkron KALIR.** Git'e session/build çıktısı koymak repo'yu kirletir; snapshot fs işletim yükü MVP'ye fazla. Runner-yerel şifreli dizin + kapanışta StoragePort'a kanıt senkronu. |
| API/ORM/UI | Fastify 5 · Prisma · Next.js+Refine | Değişiklik yok — sorgulandı, korundu. |

Yeni kararlar: **K65** (Vercel AI SDK = düşünen katman), **K66** (MCP-first araç erişimi), **K67** (`StoragePort`/BYOS — S3-uyumlu sürücü + PG-BLOB küçük kurulum; MinIO yalnız dev varsayılanı, sabit bağımlılık değil).

**Değerlendirilip reddedilenler (bu tur):** pgvector (ihtiyaç yok), "hemen kod yazmaya başla" önerisi (kural değişmedi: kullanıcı onayı olmadan kod yok; ADO türü / LLM yolu / GPU açık soruları Aşama 0 detayını etkiler).

---

## 9. Aşamalı Yol Haritası (dikey dilim disiplini)

| Aşama | İçerik | Çıkış kriteri (demo) |
|---|---|---|
| **0 — Walking skeleton** (~2-3 hafta) | Jira webhook → intake+analyst (gerçek LLM) → tek onay kapısı → engineer (Agent SDK, `docker-linux`) → **ADO'da gerçek PR** → build validation yeşil. Pilot uygulama: **ugurpay veya ugurweb** (Linux — en düşük sürtünme) | 1 gerçek ticket uçtan uca; `TestWorkflowEnvironment` + ADO adaptör contract testleri yeşil |
| **1 — Yönetişim + süreklilik** (~2-3 hafta) | 6 kapının tamamı (süresiz bekleme + hatırlatıcı modeli) + Jira grup/SoD + audit zinciri + kanıt paketi + PII + **ticket hafızası (journal + özet + session resume) + cache katman 1-2** | Denetim ekibine gösterilebilir akış; **"15 gün beklet, kaldığı yerden devam ettir" tatbikatı** |
| **2 — Ürünleşme + platform genişlemesi** (~3-4 hafta) | Work mode'lar + PR yorum döngüsü + test ajanları + Studio + LLM gateway politikası (on-prem dahil) + **`linux-android` profili + Windows runner (ugurmasaüstü)** | Pilot takım gerçek sprint'te; Android + C# ticket'ları uçtan uca |
| **3 — Yaygınlaştırma** | Ölçek, gözlemlenebilirlik, SIEM, **macOS runner (ugurmobil-ios)**, OpenShift/K8s + Helm | 5 uygulamanın 5'i de destekli; işletim runbook'u tatbikatla doğrulanmış |

Not: macOS en sona — donanım tedariki/MDM onayı en uzun süren kalem (açık soru 8); Windows VM'i daha hızlı temin edilir.

Kural: **bir aşamanın çıkış kriteri gerçek sistemlerde gösterilmeden sonraki aşamaya geçilmez.** (v1'in başarısızlık dersi.)

---

## 10. v1 Karar Kaydı Revizyonu

Korunanlar (özet): K1 Temporal, K2 TS monorepo, K3-K4 PG/Redis (K5 MinIO → K67 StoragePort), K9 single-tenant, K13-K16 knowledge/caching/Zod/audit, K17 bütçe, K22-K24 work mode/handoff/status, K26 attribution, K29 rate limit, K31 branch koruması, K37-K39 ölçek/backpressure, K40 PII, K45-K49 UX kararları.

| Eski | Yeni durum |
|---|---|
| K7 (Opus/Sonnet/Haiku listesi) | **K50:** Model kataloğu konfigde, sürümler güncel tutulur; rol→model eşlemesi tek kaynaktan |
| K11 (Bitbucket-first) | **K51:** ADO-first, `ScmPort` ile generic; Bitbucket ikincil |
| K25 (Bitbucket Pipelines CI gate) | **K52:** ADO build validation + Service Hooks |
| K30 (tree-sitter AST) | **İPTAL** — Agent SDK repo keşfi |
| K6 (Vault "var") | **K53:** Vault aşama 1'de gerçekten; default secret'la ayağa kalkmak imkânsız |
| K8 (worker→docker.sock) | **K54:** Runner servisi; docker.sock worker'da asla |
| — | **K55:** Hibrit LLM: `LlmPort` + politika yönlendirmesi (cloud Claude / on-prem vLLM) |
| — | **K56:** Yapan roller Claude Agent SDK; test sonuçları yalnız gerçek koşumdan |
| — | **K57:** Tek veri düzlemi: Studio → BFF → DB; ikinci CRUD yolu yasak |
| — | **K58:** Kanıt paketi (adım 13) ve SIEM export |
| — | **K59:** Fail-closed ilkesi: imza/tarama/politika doğrulanamıyorsa akış durur, sessiz geçiş yok |
| K8/K33 (tek tip Linux sandbox + BYO image) | **K60:** Runner matrisi — `docker-linux` + `agent-macos` + `agent-windows`; runner'lar platforma outbound bağlanır; Agent SDK oturumu runner üzerinde koşar |
| K20 (SLA 24/48/72h) + v1'in 48h auto-reject'i | **K61:** İnsan kapıları süresiz bekler (15-20 gün doğal); kademeli hatırlatıcı + eskalasyon, otomatik ret YOK; `continueAsNew` hijyeni |
| — | **K62:** Ticket hafızası — journal + yaşayan özet + Agent SDK session resume; her geliştirme döngüsü önceki oturumun devamı |
| K34 (dep cache — yazılmış, bağlanmamıştı) | **K63:** 3 katmanlı cache (bağımlılık / ticket çalışma alanı / prompt-knowledge); katman 2 ticket ömrünce yaşar, kapanışta silinir |
| K32 (.orkestra.yaml) | **K64:** `.orkestra.yaml` genişler: `platform:` alanı (linux-node · linux-android · macos-xcode · windows-dotnet) → runner havuzu seçimi |
| K12 (lisans yok) | Geçerli — iç kullanım; ticari paketleme gündemden çıktı |

---

## 11. Açık Sorular (uyum/altyapı ekipleriyle netleşecek)

1. **ADO türü:** Server (on-prem) mi Services (cloud) mı? (Adaptör ikisini de destekler; webhook/kimlik detayı netleşmeli.)
2. **Cloud LLM yolu:** Doğrudan Anthropic mı, Bedrock/Vertex mi? Kurumun bulut sözleşmeleri belirler.
3. **On-prem GPU kapasitesi:** Hangi donanım mevcut/planlı? Model seçimi PoC'si buna göre.
4. **Veri sınıflandırması:** Hangi Jira projeleri/alanları "gizli" sınıfında? Yönlendirme politikasının girdisi.
5. **Kimlik:** Studio için AD/LDAP mı, kurumsal OIDC (Keycloak/ADFS) mı?
6. **SIEM:** Hedef sistem ve format (Splunk/QRadar, CEF/syslog)?
7. **Change yönetimi:** Kanıt paketi hangi sisteme bağlanacak (Jira'nın kendisi mi, ServiceNow benzeri mi)?
8. **macOS runner donanımı:** Mac mini havuzu mu, mevcut bir Mac build altyapısı mı (örn. ADO agent'ları)? MDM/EDR politikaları AI ajan çalıştırmaya izin veriyor mu?
9. **Windows runner:** Ayrılmış VM havuzu mu, mevcut ADO self-hosted agent'larla ortak mı? (Ortak kullanım izolasyonu zayıflatır — önerim ayrık havuz.)
10. **iOS imzalama/simulator:** Test kapsamı simulator ile mi sınırlı, gerçek cihaz/TestFlight süreci akışa girecek mi?
11. **Ticket çalışma alanı saklama politikası:** 15-20 gün kod içeren cache'in şifreleme/erişim gereksinimi bilgi güvenliğiyle netleşmeli.
