# `@maestro/mcp-servers` — Dalga 3 paket raporu

Dört MCP sunucusu: `jira-mcp`, `ado-mcp`, `workspace-mcp` (ajan oturumlarına — M37) ve
`maestro-mcp` (platformun kendisini yönetmek — **M101**). Spec kaynağı: `plan/masterplan.md`
M37/M101/M32/M52/M100 + `mock/index.html` `V.mcp` ekranı.

## 1. Ne yazıldı

| Dosya | İş |
|---|---|
| `src/scopes.ts` | `read` / `operate` / `admin-proposal` kapsamları; `CallerIdentity`; kesişim (`grantedScopes`) |
| `src/tool.ts` | `defineTool` (Zod şeması + kapsam + audit konusu + handler), `defineServer`, `assertReadOnlyServer` |
| `src/forbidden-tools.ts` | **`approve_gate` · `reject_gate` · `merge_pr` yasağı** + yakın yazımları; her sunucuda zorlanır |
| `src/audit.ts` | `ai-via:<user>` aktörü (`@maestro/audit.parseActor` ile doğrulanır), `ToolAuditRecord`, `ToolAuditSink` |
| `src/runtime.ts` | Taşımadan bağımsız çekirdek: ad çözümü → kapsam → şema → handler → **audit** (her dalda) |
| `src/workspace-path.ts` | Sandbox dışına çıkma + `protected_paths` (M52) kapısı; eşleştirici `@maestro/execution`'dan |
| `src/transport.ts` | Runtime → MCP SDK `McpServer` bağlaması, çağıran başına |
| `src/transports.ts` | `serveStdio` + `serveStreamableHttp` fabrikaları |
| `src/servers/jira.ts` | `get_ticket`, `get_ticket_comments`, `search_related_tickets` — **yazma aracı yok** |
| `src/servers/ado.ts` | `get_repo`, `get_pr_status`, `list_pr_threads`, `get_pr_diff` + tek yazma: `reply_thread` (12b) |
| `src/servers/workspace.ts` | `read_file`, `list_dir`, `search_workspace`, `write_file` (M52 kapısı burada) |
| `src/servers/maestro.ts` + `maestro-platform.ts` | M101'in dokuz aracı + `MaestroPlatform` DI arayüzü |

Toplam ~1.150 satır üretim kodu + ~810 satır test. Hiçbir dosya 300 satırı geçmiyor
(en büyüğü `src/runtime.ts`, 182).

## 2. Kurallara uyum

- **`contracts` / `ports` SALT OKUNUR** — tek satır değişmedi; ihtiyaçlar §5'te talep olarak yazıldı.
- **Somut sürücü importu yok (M44)** — Jira/ADO/dosya sistemi/platform hepsi DI ile geliyor
  (`WorkPort`, `ScmPort` + bu pakette tanımlı `JiraReadAccess`, `AdoDiffAccess`, `ApplicationLookup`,
  `WorkspaceFs`, `MaestroPlatform`). Ne Prisma, ne HTTP çatısı, ne `node:fs`.
- **Tamamen çevrimdışı test** — soket yok; MCP protokol testi SDK'nın `InMemoryTransport`'uyla koşuyor.
- **Kod/yorum/test İngilizce**, bu rapor Türkçe.
- `pnpm run gate` kökten **tamamen yeşil** (44/44 görev).

## 3. Spec'in dört sert noktası ve kanıtları

### 3.1 Kapı kararı aracı YOK (M32 SoD · M101)

`approve_gate`, `reject_gate`, `merge_pr` yalnızca "yazılmadı" değil, **yazılamaz**:
`assertNoGateDecisionTools` her sunucu runtime'ında kuruluş anında koşar ve bu adları —
`approveGate`, `gate-approve`, `pr_merge` gibi yakın yazımları da — reddeder
(`src/forbidden-tools.ts`, gerekçesi dosyanın başında uzun uzun yazılı).

Kanıt (`test/no-gate-tools.test.ts`, `test/transport.test.ts`):
- dört sunucunun hiçbirinde bu adlar yok;
- `maestro-mcp` **tam olarak** M101'in saydığı dokuz aracı yayınlıyor;
- tüm kapsamları taşıyan bir çağıran için bile listede yok — hem `runtime.allTools()` hem de
  **gerçek MCP oturumunda `client.listTools()`** ile doğrulandı;
- bu adlardan biri eklenmiş bir sunucu tanımı `McpDefinitionError` ile reddediliyor.

`maestro-mcp` bekleyen kapıyı **görür** (`get_run` → `pendingGate`: adım, sahibi, kaç gündür),
ama kapatamaz. Kapı imzası yalnız insan kanalından gelir (`GateDecision.source` = `jira` | `studio`).

### 3.2 Kapsam yetmiyorsa çağrı reddediliyor

