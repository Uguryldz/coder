# Maestro · Akış ve ajan ekranı — şartname

Bu belge `maestro-akis.html` taslağının yazılı karşılığıdır. Taslak tıklanabilir bir
iskelettir, veriler sahtedir. Aşağıdaki her madde o iskeletin ne yapması gerektiğini
anlatır.

Amaç: bir Jira talebinin hangi statülerden geçtiğini, her statüde hangi ajanın
çalıştığını ve o ajanın hangi depoyu açacağını tek ekranda göstermek; kuralı aynı
ekrandan düzenletmek.

---

## 1. Ekran düzeni

Üç kolon, tam yükseklik, dikey kaydırma her kolonda ayrı.

```
┌ üst şerit ────────────────────────────────────────────────────────┐
│ Maestro · proje adı            dal · commit   [Önizle] [Kaydet]   │
├────────────┬──────────────────────────┬───────────────────────────┤
│ 230px      │ esnek                    │ 400px                     │
│ talepler   │ akış diyagramı           │ seçili adımın ayarları    │
└────────────┴──────────────────────────┴───────────────────────────┘
```

1100px altında kolonlar alt alta gelir.

**Sol — talepler.** Projeye bağlı ticket listesi. Her satır: anahtar, özet, bulunduğu
statü. Seçili satır beyaz zeminli ve solunda renkli çubuk.

**Orta — akış.** Seçili ticket'ın geçtiği statüler ve bağlı ajanlar. Detayı bölüm 2'de.

**Sağ — ayarlar.** Diyagramda seçilen kutunun ayarları. Detayı bölüm 3'te.

---

## 2. Akış diyagramı

SVG, ölçeklenir. Statüler solda dikey iner, bağlı ajanlar sağlarında durur.

### Kutu tipleri

| Tip | Görünüm | Anlamı |
|---|---|---|
| Statü | beyaz, ince çerçeve | Jira statüsü |
| Onay kapısı | krem zemin, kum rengi çerçeve | insan karar verecek |
| Ajan | açık yeşil zemin, yeşil çerçeve | o statüde çalışan bot |
| Boş ajan | gri, kesik çerçeve | bot bağlanmamış |

### Ok tipleri

| Ok | Anlamı |
|---|---|
| düz gri, "bot taşır" | ajan işini bitirince ticket'ı kendi taşır |
| düz gri, "insan onaylar" | geçiş insanın onayına bağlı |
| turuncu kesik, "reddedilirse yeniden" | onay kapısından bir önceki ajan adımına döner |
| yeşil kesik | statü ile ona bağlı ajan arasındaki bağ |

### Örnek akış (taslakta gösterilen)

```
Yapılacaklar
   ↓
Analizde ──── Analist        (depoyu klonlar, gereksinimi kodda arar)
   │             ↓ devreder
   │          Plancı         (analizden plan yazar, kod okumaz)
   ↓ bot taşır
Analiz onayı  [insan]  ──ret──► Analizde
   ↓ insan onaylar
Geliştirmede ── Geliştirici  (planı uygular, dala yazar)
   ↓ bot taşır
Kod incelemesi [insan] ──ret──► Geliştirmede
   │            └ Doğrulayıcı (kural kural PASS/FAIL)
   ↓ insan onaylar
Testte         (bot yok — insan yürütüyor)
   ↓
Bitti
```

Bot bağlanmamış statü akışı kesmez, o adım boş geçilir.

### Etkileşim

- Statü veya ajan kutusuna tıklanınca kutu seçili duruma geçer, sağ panel o kutunun
  ayarlarını gösterir.
- Kutular klavyeyle gezilebilir olmalı, seçili durum görünür olmalı.
- Boş ajan kutusuna tıklamak bot bağlama akışını açar.

---

## 3. Sağ panel — ajan ayarları

Seçili ajan için beş blok, sırayla.

### 3.1 Başlık ve arıza şeridi

Ajan adı, altında tek cümle: ne zaman çalıştığı. Ajanı engelleyen bir durum varsa
hemen altında kırmızı şerit: ne olduğu ve neyin sonucu olduğu. Örnek: depo
okunamıyorsa "analiz ticket metninden üretiliyor".

Arıza ticket'a değil ortama aitse (model seçilmemiş, kredi bitmiş) bu şerit ekranın
üstünde tek yerde durmalı, her ajanda tekrarlanmamalı.

### 3.2 Tetikleyici

Tek seçim: ajan ne zaman çalışsın.

