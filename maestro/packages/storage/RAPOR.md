# `@maestro/storage` — Dalga 1 Builder Raporu

**Durum: YEŞİL.** `pnpm install` · `pnpm -F @maestro/storage typecheck` · `pnpm -F @maestro/storage test` ·
kökten `pnpm lint` ve `pnpm typecheck` — hepsi geçiyor. 160 test, 7 test dosyası.

---

## 1. Ne yapıldı

`StoragePort`'un (M5 / K67 BYOS) iki sürücüsü, ortak bir çekirdek üzerine yazıldı.

| Dosya | Satır | İçerik |
|---|---|---|
| `src/sigv4.ts` | 206 | AWS Signature V4 — sıfırdan, yalnız `node:crypto`. Kanonik istek, imza anahtarı zinciri, başlık-imzalama ve sorgu-imzalama (presign). |
| `src/s3.ts` | 281 | s3-compat sürücüsü: `put/get/list/delete/presign`, path-style + virtual-host adresleme, ListObjectsV2 sayfalama, Object Lock başlıkları. |
| `src/pg.ts` | 188 | pg-blob sürücüsü: enjekte edilebilir `SqlExecutor` üzerinden upsert/select/delete, WORM emülasyonu, `presign` → `CapabilityNotSupportedError`. |
| `src/keys.ts` | 148 | M56 saklama politikası: anahtar şeması, anahtar güvenliği, 10 yıl hesabı, yaşam döngüsü etiketleri. |
| `src/registry.ts` | 47 | `registerStorageDrivers(registry)` — M44 DI kaydı. |
| `src/errors.ts` | 70 | Açık hata sınıfları (sessiz düşüş yok). |
| `src/deps.ts` | 38 | Enjekte edilen işbirlikçiler: `FetchLike`, `Clock`, `SqlExecutor`. |
| `src/xml.ts` | 51 | S3'ün iki XML gövdesi için asgari okuyucu (ListObjectsV2 + Error). |
| **Toplam üretim** | **1037** | Tavan 1200 ✓ · en büyük dosya 281 satır (tavan 300 ✓) |

### Kararların gerekçeleri

**SigV4 elde yazıldı.** Hedef kurumsal S3-uyumlu uç; resmî SDK'nın kimlik-sağlayıcı zinciri,
IMDS sorgusu ve retry yığını hem ölü ağırlık hem egress riski. İmzanın kendisi ~150 satır
hash işi. Doğruluk, AWS'nin **yayımlanmış üç bilinen-cevap vektörüyle** çivilendi (aşağıda).

**Fail-closed Object Lock (M57).** `put(..., { objectLock: true })` çağrılır ve sürücü
yapılandırmasında `objectLock` yoksa → `ObjectLockNotConfiguredError`. **Hiçbir istek gönderilmez.**
Çağıran nesnenin WORM korumalı olduğunu sanacağı için sessizce korumasız yazmak yasak.
Bu davranış her iki sürücüde de aynı ve invariance paketinde ayrı test ediliyor
(mutasyon testiyle doğrulandı: kuralı kaldırınca testler kırılıyor).

**pg-blob neden Prisma istemcisini kullanmıyor** (talep edildiği üzere gerekçe):
1. Dalga 0 `@maestro/db`'de yalnız **taslak şema** var, üretilmiş istemci yok — import etseydim
   `prisma generate` koşmadan bu paket typecheck bile edilemezdi (dalga sırasını kilitler).
2. Üretilmiş bir Prisma istemcisi çevrimdışı sahtelenemez; her pg-blob testi canlı veritabanı
   isterdi. Bu, "tamamen çevrimdışı ve deterministik test" kuralının doğrudan ihlali olurdu.
3. Bunun yerine `SqlExecutor` (`query(sql, params) → rows`) tanımlandı. Kompozisyon kökünde
   tek satırlık bir adaptör yeter: `prisma.$queryRawUnsafe(sql, ...params)` ya da `pg` Pool.
   Tablo adı zod regex'iyle doğrulanır (`[şema.]ad`), diğer her değer **bağlı parametredir**;
   SQL metnine hiçbir kullanıcı verisi enterpole edilmez (test edilmiştir).

**Anahtar şeması (M56).** `evidence/<yıl>/<ticket>/<runId>/<dosya>` — yıl başta, çünkü yaşam
döngüsü kuralı tek prefix'le bir yılın tamamını sonlandırabilsin; ticket ikinci sırada,
çünkü denetçi tek ticket'ı ucuza listeleyebilsin. M65 için `archive/<yıl>/<ticket>/<dosya>`.
Saklama etiketleri (`maestro-class`, `maestro-retention-years`, `maestro-archive-after-days`)
veriyle birlikte gider; restore tatbikatında (M66) politika yalnız kovadan yeniden kurulabilsin.