Her aracın kapsamı şemasında; runtime `hasScope` ile kesişimi kontrol eder ve reddi audit'e yazar.
Kapsamlar **düz bir küme**, merdiven değil: `operate` token'ı `read`'i, `admin-proposal`'ı
kendiliğinden içermez — hiyerarşi, kimsenin vermediği yetkiyi sessizce verirdi (`test/scopes.test.ts`).
Çağıranın göremeyeceği araç listelenmez; ama **liste bir kontrol değildir** — gizli aracı doğrudan
çağırmak da reddediliyor, o da test edildi.

### 3.3 `workspace-mcp` korunan yola yazmayı reddediyor (M52)

Ret **araç sınırında**, sürücü çağrılmadan önce: yazma hiç gerçekleşmiyor, dolayısıyla sonradan
yakalanacak yasadışı bir değişiklik de olmuyor. Ayrı bir ret sınıfı olarak sandbox'tan çıkma
(`/etc/shadow`, `../../id_rsa`, `C:/…`, kontrol karakterleri) **okuma dahil** her işlemde reddediliyor.
Korunan bir dosyayı **okumak** serbest — şemayı anlamak onu değiştirmek değil.

Eşleştirici `@maestro/execution`'dan aynen alındı; ikinci bir glob motoru yazmak, iki motorun
anlaşmazlığa düştüğü gün oturum sonrası kapının durduracağı bir yazmaya izin vermek demekti.
Repo'nun `.maestro.yaml` listesi platform tabanına **ekler**, onu küçültemez (`test/workspace.test.ts`).

Bu kapı, `@maestro/execution`'daki diff kapısının yerine geçmiyor: burası modelin platformdan
*istediği* işi kapsar, oradaki kapı oturumun kendi kabuğuyla yazdığını.

### 3.4 Her araç çağrısı audit kaydı üretiyor, aktör `ai-via:` önekli

`ok`, `unknown_tool`, kapsam reddi, şema reddi, politika reddi ve beklenmedik hata — altısı da
kayıt üretir. Aktör `aiViaActor()` ile üretilir ve **`@maestro/audit.parseActor`'a doğrulatılır**;
kurumsal hesap olmayan bir token (`service-bot`) hiçbir araç koşmadan reddedilir.
Kayıt **ham argüman taşımaz** (yalnız aracın türettiği `subject`) — serbest metin araç girdisi,
yıllarca saklanan ve maskelenmeyen bir tabloya müşteri verisinin bineceği yerdir (M20/M82).
Audit sink hata verirse çağrı `ToolAuditError` ile **düşer**; sessiz başarı yok.

Denetim eylemi eşlemesi: `start_workflow → RUN_STARTED`, `assign_app → ASSIGN_APP`.
`propose_param_change` bilerek `PARAM_CHANGED` **değil** — hiçbir şey değişmedi, öneri dört-göz
kuyruğuna girdi; aksini yazan satır zincirdeki en yanıltıcı satır olurdu. Kalan araçlar için
donmuş `AuditAction` enum'unda karşılık yok (bkz. §5 talebi); kayıt yine düşüyor, eylem kodu `null`.

Ek bir sertlik: `propose_param_change`, platformdan `pending_four_eyes` dışında bir sonuç dönerse
sonucu **reddediyor** — dört-göz kuyruğunun altta atlandığı an, başarı diye raporlanacağına yakalanıyor.

## 4. Test özeti

`pnpm -F @maestro/mcp-servers test` → **8 dosya, 56 test, hepsi yeşil**, tamamı çevrimdışı.

| Dosya | Test | Kapsadığı |
|---|---:|---|
| `test/no-gate-tools.test.ts` | 5 | kapı kararı araçlarının yokluğu, tam araç listesi, yeniden adlandırma denemeleri |
| `test/scopes.test.ts` | 7 | kapsam reddi, merdiven olmaması, listeleme filtresi, gizli aracın yine reddi |
| `test/audit.test.ts` | 7 | `ai-via:` aktörü, altı sonuç şekli, eylem eşlemesi, ham argüman sızmaması, sink hatası |
| `test/workspace.test.ts` | 9 | M52 yazma reddi, sandbox kaçışı, okuma serbestliği, repo listesinin eklemesi |
| `test/jira-ado.test.ts` | 10 | jira salt-okunur (yapısal), ado tek yazma, 12b thread yanıtı |
| `test/maestro.test.ts` | 7 | RBAC devri, öneri-uygulama ayrımı, kimlik doğrulama, tavanlar |
| `test/runtime.test.ts` | 6 | bilinmeyen araç, şema hatası, gerçek hatanın istisna kalması, tanım doğrulama |
| `test/transport.test.ts` | 5 | **gerçek MCP oturumu**: araç listesi, şema yayını, ret mesajının modele ulaşması |

