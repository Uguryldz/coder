# `@maestro/pii` — Dalga 1 paket raporu

**Durum:** YEŞİL. `pnpm install` · `pnpm -F @maestro/pii typecheck` · `pnpm -F @maestro/pii test`
(11 dosya / 89 test) · kökten `pnpm lint` — dördü de temiz.
**Dal:** `wave1-pii` (kendi worktree'sinde; main'e merge edilmedi, push edilmedi).

## 1. Ne yapıldı

Maskeleme çekirdeği + ReverseMap + **atlanamaz sınır geçidi** (M20). 1080 satır üretim kodu
(tavan 1200), en büyük dosya 229 satır (tavan 300), 913 satır test.

| Dosya | İş |
|---|---|
| `src/types.ts` | Tip/şema tanımları, jeton sözlüğü (`TOKEN_PREFIX`), profil ve politika Zod şemaları |
| `src/errors.ts` | `PiiPolicyError` · `PiiArgumentError` · `PiiLeakError` · `PiiReverseMapLeakError` |
| `src/detectors/tckn.ts` | 11 hane + **iki basamaklı checksum zorunlu** |
| `src/detectors/iban.ts` | ISO 13616 mod-97 (genel mod) + TR uzunluk kuralı (26) |
| `src/detectors/card.ts` | 13-19 hane + **Luhn zorunlu** |
| `src/detectors/phone.ts` | TR numara planı (+90/0090/0/gruplu/çıplak mobil) |
| `src/detectors/email.ts` | Yerel kısım + noktalı alan adı |
| `src/detectors/account.ts` | Müşteri/hesap no — **yapılandırılabilir desen**, yükleme anında derlenir |
| `src/detectors/index.ts` | Kayıt defteri + çakışma önceliği |
| `src/reverse-map.ts` | Jeton↔değer, oturum kapsamlı; serileştirilemez |
| `src/policy.ts` | dataClass→profil çözümü, fail-closed; politika doğrulama |
| `src/counts.ts` | Denetim sayaçları + `toAuditMeta` (M33 `PII_MASKED`) |
| `src/mask.ts` | Metin/nesne maskeleme, geri alma, `assertNoPii` tuzak teli |
| `src/boundary.ts` | `withPiiBoundary` · `maskOutbound`/`unmaskInbound` · `guardEgress` · `Masked<T>` |

### Jeton üretimi
Deterministik ve okunur: `[TCKN_1]`, `[IBAN_2]`, `[EMAIL_1]`, `[ACCT_1]`, `[FIELD_1]`.
Kimlik **normalleştirilmiş** değere bağlı — `TR33 0006…` ile `TR330006…` aynı jetonu alır,
`Ali@X.com` ile `ali@x.com` aynı kişidir, telefonun her yazımı `+90…` biçimine indirgenir.
Böylece model tek bir varlık üzerinde tutarlı akıl yürütür. `unmask()` ilk görülen yazımı geri koyar.
Jetonun içinde değerin hash'i **yok** (v1 jetona hash gömüyordu — bu, jetonun kendisini bir
sızıntı kanalı yapar).

### ReverseMap (M20)
Değerler `#private` alanlarda; sınıfın hiçbir numaralandırılabilir özelliği yok.
- `JSON.stringify(map)` → `PiiReverseMapLeakError` **fırlatır** (sessizce boş nesne dönmez).
- `Object.keys(map)` → `[]`, `structuredClone({...map})` → `{}`.
- `String(map)` → `ReverseMap(size=2)`, `util.inspect(map)` → `ReverseMap { size: 2 }`.
- Üretmediği bir jetonu (modelin uydurduğu `[TCKN_9]`) **dokunmadan bırakır** — başkasının
  değerini iade etmez.
- `withPiiBoundary` map'i kendi çağrı çerçevesinde yaratıp bırakır; sonuç nesnesinde map **yok**,
  dolayısıyla aşağı akışta loglanması yapısal olarak mümkün değil.

## 2. v1 hatasının panzehiri (madde 4)

v1'de maskeleyici yazılmıştı ama `runner.ts` sınırında fiilen çağrılmıyordu ve hiçbir şey
bunu fark etmiyordu. Burada aynı hata **iki bağımsız katmanda** imkânsızlaştırıldı:

1. **Tip seviyesi.** Dışarı çıkan her fonksiyon `OutboundCall<TIn,TOut> = (p: Masked<TIn>) => …`
   imzasını taşır. `Masked<T>` markası bu modülün dışında üretilemez; tek kaynağı
   `withPiiBoundary` / `maskOutbound`. Ham yükü geçirmek **derlenmez**.
