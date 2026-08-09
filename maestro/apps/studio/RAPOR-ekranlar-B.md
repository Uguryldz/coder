# Studio ekranları — küme B (yönetim ekranları)

Dalga 4 · 11 ekran · platformu yöneten, ayarlayan ekranlar.

**Branch:** `worktree-agent-ab01b419310e9e82d` · **temel commit:** `78783a7`

**Kapı:** `pnpm run gate` → **exit 0** (50/50 görev).
`pnpm --filter @maestro/studio build` → **exit 0** (478 kB JS / 145 kB gzip).
Studio testleri: **94** (56 iskelet + **38 yeni**). Hiçbir dosya 300 satırı geçmiyor
(en büyük: `common/admin-api.ts` 286, `Users.tsx` 285).

---

## 1. Yazılan ekranlar

| Ekran | Ne yapar |
|---|---|
| **params** | `GET /params` — tanım + değer + bekleyen öneri birleştirilir; her tanım listelenir (hiç değişmemiş olan varsayılanıyla görünür). `guarded` parametre **doğrudan kaydedilmez**: düğme "Onaya gönder" der, 202 yanıtı "eski değer hâlâ geçerli" mesajına dönüşür, açık öneri satırda öneren kişiyle birlikte gösterilir. Değer türü istemcide de doğrulanır (yanlış türde istek gitmez). |
| **settings** | Bağlantılar (Jira/ADO/Vault/depolama/SIEM/proxy/dizin/Confluence) + bildirim sürücüleri + **kill-switch paneli**. Secret gösterilmez, yalnız Vault referansı. |
| **users** | Kapalı `ROLES` kümesinden onay kutularıyla rol verme (serbest metin yok); `viewer` taban rol. Pasifleştirme onay modalı + gerekçe ister. **Pasif hesap listeden kaybolmaz** ve açık oturum sayısı yanında gösterilir. SoD matrisi + AI servis hesabı kartı. |
| **yaml** | `.maestro.yaml` **salt-okunur** gösterilir (dosya repoda yaşar). Korumalı yollar (M52) iki yarım: platform varsayılanları salt-okunur listelenir (**silme düğmesi yoktur**), repo eklemeleri eklenip kaldırılabilir. |
| **runners** | Havuz KPI'ları + makine tablosu. `unreachable` makine **en üste sıralanır**, ayrı bir uyarı bandı çıkar ve **kapasite hesabına katılmaz**. İzolasyon profili + kabul edilmiş risk kartları. |
| **sandbox** | Açık oturumlar + seçili oturumun zarfı (runner, imaj, limitler, timeout, egress, MCP araçları). **Canlı çıktı/transkript gösterilmez** — gerekçe §5. |
| **mcp** | Araç seti kapsamlarıyla (`read` / `operate` / `admin-öneri`) ve **yasaklı araçlar** (`approve_gate`, `reject_gate`, `merge_pr`) açıkça listelenir; "MCP kapı kararı veremez" notu KPI + kart olarak iki yerde. |
| **commands** | Jira komut tablosu + doğrulama zinciri. "Yorumun tamamı komut olmalı" ve "yorum düzenlemesi komut sayılmaz" kuralları ayrı ayrı yazılı. |
| **notify** | Hatırlatıcı merdiveni, delegasyon zinciri, canlı bekleyenler (bekleme süresine göre renk). "Hiçbir aşamada otomatik ret yok" notu. |
| **health** | Servis tablosu + Temporal + yedekleme + audit/SIEM. **Geri dönüş tatbikatı yapılmadıysa uyarıya dönüşür** (M66); yapılmışsa uyarı kaybolur. |
| **onboard** | 4 adımlı sihirbaz. Tüm seçimler `Select` (serbest metin yok). **Kuru koşum (M102) zorunlu**: yapılmadan "Admin onayına gönder" düğmesi pasif; taslak değişince eski kuru koşum sonucu **geçersiz kılınır**. Çözülemeyen ticket'lar isim isim gösterilir. |

### Ortak parçalar (`src/screens/common/`)
`QueryState` (yükleniyor/hata/boş üçlüsü, hata = `t(messageKeyOf(error))`),
`ConfirmModal` (gerekçesiz onay vermez), `KeyValue`/`formatValue`/`useDuration`,
`useLabel` (§4), `admin-api.ts` + `onboarding-api.ts` (tüm uç sözleşmeleri),
`screens.css` (yalnız `var(--token)`).

---

## 2. Katalog

**tr ve en'e 384'er anahtar eklendi** (248 → **632**, iki dilde birebir parite).
Ad alanları: `params.*`, `killswitch.*`, `settings.*`, `users.*`, `yaml.*`,
`runners.*`, `sandbox.*`, `mcp.*`, `commands.*`, `notify.*`, `health.*`,
`onboard.*`, ayrıca paylaşılan `role.*` (6 rol + açıklamaları), `platform.*`,
`duration.*`, `field.reason*`, `error.reason_required`.