- Statü "X" olduğunda
- Bir statüye geri gönderildiğinde
- Bota atandığında
- Etiket eklendiğinde

### 3.3 Hangi kod açılacak

Depo tek bir seçim değil, **ticket'ın bir alanına göre çözülen eşleme**.

**Depoyu belirleyen alan:** İş Ailesi · Bileşen · Etiket · alan kullanma (tek depo).

**Eşleme tablosu.** Sütunlar: iş ailesi değeri, depo, dal, ajanın göreceği yol.
Satır eklenip silinebilir.

Kritik: bu alanların hiçbiri serbest metin değil.

| Alan | Kaynak |
|---|---|
| iş ailesi değerleri | Jira alan tanımı |
| depo listesi | git sunucusu |
| dal listesi | seçilen deponun dalları |
| görülecek yol | serbest metin, boşsa tüm depo |

Çok değerli alanlarda (etiket, bileşen) her değer ayrı ayrı aranır. Karşılaştırma
Türkçe-duyarlı küçük harfe indirir ve boşluk kırpar.

**Hiçbir satır eşleşmezse:** varsayılan davranış "koşuyu açma, ticket'a *iş ailesi
eşleşmedi* yaz". İkinci seçenek proje varsayılan deposuna düşmek — ama bu, yeni bir
iş ailesi açıldığında ticket'ın yanlış depoda analiz edilmesi demektir ve çıktı normal
görünür. Varsayılan olmamalı.

**Doğrulama:** kaydederken deponun ve dalın gerçekten var olduğu sunucu tarafında
kontrol edilmeli. Bugün edilmiyor, hata klonlama anında patlıyor.

### 3.4 Çalışma ortamı

Analist ve geliştirici **aynı sandbox'ı** kullanır. Analistin okuduğu ağaç,
geliştiricinin yazdığı ağaçtır.

**Ortam:** varsayılan "depodan algıla". `package.json` → Node/React, `pom.xml` → Java,
`.csproj` → .NET, `pyproject.toml` → Python. Birden fazla varsa hepsi kurulur. Yanlış
algılarsa elle sabitlenebilir.

**Ömür:** ticket kapanınca · son koşudan 30 gün sonra · her koşudan sonra.
Sandbox aylarca açık kalabilir; boşta uyur, yeni koşuda kaldığı yerden uyanır,
dosyalar ve dal durur.

**Canlı durum satırı:** uyanık/uyuyor, hangi dal, kaç gündür açık, kim bağlı.

### 3.5 İş bitince

- Ticket şu statüye taşınsın: (statü listesi) veya "taşıma, yorum bırak"
- Onaylayacak kişi: ticket'ı açan · proje lideri · belirli kişi
- Reddedilirse: yeniden koş (ret gerekçesi ajana verilir) · dur, insana bırak
- En fazla kaç kez yeniden koşsun: 1–3

### 3.6 Zincir — 4 aşama

Açılır kapanır kartlar. Her kartta: sıra numarası, ajan adı, tek cümle görevi, durum
rozeti. Açılınca: gördükleri, yetkisi, kullandığı depo, modeli ve çıktı maddeleri.

| # | Ajan | Görür | Yetki | Çıktı |
|---|---|---|---|---|
| 1 | Analist | ticket + depo klonu | salt okuma | gereksinim listesi, kod karşılığı (dosya:satır), eksikler, ölçek riski, aday dosyalar, kapsam seçenekleri, açık sorular |
| 2 | Plancı | analiz belgesi + analistin notları | kod yazmaz, kapsamı değiştirmez | dosya listesi, uç sözleşmesi, DTO alanları, konvansiyonlar, sıra ve bağımlılıklar |
| 3 | Geliştirici | onaylı plan + iş kuralları | sandbox içinde yazar, koşunun dalında | kod, plan sapması satırları, kural→dosya eşlemesi |
| 4 | Doğrulayıcı | iş kuralları + diff | düzeltemez, yalnız raporlar | derleme sonucu, kural kural PASS/FAIL + kanıt, kırılan testler |

Depo satırı sabit yazılmaz, çözülmüş değeri ve **hangi satırdan geldiğini** gösterir:
"yaylagrup/billing · main · src/ — iş ailesi *Faturalama* satırından". Plancıda
"açılmaz — analistin notlarından okur" yazar.

---

## 4. Görsel dil

