# @maestro/audit — builder raporu

Denetim izinin **TEK** gerçeklemesi: SHA-256 hash zinciri · tek yazar kuralı · kurcalama/silme/yeniden
sıralama tespiti · günlük imzalı anchor · ArcSight CEF/syslog SIEM export (M33, M56, M32, M101).

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/canonical.ts` | Kanonik serileştirici (kendi yazıldı). Anahtarlar UTF-16 sırasıyla sıralı, boşluk yok, string'ler JSON kaçışlı **+ `\|` ayrıca `|` olarak kaçırılır**. Temsil edilemeyen değerler (`undefined`, `NaN`/`Infinity`, `bigint`, fonksiyon, symbol, `Map`/`Set`/`RegExp`, sınıf örneği, döngü, geçersiz `Date`) sessizce atlanmaz — `AuditCanonicalizationError` ile **reddedilir**. `Date` tek istisna: UTC ISO string'e serileşir. |
| `src/hash.ts` | `chainInput` = `seq \| at \| actor \| action \| subject \| prevHash \| canonical(meta)`; `computeEventHash` (sha256, küçük harf hex), `sealEvent` (çekirdek kayıt → sözleşmeden geçmiş `AuditEvent`), `rehash` (saklı kayıttan yeniden hesap), `sha256Hex`, `GENESIS = "genesis"`. |
| `src/actor.ts` | `parseActor` / `assertActor` / `humanBehind` / `isHumanActor`. Kabul edilen dört biçim: `user@corp` · `maestro-worker` · `maestro-runner` · `ai-via:<user>` (M101). Sınıflandırılamayan aktör append anında reddedilir. |
| `src/actions.ts` | `AUDIT_ACTION_INFO: Record<AuditAction, AuditActionInfo>` — CEF severity (0-10) + insan-okur ad + kategori + (varsa) outcome + `humanOnly`. **`Record` olduğu için contracts'a yeni action eklenirse bu dosya derleme hatası verir.** |
| `src/store.ts` | `AuditStore` arayüzü (`head` · `append` · `read`) + `InMemoryAuditStore`. Depo append-only: ilerlemeyen `seq` ve tekrar eden `hash` reddedilir (Postgres'teki unique index'in aynısı). **Prisma import edilmedi.** |
| `src/chain.ts` | `AuditChain` (tek gerçekleme): `append` · `appendMany` (tek kilit altında bütün bir koşu) · `head` · `verify`. `ChainLock` arayüzü + `LocalChainLock` (süreç içi sıraya alıcı, hata kuyruğu zehirlemez). `Clock` enjekte edilir; `at` her zaman UTC'ye normalize edilir. |
| `src/verify.ts` | `verifyChain(events, options?)` → `{ ok, checked, firstBadSeq, headHash, issues[] }`. Bulgu türleri: `schema_invalid` · `hash_mismatch` · `prev_hash_mismatch` · `sequence_gap` · `out_of_order` · `bad_start`. Dilim doğrulaması için `expectFirstSeq` / `expectPrevHash`. |
| `src/anchor.ts` | Günlük anchor (M33): `AuditAnchorBody`/`AuditAnchor` Zod şemaları, `buildAnchor` (gün dilimini önce doğrular, sonra imzalar), `verifyAnchor`, `chainDigestOf` (günün TÜM hash'leri üzerinden özet — sadece zincir başı değil), `utcDayOf`, `eventsOfDay`, `AnchorSigner` arayüzü + `HmacAnchorSigner`. Ayrıca M56: `AUDIT_RETENTION_YEARS = 10` + `retentionExpiryOf`. |
| `src/cef.ts` | `toCefLine` / `toCefLines` / `toSyslogLine` + `escapeCefHeader` / `escapeCefExtension`. Başlık: `CEF:0\|Maestro\|Maestro\|<ver>\|<action>\|<name>\|<severity>\|<ext>`. |
| `src/errors.ts` | `AuditCanonicalizationError` · `AuditActorError` · `AuditChainError` · `AuditAnchorError` · `AuditExportError`. |

**Üretim kodu: 1125 satır** (tavan 1200), en büyük dosya 213 satır (tavan 300).

### Kurcalama tespiti — denetim ekibine gösterilecek kanıt
| Saldırı | Nasıl yakalanır | Test |
|---|---|---|
| Kaydı **değiştir** (ör. onaylayanı değiştir, hash'e dokunma) | kaydın kendi alanlarından yeniden hesaplanan hash tutmaz → `hash_mismatch`, `firstBadSeq = 3` | `verify.test.ts` "catches a TAMPERED record" |
| `meta` içine tek anahtar ekle | aynı şekilde `hash_mismatch` | "catches a tampered meta field" |
| Kaydı **sil** | `sequence_gap` (kaç kayıt eksik dahil) + `prev_hash_mismatch` | "catches a DELETED record" |
| İlk kaydı sil | `bad_start` ("expected 1", "expected genesis") | "catches deletion of the first record" |
| Kayıtları **yeniden sırala** | `out_of_order` + `prev_hash_mismatch` | "catches REORDERED records" |
| Kaydı çoğalt | `out_of_order` | "catches a duplicated record" |
| Başka zincirden kayıt yapıştır (kendi içinde geçerli) | `prev_hash_mismatch` | "catches a record swapped in from another chain" |
| **Tüm günü yeniden yaz** (zincir kendi içinde tutarlı olur) | hash zinciri yakalayamaz — **anchor yakalar**: `headHash` / `chainDigest` uyuşmaz | `anchor.test.ts` "catches a rewritten chain that is internally consistent" |
| Zincirin **sonunu kırp** | zincir tek başına geçerli görünür (raporda açıkça yazılı); anchor `eventCount`/`headHash` ile yakalar | "catches deletion of the last record…" + "catches a truncated day" |

### Tek yazar kuralı
`AuditChain.append` "head oku → sıradaki kaydı yaz" işini `ChainLock` altında yapar. M33 "tek yazar"
bir **dağıtım kararıdır, garanti değildir**: aynı worker'da iki eşzamanlı aktivite aynı head'i okur ve
aynı `seq`+`prevHash` ile iki kayıt üretir — zincir çatallanır. Kilit arayüz olduğu için Dalga 3'te
worker'a Postgres advisory lock enjekte edilir, bu paket veritabanı bağımlılığı kazanmaz.
İki test bunu ispatlıyor: kilitle 50 eşzamanlı append → `seq` 1..50 kesintisiz ve zincir doğrulanıyor;
kilitsiz (testin kendi `NO_LOCK`'u ile) → yazımların çoğu reddediliyor, zincir çatallanamıyor.

## 2. Testler

`pnpm -F @maestro/audit test` → **8 dosya / 78 test, hepsi yeşil.** Tamamen çevrimdışı ve deterministik:
ağ yok, dosya yok, `Date.now()` yok — saat `fixedClock` ile enjekte ediliyor, imza anahtarı testte sabit.

- `canonical.test.ts` (11): anahtar sırası bağımsızlığı, iç içe sıralama, 20 koşuda tek çıktı, pipe kaçışı ve çakışma önleme, JSON kaçışları + yalnız-vekil, `Date`, sayı biçimi, 11 reddedilen tür, döngü, sınıf örneği, null-prototip.
- `hash.test.ts` (8): tam chain-input string'i, sha256 eşitliği, 25 koşuda tek hash, meta anahtar sırası, **her alanın tek tek hash'i değiştirmesi**, pipe kaydırma saldırısı, `sealEvent` sözleşme reddi.
- `actor.test.ts` (6): dört biçim, delegasyonun arkasındaki insan, AI ≠ insan, 14 reddedilen biçim, hata mesajının biçimleri sayması.
- `chain.test.ts` (12): genesis, bağlama, UTC normalizasyonu, aktör reddi, **gate kararı için insan-olmayan aktör reddi**, geçersiz zaman damgası, 50 eşzamanlı append, kilitsiz çatallanma ispatı, `appendMany` bütünlüğü, hata sonrası kuyruk sağlığı, depo değişmezleri, aralık okuma.
- `verify.test.ts` (13): yukarıdaki tablo + boş girdi (`checked: 0`), dilim doğrulama, sahte genesis, `AuditEvent` olmayan kayıt.
- `anchor.test.ts` (13): özet + imza, tekrarlanabilirlik, doğrulama (kayıtlı/kayıtsız), değiştirilmiş anchor, yeniden yazılmış zincir, kırpılmış gün, yanlış anahtar/keyId, kırık zinciri imzalamayı reddetme, boş gün / karışık gün, şema reddi, kanonik gövde imzası, gün gruplama, 10 yıl saklama.
- `cef.test.ts` (10): **25 AuditAction'ın hepsi için üretilen satır bağımsız ayrıştırıcıyla parse ediliyor** ve her alan doğrulanıyor; `ai-via` delegasyonu, kaçış saldırısı (`|`, `=`, `\`, `\n`, satır içine gömülü sahte `CEF:0|Evil|…` başlığı), kaçış kuralları, meta'sız satır, geçersiz kayıt reddi, toplu export; syslog: RFC 3164 çerçevesi, severity eşlemesi, host/facility doğrulaması.
- `actions.test.ts` (5): tablo ↔ enum birebir örtüşmesi, severity aralığı + ad kalitesi, önem sıralaması, `humanOnly` ve `outcome` kümelerinin tam listesi.

**CEF ayrıştırıcısı bilerek `src/cef.ts`'in tersi DEĞİL** (`test/cef-parser.ts`): format kurallarından
bağımsız yazıldı. İki taraf ortak kod kullansaydı yanlış bir kaçış kuralı da mutlu mutlu round-trip
ederdi ve Splunk/QRadar yine okuyamazdı; bağımsız ayrıştırıcı sayesinde test gerçek kanıt oluyor.

## 3. Varsayımlar

1. **Kalıcılık yok, Prisma import edilmedi (bilerek).** Gerekçe: (a) zincir mantığı saf olduğu için
   binlerce senaryo çevrimdışı ve milisaniyelerde test edilebiliyor — denetim kanıtı testin kendisi;
   (b) aynı kurallar Postgres, dosya ve test-double için tek yerden geçerli; (c) `packages/db` şeması
   `AuditLog.seq`'i "assigned by packages/audit under a chain lock" diye tanımlıyor — bu paket o
   sözleşmeyi yazar, tabloyu değil; (d) Dalga 3 worker'ı gerçek kilit + Prisma deposunu enjekte edecek.
   `InMemoryAuditStore` üretim deposu değildir; test/seed/çevrimdışı demo içindir.
2. **`at` her zaman UTC'ye normalize edilir** (`toISOString`, milisaniye). Aynı an farklı offset'lerle
   yazılırsa farklı hash çıkmasın diye. Sözleşme offset'li damgalara izin veriyor; `verifyChain`
   saklanan string'i **olduğu gibi** kullandığı için başka bir üreticinin yazdığı offset'li kayıtlar da
   doğrulanabilir.
3. **Kanonik biçim fail-closed.** `meta.foo = undefined` sessizce düşürülmez, hata verir. Çağıranlar
   `undefined` alanları `meta`'ya koymadan önce ayıklamalı (ör. `JSON.parse(JSON.stringify(x))` değil,
   açıkça inşa ederek).
4. **Gate kararları yalnız insan aktörle kaydedilir** (`GATE_APPROVE`, `GATE_REJECT`). Gerekçe: M32 SoD
   ve M101'in "maestro-mcp'de kapı onay/ret aracı YOK" kuralı. `ai-via:<user>` bile reddedilir — onay
   yalnız insan kanalından gelir. `KILL_SWITCH` bilerek kısıtlanmadı (çift onaylı akış workflow'un işi,
   ayrıca otomatik tetikleme senaryosu açık kalsın diye).
5. **Anchor imzası HMAC-SHA256 (varsayılan).** `AnchorSigner` arayüz olduğu için kurumda KMS/HSM ya da
   asimetrik imza gelirse anchor mantığı değişmez. Anahtar `SecretPort`'tan çözülmeli (bu paket anahtar
   yönetimi yapmaz).
6. **Anchor'ın nereye yazılacağı çağıranın kararı** (spec gereği): StoragePort (M5/M57 Object Lock),
   dosya düşümü, SIEM. Bu paket üretir ve doğrular, yazmaz.
7. **Kayıtsız gün anchor'lanmaz** (`empty_day` hatası): head hareket etmediği için önceki anchor hâlâ
   zinciri kapsıyor. Kurum "her gün bir anchor" isterse bu kural gevşetilmeli — arayüz talebi değil,
   parametre kararı.
8. **CEF metinleri İngilizce.** SIEM içeriği operatör altyapısıdır, kullanıcıya dönük metin değil;
   M104 kataloğu uygulanmaz, M59 gereği İngilizce kalır. Studio'da audit satırı gösterilecekse
   görünen metin katalogdan gelmeli, `AUDIT_ACTION_INFO.name`'den değil.
9. **Syslog çerçevesi RFC 3164**, varsayılan facility 13 (log audit), zaman damgası kaydın kendi anı
   (UTC) — dosya yeniden oynatıldığında tarih değişmesin diye. CEF severity → syslog severity eşlemesi:
   `>=9 → 2 (crit)`, `>=7 → 3 (err)`, `>=4 → 4 (warning)`, aksi `6 (info)`.
10. **`rt` alanı epoch milisaniye** (ArcSight sözleşmesi), `externalId = seq`, `suser = actor`,
    `cs1 = subject`, `cs2 = hash`, `cs3 = prevHash`, `cs4 = delegatedBy` (yalnız `ai-via`),
    `cs5 = meta` (kanonik JSON, boşsa alan yok), `act`, `cat`, `outcome`, `msg`.

## 4. Bağımlılıklar

| Paket | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts` | runtime (workspace) | `AuditEvent`, `AuditAction`, `IsoDateTime`, `Sha256Hex`. |
| `zod` ^4 | runtime | Zaten monorepo standardı; anchor şeması + `AuditEvent.safeParse` ile fail-closed doğrulama. |
| `node:crypto` | runtime (yerleşik) | SHA-256 ve HMAC. |
| `@types/node`, `typescript`, `vitest` | dev | Paket sözleşmesi gereği. |

