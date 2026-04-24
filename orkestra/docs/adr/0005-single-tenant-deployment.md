# ADR-0005: Single-Tenant On-Prem Deployment

## Status
Accepted — 2026-Q1

## Context
Hedef müşteri segmenti (orta-büyük kurumsal yazılım ekipleri) kendi kaynak
kodunu, Jira verisini ve PR'larını üçüncü parti bir SaaS'a göndermek
istemiyor. Pek çoğu regüle sektörde (finans, telekom, savunma). Veri
ikameti ve audit gereksinimleri SaaS multi-tenant modelini dışlıyor.

## Decision
Orkestra **single-tenant, on-prem** olarak dağıtılır. Her müşteri kendi
stack'ini (Postgres, Temporal, MinIO, Redis, API, worker, studio)
`docker compose` veya Helm chart ile ayağa kaldırır. Üretici tarafında
merkezi bir tenant veritabanı **yoktur**. Telemetri yalnızca opt-in ve
hash'lenmiş sayaç düzeyindedir.

## Consequences
- (+) Müşteri verisi kendi perimetresinde kalır; uyum (KVKK, GDPR, ISO 27001)
  kolaylaşır.
- (+) Failure blast-radius bir müşteri ile sınırlıdır.
- (+) Versiyon yükseltmesi müşteri kontrolünde — enterprise satış modeline uygun.
- (+) Multi-tenant izolasyon kodu yazmak zorunda değiliz; attack surface küçük.
- (−) Her müşteriye ayrı ops → release, destek ve diag yükü artar.
- (−) Feature flag / A/B test merkezi değil; pack + variant katalog ile çözülür.
- (−) Ücretlendirme "kullanım bazlı" yerine "seat + support tier" olur.

## Alternatives considered
- **Multi-tenant SaaS** — hedef segment veri hassasiyeti nedeniyle dışlıyor.
- **"Bring your own cloud" (BYOC)** — hâlâ bizim kontrol düzlemimizi gerektirir;
  on-prem müşteriler için çözüm değil.
- **Hybrid (kontrol düzlemi SaaS, veri düzlemi on-prem)** — ileride
  değerlendirilebilir; MVP kapsamı dışı.

## References
- `plan/projectplan.md` → **K9** (deployment modeli)
- `docs/install.md` — kurulum
- `docs/runbook.md` — backup / upgrade / scale
- ADR-0003 (sandbox on-prem gereksinimi buradan geliyor)
