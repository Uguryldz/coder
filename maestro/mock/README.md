# Maestro — UI Prototipi (mock v3, "prod'a yakın")

**Nasıl açılır:** [`index.html`](index.html) çift tık. Tek dosya, kurulum yok, internet gerekmez.

**Ne bu:** Maestro'nun bittiğindeki halinin **çalışan simülasyonu**. Arkasında ürün kodu yok ama artık ekran galerisi de değil — durum makinesi var: onay verirsen akış **gerçekten ilerler**, ret gerekçesi ajana "iletilir", ticket listesi ve panel güncellenir. Plandaki **M1–M98** kararlarının ekran karşılıkları içinde.

## Önce burayı dene (5 dakika)

1. **🎬 Canlı demo (vibe)** — sol menüde en üstte. "Ticket'ı oluştur ve izle" de: solda Jira (geliştiricinin gördüğü dünya), sağda Maestro'nun iç işleyişi. İki kez `/approve` butonuna basıyorsun, iş merge olup kanıt paketiyle kapanıyor. **Vibe coding deneyiminin tamamı bu.**
2. **İş akışları** → 22 ticket, filtreler çalışır. Herhangi bir satıra tıkla → **o ticket'ın kendi detayı** açılır (adımlar, defter, analiz, diff, testler o işe ait).
3. Kapıda bekleyen bir ticket'ta (ör. UGURMOB-188) **✓ Onayla** → imza modalı → akış bir sonraki adıma geçer, journal'a imza düşer, toast gelir. **✕ Reddet** → gerekçe zorunlu → iş 6a'ya döner "aynı oturum devam".
4. Üst bardaki **🔍 arama** (ör. "captcha") ve **🔔 bildirimler** çalışır.
5. **Jira'da görünüm** ekranındaki komut kutusuna `/status` veya `/approve` yaz — cevap verir.
6. **📖 Yardım** — platformu birine anlatacağın dille: rol bazlı başlangıç, "iş analizi alacağım" adım adım, Jira bağlama sırası, on-prem bağlantı haritası, komutlar.

## Ekranlar

**Operasyon** — Panel (hesaplanan KPI + canlı demo çağrısı) · **📖 Yardım (nasıl kullanılır)** · **🎬 Canlı demo** · İş akışları (22 ticket, çalışan filtre/arama) · **Dinamik iş akışı detayı** (6 sekme; UGURPAY-501'de el yapımı zengin içerik: 23 kayıtlı defter, 7 bölümlü analiz, gerçek diff, 9 senaryo; diğer 21 ticket'ta duruma göre üretilen içerik) · Ana ticket fan-out · Clarification · Work mode & devir · Yeni proje sihirbazı · Jira görünümü (**çalışan komut kutusu**) · Komut seti

**Yürütme** — Runner havuzları · Canlı sandbox (log akışı) · Cache & çalışma alanları · `.maestro.yaml` (M71 sonrası küçülmüş hali + `protected_paths`)

**Ajanlar** — Variant'lar · Variant detayı (persona/knowledge/eval/sürümler) · Eval & golden ticket (M78 gerekçeli-geçiş akışı) · Knowledge · Analiz şablonu

**Yönetişim** — LLM Gateway (**abonelik havuzu: 5 hesap, kota pencereleri, kuyruk — M55**) · PII maskeleme · Maliyet & kota · Denetim izi (onayların gerçekten yazıldığı) · Kanıt paketi · Güvenlik bulguları · Bildirim & eskalasyon

**Sistem** — **Maestro MCP** (M101: platformu AI ile yönetme — araç seti, kapsamlar, örnek Claude Code oturumu, 'kapı kararı yok' kuralı) · **Jira bağlantısı & eşleme** (zincirin tamamı: proje bağlama → 3 kademeli ticket→uygulama eşleşmesi (M99) → Uygulama Kayıtları + repo kartları (M100) → bağlama mekaniği: tek global webhook + izin seti + kuru koşum (M102) → "atama bekleyen" kuyruğu, atama butonu çalışır) · **Parametreler (M71: DB'de, versiyonlu, 4-göz korumalı — düzenleme modalı çalışır)** · **Uygulama ekle (M93: 4 adımlı onboarding sihirbazı, gezilebilir)** · Kullanıcılar & roller · Ayarlar & bağlantılar (NotifyPort modülleri + kill-switch) · Sistem sağlığı · Giriş · ✓ Karar defteri (M44–M98)

## Bilerek sahte kalanlar
Veri tarayıcı belleğinde (yenileyince sıfırlanır) · LLM çıktıları önceden yazılmış · süreler hızlandırılmış · tema/dil düğmeleri temsilî. Bunların gerçeği Aşama 0-3'te gelir — plan: [`../plan/masterplan.md`](../plan/masterplan.md).

## İncelerken
Artık soru "bu ekran nasıl görünüyor?" değil — **"bu akışta beni rahatsız eden ne?"** Onay modalında eksik bilgi mi var, journal'da görmek istediğin bir kayıt mı yok, canlı demoda fazla/eksik adım mı var? Her bulgu masterplan'a M-kararı olur.
