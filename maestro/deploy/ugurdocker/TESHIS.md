# Prod'da bir şey ters gittiğinde

Bu dosya tek bir soruya cevap verir: **"çalışmıyor" derken elimde ne var, ne
göndereceğim?**

Üç araç var. Hepsi konteyner içinde çalışır, hiçbiri veri yazmaz, hiçbiri
sır sızdırmaz.

---

## 1. Tanı raporu — önce bunu gönderin

Tek dosya, HTML. Yapılandırma bulguları, akış durumu, canlı Jira testi ve
maskelenmiş servis logları birlikte.

```bash
docker compose exec -T bff \
  node /app/apps/deploy/dist/bin/tani.js --out /tmp/tani.html
docker compose cp bff:/tmp/tani.html ./tani.html
```

Kaynak koddan çalışan bir kurulumda:

```bash
pnpm -F @maestro/deploy tani -- --out ./tani.html
```

**Çıkış kodu bir sinyaldir:** `0` temiz, `3` kritik bulgu var (rapor yine
üretilir). Bir CI adımı bu kodu okuyabilir.

**Ne maskelenir:** GitHub / Jira / OpenRouter token'ları, veritabanı
bağlantı dizesindeki parola, sır referansları. Ölçüldü: rapor bunların
hiçbirini içermiyor. Yine de paylaşmadan önce bir göz atın — kurulumunuza
özgü bir alan eklenmişse maskeleyici onu tanımıyor olabilir.

**Ne göndereceksiniz:** `tani.html`. Tek dosya, tarayıcıda açılır.

---

## 2. Kural provası — "bot neden çalışmıyor" sorusu için

Bir dinleme kuralının uçtan uca ne yapacağını gösterir: taramanın kuracağı
JQL gerçek Jira'ya sorulur, dönen her ticket gerçek eşleşme mantığıyla
sınanır, sonra hangi adımların koşacağı ve hangi kapıların açılacağı yazılır.

**Ajana hiçbir şey göndermez, koşu açmaz, kayıt yazmaz.**

```bash
docker compose exec -T bff node /app/apps/deploy/dist/bin/kural-provasi.js
```

Örnek çıktı:

```
━━ kural: label="maestro" · akış=analiz ━━
  1. Tarama    → 10 ticket bulundu
  2. Eşleşme   → 10/10 ticket kurala düştü  (OPS-79, OPS-78, OPS-77)
  3. Adımlar   → 2 tamlık → 2b soru → 3ö keşif → 3 analiz+plan → 4/5 onay → 13 teslim
  4. Kapılar   → 4, 5
  5. Statü     → taşıma yok, yalnız yorum
  6. Depo      → proje bağlamasının varsayılanı
```

`1. Tarama → 0 ticket` görüyorsanız kural hiçbir şey bulmuyor: tetikleyici
değeri, bot hesabı ya da statü kapısı ticket'larla uyuşmuyor. `1. Tarama`
dolu ama `2. Eşleşme → 0/N` ise sorgu buluyor, eşleşme eliyor — genellikle
takım yönetimli projede ad/id farkı.

---

## 3. Mini keşif testi — "kodu gerçekten okuyor mu"

Bir koşunun klonunu açar ve salt-okunur ajan oturumunda depoyu okutur.
Çıktı, analiz belgesindeki "kod tabanındaki karşılığı" bölümünün ham hâlidir.

**Model kredisi harcamaz** — keşif oturumu CLI koltuğunu kullanır, HTTP LLM
kanalını değil.

```bash
docker compose exec -T bff node /app/apps/deploy/dist/bin/mini-test.js OPS-119
```

`✗ çalışma alanı BOŞ` görüyorsanız klon açılmamıştır: `WORKSPACE_ROOT` ve
`SCM_TOKEN_REF` tanımlı mı bakın. Klon var ama oturum açılmıyorsa
`CLAUDE_BIN_PATH` eksiktir.

---

## Hangi durumda hangisi

| Belirti | Araç |
|---|---|
| Servis açılmıyor, ekran hata veriyor | 1 — tanı raporu |
| Ticket'lar işlenmiyor, bot sessiz | 2 — kural provası |
| Analiz geliyor ama kodla ilgisi yok | 3 — mini keşif testi |
| Ne olduğunu bilmiyorum | 1, sonra çıktısına göre 2 veya 3 |

---

## Log'ları elle toplamak gerekirse

Tanı raporu servis loglarını zaten içerir. Yine de ham log isterseniz:

```bash
docker compose logs --no-color --tail 500 bff worker > loglar.txt
```

Bu dosya **maskelenmemiştir**: token, parola ve bağlantı dizeleri içerebilir.
Paylaşmadan önce okuyun. Maskelenmiş hâli için tanı raporunu kullanın.
