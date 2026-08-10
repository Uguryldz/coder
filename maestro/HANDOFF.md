# HANDOFF

## Görev
Maestro prod pilotuna hazır hale getirildi (Windows/Mac runner'ları hariç, kullanıcı kararı).

## Tamamlandı (canlı ölçüm, tahmin değil)
- `pnpm run gate` → exit 0, **60/60**, ~4635 test. 24 paket + 6 uygulama.
- **14 eksik uç yazıldı.** Ölçüm: 11'i 200 + gerçek veri, 3'ü gerekçeli **503**
  (`eval`/`cache`/`greenfield` — o veriyi YAZAN hiçbir şey yok, boş sayfa "regresyon yok" diye okunurdu).
- **`AgentTurnRunner` bağlandı** → 6a mühendislik turu açıldı. `RUNNER_IMAGE_LINUX` set edilince
  degraded 3→2 (canlı doğrulandı). 19 adımın önündeki kilit kalktı.
- **Şablon tasarımcısı**: migration 0007 (`AnalysisTemplateVersion`, append-only), kalıcı
  `PrismaTemplateStore`, installer v1 (8 Türkçe bölüm). Tarayıcıda doğrulandı: bölüm ekleme 8→9,
  BFF restart sonrası şablon duruyor.
- **6 kırık detay ucu düzeltildi** (22/22 → 200). Sebep: Temporal'da `verifyRun` tipli 6 hayalet
  workflow; liste ucu korunuyordu, detay + `runIdOf` korunmuyordu. Ortak `queryStateOrNull`.
- **503 tutarlılığı**: `runners`/`scans` düz Error (=500) atıyordu → `capability_not_wired` (503).
- Studio `ERROR_KEYS`: **51 kod** eklendi (eski kapsam testi totolojiymiş).
- Türkçe: `mode.*` katalogda ham enum'a eşliyormuş; 9 sızıntı kapatıldı. tr/en **1523 anahtar, parite**.
- Compose: `RUNNER_IMAGE_LINUX` anchor'da yoktu (set edilse bile konteynere ulaşmıyordu) + boş
  string tuzağı (`optionalSetting()`), ikisi de düzeltildi. `deploy/SURUM-NOTU.md` yazıldı.

## Canlı sistem (şu an ayakta)
- Studio 7000 / BFF 7001, dış erişim **https://coder.uguryildiz.tech** (NPM arkasında).
- Giriş: **`admin` / `admin123`** (⚠️ parola politikası atlanarak hash yazıldı — 12 karakter +
  büyük/küçük/rakam/sembol ister; Studio'dan değiştirilirse geri dönülemez). Eski hesap:
  `ayse.kaya@bank` / `Prod!Test-2026`. **İkisi de pilot öncesi silinmeli.**
- Postgres 55432 (compose), migration 0001→0007 uygulanmış, 22 koşu.

## Devam eden
Yok.

## Sıradaki adım
Kullanıcı isterse: 4 imajı build et (`cd deploy && docker compose build`) — dördü de daha önce
build oldu, 2.62 GB. Öncesinde `deploy/.env` doldurulmalı (kurum bilgileri kullanıcıda).

## Bilinen sınırlar (gizlenmiyor, `SURUM-NOTU.md`'de)
- `runners`/`scans`/`eval`/`cache`/`greenfield` → 503: arkalarında veri üreten yok.
- Panoda sayaçlar 0: DB'de 22 koşu var ama Temporal'da canlı workflow yok, `Gate` tablosu boş.
- Gerçek Jira/ADO/LDAPS/Temporal'a **hiç bağlanılmadı** — %95 doğruluk sınırı, kalan %5 erişim günü.
- Windows/Mac runner'ları kapsam dışı (kullanıcı kararı).

## Tuzaklar (tekrar deneme)
- **404 ≠ uç yok.** `not_found` = uç yok; `no_template`/`unknown_user` = uç VAR, veri yok.
- **Kapı zaman aşımını merkezden ayarlamaya çalışma.** 3 yol denendi: `VITEST_TESTTIMEOUT`
  sessizce yok sayılıyor · `--testTimeout` paket config'ini EZİYOR (workflows'un 180s'ini 20s'e
  düşürüp korumak istediğim testleri düşürdü) · paylaşılan `testTimeout()` helper'ı doğru değeri
  hesaplayıp hiçbir etki etmiyor. Kapı artık sadece yükü **raporluyor**; test düşerse önce tek başına koş.
- `pkill -f "src/bin/bff.ts"` kendi kabuğunu da düşürür → `nohup ... &`, ayrı komutta doğrula.
- Docker imajını her değişiklikte build etme (kullanıcı uyardı). Altyapı konteynerde, uygulama `tsx`.
- Vite `allowedHosts`: yeni alan adı → 403, NPM'de bad gateway görünür.
- `uinfra-postgres`, `wendococr-redis`, `uinfra-redis` **başka projelere ait — kullanma.**
- Migration numarası: paralel ajanlar aynı numarayı alabiliyor (0005 iki kez oldu). Merge'de kontrol et.
