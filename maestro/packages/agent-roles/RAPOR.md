# `@maestro/agent-roles` — Dalga 3 paket raporu

Düşünen rollerin (intake · analyst · dev-reviewer · test-designer · test-reviewer)
promptları, çıktı şemaları ve fail-closed doğrulaması. Paketin kalbi **M108**:
analiz şablonu artık veri; Zod şeması da prompt da o veriden **çalışma zamanında**
üretilir, yani Studio'dan bölüm eklenince bu pakette tek satır değişmez.

## Ne yapıldı

### 1. Şablon = veri (M108)
- `data/analysis-template.tr.json` — kurumsal varsayılan şablon (maketteki
  şablon tasarımcısı ekranının veri modeliyle birebir: başlık · açıklama ·
  AI talimatı · zorunlu/opsiyonel · beklenen biçim · örnek metin).
- `src/template.ts` — şablonun Zod modeli (`AnalysisTemplate`). Bölüm anahtarı
  tekilliği, biçim-alan tutarlılığı (tablo → sütun zorunlu vb.), `source_list` /
  `open_items` bölümlerinin en fazla birer kez bulunması burada doğrulanır.
- `src/schema-builder.ts` — `buildAnalysisSchema(template)`: şablondan analist
  çıktı şeması. 8 biçim: `free_text · bullet_list · field_group · list_group ·
  table · impact_matrix · source_list · open_items`. Zorunlu bölüm → alan
  zorunlu; opsiyonel bölüm → `.optional()`; şablonda olmayan bölüm anahtarı
  `.strict()` ile reddedilir.
- `src/prompt.ts` — aynı şablondan prompt. Bölüm başlığı, talimatı, örneği ve
  beklenen biçimi prompta şablondan gelir.

**Kanıt:** `test/schema-builder.test.ts` "changes with the template, not with the
code" ve `test/prompt.test.ts` "grows with the template" testleri, şablona bir
`Mevzuat etkisi` bölümü eklendiğinde hem şemanın hem promptun kod değişmeden
değiştiğini gösterir.

### 2. M109 bölümleri varsayılan şablonda
- **Kaynaklar** (`source_list`, zorunlu, en az 1 satır): her satır
  `{bölüm, iddia, kaynak türü, referans}`. Kaynak türü:
  `repo_file · repo_card · knowledge_doc · ticket · clarification`.
- **Netleştirilecek açık maddeler** (`open_items`, zorunlu, boş olabilir): alan
  **var olmak zorunda** — "açık madde yok" bilinçli bir cevap, sessizlik değil.
