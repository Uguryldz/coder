# RAPOR — `@maestro/memory` (Dalga 2)

Ajanın bağlamının hiçbir koşulda kaybolmamasını sağlayan katman: append-only ticket
defteri, defterden türetilen yaşayan özet, oturum yeniden açılışında verilen bootstrap
paketi, şifreli Agent SDK oturum dosyaları ve M65 arşiv kararı.

## Ne yazıldı

| Dosya | İş |
|---|---|
| `src/journal.ts` | `appendJournal` — tek yazma API'si; `seq = max+1`, PK çakışmasında yeniden dene; aynı süreçte (store, runId) başına yazma zinciri |
| `src/store-db.ts` | `journalStoreFromDb` — `@maestro/db`'nin `AppendOnlyDb["journalEntry"]` yüzeyi; `create`/`findMany`/`aggregate` dışında bir şey **çağrılamaz** (update/delete tipte yok) |
| `src/types.ts` | `JournalStore` portu (yalnız `maxSeq`/`insert`/`list`), `JournalDraft`, enjekte `Clock` |
| `src/masking.ts` | M82 sınırı: `createJournalMasker` — `prepare` (maskele) + `seal` (doğrula + `assertNoPii`); `Journaled<T>` markası bu modül dışında basılamaz |
| `src/summary.ts` | `buildLivingSummary` — **deterministik**, ≤8000 karakter; `enrichLivingSummary` — opsiyonel LLM kancası, varsayılan kapalı |
| `src/summary-format.ts` | satır biçimleyiciler (tek satıra indirgeme, kırpma, kind sayımları) |
| `src/bootstrap.ts` | `buildBootstrapPackage` — yaşayan özet + son diff özeti + açık ret gerekçeleri + `protected_paths` uyarısı; `openRejections` saf fonksiyon |
| `src/protected-paths.ts` | M52 deny-list eşleştirici (`**`, `*`, `?`, dizin ve joker'siz desenler) + M52 varsayılanları |
| `src/session.ts` | Oturum dosyası arşivi: `saveSessionFile`/`loadSessionFile`/`tryLoadSessionFile`/`listSessionKeys`, anahtar = storage'ın `archiveKey`'i |
| `src/crypto.ts` | AES-256-GCM mühürleme (M31); anahtar ve rastgelelik **enjekte** |
| `src/archive.ts` | `decideWorkspaceArchive` — 60 gün hareketsizlik kararı (saf), `latestActivityAt`, `idleDaysBetween` |

Üretim kodu: **984 satır** (yorum/boş satır hariz; ham 1431 satır), en büyük dosya 258 satır.

## Kritik tasarım kararları

1. **Silme/güncelleme yok — hiçbir katmanda.** `JournalStore` portunun kendisi yalnız
   `maxSeq`/`insert`/`list` adlarını taşıyor; db adaptörü `appendOnly` yüzeyini alıyor,
   dolayısıyla `update`/`delete` ne tipte ne çalışma zamanında erişilebilir. Testler
   paketin dışa açık adlarında `update*/delete*/remove*` olmadığını da doğruluyor.
2. **Seq boşluksuzluğu PK ile garanti.** `max(seq)+1` oku-yaz, çakışmada yeniden dene.
   Bir seq ancak satırı commit olduğunda var olur, sonraki yazan o commit'i okur →
   ne çift kayıt ne boşluk. Test: tek tabloya iki ayrı store (iki süreç) üzerinden 40
   eşzamanlı yazım → tam `0..39`, ve çakışma sayacı > 0 (yarışın gerçekten olduğunun kanıtı).
3. **Özet deterministik.** Aynı defter → bit bit aynı metin. Bütçeye sığdırma bir
   "azaltma merdiveni" ile yapılıyor (önce tam log, sonra bölümlü + sıkıştırılmış eski
   kayıt, sonra daha dar satır); ilk sığan seviye kazanır. Son çare kırpma var, istisna yok.
   Her seviyede **son N olay + kapı kararları + açık bulgular** korunur.
4. **"Açık bulgu" tanımı.** `JournalEntry` DONUK ve durum alanı yok; bu yüzden çözülmüşlük
   metinden tahmin edilmiyor. Kural: `scan/review/test_review/ci/pii/quota/handover`
   kind'leri **durum niteliğinde**dir, en yenisi geçerlidir (eski tarama sonucunu yeni
   tarama sonucu geçersizler). Bu, donmuş sözleşmenin üstüne protokol uydurmadan
   verilebilecek tek dürüst yorum (bkz. Talepler #1).
5. **LLM bağımsızlığı.** Zenginleştirme yalnız **ekler** (`## notes (model)` bölümü);
   deterministik bölümler modelden önce yazılır, model hata verse/kotaya takılsa da
   hiçbir garanti kaybolmaz. Enricher varsa masker zorunlu (M82).
6. **Maskeleme her çağrıda yeni oturum.** ReverseMap çağrı çerçevesinde doğar ve ölür,
   deftere/özete asla girmez. Bedeli: `[EMAIL_1]` iki ayrı kayıtta aynı kişi olmayabilir.
   Bu bilinçli — 10 yıl saklanan kayıtta kalıcı, tutarlı numaralandırma tam da
   kaldırdığımız değerlerin yeniden-tanımlanabilir bir indeksi olurdu.
7. **M65 bağlam kaybı yok.** Test, workspace var/yok iki bootstrap paketini üretip
   `workspace:`/`session:` satırları dışında metinlerin **birebir aynı** olduğunu
   doğruluyor; özet, diff, ret gerekçeleri ve korumalı yol uyarısı aynen duruyor.
8. **Şifreleme fail-closed.** GCM kimlik doğrulamalı: bozulmuş oturum dosyası "yeni
   oturum"a düşmez, `SessionCryptoError` fırlatır. Yokluk (`ObjectNotFound`) ise normal
   durumdur ve `tryLoadSessionFile` `null` döner → akış journal ile bootstrap eder.

## Test özeti

`pnpm -F @maestro/memory test` → **9 dosya / 96 test, hepsi yeşil.** Tamamen çevrimdışı;
saat, depo, rastgelelik ve defter deposu enjekte.

| Dosya | Test | Kapsam |
|---|---|---|
| `journal.test.ts` | 12 | seq üretimi, tek/çok süreç eşzamanlılık, retry bütçesi, yeniden denenmeyen hatalar, maskeleme, mutasyon API'si olmadığının kanıtı |
| `summary.test.ts` | 15 | determinizm (ters sıra dahil), 8000 sınırı, korunan bölümler, patolojik girdi, zenginleştirme (ekleme/maskeleme/hata düşüşü) |
| `bootstrap.test.ts` | 11 | M65 bağlam eşitliği, açık ret hesabı, M52 uyarısı, maskeleme, bütçe |
| `store-db.test.ts` | 9 | prisma delegesine giden argümanlar, P2002/23505 → `SeqTakenError`, satır→sözleşme dönüşümü, uçtan uca append |
| `crypto.test.ts` | 12 | round-trip, yanlış anahtar, kurcalama, başlık/versiyon/kısalık, IV tazeliği |
| `session.test.ts` | 9 | anahtar düzeni, şifreli saklama, yokluk vs bozukluk, listeleme |
| `archive.test.ts` | 11 | 59/60 gün eşiği, override, saat kayması, saflık |
| `protected-paths.test.ts` | 9 | glob semantiği, regex kaçışı, M52 varsayılanları |
| `masking.test.ts` | 8 | marka, çalışma zamanı tripwire, sınıf geri düşüşü, sayaç kancası |

Kök kapı: `pnpm lint` ✅ · `pnpm typecheck` (13 paket) ✅ · `pnpm test` (26 görev) ✅.

## Varsayımlar

- Defterdeki `at` alanı çağıranın saatinden gelir; özet zaman damgalarını olduğu gibi
  yazar (yerelleştirme M104'ün işi, hafızanınki değil).
- Bootstrap metni 16000 karakterle sınırlı (bir prompt, bir DB kolonu değil); `LivingSummary`
  ise sözleşme gereği 8000.
- Oturum dosyası içerik anahtarı 32 bayt ve dışarıdan gelir; bu paket anahtar üretmez,
  saklamaz, türetmez.

## Talepler (orkestratör kararı)

1. **`contracts.JournalEntry`'de bulgu durumu yok.** "Açık bulgu" şu an "aynı kind'in en
   yenisi" kuralıyla türetiliyor. Gerçek ret/çözüm zinciri isteniyorsa `resolvesSeq?: number`
   veya `status?: "open"|"closed"` alanı gerekir — contracts DONUK olduğu için dokunulmadı.
2. **Oturum anahtarı adı/rotasyonu (M80).** Wiring dalgası için `SecretPort` anahtar adı
   standardı gerekli (ör. `memory/session-content-key`). Anahtar rotasyonu istenirse mühür
   formatına key-id eklenmeli → format sürümü 2 (şu an v1, versiyon baytı hazır).
3. **Arşiv anahtarı nerede saklanacak?** `archiveKey` yılı `createdAt`'ten türetiyor;
   akış, `decideWorkspaceArchive`'ın döndürdüğü `sessionKey`'i DB'ye yazmalı. Yazmazsa
   dönüşte `listSessionKeys(ticket, yıl)` ile taramak gerekir (fallback olarak var).
4. **Eşikler M71'e taşınmalı:** `maxIdleDays` (60), `recentCount` (12), `lineChars` (200).
   Paket bunları opsiyon olarak alıyor; varsayılanlar M65/M30'dan geliyor.
5. **`@maestro/db` bağımlılığı runtime'dır** (satır→sözleşme dönüşümü için `toJournalEntry`),
   yani `@maestro/memory` import eden herkes `@prisma/client`'ı da yükler. İstenirse
   `store-db.ts` ayrı bir alt-export'a (`@maestro/memory/db`) çekilebilir — tek satırlık
   package.json değişikliği.
6. **`protectedPathHits`** bootstrap dışında da (M52 kapısı, Dalga 3) kullanılmak üzere
   dışa açıldı; bu paket içinde yalnız testleri var — kasıtlı, ölü yol değil.
