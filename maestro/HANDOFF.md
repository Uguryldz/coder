# HANDOFF

## Görev
Studio'nun arkası bağlanmamış 16 ekranı için BFF'te eksik 14 ucu yazmak, böylece
prod pilotu (analiz → onay → Word/PDF → Jira) uçtan uca çalışsın.

## Tamamlandı (doğrulanmış, canlı ölçüm)
- Dalga 0–5 kodu: 24 paket, 6 uygulama, 66.708 satır kod, 55.382 satır test.
- `pnpm run gate` → exit 0, **60/60**, 4028 test.
- Altyapı ayakta: `maestro/deploy` compose → postgres(55432), redis, temporal(7233), temporal-ui(8233).
- Migration 0001→0004 uygulandı. DB'de 22 koşu, 19 parametre.
- Worker gerçek Temporal'a bağlanıyor: "composed 9 ports, polling maestro-delivery".
- BFF `0.0.0.0:7001`, Studio `0.0.0.0:7000`, dış erişim `coder.uguryildiz.tech` (NPM arkasında, 200 doğrulandı).
- Test kullanıcısı: `ayse.kaya@bank` / `Prod!Test-2026` (rol admin). **Kullanıcı e-posta alanıyla aranıyor.**
- Canlı doğrulanan zincir: yanlış parola→401 · webhook imzasız→401 · `/studio/runs`→22 kayıt ·
  `/studio/audit/verification`→`{"ok":true,"checked":76}` · viewer→admin ucu 403 · `limit=5000`→400.

## Son dalga (prod pilotu öncesi dört eksik) — BİTTİ
`RAPOR-son-eksikler.md`'ye bak. Özet:
1. **Analiz şablonu kalıcı.** Migration **0007** (`AnalysisTemplateVersion`, append-only trigger),
   `PrismaTemplateStore`, ve installer'ın yayınladığı **v1 varsayılan şablonu** (8 bölüm).
   `templates` artık `VOLATILE_STORES`'ta DEĞİL.
2. **Türkçe sızıntıları kapandı.** BFF artık cümle değil **katalog anahtarı** gönderiyor
   (`routing.note.*`, `routing.condition.*`, decisions `action`+`actor` ayrı alanlar,
   `yamlPresent` bayrağı). `mode.*` katalogda ham enum'du → düzeltildi. Yeni aileler:
   `audit.action.*` (26), `pii.kind/strategy.*`, `issues.status.*`. tr+en **1523 anahtar, parite**.
3. **Hata kataloğu.** Studio `ERROR_KEYS`'e **51 kod** eklendi. Eski test kendi tablosunu
   kendisiyle doğruluyordu (totoloji); yerine BFF'in `throw` noktalarını tarayan **gerçek** test.
4. **Prod imajı.** `.env.example`'a `RUNNER_IMAGE_LINUX` bölümü; compose anchor'ında
   **yoktu** — set edilse bile worker'a ulaşmıyordu, eklendi. `deploy/SURUM-NOTU.md` yazıldı.

**Yol boyunca bulunan gerçek hata:** compose `${VAR:-}` **boş string** yollar, `.min(1)` bunu
reddediyordu → `RUNNER_IMAGE_LINUX` set edilmeyince **worker boot'ta çökerdi**. `optionalSetting()`
eklendi (scanner imajları da aynı tuzaktaydı).

## Devam eden
Yok.

## Sıradaki adım
Kullanıcı onay verirse: 14 ucu paralel ajanlarla yaz. Öncelik sırası —
**1) `/onboarding` + `/onboarding/options` + `/onboarding/dry-run`** (Jira projesi bağlama; bunsuz pilot başlamaz)
2) `/doc-template` (Word şablonu) · 3) `/settings` · 4) `/repo-policy` (+`/:app/protected-paths`)
5) `/routing` `/notify` `/commands` `/mcp/manifest` `/pii` `/variants` `/eval` `/cache` `/greenfield` `/decisions`

## Eksik listesi (ölçüldü: `not_found` = uç yok)
`/settings` `/notify` `/commands` `/mcp/manifest` `/repo-policy` `/onboarding{,/options,/dry-run}`
`/pii` `/routing` `/cache` `/eval` `/greenfield` `/decisions` `/doc-template` `/variants`

**Arkası bağlı 13 ekran:** Audit, Cost, Health, KillSwitch, Knowledge, Llm, Params, Runners,
Security, Template, Users, runs(liste/detay), signals.

**Ayrı eksik:** `AgentTurnRunner` yok → koşu 6a mühendislik turunda **açık hatayla** durur.
19 adımın 7'si (analiz + PO/TL kapıları) çalışır, 12'si 6a'ya bağlı. `DEGRADED_CAPABILITIES`'te ilan ediliyor.

## Tuzaklar (tekrar deneme)
- **404 ≠ uç yok.** `{"error":"not_found"}` uç yok demek; `no_template`/`unknown_user` uç VAR, veri yok.
  İlk envanterim bu yüzden yanlıştı.
- `pkill -f "src/bin/bff.ts"` kendi kabuğumu da düşürüyor → `nohup ... &` ile başlat, ayrı komutta doğrula.
- Docker imajı **her değişiklikte build etme** (kullanıcı uyardı). Altyapı konteynerde, uygulama
  `tsx` ile kaynaktan; imaj en sonda bir kez.
- Vite `allowedHosts`: yeni alan adı → 403 (NPM'de bad gateway görünür). `MAESTRO_STUDIO_ALLOWED_HOSTS`.
- Kapı yüklü makinede flake yapar (8 çekirdek). Tek paket koşusu yeşilse kod sağlamdır.
- `uinfra-postgres`, `wendococr-redis`, `uinfra-redis` **başka projelere ait — kullanma.**
- 5432 bu makinede dolu; compose `POSTGRES_PORT=55432` ile çalışıyor.