2. **Çalışma zamanı.** `assertNoPii` tuzak teli; `guardEgress(...)` ile herhangi bir çıkış
   noktasına (gateway, artefakt yazımı, bildirim) takılır. Markayı `as unknown as` ile aşan
   çağıran bile `PiiLeakError` alır — mesajda **yalnız tip ve adet** vardır, değer yoktur.

`test/boundary.test.ts` her ikisini de kanıtlar; ilk test `@ts-expect-error` ile yazılmıştır,
yani derleyici hatayı vermeyi bırakırsa `typecheck` KIRILIR (aşağıdaki mutasyon denetimine bakın).

## 3. Test özeti

11 dosya, 89 test, tamamen çevrimdışı ve deterministik. **Gerçek kişisel veri yok**: tüm
örnekler `test/synthetic.ts` içindeki üreteçlerle (checksum'ları hesaplanarak) yaratılır (M95).

Kapsam: her dedektör için pozitif + **checksum'ı bozulmuş negatif** + yanlış-pozitif tuzağı
(sipariş no, ürün kodu, fatura no) · çakışma çözümü (IBAN'ı telefon dedektörü bölemiyor) ·
jeton determinizmi ve numaralandırma · idempotanlık · sayı olarak saklanan kimlik ·
alan kuralları (M20 "alan + regex") · Map/Set/döngüsel yükte fail-closed ret ·
ReverseMap sızıntı yüzeyleri · politika fail-closed davranışı · denetim sayaçlarında değer yokluğu ·
`AuditAction` sözleşmesinde `PII_MASKED` gerçekten var mı (ID tutarlılığı).

### Mutasyon denetimi (testlerin gerçekten yük taşıdığının kanıtı)
Dört kasıtlı bozma uygulandı ve hepsi yakalandı:

| Bozma | Sonuç |
|---|---|
| `Masked<T>` imzasını ham `Prompt` yap | `typecheck` KIRILDI (`TS2578: Unused '@ts-expect-error'`) |
| TCKN checksum'ını atla | 3 test kırmızı |
| `ReverseMap.toJSON` fırlatmasın | 1 test kırmızı |
| `withPiiBoundary` maskesiz yükü çağırsın (**v1'in tam hatası**) | 3 test kırmızı |

Sonra kaynak geri yüklendi; final koşu 89/89 yeşil.

## 4. Varsayımlar

1. **Profil ekseni.** M18/M63 profillerin kurulumda uyum ekibiyle doldurulmasını söylüyor;
   `defaultPiiPolicy()` yalnız güvenli bir başlangıçtır: her sınıf checksum'lı tüm kimlikleri
   maskeler, `acik` sınıfına kurumun kendi hesap/müşteri desenleri uygulanmaz (bunlar kurum-içi
   kavramlar). Gerçek değerler `params`/`routing.yaml` tarafından beslenecek.
2. **`gizli` = azami profil.** Bilinmeyen sınıfın düştüğü profil olduğu için `loadPiiPolicy`,
   `gizli`'nin **tüm** dedektörleri açık tutmasını zorunlu kılar; aksi belge yüklenmez.
3. **Sayısal alanlar maskelenir.** `{ tckn: 12345678950 }` gibi sayı olarak saklanan bir kimlik
   tespit edilirse jetona (string) çevrilir. Tip değişir; bu bilinçli bir tercih — sınırda
   veri sızdırmamak, tip sadakatinden önce gelir.
4. **Traversal fail-closed.** Yalnız düz nesne / dizi / `Date` / ilkel değerler maskelenir.
   `Map`, `Set`, sınıf örneği, fonksiyon → `PiiArgumentError`. "Her string'i gezdim" sözünü
   veremediğimiz yapıyı kısmen maskelemektense reddediyoruz.
5. **Kanonikleştirme geri dönüşü.** Bir değerin ilk görülen yazımı jetona bağlanır; aynı değerin
   farklı yazımları geri konurken ilk yazıma normalize olur (`TR33 0006…` ↔ `TR330006…`).
   Anlam korunur, karakter-birebir sadakat korunmaz.
6. **İsim/adres tespiti yok.** Kişi adı desenle güvenilir bulunamaz; M20'nin "alan" yarısı
   (`fieldRules`) tam olarak bunun içindir ve profilden gelir.

## 5. Arayüz / bağımlılık talepleri

- **Yeni runtime bağımlılığı YOK.** `@maestro/contracts` + `zod` (ikisi de mevcut).
  Test tarafında yalnız `vitest` + `@types/node`.
- **`contracts`/`ports` DEĞİŞTİRİLMEDİ.** İki talep (orkestratör kararı):
  1. **`PiiPort` gerekli mi?** Şu an paket doğrudan içe aktarılıyor (adapter değil, saf çekirdek).
     `llm-gateway` ve `storage` paketleri onu port üzerinden isterse `packages/ports/src/pii.ts`
     açılmalı — imza hazır: `OutboundCall<TIn,TOut>`, `withPiiBoundary`, `assertNoPii`.
  2. **Politika nereden gelecek?** `PiiPolicy` şeması bu pakette duruyor. `params` servisi
     (M71) veya `config` paketi bunu sahiplenecekse şema oraya taşınmalı; bu paket şemayı
     dışarıdan almaya hazırdır (`loadPiiPolicy(unknown)`).
- **Tüketiciler için bağlayıcı not (M20/M82):** `llm-gateway`, `memory` (journal + yaşayan özet)
  ve `storage` (artefakt) **maskeli** hâli yazmalıdır — `PiiBoundaryResult.maskedOutput` tam
  bunun içindir. `output` (gerçek değerler geri konmuş hâl) yalnız kullanıcıya dönen anlık
  gösterime gider, hiçbir yere yazılmaz.
- **Audit için:** `toAuditMeta(counts)` → `{ maskedOccurrences, maskedFields, maskedTypes }`.
  Studio "PII_MASKED · 3 alan" metnini i18n ile bundan üretir (M104 gereği metin kodda değil).

## 6. v1'den ne alınmadı ve neden

Eski `packages/pii/src/index.ts` yalnız tarihsel referans olarak okundu; **hiçbir satır
kopyalanmadı**. Alınmayanlar:

| v1'deki şey | Neden alınmadı |
|---|---|
| `config.enabled` bayrağı | Tek satırlık **fail-open** anahtarı. `enabled:false` her şeyi sessizce kapatıyordu. Kaldırıldı; kapatma ancak profilden dedektör çıkarmakla olur, `gizli` profilinden ise hiç olmaz. |
| Serbest `patternRules` (her tip için regex) | Checksum'sız regex = yanlış pozitif fabrikası. Checksum'ı olan her tip (TCKN/IBAN/kart) artık **doğrulanmadan maskelenmiyor**; serbest desen yalnız hesap/müşteri numarasına, üstelik yükleme anında derlenerek bırakıldı. |
| `try { new RegExp(...) } catch { /* skip */ }` | Bozuk desen sessizce **atlanıyordu** — maskeleme yapılmadan "başarılı" dönüyordu. Artık `PiiPolicyError` ile süreç başlangıcında patlar. |
| `hash`/`partial`/`keep` alan stratejileri | `partial` ("...***") kısmi değeri dışarı veriyor, `keep` hiçbir şey yapmıyor, `hash` jetonun içine değerin hash'ini gömüyordu. Hepsi tek bir güvenli davranışla değiştirildi: tam değiştirme + tip taşıyan jeton. |
| `ReverseMap.applyReverse` (tüm map üzerinde `split/join`) | Değer sayısıyla O(n·m), ve **kısmi jeton çakışmasına** açıktı. Tek geçişli jeton regex'i ile değiştirildi; `[TCKN_1]` ile `[TCKN_11]` karışmıyor (test edildi). |
| v1 ReverseMap'in düz `Map` alanı | Loglanabilir/serileştirilebilirdi. Artık `#private` + `toJSON` fırlatıyor. |
| `maskObject`'in bilinmeyen tipleri olduğu gibi geçirmesi | Sayılar ve sınıf örnekleri sessizce maskesiz geçiyordu. Sayılar artık taranıyor, gezilemeyen yapılar reddediliyor. |
| `runner.ts` entegrasyon şekli | **Asıl hata buydu**: maskeleme çağrısı isteğe bağlıydı (`inv.piiConfig.enabled ? ... : ham`). Bu pakette maskeleme çağrının kendisidir — atlanamaz (§2). |

## 7. Bilinen sınırlar (dürüst kapsam)

- Kişi adı/adres için desen tespiti yoktur; `fieldRules` ile alan bazlı kapatılır.
- Yalnız TR telefon planı desteklenir; yurt dışı numarası maskelenmez.
- Çıplak (ayraçsız, önek almamış) sabit hat numaraları kasıtlı olarak maskelenmez — fatura/
  sözleşme numaralarıyla ayırt edilemiyorlar. Çıplak mobil (5xx) maskelenir.
- Maskeleme her çağrıda profil derler (`compileProfile`); gateway sıcak yolunda ölçüm gerekirse
  `createSessionWith(compiledProfile)` ile derleme önbelleğe alınabilir — API hazır.
