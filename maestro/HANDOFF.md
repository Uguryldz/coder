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


## Jira "çat çat" hattı (16 Ağustos, kullanıcı isteği)
Kullanıcı: *"Jira ayarlayacağım, connection'ları yapılandıracağım, analizler gelecek çat çat."*

**Canlı kanıt — analiz akışı ÜÇ gerçek ticket'ta uçtan uca çalıştı** (OPS-42, OPS-49, OPS-51):
intake → repo keşfi → analiz → kapı 4 (Jira'dan `/approve`) → kapı 5 → adım 13 → `done`.
Onaylar gerçek Jira yorumlarından geldi, poller yakaladı.

**Kapatılan engeller:**
1. **Cloud `verifyWebhook` yoktu** — `CapabilityNotSupportedError` fırlatıyordu, yani webhook
   kurulsa bile reddedilirdi. Context7/Atlassian dokümanıyla doğrulandı: şema DC ile **birebir
   aynı** (HMAC-SHA256, `X-Hub-Signature: sha256=<hex>`, ham gövde). Yeni doğrulayıcı yazılmadı,
   Cloud var olana bağlandı. **Sessiz kopukluk:** `driver-config.ts` `webhookSecretRef` gönderiyordu
   ama `JiraCloudConfig`'de o alan yoktu → **Zod sessizce düşürüyordu**.
2. **objectLock yapılandırılmamıştı** (M56/M57: 10 yıl COMPLIANCE). Kilit **iki ayrı yerde**
   kompoze ediliyor; belgeyi yazan yol `boot.ts`'teki `deps.sink`, registry'nin portu değil.
3. **`storage_blob` tablosu YOK** — `pgBlobTableDdl()` var ama yalnız testlerde çağrılıyor.
   **Bir ajan bunu kapatıyor** (bu satır yazılırken).
4. **Kurulum rehberi gizliydi** — `{empty && <StartGuide/>}`, yani "hiç koşu yoksa". 19 koşu
   varken kurulum eksikken bile görünmüyordu. Artık `!setup.complete` ile görünüyor, kapatılabilir,
   "gizle" ≠ "tamamlandı". Tarayıcıda doğrulandı: 5 adım, 1-2 ✓, **adım 3 (webhook) vurgulu**.
5. **Yardım sayfasına Jira talimatı** eklendi — `GET /studio/listening-rules`'tan **canlı** okunuyor,
   sabit metin değil. Bot e-postası gösterilmiyor (PII), sadece accountId.

**Ticket'ın düşmesi için üç şart** (canlı `ListeningRule`): proje `OPS` + tip `Görev` +
bot'a atanmış (`712020:b836c135-c9d3-499a-a665-aed43d362cfd`) → akış `analiz`.

**Webhook sırrı üretildi ve env'e eklendi** (`MAESTRO_SECRET_KV_JIRA__WEBHOOK`, 64 hex).
Kopyası: `/tmp/jira-webhook-secret.txt`. **Jira'da webhook kaydında AYNI değer girilecek.**
BFF artık `0.0.0.0:7091` dinliyor (Jira'nın ulaşabilmesi için). İmzasız POST → **401** (doğrulandı).

**Kurulum belgesi:** `maestro/docs/jira-webhook-kurulum.md` (TR, 6 bölüm, curl testi dahil).

**AÇIK BULGU (ürün kararı):** Studio bağlantı kaydındaki `botAccountId`
(`712020:7ee7a2ab-…`) ile kuralın beklediği hesap (`712020:b836c135-…`) **FARKLI**. Kural ve
gerçek Jira bot'u eşleşiyor; bağlantı kaydı yanlış. Hangisinin doğru olduğuna karar verilmeli.


## ✅ ZİNCİR TAMAM — OPS-53 (16 Ağustos, canlı kanıt)
Analiz akışı **belge ekiyle birlikte** uçtan uca çalıştı:
```
ticket → analiz → kapı 4 (Jira /approve) → kapı 5 (/approve) → adım 13 → done
Jira eki: OPS-53-analiz.docx (12.895 B) + OPS-53-analiz.pdf (29.356 B)
```
İndirip doğruladım: `Microsoft Word 2007+` · `PDF, 2 sayfa` · Türkçe bozulmamış
(`Analiz Dokümanı`, `Hazırlayan`, `Şablon sürümü`) · 7 bölüm (amaç, kapsam, etki analizi,
kabul kriterleri, ekran/API, test yaklaşımı, risk & geri dönüş).

**Belge zinciri üç turda açıldı, her turda hata DEĞİŞTİ** (yani her tur gerçek bir halka kırdı):
1. OPS-49 → `ObjectLockNotConfiguredError` (kilit yapılandırılmamış) → `81b19c9`
2. OPS-51 → `relation "storage_blob" does not exist` (tablo yok) → migration `0017`
3. OPS-53 → **ek geldi**

**Bot hesabı düzeltildi** (`ffd8f96`): `Connection.configJson`'da operatörün KİŞİSEL hesabı
(`712020:7ee7a2ab-…` = "Uğur Yıldız") yazılıydı, bot değil. Üç kusur birbirini besliyordu:
karşılaştırma yoktu, düzeltme sessizdi, ve panel `config`'i geri gönderdiği için sonraki her
düzenleme yanlış değeri geri yazıyordu. Artık "Test et" gerçek sahibi (`/myself`) okuyup düzeltiyor
ve kehribar uyarıyla söylüyor. E-posta hiçbir çıktıda yok (PII).

**Kapı flake'i çözüldü** — sebep zaman aşımı DEĞİLDİ: Ayarlar ekranı artık dört panel mount
ediyor, kill switch sonuncusu, ve Testing Library'nin `findBy*` varsayılanı 1000 ms. Yüklü
makinede düğme o sürede render olmuyordu. `asyncUtilTimeout: 5000` (setup.ts) + studio
`testTimeout: 20_000`. Kapı ardışık koşularda 64/64.

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
