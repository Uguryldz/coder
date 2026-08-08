# @maestro/publish — builder raporu

Belge üretimi + `PublishPort` sürücüleri (M47): **jira · confluence · repo-docs**, artı sözleşmede
duran ama Aşama 2'ye ait **docx/pdf** hedefleri (M103 — sessizce yok sayılmıyor, `CapabilityNotSupportedError`).
Belgeler: 7 bölümlü analiz dokümanı (M43), kanıt paketi özeti, merge sonrası release notu taslağı (M91).
Şablon sürümü belgeye yazılıyor (M83), dil parametreden geliyor (M59/M104).

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/md.ts` | Markdown yazıcı (`Markdown`) + kaçış kuralları + `documentHeader` (M83 şablon pini) + `label()` (katalog araması, boş çeviri = hata) + `contentHash` (sha256, idempotans parmak izi). Bilet/model/kullanıcıdan gelen HER metin kaçırılıyor: satır başındaki `#`, `-`, `1.`, fence işaretleri etkisizleştiriliyor — analiz metnine gömülü bir `# Başlık` sahte bölüm açamıyor. |
| `src/keys.ts` | Paketin ürettiği TÜM mesaj anahtarları (`MSG`) + dinamik aileler (`publish.risk_tier.*`, `publish.impact_source.*`, `publish.decision.*`) + `publishMessageKeys()`. Kullanıcıya dönük tek bir metin bile kodda yok. |
| `src/documents.ts` | `renderAnalysisMarkdown` (7 zorunlu bölüm, sırayla; `AnalysisDoc.parse` ile fail-closed), `renderEvidenceSummaryMarkdown` (dosyalar + onay zinciri + saklama/Object Lock), `renderReleaseNoteMarkdown` (M91) + `ReleaseNoteDraft` Zod şeması. Belgenin dili ile istenen çıktı dili uyuşmazsa **reddediliyor**. |
| `src/parse.ts` | Markdown okuyucu (başlık, paragraf, madde/numaralı liste, fenced kod, `**kalın**`, `` `kod` ``, bağlantı, `\` kaçışları, HTML yorumu atlama). Modellenmeyen sözdizimi düz metne düşüyor, kaybolmuyor. `safeHref`: yalnız `http(s)`/`mailto`; `javascript:`/`data:` bağlantı olmuyor. |
| `src/adf.ts` | Markdown → ADF (WorkPort'un kabul ettiği düğüm kümesi). Jira adaptörü **import edilmiyor** (M44 temiz oda) — iki taraf portta buluşuyor. Numaralı liste, DC alt kümesinde karşılığı olmadığı için numarası metne yazılarak madde listesine çevriliyor (bilgi kaybı yok). |
| `src/storage-format.ts` | Markdown → Confluence storage format (XHTML alt kümesi + `code` makrosu). Kendi yazıldı, bağımlılık yok. `& < > " '` kaçırılıyor, `]]>` CDATA'yı kapatamıyor, tanınmayan dil parametresi düşürülüyor, güvensiz bağlantı düz metne çevriliyor. |
| `src/drivers/jira.ts` | `JiraPublisher` — WorkPort üzerinden ADF yorum. **M75**: (koşu, belge) çiftinin yorum id'si hatırlanıyor; yeniden yayında yorum **düzenleniyor**, ikincisi açılmıyor; içerik aynıysa Jira'ya hiç dokunulmuyor. |
| `src/drivers/confluence.ts` | `ConfluencePublisher` + `ConfluencePublishConfig` — REST v1 `/rest/api/content`. Sayfa yoksa oluşturur, varsa sürüm+1 günceller; **409'da sürümü yeniden okuyup sınırlı sayıda dener**; içerik birebir aynıysa sürüm harcamaz. Token `SecretPort`'tan (M80), boş token'la istek **atılmaz**. `fetch` enjekte. |
| `src/drivers/repo-docs.ts` | `RepoDocsPublisher` + `RepoDocsPublishConfig` — `ScmPort` ile dal + PR, enjekte `RepoWorkspace` ile dosya/commit (kendi git istemcisi yok). Aynı içerik commit **edilmiyor**; ikinci PR açılmıyor. Commit mesajı/dal adı/PR başlığı İngilizce (M59), belge gövdesi Türkçe. |
| `src/port.ts` | `MaestroPublishPort` (`PublishPort`): `req.targets` üzerinde sırayla fan-out, hedef başına bir makbuz. Bir hedef patlarsa yayın patlar (kısmi makbuz listesi yok). `UnsupportedTargetPublisher`: docx/pdf → `CapabilityNotSupportedError`. |
| `src/register.ts` | `registerPublishDrivers(registry, deps)` (M44): hedef başına bir sürücü + proje hedef kümesini karşılayan `multi` sürücüsü. Eksik yapılandırma/bağımlılık **kurulum anında** hata veriyor, koşu ortasında değil. |
| `src/types.ts` | Enjekte edilen işbirlikçiler: `Translate` (katalog), `RunContextResolver`, `PublishStateStore` (+ `InMemoryPublishState`, yalnız test/demo), `RepoWorkspace`, `FetchLike`, `PublishDeps`. |

**Üretim kodu: 1102 etkin satır** (yorum/boş satırlar dahil 1482), en büyük dosya 202 satır (tavan 300).

### İdempotans — üç hedefte de kanıtlı
| Hedef | Aynı belge ikinci kez yayınlanınca | Belge değişince |
|---|---|---|
| jira | Jira'ya **hiç istek gitmiyor**, aynı yorum id'si makbuz olarak dönüyor | aynı yorum `updateComment` ile düzenleniyor (M75) |
| confluence | **PUT atılmıyor**, sayfa sürümü artmıyor, aynı sayfa id'si dönüyor | aynı sayfa sürüm+1 (ikinci sayfa yok) |
| repo-docs | commit **yok**, ikinci PR **yok**, aynı sha dönüyor | aynı dalda yeni commit, PR aynı kalıyor |

Uçtan uca test (`test/end-to-end.test.ts`) bunu üç hedefte birlikte ispatlıyor: analiz belgesi → markdown →
jira + confluence + repo-docs; ikinci yayında hiçbir yerde yeni bir nesne oluşmuyor.

## 2. Testler

`pnpm -F @maestro/publish test` → **8 dosya / 98 test, hepsi yeşil.** Tamamen çevrimdışı ve deterministik:
ağ yok (fetch enjekte, bellek içi sahte Confluence), dosya sistemi yok, saat yok — belgeler **zaman damgası
içermiyor**, bu yüzden aynı girdi her seferinde aynı byte dizisini üretiyor (idempotansın ön koşulu).

- `documents.test.ts` (22): 7 bölüm ve sırası · M83 şablon pini + marker satırı · etki matrisi satırları ve kaynağı (M100) · risk katmanının katalogdan gelmesi · byte-birebir tekrarlanabilirlik · dil parametresi (tr/en) · dil uyuşmazlığı reddi · eksik bölüm ve boş etki matrisi reddi (fail-closed) · analiz metnine gömülü markdown enjeksiyonunun etkisizleşmesi · kanıt paketi dosya/onay/saklama satırları · başka koşuya/bilete ait paket reddi · release notu (M91) alanları ve "yayın insan işi" notu · M104 disiplini: üretilen her anahtar pakette **beyan edilmiş**.
- `parse.test.ts` (15): başlık seviyeleri, paragraf birleştirme, madde/numaralı liste ayrımı, girintili devam satırı, fenced kod (kapanmamış fence dahil), HTML yorumlarının atılması, modellenmeyen sözdiziminin düz metne düşmesi, satır içi işaretler ve `\` kaçışları, `safeHref` kabul/ret listesi.
- `adf.test.ts` (8): doc zarfı, başlık seviyesi kırpma, strong/code/link markları, güvensiz bağlantının markdan arındırılması, numaralı liste dönüşümü, `listItem > paragraph` yerleşimi, boş metin düğümü üretmeme, tam analiz belgesinin bölüm kaybetmeden dönüşmesi.
- `storage-format.test.ts` (10): blok eşlemesi, `ol`/`ul`, code makrosu + CDATA, sahte dil parametresinin düşürülmesi, `<script>`/`<ac:...>` kaçışı, **CDATA kapatma saldırısı** (tek makro kalıyor), güvenli/güvensiz bağlantı, href tırnak kaçışı, marker yorumunun atlanması, tam belgenin dengeli markup üretmesi.
- `jira-driver.test.ts` (7): ADF gövdeli yorum, aynı belgede **sıfır** Jira çağrısı, değişen belgede `updateComment` (M75), belge türü başına ayrı yorum, bozuk kayıtta başkasının yorumunu düzenlememe, boş yorum id'si reddi, WorkPort'suz kurulum reddi.
- `confluence-driver.test.ts` (11): oluşturma (storage format + Bearer + space), güncelleme (tek sayfa, sürüm+1), değişmemiş belgede sürüm harcamama, **409 yarışında yeniden okuyup başarma**, sürekli 409'da gürültülü teslim olma, sayfa başlığı değişse bile hatırlanan id'yi izleme, boş token'la istek atmama, 500 → tipli hata, eksik alanlı yanıtın reddi, yapılandırma doğrulaması.
- `repo-docs-driver.test.ts` (11): dal + commit + PR sırası, İngilizce commit/PR metinleri (M59), değişmemiş belgede commit/PR yokluğu, değişen belgede aynı dal + tek PR, belge türü başına ayrı dosya, **kayıt kaybolsa bile aynı içeriğin yeniden commit edilmemesi**, uygulamasız koşunun reddi, boş sha reddi, PR'sız mod, `..` içeren yol reddi, workspace'siz kurulum reddi.
- `register.test.ts` (12): hedef sırasına göre makbuzlar, tekrarlanan hedefin bir kez yayını, **docx/pdf'in gürültülü reddi (M103)**, kurulmamış hedefin reddi, boş belge/geçersiz istek reddi, bir hedef patlayınca kısmi makbuz olmaması, sürücü adları, registry'den çözülen portun gerçekten çalışması, `multi` sürücüsünün proje hedef kümesi, hedef kümesi verilmeyen `multi` reddi, eksik bağımlılık/bilinmeyen yapılandırma anahtarı reddi.
- `end-to-end.test.ts` (3): üç hedefe tek belge, ikinci yayında hiçbir yerde yeni nesne, revize belgede "aynı yorum + sonraki sürüm + bir commit daha".

## 3. Katalog anahtarları — **config DÜZENLENMEDİ, talep burada** (M104)

Kural gereği `packages/config/locales/*.json` dosyalarına dokunulmadı. Paketin ürettiği anahtarların tam
listesi ve önerilen tr/en değerleri aşağıda; orkestratör bunları katalog dosyalarına ekleyince
`deps.translate = t` bağlanabilir (`publishMessageKeys()` çağrısı ile eksik anahtar önceden denetlenebilir).
`steps.*` ailesi (kapı adları) zaten katalogda var, yeniden kullanıldı.

**tr:**
```json
{
  "publish.title.analysis": "Analiz Dokümanı — {ticket}",
  "publish.title.evidence_summary": "Kanıt Paketi Özeti — {ticket}",
  "publish.title.release_note": "Release Notu Taslağı — {ticket}",
  "publish.meta.template_version": "Şablon sürümü",
  "publish.meta.ticket": "Ticket",
  "publish.meta.run": "Akış",
  "publish.section.purpose": "1. Amaç ve iş değeri",
  "publish.section.scope": "2. Kapsam",
  "publish.section.impact": "3. Etki analizi",
  "publish.section.acceptance": "4. Kabul kriterleri",
  "publish.section.ui_api": "5. Ekran ve API değişiklikleri",
  "publish.section.test_approach": "6. Test yaklaşımı",
  "publish.section.risk": "7. Risk ve geri dönüş planı",
  "publish.section.clarifications": "Kullanılan açıklamalar",
  "publish.label.scope_included": "Kapsam içi",
  "publish.label.scope_excluded": "Kapsam dışı",
  "publish.label.risk": "Risk",
  "publish.label.mitigation": "Önlem",
  "publish.label.rollback": "Geri dönüş planı",
  "publish.label.risk_tier": "Risk katmanı",
  "publish.label.risk_reason": "Risk gerekçesi",
  "publish.label.impacted": "etkileniyor",
  "publish.label.not_impacted": "etkilenmiyor",
  "publish.label.none": "Yok",
  "publish.section.evidence_files": "Dosyalar",
  "publish.section.evidence_approvals": "Onay zinciri",
  "publish.section.evidence_retention": "Saklama",
  "publish.label.created_at": "Oluşturulma",
  "publish.label.retention_years": "Saklama süresi (yıl)",
  "publish.label.object_lock": "Object Lock",
  "publish.label.yes": "Evet",
  "publish.label.no": "Hayır",
  "publish.label.approval": "İmza",
  "publish.section.release_summary": "Özet",
  "publish.section.release_changes": "Değişiklikler",
  "publish.section.release_doc_updates": "Doküman güncelleme önerileri",
  "publish.label.merge_sha": "Merge SHA",
  "publish.label.pull_request": "PR",
  "publish.note.release_draft": "Bu not, ticket ve merge edilen diff'ten üretilmiş bir TASLAKTIR; yayın kararı ve son metin insana aittir.",
  "publish.risk_tier.dusuk": "Düşük",
  "publish.risk_tier.orta": "Orta",
  "publish.risk_tier.kritik": "Kritik",
  "publish.impact_source.primary_repo_discovery": "birincil repo keşfi",
  "publish.impact_source.repo_card": "repo kartı",
  "publish.decision.approve": "onaylandı",
  "publish.decision.reject": "reddedildi"
}
```

**en:**
```json
{
  "publish.title.analysis": "Analysis Document — {ticket}",
  "publish.title.evidence_summary": "Evidence Package Summary — {ticket}",
  "publish.title.release_note": "Release Note Draft — {ticket}",
  "publish.meta.template_version": "Template version",
  "publish.meta.ticket": "Ticket",
  "publish.meta.run": "Run",
  "publish.section.purpose": "1. Purpose and business value",
  "publish.section.scope": "2. Scope",
  "publish.section.impact": "3. Impact analysis",
  "publish.section.acceptance": "4. Acceptance criteria",
  "publish.section.ui_api": "5. Screen and API changes",
  "publish.section.test_approach": "6. Test approach",
  "publish.section.risk": "7. Risk and rollback plan",
  "publish.section.clarifications": "Clarifications used",
  "publish.label.scope_included": "In scope",
  "publish.label.scope_excluded": "Out of scope",
  "publish.label.risk": "Risk",
  "publish.label.mitigation": "Mitigation",
  "publish.label.rollback": "Rollback plan",
  "publish.label.risk_tier": "Risk tier",
  "publish.label.risk_reason": "Risk rationale",
  "publish.label.impacted": "impacted",
  "publish.label.not_impacted": "not impacted",
  "publish.label.none": "None",
  "publish.section.evidence_files": "Files",
  "publish.section.evidence_approvals": "Approval chain",
  "publish.section.evidence_retention": "Retention",
  "publish.label.created_at": "Created at",
  "publish.label.retention_years": "Retention (years)",
  "publish.label.object_lock": "Object Lock",
  "publish.label.yes": "Yes",
  "publish.label.no": "No",
  "publish.label.approval": "Signature",
  "publish.section.release_summary": "Summary",
  "publish.section.release_changes": "Changes",
  "publish.section.release_doc_updates": "Documentation update suggestions",
  "publish.label.merge_sha": "Merge SHA",
  "publish.label.pull_request": "PR",
  "publish.note.release_draft": "This note is a DRAFT generated from the ticket and the merged diff; the release decision and the final wording belong to a human.",
  "publish.risk_tier.dusuk": "Low",
  "publish.risk_tier.orta": "Medium",
  "publish.risk_tier.kritik": "Critical",
  "publish.impact_source.primary_repo_discovery": "primary repo discovery",
  "publish.impact_source.repo_card": "repo card",
  "publish.decision.approve": "approved",
  "publish.decision.reject": "rejected"
}
```

> Not: `packages/config/test/catalog-usage.test.ts` yalnız `steps|notify|gate|command|match|params|run|evidence|llm`
> ön eklerini tarıyor; `publish.*` ailesi tarayıcının kapsamında değil. Anahtarlar kataloğa eklenirken
> o testteki `KEY_LITERAL` düzenli ifadesine `publish` de eklenirse koruma bu pakete de uzanır (öneri).

## 4. Varsayımlar

1. **Belgeler zaman damgası taşımaz.** Üretim anı belgeye yazılsaydı aynı analiz her render'da farklı byte
   üretir, üç hedefteki idempotans kontrolü de çöpe giderdi. Zaman bilgisi zaten veriden geliyor
   (`EvidencePackage.createdAt`, onay kararlarının `at` alanı) ve Jira/Confluence/Git kendi zaman damgasını tutuyor.
2. **Jira gövdesi ADF'tir.** `WorkPort.addComment` "ADF ya da düz metin" kabul ediyor; DC'de wiki markup'a
   çeviri adaptörün işi (M46). Bu paket ADF üretir, Jira istemcisi kurmaz.
3. **Confluence REST v1** (`/rest/api/content`, `expand=version,body.storage`), DC ve Cloud v1'de aynı.
   Gerçek instance'tan kayıtlı fikstür **henüz yok** (insa-plani §6): testler elle yazılmış, sözleşmeye sadık
   bir sunucu ikizi kullanıyor. Erişim geldiğinde Aşama-0 duman testinde doğrulanmalı — özellikle kurum
   context path'i, proxy ve `title` araması (aynı space'te aynı başlık kuralı).
4. **Aynı içerikte Confluence sürümü artırılmıyor.** Şart "ikinci kopya oluşmasın"dı; sürüm geçmişini
   anlamsız kayıtlarla şişirmemek denetim açısından da daha doğru (değişmemiş belge "değişti" görünmüyor).
   Kurum "her yayın bir sürüm" isterse tek satırlık parametre işi.
5. **`PublishStateStore` kalıcı olmalı.** `InMemoryPublishState` yalnız test/demo içindir. Kayıt kaybolursa:
   jira'da ikinci bir yorum açılır (kurtarılabilir), confluence'ta başlıkla bulunur (kopya oluşmaz),
   repo-docs'ta aynı içerik commit edilmez ama makbuz sha yerine dosya yolu döner. Dalga 3'te `db` tablosu
   ya da `StoragePort` üstünde bir gerçekleme enjekte edilmeli.
6. **Commit/dal/PR metinleri İngilizce** (M59), belge gövdesi proje diline göre. Dal adı:
   `docs/maestro/<TICKET>-<belge>`; dosya: `docs/maestro/<TICKET>/<belge>.md`.
7. **Katalog metinleri de kaçırılıyor.** Katalog bir veri dosyası; içine markdown karakteri girse bile
   belge yapısını bozamaz. Yan etkisi: katalogdaki `_`/`*` karakterleri belgede `\_` olarak görünür.
8. **`markdownSource` port sözleşmesinde dışarıdan gelir.** Sürücüler onu ayrıştırır; belge üreticileri
   (`renderAnalysisMarkdown` vb.) aynı pakette ama ayrı kapıdır — workflow önce üretir, sonra yayınlar.

## 5. Bağımlılıklar

| Paket | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts` | runtime (workspace) | `AnalysisDoc`, `EvidencePackage`, `PublishRequest/Receipt/Target/DocKind`, ortak tipler. |
| `@maestro/ports` | runtime (workspace) | `PublishPort`, `WorkPort`, `ScmPort`, `SecretPort`, `PortRegistry`, `CapabilityNotSupportedError`. |
| `zod` ^4 | runtime | Monorepo standardı; yapılandırma + uzak yanıt doğrulaması (fail-closed). |
| `node:crypto` | runtime (yerleşik) | İçerik parmak izi (sha256). |
| `@types/node`, `typescript`, `vitest` | dev | Paket sözleşmesi. |

**Yeni harici runtime bağımlılığı YOK.** Markdown okuma, ADF ve Confluence storage dönüşümü elle yazıldı.
`@maestro/adapter-jira` **import edilmedi** (temiz oda); `@maestro/config` de import edilmedi — çeviri
fonksiyonu enjekte ediliyor (§6.5).

## 6. Arayüz/bağımlılık talepleri (contracts/ports DONMUŞ — burada yalnız kayıt)

1. **`PublishRequest` bilet anahtarı taşımıyor.** İçinde yalnız `runId` var; jira yorumu bir ticket'a,
   repo-docs bir uygulamanın repo'suna yazılmak zorunda. Şimdilik `deps.runContext(runId) → {ticketKey, app?}`
   enjekte ediliyor. Öneri: `PublishRequest`'e `ticketKey` (+ opsiyonel `appId`) eklenmesi — çözücüyü
   ve onun hata yollarını tümden ortadan kaldırır.
2. **`ScmPort`'ta dosya yazma/commit yok** (`createBranch`, `openPr` var; `commitFile` yok). Bu yüzden
   `RepoWorkspace` arayüzü bu pakette tanımlandı (`readFile(branch, path)` / `commitFile(...)`). Öneri:
   ya `ScmPort.commitFile(repo, branch, path, content, message): Promise<{sha}>` eklensin, ya da
   `RepoWorkspace` `packages/ports`'a taşınsın — Dalga 2 `execution`/runner tarafı da aynı yeteneğe ihtiyaç duyacak.
3. **İdempotans defterinin (`PublishStateStore`) portlarda karşılığı yok.** `WorkPort`'ta yorum listeleme/arama
   olmadığı için "bu koşunun analiz yorumu hangisiydi" sorusunun tek yanıtı hatırlanan id. Alternatif:
   `WorkPort.findComment(marker: string)` eklenmesi (o zaman defter gereksizleşir). Karar orkestratörün.
4. **`ReleaseNoteDraft` sözleşmesi contracts'ta yok** (M91). Bu pakette Zod ile tanımlandı:
   `{templateVersion, language, ticketKey, summary, changes[], docUpdates[], mergeSha, prId?}`.
   Studio/BFF gösterecekse `packages/contracts` altına taşınmalı.
5. **`Translate` enjekte ediliyor, `@maestro/config`'in `t`'si doğrudan çağrılmıyor.** Sebep: §3'teki
   anahtarlar henüz katalogda yok; doğrudan bağlansaydı paket kurulduğu gün `MissingMessageError` ile
   patlardı. Anahtarlar eklendikten sonra composition root `translate: t` geçer, imza birebir uyumlu.
6. **docx/pdf (M103) Aşama 2.** Şu an `CapabilityNotSupportedError`. Geldiğinde markdown → HTML dönüşümü
   `storage-format.ts`'in kardeşi olacak; PDF için headless tarayıcı, docx için ayrı araç kararı gerekiyor
   (insa-plani §6b ile aynı hat).
7. **`MaestroPublishPort.targets()`** şu an yalnız testte tüketiliyor; Studio'nun "bu projede hangi hedefler
   açık" ekranı ya da composition root doğrulaması için bırakıldı. Dalga 3-4'te tüketicisi olmazsa silinmeli.

## 7. Bilerek eksik bırakılanlar

- **docx/pdf üretimi yok** (M103, Aşama 2) — sessiz değil, `CapabilityNotSupportedError`.
- **Kalıcı defter gerçeklemesi yok** — arayüz + bellek içi ikiz; kalıcılık Dalga 3 (`db`) işi.
- **Belgeyi kim üretir kararı yok** — bu paket `AnalysisDoc`/`EvidencePackage`/`ReleaseNoteDraft`'tan
  markdown üretir; bu nesneleri üreten ajan/aktivite Dalga 3'te.
- **Şablonun kendisi (knowledge pack dosyası) burada değil** — M43/M83 gereği sürümlü şablon Studio'da
  yönetiliyor; bu paket sürümü belgeye **yazar**, şablonu okumaz.
- **Confluence sayfa ağacı/etiket yönetimi yok** — yalnız opsiyonel `parentPageId`. Label/kısıt (restriction)
  kurumsal kural gelince eklenir.
- **Gerçek Jira/Confluence fikstürü yok** — erişim gelene kadar sunucu ikizleri (insa-plani §6).

## 8. Doğrulama

```
pnpm install                          # ✓
pnpm -F @maestro/publish typecheck    # ✓
pnpm -F @maestro/publish test         # ✓ 8 dosya / 98 test
pnpm lint                             # ✓ (kök eslint)
pnpm typecheck                        # ✓ (kök turbo, 13 görev)
pnpm test                             # ✓ (kök turbo, 26 görev)
```