**Mutasyon kontrolü:** `guardWorkspacePath`'teki M52 dalı devre dışı bırakıldığında 3 dosyada
7 test kırmızıya döndü — testler totolojik değil.

## 5. Talepler (orkestratör kararı gerekiyor)

1. **Yeni bağımlılık: `@modelcontextprotocol/sdk@^1.30` (gerekçe).** Spec "stdio + streamable HTTP
   taşımasına uygun" diyor; MCP bir tel protokolüdür, elle yazılan bir JSON-RPC/SSE katmanı
   Claude Code ve IDE istemcileriyle uyum riskini bize taşırdı. SDK yalnız `src/transport.ts` ve
   `src/transports.ts`'te, yani iki ince dosyada; **tüm kurallar SDK'sız modüllerde** ve SDK'sız
   test ediliyor. Karşılığında protokol testini gerçek istemciyle koşabiliyoruz
   (`test/transport.test.ts`). Not: SDK kendi geçişli ağacını getiriyor (express, hono, jose, ajv…);
   üretimde yalnız sunucu tarafı kullanılıyor, ama **bağımlılık envanteri açısından bilinçli bir
   karardır** ve reddedilirse taşıma katmanı elle yazılabilir — çekirdek kod değişmez.
2. **`contracts` — `AuditAction`'a `MCP_TOOL_CALL` eklensin.** Okuma araçlarının (ve
   `propose_param_change`'in) dürüst bir eylem kodu yok; şu an `action: null` ile düşüyorlar.
   `MCP_TOOL_CALL` (kategori `governance`, severity ~4) eklenirse eşleme tamamlanır. **Ben ekleyemem**
   (contracts donuk); paket şu haliyle çalışır.
3. **`ports` — `WorkPort`'a okuma yetenekleri:** `listComments(key, limit)` ve proje kapsamlı
   `searchRelated(...)`. Şimdilik `JiraReadAccess` DI dikişiyle karşılandı (`src/servers/jira.ts`).
4. **`ports` — `ScmPort.getPrDiff(repo, prId, maxBytes)`.** Şimdilik `AdoDiffAccess` dikişi.
5. **`ports` — uygulama kaydı okuması** (`getApplication(appId): ApplicationRecord`). `ScmPort.resolveRepo`
   bir `ApplicationRecord` istiyor ama onu getiren port yok; `ApplicationLookup` dikişiyle karşılandı.
6. **Kapsam kararı:** maket `V.mcp` ekranında olup görev tanımının dokuz aracına girmeyen araçlar
   (`list_pending_gates`, `notify_gate_owner`, `set_workmode`, `pause`/`resume`/`retry_step`,
   `quota_status`, `runner_health`, `toggle_killswitch`) **bilerek yazılmadı** — spec dışına taşmamak
   için. Hepsi mevcut `MaestroPlatform` + `defineTool` kalıbına birebir oturur; istenirse ~15 satır/araç.

## 6. Varsayımlar ve bilinen sınırlar

- **Kimlik bağlaması bağlantı başınadır.** `bindMcpServer(runtime, caller)` çağıranı bağlanma anında
  sabitler; BFF token'ı doğrulayıp RBAC'ı çözdükten sonra çağırır. Oturum ortasında kimlik
  değiştirilemez.
- **SDK, şemaya uymayan argümanları callback'ten önce reddeder.** Bu retler audit'e düşmez: hiçbir
  şey koşmadı, hiçbir duruma dokunulmadı — bozuk bir HTTP isteğinin muhasebe kaydı olmaması gibi.
  Platforma **ulaşan** her çağrı, platformun kendi retleri dahil, kayda geçiyor.
- **Sembolik bağ kaçışı sürücünün sorumluluğudur.** `guardWorkspacePath` yolu sandbox-göreli hale
  getirir; workspace içine konmuş bir symlink'in `/etc`'ye işaret ettiğini ancak diske dokunan sürücü
  görebilir. `WorkspaceFs` dokümantasyonunda şart olarak yazılı.
- **PII maskeleme bu katmanda yok.** `jira-mcp` ticket içeriğini sandbox içindeki ajana olduğu gibi
  verir; maskeleme sınırı LLM egress'inde (`@maestro/pii`, M20/M82). MCP sonuçları modele sandbox
  içinden gittiği için sınır değişmiyor — ama `gizli` veri sınıfında MCP sonuçlarının da maskeleme
  boundary'sinden geçmesi gerekip gerekmediği **orkestratörün onaylaması gereken bir karardır**.
- `maestro-mcp` araçlarının satır seviyesi yetkisi platformdadır: MCP kapsamı "hangi tür iş"
  sorusunu yanıtlar, "hangi satır" sorusunu değil. Her metoda `actingUser` geçiliyor ve test bunu
  dokuz aracın dokuzunda da doğruluyor.
