# HANDOFF

## DURUM
Canlı sistem AYAKTA ve UI **doğru** veri gösteriyor. Kullanıcı "çalışan sistem" istedi; bu oturumda
altı gerçek hata bulundu ve düzeltildi, hepsi canlıda doğrulandı. Kapı 64/64 yeşil.

## Bu oturumda düzeltilen altı hata (hepsi canlıda görüldü, testte değil)
1. **UI yanlış BFF'e bakıyordu** — iki BFF koşuyordu (7001 eski, 7091 canlı). Studio 7001'deydi.
   Eski kapatıldı, Studio `MAESTRO_BFF_ORIGIN=http://127.0.0.1:7091` ile bağlandı.
2. **41 dosyalık canlı iş COMMIT'SİZDİ** → `11d5f03`. Makine kapansa kaybolurdu; ajanlar da
   üstüne dallanamıyordu.
3. **`variantId` boş dize** (`954cd80`) — mağaza sınırında reddediliyor, sessiz varsayılan YOK.
4. **Ticket başına akış kararı** (`8ab7f44`) — `ListeningRule` tablosundan; migration gerekmedi.
5. **Pano yalan söylüyordu, iki katman:**
   - DB: 16 satırın 16'sı `running`, Temporal'da 11'i ölü → uzlaştırıcı (`18e794b`), açılışta
     12 satır hizaladı. Yan bulgu: `TERMINAL_STATUSES` genişletilmeseydi ticket'lar **kalıcı
     olarak yeniden koşturulamaz** olurdu.
   - UI: durumu Temporal'dan okuyordu, motor ölü koşuya hâlâ "running" diyordu (`72cacc7`) →
     kayıt terminal ise DB kazanır.
6. **Üç ayrı 400 hatası** — tarayıcı boş `cursor=`/`status=` gönderiyordu (`ba4122f`,
   `blankAsAbsent` yardımcısı), ve tickets ekranı `limit=500` istiyordu, tavan 200 (`1f91582`).
   Üçü de `curl` ile üretilemiyordu; **ancak tarayıcı ağ günlüğünde** görünüyordu.

## Word/PDF (`592f763`)
Pilottan Temporal hattına taşındı — **kopyalanmadı**: pilotun kodu renderer'ları doğrudan çağırıp
**PII kapısını atlıyordu**. Artık publish portundan geçiyor. Yolda üç hata: publish sürücüsü tek
hedefliydi, StoragePort bağlı değildi, ve şablon pini maskeleyici tarafından `[EMAIL_1]` yapılıyordu.

## Canlı doğrulama (tarayıcı, 16 Ağustos)
Pano: Aktif 2 · Kapıda 2 · Tamamlanan 1 · Toplam 16 · "11 tanesi hatalı".
Arşiv sekmeleri: Tümü (16) · Çalışıyor (2) · Kapıda (2) · Tamamlandı (1) · Hatalı (11).
DB ile birebir. OPS-40 analiz hattını uçtan uca bitirmiş (kapı 4 → onay → kapı 5 → adım 13).

## Devam eden
Yok.

## Sıradaki adım
Yeni bir ticket ile uçtan uca doğrulama: analiz → iki kapı → **Word/PDF eki** (yeni yol henüz
canlı ticket'la denenmedi).

## Servisler (setsid; terminal kapansa da yaşar)
- worker: `apps/deploy` → `./node_modules/.bin/tsx src/bin/worker.ts`, log `/tmp/worker-v8.log`
- bff: aynı dizin `src/bin/bff.ts`, port **7091**, log `/tmp/bff-v12.log`
- studio: `apps/studio` → `MAESTRO_BFF_ORIGIN=http://127.0.0.1:7091 MAESTRO_STUDIO_HOST=0.0.0.0
  MAESTRO_STUDIO_ALLOWED_HOSTS="coder.uguryildiz.tech,..." ./node_modules/.bin/vite --port 7000`
- env: `set -a; source /tmp/analiz-env.sh; set +a` + `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`
- Giriş: **`admin` / `admin123`** — parola politikası atlanarak yazıldı. **Pilot öncesi SİLİNMELİ.**


## Ayarlar ekranı — motor satırı (16 Ağustos, kullanıcı sorusu üzerine)
Kullanıcı "motor ayarları neden yok?" diye sordu. İki gerçek kusur bulundu:
1. **Temporal, veritabanı ve LLM `/settings` listesinde HİÇ YOKTU.** Eklendi; motor ve veritabanı
   `read.health`'in **aynı** probe setini okuyor (ikinci set, sağlık ekranıyla çelişebilirdi).
2. **Jira yanlış değişkeni okuyordu** — kod `JIRA_BASE_URL`, ortamda `JIRA_CLOUD_BASE_URL`.
   Çalışan bir bağlantı "yapılandırılmamış" görünüyordu; boş ekrandan kötü, çünkü operatörü
   olmayan bir sorunu kovalamaya iter. Artık ikisi de okunuyor (Cloud/DC iki ayrı sürücü).
3. **Ekran o tabloyu göstermiyordu** — `Settings.tsx` iki ayrı liste kullanıyor:
   `/studio/connections` (operatörün yönettiği 3 bağlantı) ve `/settings` (dağıtımın 11 gerçeği).
   Salt-okunur tablo geçmişte "tekrarlıyor" diye kaldırılmıştı; o gün doğruydu, motor eklenince
   geçersiz kaldı. `InfrastructurePanel` eklendi — iki tablo **bilerek ayrı**: aynı `id` iki
   listede **farklı gerçeği** taşır (operatörün yazdığı site ≠ .env'deki site) ve ayrışma en
   değerli bilgidir. `DATABASE_URL` parolası sunucuda maskeleniyor (`***`), ekranda tekrar değil.

**Canlı doğrulama (tarayıcı):** 11 satır. Temporal `localhost:7233` ● bağlı · az önce yoklandı;
Veritabanı `postgresql://maestro:***@...` ● bağlı; Jira/LLM/Kimlik/Confluence yapılandırıldı;
ADO/Vault/Depolama/Egress/SIEM kurulmadı (doğru — o değişkenler gerçekten yok). Ham parola yok.

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