Ekranlarda **tek bir gömülü kullanıcı metni yok**. Süre ifadeleri bile katalogdan
(`duration.days_hours`) — sayıya birim eklenerek üretilmiyor.

---

## 3. Testler (38 yeni)

| Dosya | Adet | Kapsam |
|---|---|---|
| `test/screens-params.test.tsx` | 7 | Guarded parametrede "Kaydet" **yok**, "Onaya gönder" var; 202'de "eski değer geçerli"; açık öneri + öneren; hata kodu değil çevrilmiş cümle; tür uymayan değer **PUT edilmez**; hiç değişmemiş parametre varsayılanıyla listelenir. |
| `test/screens-killswitch.test.tsx` | 6 | Düğmeye basmak **istek göndermez** (yalnız modal açar); gerekçesiz onay **istek göndermez**; onaylanınca gövde `{level, reason}`; delegated oturumda kontroller **gizli**; admin olmayanda **gizli**; `all` onayında "geri alınamaz" uyarısı; sunucudaki seviye gösterilir. |
| `test/screens-users.test.tsx` | 8 | Pasif hesap **listede kalır** + açık oturum sayısı görünür; pasifleştirme öncesi oturum uyarısı; gerekçesiz **PUT yok**; sunucu "3 oturum açık" derse operatöre söylenir; rol alanı **checkbox**, dialogda hiç `textbox` yok; roller boşaltılınca gövde `{roles:["viewer"]}`; viewer ve delegated admin'e düzenleme yok. |
| `test/screens-platform.test.tsx` | 17 | runners: unreachable **ilk satır**, uyarı bandı, kapasiteye **katılmaz**, hata çevrilir. sandbox: boş durum uydurmaz, zarf + limitler. yaml: varsayılanlar için **sıfır** silme düğmesi, yalnız POST (hiç DELETE yok), boş yol gönderilmez. mcp: yasaklı araçlar + "karar veremez". health: tatbikat yoksa uyarı / varsa uyarı yok / **tanınmayan servis sayfayı düşürmez**. commands: iki dil kuralı. notify: otomatik ret yok + "16 gün 2 saat". onboard: kuru koşumsuz gönderim **engelli**, çözülemeyen ticket'lar isimle, taslak değişince kuru koşum geçersiz. |

