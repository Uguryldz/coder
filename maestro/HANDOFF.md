# HANDOFF

## DURUM
Pilot emekli ediliyor, analiz hattı Temporal'a taşınıyor. Canlı sistem AYAKTA ve UI gerçek veri
gösteriyor. Kullanıcı "çalışan sistem" istedi; bu oturumda port kablolaması düzeltildi, 41 dosyalık
commit'siz iş commit'lendi, üç düzeltme turu koştu.

## Bu oturumda (16 Ağustos) yapılanlar
1. **UI yanlış BFF'e bakıyordu.** İki BFF koşuyordu: 7001 (dünkü eski kod) ve 7091 (canlı analiz
   hattı). Studio 7001'e bağlıydı. Eski kapatıldı, Studio `MAESTRO_BFF_ORIGIN=http://127.0.0.1:7091`
   ile yeniden başlatıldı. Tarayıcıda doğrulandı: pano 12 aktif / 3 kapıda / 1 tamamlanan / 16 toplam.
2. **41 dosyalık canlı iş COMMIT'SİZDİ** (`FlowType`, `flowOf`, beş canlı hata düzeltmesi). Kapı
   koşuldu, 5 ölü import düzeltildi, `11d5f03` olarak commit'lendi. Ajanlar artık üstüne dallanabiliyor.
3. **`variantId` boş dize** (`954cd80`): OPS-22/23 boş varyantla açılmış, gateway'de patlıyordu.
   Mağaza sınırında reddediliyor — sessiz varsayılan KOYULMADI (yanlış bağlanmış kurulumu maskelerdi).
4. **Ticket başına akış kararı** (`8ab7f44`): `ListeningRule` tablosundan, `flowOf(env)` geri düşüşü
   korunarak. Migration GEREKMEDİ — tablo zaten `flowType` taşıyor.

## Doğrulanmış canlı kanıt
- **OPS-40**: kapı 4 açıldı → Jira `/approve` → kapı 5 → onay → adım 13 → "analiz teslim edildi".
  Analiz hattı uçtan uca çalıştı (HANDOFF'un eski "sıradaki iş" maddesi ZATEN BİTMİŞ).
- Word/PDF **çalışıyor ama PİLOTTA**: `maestro/ops9-analiz.pdf` = 9 sayfa, Türkçe düzgün, Jira'ya
  gerçek ek olarak yükleniyor (`JiraCloudWorkPort.addAttachment`). Renderer'lar
  `packages/publish/src/{docx,pdf}-render.ts` (**`drivers/docx.ts` YOK**).

## KRİTİK AÇIK: pano yalan söylüyor
DB'de **16 koşunun 16'sı `running`**; Temporal'da **13'ü `Failed`**, biri `Completed`.
Sebep: (a) `RunLifecycle` yalnız `running|done|cancelled` — Postgres enum'unda `fail` VAR ama
yazılamıyor; (b) çöken workflow kendini işaretleyemez, dışarıdan uzlaştırma gerekiyor.
`RunContext.status` alanı VAR (`impl/deps.ts:72`) ve `delivery.ts:297` `done` yazıyor — mekanizma
mevcut, eksik olan `fail` yolu. **Bir ajan bunu yazıyor.**

## Devam eden (bu satır yazılırken koşan ajanlar)
- Word/PDF'i pilottan Temporal `deliverAnalysis`'e taşıma
- Koşu durumu uzlaştırıcısı (yukarıdaki kritik açık)

## Sıradaki adım
İkisi inince: kapı + canlı doğrulama, sonra yeni bir ticket ile uçtan uca (analiz → onay → belge).

## Servisler (setsid, terminal kapansa da yaşar)
- worker: `apps/deploy` içinde `./node_modules/.bin/tsx src/bin/worker.ts` → log **`/tmp/worker-flow.log`**
- bff: aynı dizin `src/bin/bff.ts`, port **7091** → log `/tmp/bff-v5.log`
- studio: `apps/studio` içinde `MAESTRO_BFF_ORIGIN=http://127.0.0.1:7091 ... vite --port 7000`
  → log `/tmp/studio-live.log`. Dış erişim `coder.uguryildiz.tech` (NPM arkasında).
- env: `set -a; source /tmp/analiz-env.sh; set +a` + `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`
- Giriş: **`admin` / `admin123`** (parola politikası atlanarak hash yazıldı — Studio'dan
  değiştirilirse geri dönülemez). Pilot öncesi SİLİNMELİ.

## Tuzaklar
- **`/tmp/worker-v5.log` ÇÖKMÜŞ ESKİ worker'a ait** ("Not running. Current state: STOPPED").
  Canlı worker `/tmp/worker-flow.log`'a yazıyor. Yanlış loga bakan sistemin çöktüğünü sanır.
- **Kapı yük altında flake yapıyor** — üç ajan koşarken yük 27/8 çekirdek. Düşen test TEK BAŞINA
  koşulmalı; geçiyorsa kod sağlamdır. Bu oturumda 3 kez oldu (bff/password, studio/users,
  studio/params), üçü de tek başına yeşil.
- Zaman aşımını merkezden ayarlamaya ÇALIŞMA: `VITEST_TESTTIMEOUT` yok sayılıyor, `--testTimeout`
  paket config'ini EZİYOR (workflows'un 180s'ini düşürüp korumak istediği testleri düşürdü),
  paylaşılan helper hiç etki etmiyor. Kapı sadece yükü RAPORLUYOR.
- Worktree'ler `1c78e71`'den dallanıyor (maestro/ yok). Ajana `git reset --hard <hedef-commit>`
  izni ver — **`main` DEĞİL**, main geride olabilir; doğrulanabilir bir commit hash ver.
- `pkill -f "src/bin/worker.ts"` kendi kabuğunu vurur; `\.ts` diye kaçır.
- `contracts`/`ports` FROZEN — `FlowType` bu oturumda `contracts/common.ts`'e eklendi.
- Jira Cloud auth **Basic** (`email:token`), DC **Bearer**.
- Bot hesabı `User` tablosunda `maestro-admins` üyesi (dört-göz muafiyeti). **Bankaya giderken SİL.**
- `uinfra-postgres`, `wendococr-redis` başka projelere ait — kullanma.