**Sürücü-değişmezliği (masterplan §4).** `test/driver-contract.test.ts` tek bir test paketini
**üç koşum** üzerinde çalıştırır: s3-compat (path-style), s3-compat (virtual-host), pg-blob.
66 test. Kapsam: ikili/UTF-8 tam-tur, üzerine yazma, eksik anahtar hatası, prefix listeleme +
sıralama, boş prefix, eşleşmeyen prefix, `keyPrefix`'in çağırana görünmezliği, silme,
**eksik anahtarı silmenin no-op olması**, 8 farklı güvensiz anahtarın aynı hatayla reddi,
M56 kanıt anahtarıyla yaz+listele, M57 fail-closed, ve `presign` yeteneğinin ilanı.

---

## 2. Test özeti

| Dosya | Test | Odak |
|---|---|---|
| `driver-contract.test.ts` | 66 | **Sürücü-değişmezliği** — aynı paket 3 koşumda |
| `s3.test.ts` | 24 | Adresleme, imzalama, saklama başlıkları, presign, hata eşleme, sayfalama, config |
| `keys.test.ts` | 28 | Anahtar şeması, anahtar güvenliği, 10 yıl hesabı, etiketler |
| `pg.test.ts` | 16 | SQL yüzeyi, parametre bağlama, WORM emülasyonu, DDL |
| `sigv4.test.ts` | 10 | **AWS bilinen-cevap vektörleri** + kanonikleştirme kuralları |
| `xml.test.ts` | 8 | ListObjectsV2, varlık çözme, hata gövdesi |
| `registry.test.ts` | 8 | M44 kaydı, çözümleme, eksik bağımlılık reddi |
| **Toplam** | **160** | Ağ yok, saat enjekte, tamamen deterministik |

