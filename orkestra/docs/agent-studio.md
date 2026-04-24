# Agent Studio

Admin UI: http://localhost:3001 (prod'da ayrı host)

## Ekranlar

### Dashboard
Aktif / bekleyen / bloklu / bugün bitmiş workflow sayıları + en son ticket tablosu.

### Variants
7 rol (intake, analyst, developer, dev-reviewer, test-designer, test-reviewer, test-runner) × domain variant (mobile, web, backend). Her variant için active/passive toggle.

### Variant Detay (3 sekme)

**1. Persona** — Monaco editor ile system prompt. Model (Opus/Sonnet/Haiku) seçimi, temperature, max_tokens. Kaydet → yeni immutable `PromptVersion`. Promote butonu → aktif versiyonu değiştir.

**2. Knowledge** —
- Sol: klasör ağacı (rules, conventions, domain, examples, glossary) + dnd-kit sortable
- Sağ: Tiptap markdown editor
- "+ Dosya" — yeni dosya ekle (kategori seç)
- "🔗 Attach" — paylaşılan kütüphaneden dosya bağla
- Dosya versiyonu otomatik (save edildiğinde hash değiştiyse bump)

**3. Test (Eval)** — Golden ticket seçerek yeni prompt + knowledge kombinasyonunu eski ile karşılaştırma. Diff view + LLM-as-judge skoru. Regresyon denetimi için şart.

### Shared Library
Variant'lar arası paylaşılan dosyalar (örn. `refund-policy.md`, `accessibility-rules.md`). Değişiklik attach'li tüm variant'ları etkiler.

### Routing Rules
Jira label/component/project → variant eşleştirmesi. Priority sıralı (düşük = önce).

### Workflows
Aktif ve geçmiş workflow'lar. Detay için tıkla:
- Timeline (step-by-step)
- Her adımın AI çıktısı (markdown render)
- Human decisions
- Audit entries
- Aksiyonlar: Cancel, Retry, Mode change

### Audit
Hash-chain'li kayıt. "Verify Chain" butonu ile tamper kontrolü.

### Settings
- Jira / Bitbucket / Claude bağlantı konfigürasyonu
- PII masking alanları + regex kuralları
- SLA default süreleri
- Cost budget
- Admin kullanıcı yönetimi

## Variant Eğitim Akışı

```
1. Admin → Variant seç (örn. mobile-analyst)
2. Knowledge sekmesinde dosya ekle/düzenle
3. Save → PromptVersion v(n+1) oluşur (immutable)
4. Test sekmesinde golden ticket'larda v_eski vs v_yeni karşılaştır
5. Promote → activeVersionId güncellenir
6. Yeni ticket'lar v_yeni ile çalışır; running workflow'lar v_eski bitirir
```

## Knowledge Feedback

Merge sonrası AI patch ile final merge arasındaki diff **Knowledge Feedback** sekmesinde görünür. Admin manuel inceleyip `examples/lesson-learned-{ticket}.md` olarak ekleyebilir (otomasyon v2).

## RBAC

- **Admin** — tüm CRUD + promote
- **Team Lead** — kendi domain'inin variant'ları + routing
- **Analyst** — sadece okuma
- **Viewer** — sadece dashboard + workflow okuma

## Shortcut İpuçları

- **Ctrl+S** (Persona / Knowledge editor) → yeni versiyon kaydet
- **/** global search (workflow ID, ticket key)