| Rol | Renk |
|---|---|
| zemin | `#E4E7E3` |
| yüzey | `#FFFFFF` |
| metin | `#14181C` / ikincil `#5A6470` |
| çizgi | `#C8CEC8` |
| ajan / onay | `#1F5F5B`, açık tonu `#DCE9E7` |
| insan kapısı, geri dönüş | `#A85B12`, açık tonu `#FBF3E7` |
| arıza | `#A32E2E`, açık tonu `#F6E0E0` |
| çalışıyor | `#2F6B3A` |

Tek yazı ailesi (Inter/sistem), ticket anahtarı ve depo adı için mono. Büyük harfli
etiket yok, cümle düzeni. Hareket yalnız kullanıcının açtığı kartlarda.

---

## 5. Yazım kuralları

- Sistem terimi değil, kullanıcının anladığı ad: "depo" evet, "repoMap satırı" hayır.
- Buton ne yapacağını yazar: "Değişiklikleri kaydet", "Gönder" değil.
- Hata mesajı ne olduğunu ve sonucunu söyler, özür dilemez.
- Boş durum davet eder: "Bot bağla — şimdilik burayı insan yürütüyor".

---

## 6. Bilinen boşluklar

Bunlar taslakta bilerek çözülmedi. Uygulamaya geçmeden karar verilmeli.

1. **Koşu kimliği.** Bugün `maestro-<TICKET>`, ticket başına tek koşu. Ret sonrası
   yeniden koşma bu haliyle çalışmaz — ikinci deneme "zaten var" deyip geçer. Her
   denemeye ayrı numara gerekiyor. Ekrandaki ret döngüsü bu yapılmadan sadece niyet.

2. **Paylaşılan sandbox kirleniyor.** Analist ve geliştirici aynı diski kullanınca,
   analist yeniden koştuğunda geliştiricinin yarım işini depodaki gerçek kod sanar.
   Oturumlar arası temizlik ya da analiste ayrı salt-okunur kopya gerekir.

3. **Uzun ömürlü klon eskiyor.** İki ay açık kalan sandbox iki aylık eski koddur.
   Uyanınca ana dalı çekmesi gerekir, çekince de yarım işle çakışır. İkisini birden
   çözen bir kural yazılmalı.

4. **Tek iş, iki depo.** Eşleme tek satır seçer. Servis ve arayüze birden dokunan
   işlerin karşılığı yok.

5. **Sandbox kotası.** Ticket kapanana kadar açık kalıyorsa 60 açık ticket 60 sandbox
   eder. Sınır ve terkedilmişleri toplayan mekanizma yok.

6. **Bağımlılık kaynağı.** Ortam algılandı diyelim — kurulum paketleri nereden inecek?
   Sandbox'ın iç Nexus'a erişimi ve kimliği tanımlı değil.

7. **Bütçe.** Koşu başına harcama tavanı ve ticket başına deneme sınırı yok. Ret
   döngüsü koyduk, maliyet tarafı boş.

8. **Ticket akış sırasında değişirse.** Onaydan sonra açıklama güncellenirse kimse fark
   etmiyor. Onay anındaki metnin parmak izi alınıp değişince uyarılmalı.

9. **Statüyü kim taşıdı.** Ticket'ı elle sürükleyen bir insanı bot kendi tetikleyicisi
   sanabilir. Kimin taşıdığını ayırt eden işaret gerekiyor.

10. **Koddan sonrası.** Geliştirici dala yazıyor, sonrası tanımsız: PR'ı kim açıyor, CI
    koşuyor mu, kimse birleştirmezse dallar ne oluyor.

11. **Katman karışıklığı.** Ekranın solunda tek ticket var, sağında tüm projeyi
    etkileyen kural. Kaydet'e basan kişi değişikliğin kapsamını bilmiyor. Ya sağ panel
    salt okunur olup kural düzenlemeye link vermeli, ya ekranın başlığı ticket değil
    kural olmalı.

12. **Koşu açılmayan haller.** Proje bağlı değilse, acil durdurma açıksa veya depo
    çözülemezse ticket olduğu yerde kalıyor ve ekranda iz yok. "Bot neden çalışmadı"
    en sık gelecek soru — statünün yanında sebep gösterilmeli.

13. **Koşu geçmişi.** Ekran anlık durumu gösteriyor. Kaçıncı deneme, önceki koşuda ne
    oldu, kim ne zaman reddetti — hiçbiri yok.

14. **Zaman aşımı.** Onay kapısında 48 saat geçerse ne olacağı tanımsız.