**Bilinen-cevap vektörleri (AWS dokümantasyonu, S3 örnekleri):**
- `GET /test.txt` başlık imzası → `f0e8bdb87c96...bdb41` ✓
- `PUT /test$file.text` başlık imzası → `98ad721746da...108bd` ✓ (gövde hash'i de bağımsız doğrulandı)
- Presigned URL, 86400 sn → `aeeed9bbccd4...4d404` ✓

> Not: `kSigning` türetimi için hafızadan yazdığım dördüncü bir vektör tutmadı ve
> **doğrulanamadığı için testten çıkarıldı** — yanlış beklentiyi koda uydurmak yerine attım.
> Üç yayımlanmış S3 imzası zaten `signingKey` zincirini uçtan uca kanıtlıyor.

**Sahteler gerçek denetim yapar (tautolojik test değil):**
- `FakeS3` her istekte SigV4 `Authorization` başlığını arar ve `x-amz-content-sha256`'yı gövdeden
  yeniden hesaplayıp karşılaştırır; uyuşmazsa 400 döner. Sayfa boyutu 1-2'ye çekilerek
  continuation döngüsü gerçekten koşturulur.
- `FakePg` yalnız sürücünün üretmesi gereken ifadeleri tanır, **tanımadığına `throw` eder**;
  parametre sayısını ve `$2`'nin `Uint8Array` olduğunu doğrular.

**Mutasyon denetimi** (testlerin ısırdığının kanıtı — 4/4 yakalandı):

| Mutasyon | Sonuç |
|---|---|
| M57 fail-closed kuralını sessiz düşüşe çevir | KIRILDI ✓ |
| Sayfalamayı ilk sayfada durdur | KIRILDI ✓ |
| pg `presign` gerçek URL uydursun | KIRILDI ✓ |
| `..` segment kontrolünü kaldır | KIRILDI ✓ |

---

## 3. Varsayımlar

1. **`delete` fikirseldir (idempotent).** Olmayan anahtarı silmek her iki sürücüde de sessizce
   başarılıdır (S3'ün doğal davranışı; pg'de `DELETE` 0 satır etkiler). Port dokümante etmiyordu;
   invariance testi bunu sözleşme olarak sabitliyor.
2. **`list` mantıksal anahtar döndürür.** `keyPrefix` yapılandırılmışsa çağıran onu hiç görmez —
   ne `put`'ta verir ne `list`'te alır.
3. **`content-length` imzalanmaz ve gönderilmez.** `fetch` bu başlığı kendi yönetir ve
   çağıranınkini atar; imzalasaydım imza uçta geçersiz olurdu. `host` imzalanır ama açıkça
   gönderilmez (fetch onu URL'den türetir, ikisi yapısal olarak aynıdır).
4. **Varsayılan adresleme `path`.** Kurumsal uçlarda joker DNS/TLS genelde yok.
5. **Saat enjekte edilir** (`now`); saklama son tarihleri bu yüzden testte birebir sabittir.
6. `retainUntil` UTC takvimiyle çalışır; 29 Şubat başlangıcı 1 Mart'a yuvarlanır — saklamayı
   **uzatır**, asla kısaltmaz.

---

## 4. Arayüz / bağımlılık talepleri (orkestratör kararı gerekir)

1. **Bağımlılık — kabul edilebilir olduğunu düşünüyorum, onayınıza sunulur:**
   `@types/node` **devDependency** olarak eklendi (`node:crypto`, `Buffer`, `URL` tipleri için).
   Yeni **runtime** bağımlılığı **yok**; `@maestro/test-kit` zaten aynı devDependency'yi
   taşıdığından sürüm ve lockfile açısından bedelsiz.
2. **`StoragePort` arayüz talebi (DOKUNMADIM, karar sizin):** `get` bir `Uint8Array` döndürüyor,
   yani nesne tamamen belleğe alınıyor. Kanıt paketleri ve workspace arşivleri (M34/M65) yüzlerce
   MB olabilir. Dalga 2'den önce `getStream`/`putStream` eklenmesi ya da `put`'un
   `AsyncIterable<Uint8Array>` kabul etmesi değerlendirilmeli. Bugün için sınır: nesne boyutu
   ≈ süreç belleği.
3. **`db` paketine görev devri:** `pgBlobTableDdl()` ihtiyaç duyulan tabloyu (`storage_blob`)
   üretiyor ve sütunları teste bağlanmış durumda; asıl migration'ı Dalga 1 `db` paketi yazmalı.
   Sütunlar: `key/data/content_type/tags/object_lock/retain_until/created_at/updated_at`.
4. **`config` paketine öneri:** `STORAGE_ENDPOINT` env'i var ama bucket/anahtar/adresleme yok.
   Kompozisyon kökü yazılırken `S3StorageOptions`/`PgBlobStorageOptions` şemaları oradan
   beslenmeli; şemalar bu paketten export ediliyor.

---

## 5. Bilerek eksik bırakılanlar

1. **S3'te WORM ihlalinin hata eşlemesi.** Nesne kilidi nedeniyle reddedilen üzerine-yazma/silme
   gerçek S3/MinIO'da HTTP 403 + `<Code>AccessDenied</Code>` döner — kilide özgü, ayırt edilebilir
   bir kod yoktur. Uydurma bir kod ("halüsinasyon entegrasyon") yazmaktansa bugün
   `StorageRequestError` bırakıldı; **pg-blob** tarafında ise Postgres'in böyle bir özelliği
   olmadığı için kilit sürücüde emüle edilir ve `ObjectLockedError` atar. Bu tek nokta iki sürücü
   arasında farklıdır ve bu yüzden invariance paketinde **değildir**. Kapanışı: gerçek uçtan
   kaydedilmiş yanıt fikstürüyle (insa-plani §6, Aşama-0 duman testi).
2. **Çok parçalı yükleme (multipart upload).** Büyük nesneler için gerekli; yukarıdaki (4.2)
   akış arayüzü kararına bağlı, o karardan önce yazmak boşa iş olur.
3. **Kova yaşam döngüsü kuralının uca uygulanması.** Politika veriyle birlikte etiket olarak
   gidiyor; kuralın kovaya `PutBucketLifecycleConfiguration` ile basılması bir kurulum/deploy
   işidir (`deploy` paketi), sürücünün çalışma zamanı işi değil.
4. **Retry/backoff ve devre kesici.** Bilinçli olarak dışarıda: bunlar tüm portlar için ortak bir
   politika katmanıdır (llm-gateway'de de aynı ihtiyaç var); her sürücüye ayrı ayrı yazmak
   v1'in dağınıklığını tekrarlar. Orkestratör ortak bir sarmalayıcıya karar vermeli.
5. **Sunucu tarafı şifreleme (SSE-KMS) başlıkları.** Masterplan'da bir M kararı yok; spec dışına
   taşmamak için eklenmedi.

---

## 6. Not: dal tabanı

Worktree `origin/main` (`1c78e71`) üzerinden açılmıştı ve o commit'te `maestro/` dizini **yok**.
Dalga 0 çalışması yalnız yerel `main`'de (`0dfde46`) duruyor. Bu yüzden bu paket
`wave1-storage` dalında, `0dfde46` tabanı üzerine yazıldı. main'e merge edilmedi, push edilmedi.
