# HANDOFF

## DURUM
Beş commit hazır (`c6c9799` → `06bc27a`), çalışma ağacı temiz, imajlar **1.0.4** olarak
derleniyor. Kullanıcının şikâyeti "proda deploy edince yüzlerce hata alıyorum, analiz bile
yapamadım" idi; bu oturumda temiz bir prod kurulumu sıfırdan yapıldı ve sebepler bulundu.

## Prod kurulumu SORUNSUZ kalkıyor
Temiz dizinde `install.sh` çalıştırıldı: altı konteyner sağlıklı, migrate geçici parolayı
düzgün bastı, panel ve API erişilebilir. Hata kurulumun kendisinde DEĞİL.

## "Analiz bile yapamadım"ın iki sebebi (ikisi de `.env`'de yorumlu geliyordu)
1. **`MAESTRO_FLOW` boş** → kurala uymayan ticket TAM boru hattına girer: analiz yazılır, iki
   kapı onaylanır, sonra mühendislik adımında `RUNNER_IMAGE_LINUX` yok diye ölür. İş bittikten
   SONRA, en pahalı yerde. (OPS-38 böyle öldü.)
2. **`JIRA_POLL_MS` boş** → ticket'a yazılan `/approve` hiç okunmaz. Jira Cloud'da webhook
   imzası doğrulanamadığı için yoklama TEK yoldur; kapı sonsuza dek bekler.

`install.sh` artık ikisini de kontrol edip onay istiyor (dayatmıyor — kod yazan saha için ikisi
de meşru). Davranış `banka-bundle.test.ts`'te kilitli.

## Bu oturumda düzeltilen diğer gerçek hatalar
- **Jira Cloud Studio'dan HİÇ kurulamıyordu**: sürücü `config.email` ile Basic auth kurar,
  formda o kutu yoktu → her satır `basicAuth("", token)` gönderip 401 alıyordu.
- **`authKind` seçicisi ölüydü**: dört seçenek sunuyordu, `probeFor` şemayı türden belirliyor
  ve o alanı hiç okumuyordu. Kaldırıldı.
- **Test notu parametrelerini kaybediyordu**: "DNS: {host}" sayfa yenilenince literal `{host}`.
  İki prob (panel + sağlık sayfası) artık aynı kodlayıcıyı kullanıyor.
- **Boş `SCM_HOST`** her klonlamayı `https:///owner/repo.git` yapıyordu (`?.trim()` yalnız
  anahtar YOKKEN `undefined` döner; compose `${SCM_HOST:-}` gönderiyor = var ve boş).
- **`/projects` → "Uygulama ekle"** repo olmadan hiç gönderilemiyordu; kuru koşu da repo
  istiyordu (oysa prova depoya hiç dokunmaz).
- **Worker healthcheck'i `NONE`'dı**: ayakta ama iş alamayan worker'ı kimse göremiyordu.

## Autoheal — "analiz botu hiç ölmeyecek"
Compose sağlık durumuna göre restart ETMEZ (`restart: unless-stopped` yalnız süreç ölünce).
Ölçüldü: prod test yığınında worker sekiz dakika `unhealthy`, `RestartCount` 0.
`apps/deploy/src/bin/autoheal.ts` bu halkayı kapatıyor — aynı node imajından koşar, yalnız bu
compose projesinin konteynerlerini, yalnız `restart` fiiliyle. Soket salt-okunur.
**Açılış taraması şart**: Docker `unhealthy`'yi yalnız GEÇİŞ anında yayınlar, yani zaten takılı
olan hiç olay üretmez. Canlıda doğrulandı: tarama takılı worker'ı bulup kurtardı.

## Devam eden (bu satır yazılırken)
- Tam test paketi (`turbo run test typecheck --concurrency=2`)
- `docker build` → `uguryldz/maestro-node:1.0.4` ve `uguryldz/maestro-studio:1.0.4`
- Sonraki adım: **push** (kullanıcı onayı var: "son bi tarama yap eminsen çıkalım")

## Sıradaki iş
1. İmajlar bitince `docker push` (iki imaj).
2. Prod yığınını 1.0.4 ile yeniden kurup worker'ın `healthy` olduğunu doğrula — 1.0.3'te
   healthcheck kodu olmadığı için `unhealthy` görünüyordu, bu BEKLENEN durumdu.
3. Jira token'ı olmadığı için prod yığınında gerçek ticket koşturulamadı. Analiz zincirinin
   LLM'e kadarki kısmı kanıtlandı (imajın içinden gerçek OpenRouter çağrısı HTTP 200, on-prem
   `openai_compat` bağlantısı yeşil), Jira'lı uçtan uca kanıt eksik.

## Testler
Tek tek: bff 918/918 · deploy 784/784 · studio 404/404 · workflows 199/199 · config 26/26 ·
pii 154/154 · adapter-jira 67/67. Turbo'nun toplu koşusu bu makinede YÜK yüzünden ALAKASIZ
paketleri kırmızı gösterebiliyor (23 GB kullanımda, yük ortalaması 17) — düşen paketi TEK
BAŞINA koştur, geçiyorsa kod sağlamdır.

## Tuzaklar
- `pkill -f "src/bin/worker.ts"` kendi kabuğunu vurur; `\.ts` diye kaçır.
- Jira Cloud auth **Basic** (`email:token`), DC **Bearer** — iki ayrı sürücü.
- `contracts`/`ports` FROZEN — ama `FlowType` ve `CONNECTION_KIND_SPECS` contracts'a eklendi
  (workflows paketi BFF'i import edemez, M44).
- `unbound` sessizliği KASITLI (M102): tek küresel webhook her projeyi görür, cevap vermek
  "Maestro burayı izliyor" bilgisini sızdırır. Testle korunuyor — bug sanıp "düzeltme".
- Bot hesabı `User` tablosunda `maestro-admins` üyesi (dört-göz muafiyeti). **Bankaya giderken SİL.**
- `.playwright-mcp/` artık `.gitignore`'da (734 dosya `git status`'u okunmaz yapıyordu).
