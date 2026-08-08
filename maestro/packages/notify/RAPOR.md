# RAPOR — `@maestro/notify` (Dalga 2)

`NotifyPort` (M45) eklenti sürücüleri: **teams** · **smtp** · **jira** · **slack**, artı
tamamen parametrik **eskalasyon merdiveni** (M88) ve kanal seçimi (M71/M87).
Kod/yorum/test adları İngilizce (M59); bu rapor Türkçe.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/deps.ts` | Enjekte edilen çalışma zamanı ortakları: `FetchLike`, `Clock`, `Sleep`, **`SocketLike` + `SocketFactory`** (SMTP taşıması). Tüm testler bunlar sayesinde çevrimdışı ve deterministik. |
| `src/errors.ts` | Tipli hatalar: `NotifyConfigError`, `NotifyMessageError`, `NotifyRecipientError`, `NotifyTransientError` (yeniden denenir), `NotifyPermanentError` (denenmez), `NotifyDeliveryError` (teslim edilemedi — çağırana ulaşır). `redact()`/`safeMessage()` sır maskeleme. |
| `src/config.ts` | Zod yapılandırmaları (hepsi Studio/DB parametresi — M71): `RetryPolicy`, `WebhookDriverConfig` (hedef adı → SecretPort anahtarı), `SmtpDriverConfig`, `JiraDriverConfig`, `NotifyRouting` (olay→kanal), `EmailAddress`. Port/sürücü kimlikleri. |
| `src/message.ts` | **M104 çekirdeği**: `renderMessage()` metni `@maestro/config`'in `t()`'siyle katalogdan çözer; `requireNotification()` donuk sözleşmeye göre fail-closed doğrular; `routeNotification()` olay→kanal yönlendirmesi. |
| `src/retry.ts` | Teslim garantisi: `sendWithRetry` (sınırlı deneme, üstel+tavanlı backoff, `Retry-After` desteği), `sendToEachTarget` (her hedef denenir, hatalar toplanıp bildirilir). |
| `src/webhook.ts` | İki Incoming-Webhook kanalının ortak makinesi: sırdan URL çözümü, https zorunluluğu, durum kodu sınıflandırması, gövde/URL maskeleme. |
| `src/teams.ts` | Teams Incoming Webhook — `message`/`attachments` zarfı içinde **Adaptive Card** (1.4). "200 ama gövde 'failed'" durumu başarı sayılmaz. |
| `src/slack.ts` | Slack Incoming Webhook — `text` + `mrkdwn` blok; `&<>` kaçışlama. |
| `src/jira.ts` | Jira yorumu — **enjekte `WorkPort` üzerinden** (M44 temiz oda: `@maestro/adapter-jira` import edilmez). `to` = ticket key'leri; hata sınıflandırması yapısal (`status` alanı). |
| `src/smtp-protocol.ts` | El yazımı SMTP tel katmanı: çok satırlı yanıt okuyucu (`SmtpReplyReader`), EHLO yetenek ayrıştırma, RFC 5322 tarih, RFC 2047 encoded-word, dot-stuffing, base64 MIME gövdesi, **CR/LF başlık enjeksiyonu reddi**. |
| `src/smtp-client.ts` | SMTP oturumu: EHLO → STARTTLS → AUTH (PLAIN/LOGIN) → MAIL → RCPT → DATA → QUIT. Fail-closed kurallar §3'te. |
| `src/smtp.ts` | `NotifyPort` SMTP sürücüsü: SecretPort'tan parola, katalog metninden gövde, tek işlemde çok alıcı. |
| `src/calendar.ts` | Çalışma takvimi (M88): sabit UTC ofseti, çalışma günleri, mesai penceresi, tatiller; `workingMinutesBetween` ve tersi `addWorkingMinutes`. |
| `src/escalation.ts` | Merdiven şeması + **saf fonksiyon `escalationDueAt(ladder, {openedAt, now, firedStepIds})`** ve `planEscalation()` (bildirim üretimi + delegasyon listesi). `DEFAULT_LADDER` = 24s Jira → 72s Teams+e-posta → 7g vekile delegasyon. |
| `src/register.ts` | `registerNotifyDrivers(registry, deps)` (M44) + `CompositeNotifier` (`multi` sürücüsü): çekirdek tek `NotifyPort` tutar, `notification.channel`'a göre dağıtım yapılır. |

**Boyut:** üretim kodu **1192 satır** (yorum/boşluk hariç; tavan 1200), en büyük dosya 183 satır (tavan 300).
Test: 11 dosya, **106 test**, tamamı çevrimdışı.

## 2. Kararlar ve gerekçeleri

### 2.1 SMTP istemcisini kendimiz yazdık (nodemailer EKLENMEDİ) — karar: YAZ
Görev "riskli görüyorsan gerekçelendir ve minimal arayüz bırak" diyordu; **yazmayı seçtim**. Gerekçe:
1. **Kapsam gerçekte küçük**: gönderim akışı 1982'den beri sabit; oturum mantığı 152 satır, tel katmanı 174 satır.
2. **Enjekte edilebilirlik şart**: nodemailer'ın soketi enjekte edilemez; onunla her SMTP testi ya canlı sunucu
   ya da kütüphane iç mock'u ister — "çevrimdışı + deterministik" kuralı sınıfça ihlal olurdu. Bizim
   `SocketLike`'ımızla senaryolu sahte sunucu 30 satır (bkz. `test/helpers.ts`).
3. **Banka tedarik yüzeyi**: bir kod yolu için büyük geçişli bağımlılık ağacı (ve onun CVE takibi) girmiyor.
4. **İhtiyacımız dar**: gönderim (submission), düz metin gövde, tek MIME parçası. Eklenti yok, ek yok,
   HTML yok, DKIM imzalama yok (relay'in işi), havuzlama yok.
**Kabul edilen sınırlar (dürüst kapsam):** AUTH yalnız PLAIN + LOGIN (CRAM-MD5/XOAUTH2 yok — kurum
relay'inde ikisi de yaygın değil, gerekirse ~20 satır eklenir); ek/HTML gövde yok; SMTPUTF8 yok
(adresler ASCII; başlıklar RFC 2047 ile kodlanır, gövde base64/UTF-8 — Türkçe metin sorunsuz);
bağlantı havuzu yok (bildirim hacmi buna değmez).

### 2.2 Gerçek soket adaptörü (`node:net`/`node:tls`) bu pakette YOK — talep §5.2
Arayüz (`SocketFactory`) tanımlı ve sürücü, adaptör verilmeden **kurulum anında gürültülü hata verir**
(test edilmiştir). Adaptörün kendisi kompozisyon kökünün işi: paket içinde kalsaydı ya ağ isteyen bir test
gerektirirdi ya da test edilmemiş ölü yol olarak kalırdı (§5 kontrol listesi). Sözleşme + iskelet §5.2'de.

### 2.3 Takvim sabit UTC ofseti kullanır, IANA bölgesi değil
Türkiye 2016'dan beri kalıcı UTC+3; sabit ofset hesabı tam, bağımlılıksız ve konteynerin `TZ` değişkeninden
bağımsız olarak tekrarlanabilir yapar (Temporal replay determinizmi için önemli). Ofset parametredir;
DST uygulayan bir ülke için ileride bölge adı gerekirse §5.3'teki talep açılır.

### 2.4 Jira sürücüsü düz metin gönderir
`WorkPort.addComment(key, body)` "ADF belgesi **veya** düz metin" kabul ediyor ve `@maestro/adapter-jira`
dönüşümü kendi `adf.ts`'inde yapıyor. Burada ikinci bir renderer yazmak, sessizce sapan iki biçimlendirme
demekti. Temiz oda korunuyor: bu paket Jira'nın HTTP API'si olduğunu bilmiyor.

### 2.5 Teslim semantiği: at-least-once
Yeniden deneme (ve Temporal'ın dayanıklı yeniden denemesi) **kopya bildirim** üretebilir; SMTP'de tek işlemde
çok alıcı olduğu için yeniden deneme hepsine yeniden gönderir. Bilinçli tercih: *kaybolan* bir kapı bildirimi
işi sessizce öldürür, *tekrarlanan* bir hatırlatma öldürmez. Idempotency anahtarı talebi §5.4.

## 3. Fail-closed davranışlar

- **Katalog (M104):** olmayan anahtar → `NotifyMessageError` (sessiz geçiş YOK). Şablondaki `{param}`
  doldurulmamışsa da hata — "{ticket} kapıda bekliyor" metnini onaycıya göndermek sessiz bozulmadır.
- **Sözleşme:** her sürücü gelen bildirimi donuk `Notification` şemasıyla doğrular; kanalı kendisine ait
  olmayan bildirimi reddeder (`multi` sürücüsü de etkin olmayan kanalı reddeder, sessizce düşürmez).
- **Webhook URL'i:** `to` yalnız **hedef adı** taşır; URL SecretPort'tan gelir ve `https://` değilse
  gönderim yapılmaz (URL'in yolu bearer kimliğidir). Bilinmeyen hedef → hata, sessiz atlama yok.
- **STARTTLS:** `security: "starttls"` iken sunucu STARTTLS ilan etmiyorsa **açık metne düşülmez**, hata verilir.
  El sıkışma öncesi sunucudan veri gelirse (STARTTLS komut enjeksiyonu) oturum reddedilir.
- **Kimlik bilgisi:** şifreli olmayan kanalda AUTH gönderilmez (`allowInsecureAuth` yalnız laboratuvar kaçışı,
  varsayılan kapalı). Desteklenen AUTH mekanizması yoksa hata.
- **Alıcı reddi:** bir `RCPT TO` reddedilirse mesaj **hiç kimseye** gönderilmez (kısmi teslim = sessizce
  eksik onaycı). Jira'da geçersiz ticket key'i gönderim başlamadan reddedilir.
- **Hata yutulmaz:** her başarısız yol `NotifyDeliveryError` ile çağırana çıkar; kaç deneme yapıldığı ve
  hangi hedeflerin düştüğü mesajın içindedir.
- **Merdiven:** alıcısı boş çıkan eskalasyon adımı hata verir; ulaşılamaz eşik (takvim yüzünden) hata verir.

## 4. Test özeti (106 test / 11 dosya, ağ YOK)

| Dosya | Test | Ne kanıtlıyor |
|---|---|---|
| `message.test.ts` | 9 | Katalogdan TR/EN gövde, olmayan anahtar/parametre hatası, konu satırı sınırı, sözleşme doğrulaması, olay→kanal yönlendirme + bilinçli susturma |
| `teams.test.ts` | 12 | Adaptive Card zarfı, sırdan URL çözümü, bilinmeyen hedef, http reddi, 500/429/408 yeniden deneme + backoff değerleri, 400 denenmez, tükenince hata, "200 ama failed" gövdesi, çok hedefli kısmi hata raporu, kanal uyuşmazlığı, taşıma hatası |
| `slack.test.ts` | 4 | Blok yapısı, mrkdwn kaçışı, gövde başarısızlık okuması, 403 |
| `jira.test.ts` | 8 | WorkPort'a katalog metni, çok ticket, geçersiz key, 503 denenir / 403 denenmez, `CapabilityNotSupportedError`, soket hatası denenir, kısmi hata raporu |
| `smtp-protocol.test.ts` | 14 | Tek/çok satırlı yanıt, parçalı chunk birleştirme, kopan bağlantı, bozuk kod, kod değişimi, tampon kontrolü, yetenek ayrıştırma, RFC 5322 tarih, encoded-word (75 kar. sınırı), CR/LF enjeksiyon reddi, dot-stuffing, base64 gövde |
| `smtp.test.ts` | 13 | Tam komut sırası + TLS yükseltme + kapanış, AUTH PLAIN/LOGIN, STARTTLS yokluğunda ret, açık metinde kimlik göndermeme, implicit TLS, alıcı reddinde iptal, 4xx yeni bağlantıda yeniden deneme, 5xx denenmez, TLS öncesi veri enjeksiyonu, geçersiz e-posta, gövde/tarih içeriği, eksik username |
| `calendar.test.ts` | 10 | ISO gün eşlemesi, mesai penceresi, akşam/hafta sonu/tatil atlama, `addWorkingMinutes` tam tersinir, Cuma akşamı + 24 iş saati = Çarşamba, Pazar–Perşembe haftası, geçersiz pencere, ulaşılamaz eşik |
| `escalation.test.ts` | 16 | Varsayılan merdiven, **DB'deki `escalation.ladder` değerinin aynen ayrıştığı**, eşik altı/üstü tetikleme, tekrar tetiklememe, determinizm, çakışan adım kimlikleri, başa adım eklemede kimlik kararlılığı, mesai-içi modu, sonraki tetik anı, ters zaman reddi, plan → bildirim/delegasyon/alıcısız adım |
| `retry.test.ts` | 7 | Başarıda tek deneme, geçici hatada backoff dizisi, kalıcı hatada deneme yok, bilinmeyen hata yutulmaz, backoff tavanı/Retry-After, çok hedefte hepsinin denenmesi ve toplu rapor |
| `register.test.ts` | 7 | 5 sürücü kaydı, registry üzerinden çalışan port, eksik bağımlılıkta gürültülü hata, geçersiz config reddi, composite dağıtımı, etkin olmayan kanal reddi, boş composite reddi |
| `leak.test.ts` | 6 | Webhook URL'i ve SMTP parolası; taşıma hatası, sunucu yankısı, hata gövdesi, `String`/`inspect`/`JSON.stringify`/`stack` yüzeylerinin hiçbirinde sır yok; `redact()` yüzde-kodlu biçimi de maskeler |

Kapılar: `pnpm install` ✓ · `pnpm -F @maestro/notify typecheck` ✓ · `test` ✓ (106) ·
kökten `pnpm lint` ✓ · `pnpm typecheck` ✓ (13 görev) · `pnpm test` ✓ (26 görev).
**Dürüstlük notu:** kökten `pnpm test` yeşil ama `@maestro/config#test` önbellekten geliyor;
`turbo run test --force --continue` ile koşulduğunda 26 görevden 25'i yeşil, **tek kırmızı
`@maestro/config#test`** ve sebebi bu paket değil (§5.4). Notify hem önbellekli hem `--force` yeşil.

## 5. Talepler ve bulgular (orkestratör kararı)

### 5.1 Katalog anahtarı talebi (M104) — `packages/config` DÜZENLENMEDİ
Bu paket **hâlihazırdaki `notify.*` anahtarlarının hepsini** kullanıyor, yeni anahtar olmadan çalışıyor.
Tek gerçek eksik, varsayılan merdivenin son basamağı: 7 günde **vekile delegasyon** adımı şu an
`notify.escalation` metnini kullanıyor, oysa mesaj "devredildi" demeli.

| Anahtar | tr | en |
|---|---|---|
| `notify.delegated` | `{ticket} kapısı {days} gündür yanıtsız — {delegate} vekiline devredildi` | `{ticket} gate unanswered for {days} days — delegated to deputy {delegate}` |

Eklendiğinde `DEFAULT_LADDER`'ın delegasyon adımına `messageKey: "notify.delegated"` yazılacak (tek satır).
**Öneri (zorunlu değil):** e-posta konu satırı şu an gövdenin ilk satırından türetiliyor. Kanal başına
ayrı başlık istenirse bu, `notify.subject.<event>` ailesi olarak merkezî katalogda tanımlanmalı — paket
içinde asla. Karar orkestratörün.

### 5.2 Bağımlılık/kod talebi: `SocketFactory` gerçeklemesi
**Yeni npm bağımlılığı EKLENMEDİ** (nodemailer dahil). Üretimde SMTP'yi çalıştırmak için kompozisyon kökünün
`node:net`/`node:tls` üzerinde şu sözleşmeyi karşılayan ~60 satırlık bir adaptör vermesi gerekiyor:

- `read()`: sıradaki baytlar; bağlantı kapandıysa `null`. (Stream'in async iterator'ı birebir uyar.)
- `write(bytes)`: yazma tamponu boşalınca çözülen promise.
- `startTls()`: **aynı** bağlantıyı `tls.connect({ socket })` ile yerinde yükseltir; yükseltme sonrası
  okuma yeni TLS soketinden yapılır. (İstemci, yükseltme öncesi tamponda bayt kalmadığını zaten doğruluyor.)
- `close()`: soketi kapatır. Ayrıca `timeoutMs` taşıma katmanında uygulanmalı (`socket.setTimeout`),
  çünkü istemci okuma zaman aşımını taşımaya devrediyor.

İsterseniz bu adaptörü ayrı bir düzeltme turunda ben yazarım; paket o zaman ~1250 satıra çıkacağı için
**1200 satır tavanının aşılmasına onay** gerekir (ya da adaptör `packages/deploy`/kompozisyon köküne konur).

### 5.3 Arayüz notları (contracts/ports'a DOKUNULMADI)
1. **`Notification.to` anlamı kanala göre değişiyor**: teams/slack → yapılandırılmış *hedef adı*,
   smtp → e-posta adresi, jira → ticket key. Sürücüler bunu doğruluyor ama sözleşmede yazılı değil;
   `packages/contracts/src/notify.ts` yorumuna tek cümle eklenmesi (davranış değişikliği yok) yararlı olur.
2. **Port adı tutarsızlığı**: bu paket `"notify"` kullanıyor (adapter-jira `"work"`, secrets `"secret"`,
   llm-gateway `"llm"` ile aynı kalıp). `packages/storage` ise `"StoragePort"` kullanıyor — kompozisyon
   kökü karışmadan önce tek kalıba çekilmeli.
3. **Idempotency**: `NotifyPort.send` bir idempotency anahtarı taşımıyor; teslim at-least-once (§2.5).
   Kopya bildirimi kabul etmiyorsak sözleşmeye alan eklenmesi gerekir — tek elden karar sizin.
4. **DST'li ülke**: takvim sabit ofsetli (§2.3); ileride bölge adı gerekirse `BusinessCalendar`'a
   `timeZone` alanı eklenmeli (bu pakette geriye dönük uyumlu olur).

### 5.4 Bu paketin DIŞINDA bulunan kırık: `@maestro/config` katalog testi
`pnpm -F @maestro/config exec vitest run` **kırmızı**: `llm-gateway/src/messages.ts` katalogda olmayan
`llm.blocked_by_route` anahtarını yayıyor (her iki dil için de eksik). Kökten `pnpm test` bunu **turbo
önbelleği yüzünden yeşil gösteriyor** — dalga kapısı koşulurken `--force` ile doğrulanmalı.
Notify kaynaklı değil; düzeltmesi ya katalog anahtarı ya da o paketin anahtar adıdır.

## 6. Varsayımlar
- Teams "Incoming Webhook" (klasik connector veya Power Automate uç noktası) kullanılacak; Graph API/bot
  senaryosu kapsam dışı. Klasik connector başarıda `1` döndürür, Power Automate boş gövdeyle 202 döner —
  ikisi de başarı sayılıyor, "failed/error/invalid" içeren 2xx gövdesi reddediliyor.
- Kurum SMTP relay'i submission portu (587 STARTTLS veya 465 implicit) sunuyor; DKIM/SPF relay tarafında.
- Eskalasyon merdivenini yürüten zamanlayıcı Temporal'dır: bu paket "şu an hangi adım" sorusunu saf
  fonksiyonla yanıtlar, `next.dueAt` doğrudan timer'a verilebilir; hangi adımların tetiklendiğini
  (`firedStepIds`) çağıran kalıcı tutar (workflow durumu ya da `StepEvent`).
- `runner_health` (M87) ayrı bir kod yolu gerektirmiyor: ops kanalı `NotifyRouting.byEvent.runner_health`
  parametresiyle seçilir; sürücüler olaydan bağımsızdır.