**Yeni harici runtime bağımlılığı YOK.** `@maestro/ports`'a bağımlılık da yok (aşağıdaki talep #1).

## 5. Arayüz/bağımlılık talepleri (contracts/ports DONMUŞ — burada yalnız kayıt)

1. **`AuditPort` (veya `AuditStore`) `packages/ports`'ta yok.** Depo arayüzü şu an `packages/audit`
   içinde (`src/store.ts`). Dalga 2-3'te worker/BFF bu arayüze yazacaksa `ports`'a taşınması daha
   doğru olur — **orkestratör kararı**. Taşınırsa bu paket sadece `implements` tarafını korur.
2. **`AuditAnchor` sözleşmesi contracts'ta yok.** Anchor Zod şeması bu pakette tanımlandı. Anchor
   Studio'da gösterilecek ya da BFF'ten dönecekse `packages/contracts/src/audit.ts` yanına taşınmalı.
   Önerilen şekil bu pakette hazır: `{version, day, createdAt, algorithm, firstSeq, lastSeq,
   eventCount, prevHash, headHash, chainDigest, signature:{alg,keyId,value}}`.
3. **`AuditEvent.meta` `z.record(z.string(), z.unknown())`** — `unknown` olduğu için sözleşme
   düzeyinde "hash'lenebilir" garantisi yok; garantiyi kanonik serileştirici veriyor (fail-closed).
   İsteğe bağlı iyileştirme: `meta` için JSON-değer tipi tanımlanması.
