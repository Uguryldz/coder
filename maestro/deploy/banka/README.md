# Maestro — Banka İçi (İnternetsiz) Kurulum

Bu paket, Maestro'yu **internete çıkmayan** bir sunucuya kurmak içindir.
Referans desen: `wendoc.ai/Docker/ugurdocker` (imaj adresleri `.env`'de, sırlar
`.env`'de, named volume, tek komut kurulum).

**Kurulum yapan kişinin bilmesi gerekenler bu dosyada; sırayla okuyun.**

---

## 0. Önce şunu bilin: imajlar DIŞARIDA hazırlanır

İnternetsiz sunucuda **build yapılmaz** (`pnpm install` ve `apt-get` internet
ister). Akış şudur:

```
[İnternetli makine]                    [Banka sunucusu]
  build → docker save → .tar   ──USB/SFTP──→   docker load → docker compose up
```

Ya da bankanın kendi registry'si (Nexus/Harbor) varsa: dışarıda build → push →
sunucuda pull. İkisi de aşağıda anlatılıyor.

---

## 1. Dışarıda imaj hazırlama (internetli makinede)

### 1.1 Kaynağı al ve sürümü sabitle

```bash
git clone <maestro-repo> maestro && cd maestro
git checkout <sürüm-etiketi>          # hangi commit'ten build edildiği kayda geçsin
git rev-parse --short HEAD            # bu değeri not edin — imaj etiketi olacak
```

### 1.2 İki imajı build et

`node` imajı tek tanedir; **BFF, worker ve migration** rolleri aynı imajdan
`MAESTRO_ENTRYPOINT` env'i ile ayrılır (bkz. `deploy/docker/Dockerfile.node`).
Bu yüzden üç değil **iki** imaj taşınır.

```bash
export TAG=$(git rev-parse --short HEAD)

docker build -f deploy/docker/Dockerfile.node   -t maestro/node:$TAG   .
docker build -f deploy/docker/Dockerfile.studio -t maestro/studio:$TAG .
```

### 1.3 Build'i DOĞRULA (bu adımı atlamayın)

Geçmişte imaj sessizce bozuk çıktı: `apt-get` başarısız olduğu hâlde build
"başarılı" göründü ve Prisma yanlış OpenSSL tahminiyle çalıştı.

```bash
# a) OpenSSL gerçekten kurulu mu (Prisma query engine için şart)
docker run --rm --entrypoint sh maestro/node:$TAG -c "openssl version"
#    Beklenen: OpenSSL 3.x ...    Hata verirse imaj KULLANILMAZ.

# b) Migration dosyalarının TAMAMI imajda mı
docker run --rm --entrypoint sh maestro/node:$TAG \
  -c "ls /app/packages/db/prisma/migrations | wc -l"
#    Beklenen: depodaki migration klasör sayısıyla AYNI sayı.
#    Az çıkarsa imaj bayattır — yeniden build edin.

# c) Studio bundle'ı üretilmiş mi
docker run --rm --entrypoint sh maestro/studio:$TAG \
  -c "ls /usr/share/nginx/html/index.html && echo VAR"
```

### 1.4 Yan imajları da topla

Bunlar Docker Hub'dan gelir, bankada yoktur:

```bash
docker pull postgres:17-alpine
docker pull redis:7-alpine
docker pull temporalio/auto-setup:1.25.2
docker pull temporalio/ui:2.32.0
```

### 1.5 Tek tar dosyasına paketle

```bash
docker save \
  maestro/node:$TAG \
  maestro/studio:$TAG \
  postgres:17-alpine \
  redis:7-alpine \
  temporalio/auto-setup:1.25.2 \
  temporalio/ui:2.32.0 \
  | gzip > maestro-imajlar-$TAG.tar.gz

sha256sum maestro-imajlar-$TAG.tar.gz > maestro-imajlar-$TAG.sha256
```

Taşınacak dosyalar: `maestro-imajlar-$TAG.tar.gz`, `.sha256` ve bu `banka/`
klasörü (compose + .env.example + install.sh + README).

---

## 2. Banka sunucusunda kurulum

### 2.1 Ön koşullar

- Docker Engine + Compose v2 (`docker compose version` çalışmalı)
- 4 CPU / 16 GB RAM önerilir (asgari 2 CPU / 8 GB)
- Disk: imajlar ~3 GB + veritabanı büyümesi
- Sunucudan erişilebilmesi gerekenler: **Jira Data Center**, **Azure DevOps
  Server/TFS**, **LDAP/AD**, **kurum içi LLM uç noktası**

### 2.2 İmajları yükle

```bash
sha256sum -c maestro-imajlar-<TAG>.sha256     # bütünlük kontrolü
gunzip -c maestro-imajlar-<TAG>.tar.gz | docker load
docker images | grep maestro                  # iki imaj görünmeli
```

### 2.3 Yapılandır

```bash
cd banka
cp .env.example .env
# .env'i doldurun — ZORUNLU alanlar dosyada "ZORUNLU" diye işaretli
```

### 2.4 Kur

```bash
./install.sh          # ön kontrolleri yapar, sırayla başlatır, sağlığı bekler
```

Panel: `http://<SUNUCU_IP>:7000`

---

## 3. Kurulum sonrası doğrulama

```bash
docker compose ps                    # hepsi healthy/running olmalı
docker compose logs migrate          # "migrations applied" görmelisiniz
curl -f http://localhost:7001/readyz # BFF hazır mı
curl -f http://localhost:7000/healthz
```

**İlk giriş:** `.env`'deki `BOOTSTRAP_ADMIN_*` değerleriyle. İlk oturumda parola
değiştirmeniz istenir.

---

## 4. Bilinen tuzaklar (sahada yaşandı)

| Belirti | Sebep | Çözüm |
|---|---|---|
| LLM çağrısı 404 | `LLM_BASE_URL` sonunda `/v1` var; sürücü zaten ekliyor | Sonundaki `/v1`'i **silin** |
| `gizli` işler maskeleniyor/reddediliyor | `LLM_ON_PREM=false` kalmış | `true` yapın (endpoint gerçekten kurum içiyse) |
| `SecretNotFoundError` | LLM anahtarı boş bırakılmış | Yerel endpoint yetki istemese de **dolu bir değer** yazın |
| `unable to verify the first certificate` | Banka CA'sı Node'un listesinde yok | `NODE_EXTRA_CA_CERTS` ayarlayın + CA'yı mount edin |
| `migrate` konteyneri exit 1 | Bayat imaj | Güncel koddan yeniden build (§1.3-b ile doğrulayın) |
| Prisma "failed to detect libssl" | İmajda OpenSSL yok | §1.3-a doğrulaması; imajı yeniden build edin |

---

## 5. Güncelleme (veri korunarak)

```bash
# Yeni imaj tar'ını yükleyin, sonra:
# .env'de MAESTRO_NODE_IMAGE / MAESTRO_STUDIO_IMAGE etiketini yeni sürüme çevirin
docker compose up -d          # migrate otomatik çalışır, veri korunur
```

**ASLA `docker compose down -v` çalıştırmayın** — `-v` veritabanı volume'ünü siler.

---

## 6. Yedekleme

```bash
# Veritabanı
docker compose exec -T postgres pg_dump -U maestro maestro | gzip > maestro-$(date +%F).sql.gz

# .env dosyası da yedeklenmeli (sırlar orada) — güvenli yerde saklayın
```

---

## 7. Bu kurulumda ÇALIŞMAYAN şeyler

Dürüst liste — sunum değil, kurulum gerçeği:

- **SIEM'e otomatik log akışı yok.** CEF/syslog biçimlendirici hazır, ama
  toplayıcıya ileten taşıyıcı yazılmadı. Bugün denetim kaydı panelden
  JSON/CSV indirilir.
- **E-posta bildirimi yok.** SMTP sürücüsü yazıldı, taşıma katmanı bağlanmadı.
  Çalışan kanallar: Jira yorumu, Teams, Slack.
- **SAML/OIDC SSO yok.** Kimlik doğrulama LDAP/LDAPS veya yerel hesap.
- **GitLab/Bitbucket adapter'ı yok.** Desteklenen: Azure DevOps Server/TFS,
  GitHub Enterprise, Jira Data Center.
- **Geliştirme hattı (kod yazma → PR → merge) uçtan uca canlı denenmedi.**
  Analiz hattı doğrulanmıştır; kod hattı altyapısı yazılıdır.
