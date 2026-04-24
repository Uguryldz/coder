# Jira AI Orkestra — Proje Planı (FİNAL)

> **Durum:** v3.7 FİNAL — Otonom çalışma protokolü.
> **Son güncelleme:** 2026-04-21
> **Altın kural (1):** Kullanıcı "başla" demeden **tek satır kod yazılmaz**.
> **Altın kural (2):** Kullanıcı "başla" dedikten sonra **durak yok, ara onay yok, ara soru yok** — tüm 7 faz bitirilir, sonunda **tek bir final rapor** sunulur.
> **Görsel akış:** [`diagrams/workflow.png`](diagrams/workflow.png)
> **Sistem mimarisi:** [`diagrams/system.png`](diagrams/system.png)
> **UI wireframe:** [`diagrams/ui_mockup.png`](diagrams/ui_mockup.png)
> **Uzun vadeli hedef:** Atlassian marketplace app / potansiyel satın alma.

---

## 0. Hızlı Özet (Yöneticiye)

- **Ne:** Jira ticket → PR otomasyonu. 7 AI ajan + 6 insan onay kapısı + 4 work mode.
- **Nasıl:** İnsan ve AI birlikte çalışır; ticket domain'ine göre variant'lı ajanlar (mobile-dev / web-dev / ...) knowledge pack ile eğitilir.
- **Süre:** ~9.5 hafta (1 kişi). Takım varsa daha kısa.
- **Deploy:** On-prem Docker Compose (tek komut kurulum).
- **Tek dış çıkış:** Claude API.

Akış görselini görmek için → [workflow.png](diagrams/workflow.png)

---

## 1. Değişiklik Özeti (v3.2 → v3.3 FİNAL)

Başka bir AI tarafından gelen geri bildirim değerlendirildi. Karar özeti:

| Öneri | Karar | Gerekçe |
|-------|-------|---------|
| Repo mapping (tree-sitter) | ✅ **Kabul — MVP Faz 3** | Developer AI token limitine takılmadan repo'yu navigate edemez, AST skeleton şart |
| Rate limit (Anthropic TPM/RPM + Jira) | ✅ **Kabul — MVP Faz 2** | 500 ticket/gün × 7 ajan limit'e çarpar, exponential backoff + token bucket |
| Branch protection + no force push | ✅ **Kabul — MVP Faz 3** | ai-assist modunda insan+AI aynı branch → force-push faciası riski |
| Context pruning (12b) | ✅ **Kabul — implementation note** | Retry'da önceki attempt özetlenir, tam geçmiş gönderilmez |
| LangFuse LLM observability | ⏭️ **v2** | Audit log + StepExecution MVP için yeterli, LangFuse ayrı service yükü |
| LangSmith | ❌ **Red** | Cloud-only, on-prem'i bozar |
| XState | ❌ **Red** | Temporal zaten state machine, duplikasyon antipattern |
| gVisor / Kata Containers | ⏭️ **v2 hardening** | Docker + seccomp + no-new-privs + non-root + read-only rootfs MVP için yeterli |
| Contract validation | ℹ️ **Zaten var (K15)** | Zod structured output |
| Jira adapter | ℹ️ **Zaten var (K10)** | DC öncelikli, Cloud v2 adapter |

**Eklenen karar:** K29 (rate limit), K30 (repo mapping), K31 (branch protection).
**Toplam süre etkisi:** +1.5 gün → ~9.5-10 hafta.

---

## 2. Workflow — 15 Adım

```
0.  Work Mode Seçimi       Jira label / routing
                           (full-auto / ai-assist / human-lead / human-only)
1.  Talep                  (Jira ticket)
2.  Talep Değerlendirme    AI  intake
2b. Clarification Loop     ◐   eksikse → reporter → SLA 72h
3.  Analiz                 AI  analyst → {analysisDoc, technicalDesign}
4.  Analiz Onayı           👤  PO
5.  Development Onayı      👤  Tech Lead (teknik tasarımı onaylar)
6a. Geliştirme             AI+👤 work mode'a göre
6b. Güvenlik Taraması      🤖  gitleaks + semgrep + trivy
6c. Dev Kontrol            AI+👤 dev-reviewer
7.  Test Senaryosu         AI  test-designer
8.  Senaryo 4-Göz          AI  test-reviewer
9.  Test Onayı             👤  QA
10. Test Koşumu            AI  test-runner
10b.CI Gate                🤖  Bitbucket Pipelines → kırmızıysa 6a
11. Test Sonuç Onayı       👤  QA
12. PR Onayı               👤  Tech Lead
12b.PR Yorum Döngüsü       ◐   "request changes" → 6a
    → DONE
```

