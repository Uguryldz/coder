# Güvenlik Politikası / Security Policy

Jira AI Orkestra single-tenant, on-prem çalışan ticari bir üründür. Güvenliği
ciddiye alıyoruz; bulunan zafiyetlerin sorumlu biçimde açıklanmasını önemsiyoruz.

## Desteklenen Sürümler / Supported Versions

Güvenlik güncellemeleri yalnızca aşağıdaki sürümler için yayınlanır:

| Sürüm | Destek Durumu | Notlar |
|-------|---------------|--------|
| 0.1.x | Aktif (MVP) | Tüm güvenlik fix'leri |
| < 0.1 | Desteklenmiyor | Pre-MVP iç sürümler |

Genel kural: en son minor sürüm + bir önceki minor sürüm desteklenir.
LTS sürümler ayrıca bir ticari destek sözleşmesi kapsamında tanımlanır.

## Zafiyet Bildirimi / Reporting a Vulnerability

**Lütfen zafiyetleri public issue tracker'da AÇMAYIN.**

E-posta: **security@<company>.tld** — `<placeholder>`
PGP Fingerprint: `<PLACEHOLDER — 0000 0000 0000 0000 0000  0000 0000 0000 0000 0000>`
PGP Key URL: `https://<company>.tld/.well-known/security.asc` — `<placeholder>`

Bildiriminizde lütfen bulundurun:

- Etkilenen bileşen (ör. `packages/sandbox`, `apps/api`, `apps/studio`)
- Sürüm / commit hash
- Zafiyetin tekrarlanabilir adımları (PoC varsa ek olarak)
- Beklediğiniz etki (CVSS 3.1 puanı önereceğiniz varsa değerli olur)
- Ekranda görünen PII varsa, maskeleyin veya ayrı şifreli kanalda iletin

## Cevap SLA / Response SLA

| Aşama | Süre |
|-------|------|
| İlk teyit (acknowledgement) | **72 saat** içinde |
| Etki değerlendirmesi ve triage | **7 gün** içinde |
| Fix veya azaltım (mitigation) | **30 gün** hedef (kritik: 7 gün) |
| Koordineli açıklama | Fix sonrası 30 gün embargo, karşılıklı anlaşma ile |

Kritik (CVSS ≥ 9) zafiyetler için ekip 24 saat içinde cevap verir ve mümkünse
out-of-band hotfix yayınlar.

## Kapsam / Scope

**Kapsamda (in-scope):**

- Bu monorepo altındaki tüm kod: `apps/*`, `packages/*`, `scripts/*`
- `deploy/` altındaki resmi Docker / Compose konfigürasyonları
- Yayınlanan Docker imajları (`ghcr.io/<org>/orkestra-*`)
- Operatör-görünür UI'lar (Agent Studio), webhook endpoint'leri, API yüzeyi
- Sandbox izolasyon modeli, PII maskeleme, audit chain bütünlüğü

**Kapsam dışı (out-of-scope):**

- Müşterinin kendi Jira / Bitbucket / Confluence / Slack instance'ları
- Müşterinin Kubernetes / Docker altyapısının yanlış yapılandırılması
- Claude API'nin kendisi (Anthropic'e bildirilmeli)
- Üçüncü parti bağımlılıklar (yukarı akışa bildirilmeli; biz de koordine ederiz)
- Sosyal mühendislik, fiziksel güvenlik, DoS (L7 hariç)
- Otomatik tarayıcılardan (Nuclei, OWASP ZAP default) gelen düşük-sinyal raporlar

## Paylaşılabilir Artefaktlar / Safe-to-Share Artifacts

Destek talebi veya güvenlik raporu gönderirken aşağıdakileri paylaşmak
güvenlidir (PII / secret barındırmadığı doğrulandığı sürece):

- `orkestra-diag` çıktısı (araç yayınlandığında; secret redaksiyonu built-in)
- `docker compose logs` çıktısı — **PII / secret redaksiyonu yapıldıktan sonra**
- Temporal workflow history export (sensitive input alanları maskelenmiş)
- `audit.log` zincirinin hash'leri (içerik değil)
- Prometheus metrikleri (label cardinality farkında)

Asla paylaşmayın: `.env`, `.env.local`, `deploy/secrets/`, müşteri Jira
ticket gövdeleri, kaynak kod sızıntısı içeren log satırları.

## Güvenlik Özellikleri / Security Features

Bu üründe hâlihazırda bulunan kontroller:

- Hash-chain'li immutable audit log (`packages/audit`)
- Ephemeral Docker sandbox (`packages/sandbox`) — no-network default
- PII maskeleme pipeline'ı (`packages/pii`) — LLM'e gitmeden önce uygulanır
- Tek dış çıkış noktası: Claude API (ve opsiyonel olarak devre dışı bırakılabilir)
- Secret yönetimi: env-based, `.env` repo'ya commit edilmez
- Agent Studio için RBAC
- Rate limiter + prompt cache tarafında tenant izolasyonu

## Ödül / Bounty

Şu an resmi bir bug bounty programımız yoktur. Saygın, koordineli açıklamaya
uyan araştırmacılara takdirimiz ve ürün içi "Security Hall of Fame" sayfasında
(yayınlandığında) atıf sunarız.