- Promptta "kaynak gösteremiyorsan iddiayı yazma" talimatı zorunlu kural olarak
  geçer (M98'in uygulaması).

### 3. Doğrulama iki katmanlı, ikisi de fail-closed (M43)
`src/validate.ts` → `validateAnalysis`:
1. **Şekil** — üretilen şemayla `safeParse`. Eksik zorunlu bölüm Türkçe ve
   bölüm adıyla raporlanır (`"Risk ve geri dönüş planı" bölümü zorunlu ama
   çıktıda yok.`), boş Kaynaklar kendi cümlesini alır.
2. **Doğruluk** — şemanın göremediği kısım:
   - dolu her iddia bölümünün Kaynaklar'da en az bir satırı olmalı,
   - her referans role **gerçekten gösterilen** bağlamda geçmeli
     (`src/context.ts` → `buildReferenceIndex`; repo keşfi dosyaları, repo kartı
     uygulama/modül yolları, knowledge doküman adları, ticket anahtarı,
     netleştirme kimlikleri). Bağlamda olmayan referans = uydurma → ret.
   - yer tutucu metin (TODO/TBD/N-A…) taraması.

`src/run.ts` → `runRole`: bir çağrı, **somut eksik listesiyle bir düzeltme turu**,
sonra `RoleOutputError`. Üçüncü deneme yok, kısmen geçerli doküman dönmez.
`queued` / `degraded` / `blocked` sonuçları (M55/M18/M97) olduğu gibi
workflow'a geri verilir — hataya çevrilmez.

### 4. Roller
| Rol | Dosya | Çıktı | Kendine özel kural |
|---|---|---|---|
| intake (2) | `role-intake.ts` | `IntakeOutput` | Şemada uydurulmuş değer koyacak **alan yok**; eksik varsa soru zorunlu, "tam" deyip eksik listelemek çelişki sayılır |
| analyst (3) | `role-analyst.ts` | şablondan üretilen şema | yukarıdaki iki katman |
| dev-reviewer (6c) | `role-dev-reviewer.ts` | `DevReviewOutput` | her bulgunun dosyası **incelenen diff'te** geçmeli; blocker/major varken `approved=true` reddedilir |
| test-designer (7) | `role-tests.ts` | `TestDesignOutput` (Türkçe Gherkin) | her kabul kriteri `criterionIndex` ile karşılanmalı; en az bir olumsuz senaryo |
| test-reviewer (8) | `role-tests.ts` | `TestReviewOutput` | kapsam raporu senaryolardan **yeniden hesaplanır**; gerçek boşluğu görmeyen ya da olmayan boşluk uyduran denetim reddedilir (4-göz) |

### 5. Sözleşmeye köprü
`src/to-contract.ts` — `AnalysisDoc` **taban**: bölümler `contractField` ile
sözleşme alanlarına bağlanır, şablonun getirdiği **ek bölümler**
`TemplatedAnalysis` içinde taşınır (sözleşme `.strict()` olduğu için oraya
sığmaz) ve yayımlanan dokümana `renderAnalysisMarkdown` ile girer.
`toIntakeResult` / `toReviewResult` / `toTestReviewResult`, `packages/workflows`
aktivite arayüzlerinin (`IntakeResult`, `ReviewResult`) şekline birebir uyar.

### 6. Variant (M38) ve eval (M78)
- `src/variants.ts` — variant, **veri katmanı**: prompt metni override'ı +
  isteğe bağlı kendi şablonu. Var olmayan bir anahtara override yazmak hata
  (sessizce etkisiz kalan ayar bu projede kabul edilmiyor).
- `src/eval.ts` — golden ticket değerlendirme **şekli** (`RoleEvaluator`,
  `AnalysisGoldenCase`, `IntakeGoldenCase`) + **saf skorlama**
  (`scoreAnalysis`, `scoreIntake`, `aggregate`, `detectRegression`). Saat yok,
  I/O yok, model yok — aynı girdi aynı skor, yoksa regresyon karşılaştırması
  anlamsız olurdu. Koşucunun gerçeklemesi Dalga 4.

## Test özeti
`pnpm -F @maestro/agent-roles test` → **12 dosya, 115 test, tamamı yeşil.**
Tamamen çevrimdışı: `@maestro/test-kit`'in mock-LLM'i (doğrulayan port) ve
test içi "scripted" port (doğrulamayan port + düzeltme turunu sürmek için).

Özellikle istenen davranışların testleri:
- şablona bölüm eklenince **şema** değişiyor → `schema-builder.test.ts`
- şablona bölüm eklenince **prompt** değişiyor → `prompt.test.ts`
- eksik bölümlü çıktı reddediliyor → `schema-builder.test.ts`, `validate.test.ts`, `run.test.ts`
- Kaynaklar boşsa analiz geçmiyor → `validate.test.ts`, `run.test.ts`
- uydurma kaynak (bağlamda olmayan dosya) reddediliyor → `validate.test.ts`, `run.test.ts`
- intake eksik bilgide uydurmuyor, soru üretiyor → `role-intake.test.ts`
- bir düzeltme turu, sonra hata → `run.test.ts`, `role-intake.test.ts`, `role-review.test.ts`, `role-tests.test.ts`

Kök kapı: `pnpm run gate` → **44/44 görev başarılı** (lint + typecheck + test).

## Varsayımlar / kararlar (gözden geçirilsin)
1. **Şemayı kapıya, semantiği bize.** `LlmPort.generateObject`'e üretilen şema
   verilir (modelin JSON şemasını görmesi için); dönen değer paket içinde
   **yeniden** doğrulanır — port doğrulamayı atlasa da eksik doküman kapıya
   gitmez. Şekil hatası da bu yüzden düzeltme turuna girer, istisnaya değil.
2. **Kaynaksız şablon = analiz yok.** `buildAnalysisSchema`, şablonda
   `source_list` bölümü yoksa `TemplateError` atar. M108 "bölüm ekle/çıkar
   serbest" diyor; izlenebilirliği tamamen kaldırmak ise M109 + denetim gereğini
   kaldırmak olurdu. Studio böyle bir şablon kaydedebilir, analist onunla
   **koşmaz**. Karar sende: bu sertlik kalsın mı?
3. **`riskAndRollback` biçimi `field_group`, `scope` biçimi `list_group`.**
   Makette ikisi de serbest metin/madde listesiydi; `AnalysisDoc` ise
   `{risk, mitigation, rollback}` ve `{included, excluded}` istiyor. Sözleşme
   alanına bağlı bölümlerin alt anahtarları sözleşmeyle aynı olmak zorunda
   (uymazsa `TemplateError`).
4. **`uiApiChanges` opsiyonel ama sözleşmede zorunlu.** Bölüm hiç
   doldurulmazsa sözleşmeye `data/prompts.tr.json` içindeki
   `bolum.degisiklikYok` metni ("Değişiklik yok.") yazılır — uydurma değil,
   şablonun kendi talimatının karşılığı.
5. **Referans eşleşmesi birebir** (trim sonrası). "Neredeyse doğru" bir dosya
   yolu, denetçinin açamayacağı bir yoldur.
6. **Prompt metinleri yalnız `tr`.** M104 kataloğu `packages/config`'te
   kullanıcıya dönük metinler için; buradaki metinler **modele** dönük ve
   variant'la (M38) değiştirilir. İkisini birleştirmek istenirse orkestratör
   kararı gerekir.

## Talepler
- **Arayüz değişikliği talebi yok.** `contracts` ve `ports` salt okunur
  kullanıldı; `AnalysisDoc`, `ImpactCell`, `LlmPort`, `LlmOutcome`, `LlmRole`
  olduğu gibi tüketildi.
- **Yeni harici bağımlılık yok** (`zod` + workspace paketleri).
- Wave 4 için açık uç: `RoleEvaluator` gerçeklemesi, golden ticket setinin
  saklanması (StoragePort) ve Studio eval ekranı.