4. **`AuditEvent.seq` `number`, `db` şemasında `BigInt`.** 10 yıllık hacimde `Number.MAX_SAFE_INTEGER`
   aşılmaz (2^53 kayıt), ama `db` katmanı BigInt↔number dönüşümünü açıkça yapmalı — sessiz `Number()`
   dönüşümü v1 tarzı bir hata kaynağı olur. Bilgi amaçlı not.
5. **Kilit gerçeklemesi Dalga 3'e ait.** Worker `ChainLock`'u Postgres advisory lock ile (tek zincir
   için tek kilit anahtarı) uygulamalı; ayrıca `AuditLog.seq` PK + `hash` unique index ikinci savunma
   hattıdır (süreçler arası çatallanma).

## 6. Bilerek eksik bırakılanlar

- **Kalıcı depo (Prisma) yok** — §3.1'deki gerekçe; Dalga 1 `db` + Dalga 3 worker birleştirecek.
- **Anchor'ın diske/S3'e yazılması yok** — spec gereği çağıranda (StoragePort/dosya).
- **Dosya düşümü / syslog soketi yok** — `toSyslogLine` satırı üretir; dosyaya yazan ya da UDP/TCP'ye
  gönderen taşıyıcı (M33 "dosya düşümü") Dalga 2 `notify`/deploy tarafının işi. Bu paket saf mantık.
- **Kanıt paketi (evidence) üretimi yok** — ayrı sözleşme (`contracts/evidence.ts`), ayrı paket.
- **Retention silme işi yok** — `retentionExpiryOf` tarihi hesaplar; yaşam döngüsü kuralını uygulayan
  StoragePort/arşiv işi (M56) başka pakette.
- **CEF parser üretimde yok** — yalnız testte (bağımsız kanıt için). SIEM tarafı okur, biz yazarız;
  üretimde çağrılmayan bir parser ölü yol olurdu.

## 7. Doğrulama

```
pnpm install                       # ✓
pnpm -F @maestro/audit typecheck   # ✓
pnpm -F @maestro/audit test        # ✓ 8 dosya / 78 test
pnpm lint                          # ✓ (kök eslint)
pnpm typecheck                     # ✓ (kök turbo, 8 paket)
```
