# ADR-0004: Variant Başına Knowledge Pack (RAG Yok)

## Status
Accepted — 2026-Q1

## Context
7 ajan × N projede her biri farklı kodlama stili, domain bilgisi, test
beklentisi ister. LLM'e her seferinde full repo göndermek mümkün değil ve
RAG (embedding + vector store) eklemek operatör tarafında yeni bir altyapı
bileşeni, tuning yükü ve tutarsızlık kaynağı yaratır. Bilgi miktarı (≤ 200 KB
civarı prompt'a sığan, editoryal olarak taranmış) sınırlı tutulabiliyor.

## Decision
Her variant'a **statik, versiyonlu, insan-editoryal Knowledge Pack**
bağlanır. Pack; code conventions, domain jargon, örnek PR'lar, anti-pattern
listesi içerir. Prompt inşasında pack tamamen (veya templated subset olarak)
enjekte edilir. Vector store / embedding kullanılmaz.

## Consequences
- (+) Deterministik prompt — aynı input + variant + pack sürümü = aynı çıktı
  davranışı (caching'e uygun).
- (+) Prompt cache hit-rate yüksek; maliyet öngörülebilir.
- (+) Operatör yalnızca markdown/yaml editler; yeni altyapı yok.
- (+) Güvenlik denetimi basit: pack içeriği audit'lenebilir.
- (−) Bilgi hacmi büyürse token bütçesi baskılanır → pack'i bölmek + routing
  ile variant seçimi gerekir.
- (−) Dinamik "son 50 PR'ı öğren" senaryosu bu modelde yok; ayrı batch job
  ile pack güncellenir.

## Alternatives considered
- **Klasik RAG (pgvector / Qdrant)** — altyapı ve tuning maliyeti MVP için
  yüksek; deterministiklik kaybı.
- **Fine-tuning** — müşteri verisi, maliyet ve API kısıtları nedeniyle dışarıda.
- **Her ajan için tek global knowledge base** — variant'lar arası çakışma;
  proje-özel ince ayar imkansız.

## References
- `plan/projectplan.md` → **K13** (bilgi modeli), **K43** (variant katalog)
- `docs/agent-studio.md` — pack yönetimi UI
- ADR-0001 (Temporal determinism ile uyumlu)