`test/harness.tsx` — rota tablolu, **her isteği kaydeden** fetch stub'ı. Böylece
testler yalnız ekranda ne yazdığını değil **ne gönderildiğini** de doğruluyor.
Tanımsız uç 404 `not_found` döner (BFF'in yapacağı şey). Ağa çıkan test yok.

**Mutasyon doğrulaması yapıldı:** `ParamEditor`'da guarded dalının etiketi
`params.action.propose` → `action.save` yapıldığında **2 test kırmızıya döndü**;
düzeltilince geri yeşillendi. Testler tautolojik değil.

---

## 4. UÇ İSTEKLERİ (BFF ajanına)

Bugün var olan ve **kullandığım** uçlar: `GET /params`, `PUT /params/:key`,
`GET /killswitch`, `POST /killswitch`. Aşağıdakiler **yok**; ekranları ve veri
katmanını yazdım, uydurma veri göstermiyorlar — uç gelene kadar hata/boş durum
gösteriyorlar. Tip sözleşmeleri `src/screens/common/admin-api.ts` ve
`onboarding-api.ts` içinde yazılı; BFF'in dönüşü onlara uymalı.

> **Ortak kural:** kullanıcıya görünecek her metin **katalog anahtarı** olarak
> dönmeli (`descriptionKey`, `noteKey`, `messageKey`), düzyazı olarak değil (M104).
> Studio ham sunucu metni basmıyor.

### 4.1 `GET /users` → `UsersView`
Roller: `admin`. Dönüş:
- `users[]`: `userId`, `username`, `displayName`, `groups[]`, `roles[]` (**`contracts` `Role` kümesinden**), `active`, **`activeSessions`** (canlı oturum sayısı), `lastLoginAt|null`.
- `sod[]`: `{ id, enforced }` — `id` katalog anahtarının son parçası (`producer_approver`, `po_tl`, `approver_merger`, `ai_cannot_approve`, `qa_split` eklendi).
- `serviceAccount`: `{ account, jira, ado, commitSignature, credentialTtlMinutes }` veya `null`.

**`activeSessions` kritik:** geçmişte "iptal edilen hesap 8 saat admin kaldı"
açığı bulunmuş. Arayüz pasif hesabın canlı oturumunu gösteriyor; bu alan
gelmezse açık yine görünmez olur.

### 4.2 `PUT /users/:userId/roles` → `ManagedUser`
Gövde: `{ roles: Role[] }`. Roller kapalı kümeden doğrulanmalı; boş dizi
gelirse `["viewer"]` uygulanmalı (Studio zaten böyle gönderiyor). Audit.

### 4.3 `PUT /users/:userId/active` → `ManagedUser`
Gövde: `{ active: boolean, reason: string }` (**gerekçe zorunlu**).
`active:false` **hesabın tüm oturumlarını da düşürmeli**; dönüşteki
`activeSessions` gerçek kalan sayı olmalı (Studio 0 değilse operatörü uyarıyor).
Kendi hesabını pasifleştirme ve son admin'i pasifleştirme reddedilmeli.

### 4.4 `GET /runners` → `RunnersView`
`runners[]`: `id`, `host`, `pool`, `platform`, `capacity`, `busy`, `jobs[]`,
`status: "ok"|"warn"|"unreachable"`, `messageKey|null`, `lastSeenAt`.
**`unreachable` gizlenmemeli** — heartbeat'i gecikmiş makine bu statüyle gelmeli.

### 4.5 `GET /sandbox` → `SandboxView`
`sessions[]`: `sessionId`, `ticketKey`, `runnerId`, `pool`, `image`,
`workspaceMounted`, `resumed`, `turn`, `memoryMb`, `cpus`, `pids`,
`timeoutMinutes`, `egressTargets`, `startedAt`, `tools[]{name,scope}`.
**Oturum çıktısı/transkript talep etmiyorum** — gerekçe §5.

### 4.6 `GET /health` → `HealthView`
`/healthz` ve `/readyz` var ama ayrıntı taşımıyor. Gereken:
`services[]{id,status,version,uptimeSeconds,noteKey,noteParams}`,
`workflows{open,longestDays,continueAsNew,failedActivities}`,
`backup{databaseAt,vaultAt,**restoreDrillAt**}`,
`audit{queued,lastShippedAt,lastAnchorAt}`.
`restoreDrillAt: null` → ekran M66 uyarısını çıkarır. Bu alan **null dönebilmeli**,
sahte tarih dönmemeli.

### 4.7 `GET /settings` → `SettingsView`
`connections[]{id,endpoint,status,credentialRef,checkedAt}` — `credentialRef`
**Vault yolu veya auth yöntemi**, asla secret. `notifyDrivers[]{channel,enabled,target}`.
(Mockta "Bağlantıyı test et" düğmesi var; `POST /settings/connections/:id/test`
ileride eklenirse ekrana takarım — şimdilik koymadım, bkz. §5.)

### 4.8 `GET /notify` → `NotifyView`
`ladder[]{afterHours,channels[],kind:"notify"|"delegate"|"report"}`,
`delegations[]{role,primary,backup,lastResort}`,
`waiting[]{ticketKey,step,waitingHours,lastActionKey,lastActionParams}`.
`step` katalog son-parçası (`analysis`,`pr`,`clarification`,`test_plan`,`test_result` eklendi).

### 4.9 `GET /mcp/manifest` → `McpView`
`endpoint`, `auditActor`, `tools[]{name,scope,descriptionKey}`,
**`forbiddenTools[]`**. Yasaklı liste **sunucudan gelmeli** — Studio'da sabit
yazarsam, MCP'ye bir gün `approve_gate` eklenirse ekran yalan söylemeye devam eder.
Not: mockta araç adı `toggle_killswitch`; görev tanımına göre doğrusu
**`propose_killswitch`** ve kapsamı `admin-proposal`.

### 4.10 `GET /commands` → `CommandsView`
`commands[]{name,roles[],takesArgument,whenKey,effectKey}`.
Kaynak `apps/bff/src/jira-commands.ts` — orada zaten var, dışa vurulması yeterli.

### 4.11 `GET /repo-policy` → `RepoPolicyView`
`policies[]`: `appId`, `platform`, `repo`, `yaml` (dosyanın ham içeriği),
`protectedPaths{ **platformDefaults[]**, **repoAdditions[]** }`, `fetchedAt`.
**İki listenin ayrı gelmesi zorunlu** (M52): tek liste gelirse arayüz varsayılanı
silinebilir gösterir ve sunucunun reddedeceği bir düğme çizmiş olurum.

### 4.12 `POST /repo-policy/:appId/protected-paths`
Gövde `{ path }`. **Yalnız ekleme.**
### 4.13 `DELETE /repo-policy/:appId/protected-paths/:path`
**Yalnız `repoAdditions` silinebilir**; `platformDefaults` içindeki bir yol için
403 dönmeli (Studio zaten düğme çizmiyor, ama kapı sunucuda olmalı).

### 4.14 `GET /onboarding/options` → `OnboardingOptions`
`{ jiraProjects[], adoRepos[], platforms[] }`.
### 4.15 `POST /onboarding/dry-run` → `DryRunResult`
Gövde `{ jiraProject, adoRepo }` → `{ byRule[], bySuggestion[], unresolved[] }` (ticket key'leri).
### 4.16 `POST /onboarding` → `{ proposalId }`
Gövde: `{ jiraProject, adoRepo, platform, triggerMode, gateSet, mergeMode }`.
**Canlı yapılandırma yazmamalı** — admin onay kuyruğuna öneri düşürmeli (M93).
Sunucu da kuru koşum yapılmadan gönderimi reddetmeli (istemci kapısı yeterli değil).

---

## 5. Yapmadıklarım ve nedenleri

- **Sandbox canlı log/transkript paneli.** Mockta var; koymadım. Canlı ajan
  çıktısı **maskelenmemiş ticket metni** (PII, M18) içerebilecek tek yüzeydir ve
  onu okuyacak bir uç da yok. Uydurma log akıtmak yerine oturum zarfını gösterip
  nedenini ekranda yazdım. Ürün bunu isterse maskeleme + yetki kararı önce verilmeli.
- **`.maestro.yaml` içeriğini Studio'dan düzenleme.** Dosya repoda yaşar ve
  doğruluk kaynağı takımdır (M71/M93); düzenleme takımın PR süreciyle olmalı.
  Yalnız korumalı yollara ekleme akışı var.
- **"Bağlantıyı test et" / "AD'den senkronize et" / "Tümünü test et" düğmeleri.**
  Mockta var ama karşılık gelen uç yok; **çalışmayan düğme çizmedim**. Uçlar
  gelirse ekleme maliyeti düşük (§4.7).
- **Parametre sürüm geçmişi paneli.** `GET /params` yalnız güncel `values`
  dönüyor; geçmiş için `GET /params/:key/history` gerekir. İstemedim çünkü küme
  B'nin güvenlik yükü 4-göz akışındaydı; ayrı bir istek olarak açılabilir.
- **Kill-switch "öneri" kuyruğu ekranı.** M101'e göre MCP `propose_killswitch`
  ile öneri oluşturur ve insan Studio'da onaylar. Bugün BFF'te bekleyen
  kill-switch önerisi tutan bir yapı **yok** (`POST /killswitch` doğrudan uygular).
  Studio tarafını **çift onaylı bir öneri gibi** tasarladım (modal + zorunlu
  gerekçe + geri alınamaz uyarısı), ama **MCP'den gelen bekleyen öneriyi listeleyen
  bir kuyruk yapamadım** — veri yok. Bunun için gereken:
  `GET /killswitch/proposals` → `{ proposals[]{ id, level, reason, proposedBy, at } }`
  ve `POST /killswitch/proposals/:id/approve`. **Bu, M58+M101'in tam karşılığı için
  eksik kalan tek parçadır**; params'taki 4-göz deseninin (`pending` + ikinci kişi)
  kill-switch'e de uygulanması gerekir.
- **Karanlık tema anahtarı** ve **rota tablosu değişikliği** — kapsam dışı,
  `screens.ts`'e dokunulmadı.

---

## 6. Ortak alana yazdıklarım

`src/ui/`, `src/api/`, `src/app/` dosyalarının **hiçbirine dokunmadım**.
`src/app/screens.ts` değişmedi.

Ortak sayılabilecek tek dosya çifti **katalog**: `packages/config/locales/{tr,en}.json`
(384'er anahtar eklendi, mevcut anahtar **değiştirilmedi** — merge betiği çakışma
olursa duruyor, çakışma çıkmadı). Diğer küme ajanları da buraya yazacağı için
birleştirmede anahtar kesişimi kontrol edilmeli; ad alanlarım ekran adlarımla
başladığı için çakışma beklemiyorum. Paylaşılan `role.*`, `platform.*`,
`duration.*`, `field.reason*` anahtarlarını **ben ekledim** — başka bir ajan aynı
anahtarı farklı metinle eklerse çakışır, o durumda benimki silinebilir.

## 7. Not: kapı çalıştırırken görülen flake

`pnpm run gate` bir koşumda `@maestro/storage#test`, başka bir koşumda
`@maestro/claude-driver#test` ile düştü; ikisi de **tek başına çalıştırıldığında
geçiyor** (210/210 ve 68/68) ve **benim değişikliklerim stash'lenmiş temiz ağaçta
da aynı davranış gözlendi**. Zamanlamaya duyarlı iki test (`s3-response` 3.2 sn'lik
sayfa tavanı testi, `node-spawn` proses grubu öldürme testi) `--concurrency=4`
altında yük bindiğinde düşüyor. Son üç koşumun ikisi ve **son koşum exit 0**.
Studio'nun 94 testi her koşumda geçti. Bu, küme B'nin ürettiği bir sorun değil
ama kapının güvenilirliği için ayrıca ele alınmaya değer.