Görsel için [workflow.png](diagrams/workflow.png) — yeşil ok = ilerleme, kırmızı kesik ok = red/loop, hexagon = insan kapısı, mavi = AI, mor = otomatik tarama.

---

## 3. 4 Work Mode

| Mod | Analiz | Kod | Review | Test Tasarımı | Test Koşumu |
|-----|--------|-----|--------|---------------|-------------|
| **full-auto** | AI | AI | AI | AI | AI |
| **ai-assist** | AI | 👤 (AI pair) | AI | AI | AI |
| **human-lead** | AI (opsiyonel) | 👤 | AI | 👤 | 👤 |
| **human-only** | 👤 | 👤 | 👤 | 👤 | 👤 |

Seçim: Jira label → `mode:full-auto` vb. veya project default. Workflow ortasında `/mode-change` ile değişir.

### Handoff Mekanizması
- **İnsan → AI:** `/ai-takeover`, `/ai-write-test`, `/ai-analyze`
- **AI → İnsan:** düşük confidence, bütçe aşımı, 2. ret → otomatik handoff signal

---

## 4. 7 AI Ajan + Knowledge Pack

### 4.1 Yapı

```
{role}/{variant}/
├── prompt.md           ← statik persona
└── knowledge/
    ├── rules/          ← zorunlu kurallar
    ├── conventions/    ← tercihler
    ├── domain/         ← iş bilgisi
    ├── examples/       ← few-shot
    └── glossary/       ← terimler
```

### 4.2 Her Ajan Variant'lanır

```
analyst:         mobile / web / backend
developer:       mobile / web / backend
dev-reviewer:    mobile / web / backend
test-designer:   mobile / web / backend
test-runner:     mobile / web / backend
test-reviewer:   (tek variant default)
intake:          (tek variant default)
```

### 4.3 Shared Knowledge Library
Ortak dosyalar (`refund-policy.md`, `accessibility.md`) bir yerde tutulur, birden çok variant'a **attach** edilir. Güncelleme tek yerden.

### 4.4 Repo Mapping (Yeni K30)
Developer AI'a 3 seviyeli bağlam:
1. **AST Skeleton** (tree-sitter ile) — class/method imzaları, prompt içinde
2. **Target Files** — değişecek dosyaların tam içeriği
3. **Tool-use** — gerekirse `grep`, `read_file` tool çağrıları (ephemeral sandbox içinde)

### 4.5 Prompt Caching
Cache key: `{variant_id}:{knowledge_hash}`. Maliyet: cache'li ~$100/gün, cache'siz ~$1000/gün (500 ticket × 7 ajan).

### 4.6 Knowledge Feedback Port (v2 Hazırlığı)
Merge sonrası diff (AI patch vs final) yakalanır, admin manuel knowledge'a ekleyebilir. Otomatik öneri v2'ye.

### 4.7 Agent Studio UI — 3 Sekme
1. **Persona** — prompt editor
2. **Knowledge** — dosya CRUD + shared library attach
3. **Test** — golden ticket eval (prompt/knowledge değişiminin regresyonunu ölçer)

### 4.7.1 Agent Eğitim ve Yönetim Akışı

**7 Adımlık Lifecycle:**
1. Admin → Agent Studio login
2. Variant seç (örn. `mobile-analyst`)
3. Knowledge sekmesinde dosya ekle/düzenle (Tiptap markdown + dnd-kit tree)
4. "Save Version" → `PromptVersion` **immutable** kaydı (v3)
5. Test sekmesinde golden ticket üzerinde **v2 vs v3 diff + LLM-as-judge** karşılaştır
6. Promote → `activeVersionId = v3` + Redis cache invalidate + audit log
7. Runtime: yeni ticket'lar v3 alır, çalışan workflow'lar kendi versiyon'uyla biter

**Safety:**
- Immutable versions (değiştirmek için yeni versiyon)
- 1-tık rollback (activeVersionId geri çevir)
- Running workflow koruması (kendi versiyon'unu bitirir)
- RBAC (admin / team-lead / viewer)
- Hash-chained audit log

**Persistence:**
- Metadata → PostgreSQL (`agent_variants`, `prompt_versions`, `knowledge_files`, `variant_knowledge_links`, `routing_rules`, `evaluations`, `audit_log`)
- Dosya içeriği → MinIO (`knowledge/{variant_id}/{version}/...`)
- Cache → Redis (`cache:{variant_id}:{knowledge_hash}`)

---

## 4.7.5 Ölçeklenebilirlik ve Concurrency

### Hedef: 100 Eş Zamanlı Ticket

Mimari stateless worker + role bazlı queue + durable workflow kombinasyonu ile bu ölçeği karşılar. Anahtar bileşenler:

| Bileşen | Ölçek Stratejisi |
|---------|------------------|
| API | Stateless, yatay replikasyon (docker compose scale api=N) |
| Worker | Role bazlı task queue (intake/analyst/developer/...), her rol bağımsız scale |
| Sandbox pool | Max concurrent N (default = CPU_cores / 4), aşım → Temporal activity retry |
| Claude API | Token bucket (TPM/RPM per-model) + exponential backoff + backpressure |
| Bitbucket | Per-user rate bucket + backoff |
| Temporal | Postgres backend, connection pool tuning, sticky queue |
| Postgres | Connection pool = sum(worker_max_concurrent) × 1.5 |

### Backpressure Akışı

Rate limit hit → Temporal activity fail → retry with longer delay → workflow **Jira yorumu** ile "queued, waiting capacity" bildirimi gönderir. Sessiz bekleme yok.

### Ölçek Reçetesi (MVP)

```bash
# Small: 10 ticket/gün
docker compose up -d

# Medium: ~100 ticket/gün
docker compose up -d --scale worker-developer=3 --scale worker-analyst=2

# Large: ~500 ticket/gün
docker compose up -d --scale worker-developer=8 --scale worker-analyst=5 \
  --scale worker-test-runner=4
```

K8s Helm chart ile HPA → v2.

---

## 4.8 Developer Runtime Environment (Sandbox)

### Temel Yaklaşım: BYO Image + Repo Config

Monolitik "her stack'i içeren" sandbox yerine: müşteri kendi **Bitbucket Pipelines image'ını kullanır**, repo kökündeki `.orkestra.yaml` ile komutlar/dep'ler tanımlanır. Tek doğruluk kaynağı, tek bakım.

### `.orkestra.yaml` (Repo Kökünde)

```yaml
language: node
sandbox_image: node:20-alpine          # Bitbucket Pipelines image'ı ile aynı
clone_depth: 50

commands:
  install:          "npm ci"
  lint:             "npm run lint"
  build:            "npm run build"
  test_unit:        "npm test"
  test_integration: "npm run test:int"
  coverage:         "npm run coverage"

test_dependencies:
  - postgres:16
  - redis:7

cache_paths:
  - node_modules
  - ~/.npm

env_secrets:                           # Vault'tan inject
  - DATABASE_URL

coverage_threshold: 70
```

### Sandbox İçinde Akış

```
1. Ephemeral container başlat (customer's image)
2. git clone --depth 50, pinned base commit
3. checkout -b feature/JIRA-XXX
4. install (cache'li)
5. AI patch üretir → git apply
6. lint → build → test_unit
7. docker-compose up test_dependencies
8. test_integration → coverage gate
9. ✅ → commit + push  |  ❌ → loglar AI'a geri (bounded retry)
10. Container imha (TTL 1h)
```

### Sandbox ≠ CI Gate

| Kapı | Ne | Amaç |
|------|-----|------|
| **Sandbox** (6a içinde) | lint + build + unit + integration + coverage | AI self-check, hızlı |
| **CI Gate (10b)** Bitbucket Pipelines | Tam build + unit + integration + e2e + müşteri check'leri | Gerçek doğruluk |

İkisi de yeşil olmak zorunda.

### Dep Cache

`{repo}:{lockfile_hash}` keyed persistent volume. Lockfile değişmedikçe `node_modules` hazır. 500 ticket/gün × 5-10 dk tasarrufu → **~80 saat/gün** compute.

### Network Allow-list
- Paket registry'leri (npmjs, pypi, maven, ...)
- Müşterinin internal registry'si
- Bitbucket (scoped token)
- Claude API (tool-use proxy üzerinden)
- **Kalan tüm internet: deny** (data exfil koruma)

---

## 4.9 PII / Veri Sınırı (Compliance)

### Problem
Jira ticket'ı kullanıcı datası içerebilir (email, TC, telefon, kart no kısmi, müşteri ismi). Ham ticket Claude'a gönderilirse **müşterinin veri sınırı ihlal edilir** → regülasyonlu sektör (finans, sağlık, kamu) reddeder.

### Çözüm (MVP)

1. **PII Masking Layer** — LLM çağrısı öncesi input preprocessing
   ```yaml
   # Agent Studio'da config
   pii_masking:
     enabled: true
     fields:                              # Jira custom field'lar
       - customer_email:  "hash"          # user@x.com → usr_a3f2@x.com
       - customer_name:   "redact"        # Ayşe Y. → [REDACTED]
       - phone:           "partial"       # +905xx... → +905xx***
     patterns:                            # serbest metin regex
       - tc_kimlik:       "[0-9]{11}"
       - credit_card:     "[0-9]{13,16}"
   ```

2. **Reverse mapping** — maskelenen değerler local DB'de tutulur; AI çıktısında `[REDACTED]` dönerse workflow son teslimde yerine koyabilir (opsiyonel).

3. **Audit log** — hangi alanlar maskelendi kaydedilir.

4. **Opt-out per variant** — bazı variant'lar ham data görmeyi gerektirebilir (örn. `compliance-analyst`), admin explicit opt-out verir.

### v2
- On-prem LLM adaptörü (K13) zaten var — air-gapped müşteri Claude'a hiç data göndermez.
- Differential privacy katmanı.

---

## 5. Jira Entegrasyonu

### 5.1 Kullanıcı/Rol Haritası
| Rol | Jira'dan |
|-----|----------|
| PO | Reporter veya custom field `po_approver` |
| Tech Lead | Custom field `tech_lead` |
| QA | Custom field `qa_lead` veya Component owner |
| Backup | Delegation chain veya `backup_*` custom field |

### 5.2 Status Transition
Her workflow adımı Jira status'una map'lenir (`AI Analyzing`, `Waiting for PO`, `AI Coding`, `CI Running`, ...). Status isimleri configurable.

### 5.3 Jira Komut Seti (Yorum)

| Komut | Kim | Etki |
|-------|-----|------|
| `/approve` · `/reject` · `/cancel` | Onay kapısındaki kişi | Workflow kararı |
| `/ai-analyze` · `/ai-write-test` · `/ai-explain` | Dev | Ajan tetikle |
| `/ai-takeover` · `/ai-handoff` | Dev / AI | Mode geçişi |
| `/mode-change <mode>` · `/retry` | Tech Lead | Yönetsel |
| `/status` | Herkes | Durum özeti |

---

## 6. Temel Kararlar (Tümü Kilitli)

| # | Karar | Neden |
|---|-------|-------|
| K1 | Temporal (self-hosted) | Durable execution + SLA + retry |
| K2 | TypeScript monorepo (pnpm + Turborepo) | Tek dil |
| K3 | PostgreSQL | Tek RDBMS |
| K4 | Redis | SLA timer, rate limit coalesce |
| K5 | MinIO | On-prem object storage |
| K6 | Vault | Secret yönetimi |
| K7 | Claude (Opus / Sonnet / Haiku) | Role göre model |
| K8 | Ephemeral Docker sandbox | On-prem izole runtime |
| K9 | Single-tenant | Tek kurulum = tek müşteri |
| K10 | Jira DC/Server | Cloud v2 |
| K11 | Git adapter — MVP = **Bitbucket** | GitHub/GitLab v1.1 |
| K12 | Lisans yok | Kullanıcı talebi |
| K13 | Knowledge Pack (variant + shared library) | Ajan eğitimi |
| K14 | Prompt caching zorunlu | Cost koruma |
| K15 | Structured output (Zod) | Inter-agent contract |
| K16 | İmzalı audit log (hash chain) | Tamper-proof |
| K17 | Per-workflow cost budget ($5 default) — **arka planda**, admin dashboard'a görünür; günlük kullanıcıya (PO/TL/QA) gösterilmez | Runaway cost, kullanıcı deneyimini kirletmeden |
| K18 | Workflow kullanıcıları = Jira'dan | Tek doğruluk |
| K19 | Agent Studio admin = lokal tablo | Minimum auth |
| K20 | SLA = Jira due date (varsa) else 24/48/72h | Ticket bazlı |
| K21 | Backup person = Jira delegation | İnsan yok ise |
| K22 | 4 Work Mode | Paylaşımlı çalışma |
| K23 | Handoff signal'leri (iki yönlü) | Mid-workflow geçiş |
| K24 | Jira status auto-transition | Takım visibility |
| K25 | CI Gate (10b) — Bitbucket Pipelines | Gerçek kalite kapısı |
| K26 | Branch `feature/JIRA-XXX` + `[AI]` prefix + `Co-Authored-By: Claude` | Standart + attribution |
| K27 | Human PR review opt-in | dev-reviewer insan PR'ları için |
| K28 | Knowledge feedback port | v2 öğrenme altyapısı |
| K29 | **Rate limit: Anthropic TPM/RPM + exponential backoff + circuit breaker** | 500 ticket/gün burst koruması |
| K30 | **Repo mapping: tree-sitter AST skeleton + tool-use** | Developer AI token/cost kontrolü |
| K31 | **Branch protection: no force-push + AI always rebase** | ai-assist modunda race koruma |
| K32 | **`.orkestra.yaml`** — repo-level runtime config | Her projenin build/test komutları standart |
| K33 | **BYO Sandbox Image** — müşteri Bitbucket Pipelines image'ını kullanır | Monolitik image şişmesin, tek bakım |
| K34 | **Persistent Dep Cache** — `{repo}:{lockfile_hash}` keyed volume | 500 ticket/gün için performans şart |
| K35 | **Sandbox self-check ≠ CI Gate** — sandbox hızlı, Pipelines authoritative | Hızlı feedback + gerçek doğruluk |
| K36 | **Network allow-list** — registry + Bitbucket + Claude, kalan deny | Data exfil koruması |
| K37 | **Horizontal scaling (docker compose scale / K8s replicas)** — stateless worker, role bazlı bağımsız ölçek | 100+ eş zamanlı ticket |
| K38 | **Sandbox capacity pool** — max concurrent sandbox (default CPU/4), üstü Temporal activity retry'a | Container patlaması önler |
| K39 | **Backpressure** — Claude/Bitbucket rate limit hit → Jira'ya "queued, waiting" bildirimi + Temporal sleep | Sessiz bekleme yok, şeffaflık |
| K40 | **PII maskeleme** — Jira alan bazında regex/field config, LLM'e masked içerik gider | Regülasyonlu müşteri + compliance |
| K41 | **Workflow cleanup** — `/cancel` veya fail → sandbox kill + branch kaldır + Jira status "Cancelled" | Kirli state kalmasın |
| K42 | **Bitbucket rate limit awareness** — per-user/app bucket, bu da K29 ile birlikte | Bitbucket DC de limit koyabilir |
| K43 | **Agent Studio tabanı = Refine** + shadcn/ui + Tiptap + Monaco + dnd-kit + NextAuth | Sıfırdan yazmak yerine 10 gün kazanç |
| K44 | **Dil kararı teyit: TypeScript** — Python'a geçiş değerlendirildi, reddedildi | Temporal TS SDK first-class, Forge Node, Next.js API+UI birleşik, Zod end-to-end type safety |
| K45 | **Zengin ADF yorum formatı** (başlık, tablo, kod bloğu, liste) — düz metin değil | Okunabilir AI çıktısı Jira içinde |
| K46 | **"AI Workflow Detail" custom URL field** — her ticket'ta Agent Studio deep-link | Tam panel için Jira'dan tek tıkla geçiş |
| K47 | **Her adımda özet bot yorumu** (durum + sorumlu + SLA + komutlar) | Ticket'a bakan anında durum görür |
| K48 | **Komut doğrulama** (yetki + state + typo + idempotency) | Yanlış kullanım koruması |
| K49 | **Hibrit UX onayı** — Jira yorum (komut) + ADF (içerik) + Workflow Detail link (derinlik) + bot özet (durum). Bütçe/token arka planda, kullanıcı görmez | Sağlıklı günlük deneyim, cluttered olmayan arayüz |

---

## 7. MVP'de Olan / Olmayan

### ✅ MVP'de VAR
- 15 adımlık workflow (0, 2b, 5b, 10b, 12b dahil)
- 4 work mode + handoff
- 7 AI ajan (variant'lı) + Knowledge Pack + shared library + prompt caching
- Agent Studio UI (persona + knowledge + eval)
- 6 insan onay kapısı + 11 Jira komutu
- Jira DC entegrasyonu (user read + status transition + comments)
- Bitbucket + Pipelines CI gate + human PR review opt-in
- Slack bildirim + TestRail/Xray
- SLA timer (Jira due date) + backup person routing
- 4-göz kuralı, test pyramid, coverage gate, flaky detection, bounded retry
- Per-workflow cost budget
- **Rate limit + backoff (Anthropic + Jira)**
- **Repo mapping (tree-sitter AST + tool-use)**
- **Branch protection + no force push**
- gitleaks + semgrep + trivy
- Pinned base commit + auto rebase
- Ephemeral Docker sandbox (non-root, network-isolated, read-only rootfs)
- **Developer runtime: `.orkestra.yaml` + BYO image + dep cache + sandbox self-check**
- **Horizontal scaling (docker compose scale) — 100+ eş zamanlı ticket desteği**
- **Sandbox capacity pool + backpressure (Claude/Bitbucket rate limit şeffaflığı)**
- **PII masking layer (Jira alan + regex bazlı)**
- **Workflow cleanup (cancel/fail sonrası sandbox + branch + Jira temizliği)**
- İmzalı audit log (hash chain)
- Vault secret, Knowledge feedback port (manuel)
- Docker Compose kurulum + install wizard + health endpoint + structured log

### ❌ MVP'de YOK (v2'ye)
- Çoklu Git (GitHub/GitLab)
- SSO (OIDC/SAML)
- Full observability stack (Prometheus/Grafana/Loki/LangFuse)
- Helm chart / K8s
- Air-gap paketleme
- gVisor/Kata hardening
- Prompt versioning UI diff viewer
- Upgrade/migration otomasyonu
- Backup/restore scripts, diag CLI
- Multi-tenant, lisans sistemi
- Knowledge feedback otomatik işleme
- Non-code ticket routing
- Breaking change özel onayı
- Multi-repo ticket
- Rollback / post-merge monitoring
- Compliance tier
- Personal knowledge pack
- Dispute resolution
- Epic-level workflow

---

## 8. Mimari

```
  Jira (DC) ──webhook──►  API  ──►  Temporal  ──►  Worker Pool (role bazlı)
    ▲                      │                         │
    │  status               ▼                         ▼
    │  transition       Postgres                 Claude API
    │  + yorum          Redis ◄──── Knowledge ──► (cache'li, tek dış)
    │  komutları        MinIO        Pack             │
    ▼                   Vault                         ▼
  komutlar                                      Dev Sandbox
                                           (ephemeral Docker)
                                                      │
                                                      ▼
                                                  Bitbucket
                                                      │
                                                      ▼
                                              Bitbucket Pipelines
                                                      │
                                                      ▼
                                                    Slack
```

---

## 9. 7 AI Ajan — Sözleşmeler

| Ajan | Girdi | Çıktı | Model | Knowledge |
|------|-------|-------|-------|-----------|
| intake | Ticket | `{complete, missingFields, questions, workMode}` | Haiku | template rules |
| analyst | Ticket + AST skeleton | `{analysisDoc, technicalDesign, risks, AC}` | Opus | domain + conventions + examples |
| developer | Analiz + tasarım + AST + target files | `{patch, filesChanged, explanation, prDescription}` | Opus | coding standards + architecture |
| dev-reviewer | Patch + analiz | `{verdict, comments, breaking, severity}` | Opus | review checklist |
| test-designer | Analiz + patch | `{scenarios[]}` | Opus | test strategy |
| test-reviewer | Senaryolar | `{verdict, coverage, missing}` | Sonnet | coverage rules |
| test-runner | Senaryolar + repo | `{results, coveragePct, flaky[]}` | Sonnet | - |

---

## 10. Kontrol Matrisi

| Kontrol | Nasıl |
|---------|-------|
| SLA | Temporal timer + Jira due date + hatırlatıcı |
| Backup person | SLA timeout → delegation chain → mimar |
| 4-göz | Workflow hard check |
| Test pyramid | test-reviewer enforce |
| Coverage gate | %70 altı → test-designer |
| Flaky | 3 koşu, 2 sonuç → insan |
| Bounded retry | Temporal max 1 |
| Secret | Vault link, plain asla |
| Cost budget | %80 uyarı, %100 stop |
| **Rate limit** | Token bucket + exponential backoff + circuit breaker |
| Merge conflict | Pinned base + auto rebase + fail → developer AI |
| PR comment loop | Bitbucket webhook → 6a signal |
| Eskalasyon | 3. ret → mimar |
| `/cancel` | Global signal |
| Audit | Hash-chained, imzalı |
| Güvenlik | gitleaks + semgrep + trivy |
| Sandbox | Ephemeral Docker + seccomp + no-new-privs + non-root + read-only + network-isolated |
| CI Gate | Bitbucket Pipelines, red → 6a |
| Human PR review | Opt-in per repo |
| **Branch protection** | no force push + AI always rebase |

---

## 11. Zaman Planı

| Faz | Ne | Süre |
|-----|----|------|
| **0** | Proje iskelet, Docker Compose, Temporal + Postgres + Redis + MinIO + Vault | 2 gün |
| **1** | Workflow iskeleti (15 adım mock) + Jira webhook + signal'ler + clarification loop + status transition | 2 hafta |
| **2** | 7 AI ajan (Claude + structured output) + analyst 2'li çıktı + Knowledge Pack runtime + prompt caching + **rate limit + backoff** | 2 hafta |
| **3** | Developer AI + ephemeral sandbox + **`.orkestra.yaml` parser** + **BYO image runtime** + **dep cache volume** + **test deps via docker-compose** + Bitbucket adapter + güvenlik (gitleaks/semgrep/trivy) + pinned base + auto rebase + branch/commit attribution + tree-sitter repo mapping + branch protection | 2.5 hafta |
| **4** | İnsan kapıları + 4 work mode + handoff + Jira komut seti + SLA + backup + cost budget + PR comment loop + Slack | 2 hafta |
| **5** | Test ajanları + TestRail/Xray + coverage gate + flaky detection + CI Gate + human PR review | 1.5 hafta |
| **6** | Agent Studio (**Refine + shadcn + Tiptap + Monaco + dnd-kit**) — variant + Knowledge Pack + shared library + routing + eval + knowledge feedback port + audit log hash chain | 1 hafta |
| **7** | Docker Compose paket + install wizard + runbook + demo data | 3 gün |

**Toplam: ~10 hafta** (1 kişi) — Refine ile Faz 6 kısaldı. Her faz sonunda demo + onay.

### Ek İşler (fazlara dağıtılmış)
- **Faz 2:** PII masking layer (+1 gün), Claude backpressure (+0.5 gün)
- **Faz 3:** Sandbox capacity pool (+0.5 gün), Bitbucket rate limit (+0.5 gün)
- **Faz 4:** Workflow cleanup activity (+0.5 gün)
- **Faz 7:** Horizontal scaling dokümantasyonu + default compose override files (dahil)

---

## 12. Atlassian Marketplace Uyumu (Gelecek)

Bugün kod etkisi yok, ama kararlar bu hedefe uyumlu:
- Single-tenant model → marketplace app olarak paketlenebilir
- REST-first API → Forge / Connect adaptasyonu sonraya
- Jira custom field tabanlı konfig → native look & feel
- OAuth-ready auth → SSO v2'de eklenir

**v2+:** Forge module, Marketplace listing, Cloud adapter.

---

## 13. Değerlendirildi — Reddedildi (Kayıt)

Başka önerilerin tekrar gelmemesi için:

### Mimari
- **Sim AI / Flowise / Langflow / n8n:** Görsel workflow builder. Bizim workflow sabit (Temporal), kullanıcı canvas kurmuyor. İkinci bir executor = duplikasyon, framework yükü, yanlış UX mesajı.
- **XState:** Temporal zaten state machine, duplikasyon.
- **LangSmith:** Cloud-only, on-prem'i bozar.
- **LangFuse (MVP):** v2'ye; entegrasyon noktası hazır.
- **gVisor/Kata:** v2 hardening.
- **E2B sandbox:** Cloud, on-prem'i bozar.
- **Sentry Cloud / Inngest Cloud:** Hepsi SaaS.
- **LangGraph + Temporal:** Duplikasyon.

### Dil
- **Python / FastAPI:** Değerlendirildi, reddedildi.
  - Temporal TS SDK Python'dan ilerde
  - Atlassian Forge = Node.js (marketplace yolu)
  - Next.js API+UI colocation avantajı kaybolur
  - Zod end-to-end type safety çift bakıma dönüşür
  - ML/RAG/fine-tune gereksinimi yok, Python ekosistem avantajı moot

### Admin UI Framework
- **Directus:** Ürün için uygun değil.
- **ToolJet:** Ürün için uygun değil.
- **Strapi:** Ürün için uygun değil.
- **Retool:** Proprietary, embed edilmez.
- **Appsmith:** Lowcode, ihtiyacımıza fazla.

---

## 14. Çalışma Kuralları — Otonom Mod

### 14.1 Başla Öncesi
- Kullanıcı **"başla"** demeden tek satır kod yazılmaz.
- Plan değişikliği için onay alınır.

### 14.2 Başla Sonrası — Otonom Yürütme
- **Durak yok.** Faz 0 → Faz 7 ara vermeden yürütülür.
- **Ara onay yok.** "Şunu yapayım mı?" sorusu sormam.
- **Ara demo yok.** Her faz sonunda ayrı bildirim yok.
- **Ara soru yok.** Belirsizlikte en savunulabilir kararı alırım, final rapora not ederim.
- **Kod + entegrasyon + test + dokümantasyon** hepsi tek uçuşta.
- **Kesinti sadece:** (a) kritik güvenlik kararı, (b) geri dönüşü olmayan yıkıcı işlem, (c) planda açık çelişki.

### 14.3 Belirsizlik Anında Karar Prensibi
1. Planda yazan → aynen uygula
2. Planda yazmıyorsa → MVP VAR/YOK listesine göre karar ver
3. Hiçbiri net değilse → en basit + en az bakım yükü + best-practice seçenek. Rapora gerekçesiyle yaz.

### 14.4 Yıkıcı İşlem Yasakları (Otonom modda bile)
- `git push --force` (K31)
- DB drop / reset (migration hariç)
- Plain-text secret commit
- Planda olmayan proprietary/external SaaS bağımlılığı
- Plan dışı mimari sapma

### 14.5 Final Rapor Formatı
Proje bittiğinde tek mesajda:

1. **Özet** — Ne yapıldı, ne çalışıyor
2. **Kurulum** — `docker compose up` adımları
3. **Test durumu** — Her bileşen green/yellow/red
4. **Dosya haritası** — Monorepo yapısı
5. **Konfigürasyon** — Env var + secret listesi
6. **Verdiğim kararlar** — Belirsizliklerde alınan karar + gerekçe
7. **Bilinen eksikler** — MVP YOK + ek tespit
8. **İlk müşteri kurulum adımları** — Jira/Bitbucket/Claude entegrasyonu
9. **v2 öncelik önerileri**

---

## 15. Son Checklist — "Hazır"

- [x] Tüm açık sorular kapandı
- [x] Tüm geri bildirimler değerlendirildi
- [x] Mimari kilitli (44 karar)
- [x] Workflow görseli hazır ([diagrams/workflow.png](diagrams/workflow.png))
- [x] Sistem diyagramı hazır ([diagrams/system.png](diagrams/system.png))
- [x] UI wireframe hazır ([diagrams/ui_mockup.png](diagrams/ui_mockup.png))
- [x] MVP VAR/YOK listesi net
- [x] ~10 haftalık plan hazır
- [x] **Otonom mod protokolü tanımlı**
- [ ] **Kullanıcı "başla" diyecek**

**Başla** → Faz 0'dan Faz 7'ye kadar tek uçuşta tüm proje bitirilir, **final rapor** sunulur.
