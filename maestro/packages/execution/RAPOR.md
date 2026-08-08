# RAPOR — `@maestro/execution`

Dalga 2 paketi: **ajan oturumunun gerçekten koşturulması** (M17 · M30 · M52 · M54 · M55 · M20/M82).
`packages/contracts` ve `packages/ports` **okundu, değiştirilmedi**. Başka hiçbir paketin dosyasına
dokunulmadı; tek dosya-dışı etki `pnpm-lock.yaml` (yeni workspace paketi kaydı).

Kapsam sınırı: llm-gateway "hangi sürücü / hangi oturum" kararını verir, bu paket "turu koştur, ne
çıktığını topla, kapıları uygula" işini yapar. `LlmOutcome`'ın `queued`/`degraded`/`blocked` dalları
burada **yeniden yorumlanmaz**, olduğu gibi yukarı geçer.

## 1. Ne yazıldı

| Dosya | İçerik |
|---|---|
| `src/cli.ts` | `claude` CLI argv + env üreticisi (saf). Bayrak doğrulaması → §2 |
| `src/stream-json.ts` | `--output-format stream-json` NDJSON okuyucusu (saf, fail-closed) |
| `src/claude-sub.ts` | **`ClaudeSubRunner implements AgentRunner`** — M55 abonelik sürücüsünün çalıştırma yarısı |
| `src/node-spawn.ts` | `SpawnFn`'in `node:child_process` gerçeklemesi (paketteki tek saf-olmayan adaptör) |
| `src/bootstrap.ts` | M30 oturum bootstrap metni + `composeTurnPrompt` (saf) |
| `src/protected-paths.ts` | M52 deny-list: glob derleyici, yol normalize, ihlal bulucu, fail-closed kapı |
| `src/strikes.ts` | M54 sayaç + CI hata parmak izi + "insana devir" kararı |
| `src/collect.ts` | Sonuç toplama: diff özeti, komut sonuçları, **PII sınırından geçen** journal yazıcısı |
| `src/execution.ts` | `AgentExecution.runTurn` — turu uçtan uca bağlayan orkestrasyon (Dalga 3 bunu çağırır) |
| `src/types.ts`, `src/errors.ts`, `src/index.ts` | Enjeksiyon arayüzleri, hata sınıfları, dışa açım |

**Üretim kodu 1191 satır** (tavan 1200), en büyük dosya 142 satır (tavan 300).
**112 test / 9 dosya**, hepsi çevrimdışı ve deterministik.

### `AgentRunner` nasıl dolduruldu

llm-gateway `agentSession` içinde `deps.agentRunner.run(...)` çağırıyor ve runner yoksa
`AgentRunnerNotWiredError` atıyor. `ClaudeSubRunner` tam olarak o arayüzü karşılıyor:

```ts
const gateway = new LlmGateway(cfg, {
  ...deps,
  agentRunner: new ClaudeSubRunner(nodeSpawn(), {
    binPath: "/home/svc/.local/bin/claude",
    basePath: "/usr/bin:/home/svc/.local/bin",
    home: "/home/svc",
    permissionMode: "acceptEdits",
    mcpConfigPath: "/etc/maestro/mcp.json",
    timeoutMs: 30 * 60_000,
    resolveSeat: (ref) => secrets.claudeSeat(ref),   // credentialRef → OAuth token
  }),
});
```

`vendorSessionId === null` → yeni oturum, aksi halde `--resume <id>`. Dönen `vendorSessionId`
gateway'in `AgentSessionStore`'una gidiyor; `resumeToken` ↔ vendor session eşlemesi gateway'de kalıyor,
bu paket vendor tarafını sürüyor.

## 2. CLI bayrakları nereden doğrulandı (uydurma yok)

Makinede kurulu sürüm: `/home/ubuntu/.local/bin/claude` → `/home/ubuntu/.local/share/claude/versions/2.1.226`
(ELF ikili, bundled). **Gerçek `claude` hiçbir testte çağrılmadı**; doğrulama iki kaynaktan yapıldı:

**(a) `claude --help` çıktısı (v2.1.226).** Kullanılan her bayrak yardım metninde birebir var:

| Bayrak | Yardım metnindeki tanım |
|---|---|
| `-p, --print` | "Print response and exit (useful for pipes)" |
| `--output-format <format>` | "only works with --print: text (default), json, **stream-json**" |
| `--verbose` | "Override verbose mode setting from config" |
| `--input-format <format>` | "only works with --print: text (default), stream-json" |
| `--model <model>` | "Model for the current session" |
| `--permission-mode <mode>` | choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` |
| `--mcp-config <configs...>` | "Load MCP servers from JSON files or strings" |
| `--strict-mcp-config` | "Only use MCP servers from --mcp-config, ignoring all other MCP configurations" |
| `--allowedTools, --allowed-tools <tools...>` | "Comma or space-separated list of tool names to allow" |
| `-r, --resume [value]` | "Resume a conversation by session ID" |
| `--session-id <uuid>` | "Use a specific session ID (must be a valid UUID)" |
| `--fork-session` | "When resuming, create a new session ID instead of reusing the original" — **kullanılmıyor** (id'nin sabit kalması resume doğrulamasının dayanağı) |

**(b) İkilinin içindeki dizgiler** (`grep -a` ile, ikili çalıştırılmadan) — akış mesaj şekilleri için:

```
type:"system",subtype:"init",cwd:…,session_id:…,tools:…,mcp_servers:…,model:…,permissionMode:…
{type:"result",subtype:"success",duration_ms,duration_api_ms,is_error,num_turns,result,
 stop_reason,total_cost_usd,usage:{…},modelUsage,permission_denials,session_id,uuid}
type:"result",subtype:"error_during_execution" … errors:[…]
usage: input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
mcp__${serverName}                       → izinli araç adı öneki
CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY   → env değişken adları
"Error: When using --print, --output-format=stream-json requires --verbose"
```

Son satır bu paketteki bir tasarım kuralının kaynağı: `--verbose`, stream-json ile **çift** olarak
gönderiliyor, ayrı düşürülemiyor (`cli.test.ts` bunu kilitliyor).

### `--bare` neden KULLANILMIYOR (M55 için kritik)

`--bare`, izolasyon için doğru anahtar gibi duruyor ama yardım metni şunu diyor:
"Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`
(**OAuth and keychain are never read**)". Abonelik koltuğunun elinde tam olarak API anahtarı **yok** —
`--bare` bu sürücüyü çalışamaz hale getirirdi. Onun yerine `--mcp-config` + `--strict-mcp-config`
ile daraltma yapılıyor; test: "never uses --bare".

### Diğer sürücü kararları

- **Prompt argv'de değil, stdin'de.** Tire ile başlayan/çok satırlı bir görev bayrak sanılamaz ve
  görev `ps` çıktısına düşmez.
- **Env allow-list.** `process.env` kopyalanmıyor; sadece `PATH`, `HOME`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR` veriliyor (M80). `ANTHROPIC_API_KEY` bu yolda hiç set edilmiyor — test var.
- **`shell: false`.** Argümanlar dizi olarak geçiyor.
- **Fail-closed okuma.** `result` mesajı yok → hata; iki tane var → hata; `is_error`/non-zero exit →
  hata; timeout → hata. Hiçbiri "boş cevap"a çevrilmiyor (gateway sözleşmesi: outcome = karar,
  exception = arıza).
- **Resume kimlik kontrolü.** `--resume` sonrası dönen `session_id` farklıysa CLI yeni bir konuşma
  başlatmış demektir → M30 bağlamı kaybolmuştur → hata.
- **Token sayımı.** `tokensIn = input + cache_read + cache_creation`; önbellekli tur "bedava"
  sayılmıyor (M55 kota muhasebesi).

## 3. M30 — bootstrap

`buildSessionBootstrap(ctx)` saf fonksiyon; ticket defteri + yaşayan özet + workspace durumu +
protected_paths + izinli MCP sunucuları + görev tek blok halinde üretiliyor.
`composeTurnPrompt(ctx, isResume)`: **resume'da yalnız görev** gider — bootstrap'i tekrar göndermek
hem kota yakar hem de modele "sıfırdan başlıyorsun" der. Sınırlar parametrik
(`DEFAULT_BOOTSTRAP_LIMITS`: son 40 kayıt, detay 600 karakter, 50 kirli dosya) ve kırpma **sayısıyla
birlikte** yazılıyor ("5 older entries omitted"). Workspace yoksa metin bunu açıkça söylüyor
(M30: "workspace yoksa journal+özet ile bootstrap").

Metin İngilizce, çünkü model promptu — kullanıcıya görünen bir dize değil; M104 i18n kapsamına girmez.

## 4. M52 — protected_paths (fail-closed)

- Desteklenen glob alt kümesi: `**`, `*`, `?`. Fazlasını isteyen desen **yükleme anında reddediliyor**
  (sessizce hiçbir şey eşleşmemesi bu paketin en tehlikeli sessiz hatası olurdu).
- `**/migrations/**` üst düzey `migrations/x.sql`'i de yakalar (`**/` sıfır segment eşler).
- Mutlak yol / `..` içeren yol / ters bölü → hata; workspace dışına çıkan bir değişiklik zaten ihlaldir.
- Varsayılan liste (M52 "migration + secrets varsayılan korumalı"): `**/migrations/**`, `**/*.sql`,
  `**/secrets/**`, `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `.maestro.yaml`.
- Kontrol **oturum sonunda** yapılıyor; ihlal varsa tur `status: "failed", reason: "protected_path"`
  döner, hangi dosyanın hangi deseni tetiklediği rapora yazılır ve **doğrulama komutları hiç
  koşturulmaz** (yasal olmayan bir diff üstündeki yeşil build onay gibi okunurdu).
- Workspace okunamıyorsa `WorkspaceProbeError` — "hiçbir şeye dokunulmadı" kanıtlanamaz, o yüzden
  sessizce "değişiklik yok" denmiyor.

## 5. M54 — 3-strike devir

`StrikeLedger(now, limit = 3)`; anahtar `{runId, scope: "gate"|"ci"|"agent", ref}`. Farklı kapı,
farklı scope, farklı run **asla** sayaç paylaşmaz. `handoverDecision(state)` →
`{handover, workMode: "ai_assist", messageKey: "run.handover_stuck", count, limit, reasons}`.
N parametrik (M54; M71 gereği DB'den gelir). `ciFingerprint()` sayıları, hex id'leri, yolları ve
süreleri normalize edip sha256'nın ilk 16 hane'sini döner — aynı bozuk testin iki koşusu tek sayaca
düşer, gerçekten farklı iki hata düşmez.

**Sinyal üretilir, uygulanmaz.** Work-mode değişimi ve Jira özeti Dalga 3 workflow'unun işi.

## 6. Sonuç toplama + PII sınırı (M20/M82)

`SessionReport` = değişen dosyalar · diff özeti (`files/insertions/deletions`) · komut çıktıları
(lint/build/test, **hepsi koşar**, ilk kırmızıda durmaz) · protected ihlalleri · strike durumu ·
`resumeToken` · zaman damgası.

Journal yazımı `createReportJournal()` üzerinden, `@maestro/pii`'nin **`withPiiBoundary`**'siyle:
sink'in parametre tipi `Masked<SessionReport>` olduğu için **ham rapor ile sink'i çağırmak derlenmez**
(bunu `@ts-expect-error`'lu bir test kilitliyor; tsconfig `test/**`'i de derliyor, yani iddia
typecheck'te doğrulanıyor). Sınır sink'ten önce `assertNoPii` koşturur, yani maskelemeyi ıskalayan
bir masker `PiiLeakError` verir. Komut çıktıları da maskelenir — müşteri kaydı basan bir test
tam olarak sızıntının yolu. Ham kopya yalnız çağıranın elinde kalır, journal'a maskeli hali gider.

## 7. Varsayımlar

1. **`WorkspaceProbe` ve `VerificationRunner` bu pakette gerçeklenmedi**, enjekte ediliyor: git
   çalışma kopyasını okumak ve komutu sandbox'ta koşturmak `runners/docker-linux`'un ve Dalga 3'ün
   işi. Bu paket ikisinin de hatasını **ölümcül** sayar (fail-open yok).
2. `permissionMode` varsayılansız, zorunlu alan: bir bankada ajanın gözetimsiz ne kadar iş
   yapabileceğine bu paket karar veremez, composition root karar verir.
3. `credentialRef → SeatCredential` çözümü `resolveSeat` fonksiyonuyla dışarıda; bu nesne hiçbir
   zaman token tutmaz. Gerçeklemesi `SecretPort` üzerinden Dalga 3'te bağlanacak.
4. `@maestro/llm-gateway` bağımlılığı **yalnız tip** içindir (`import type`, `verbatimModuleSyntax`
   ile derlemede silinir). Runtime'da gateway'e bağlanma yönü tersidir: gateway runner'ı enjekte alır.
5. Yeni npm bağımlılığı yok. `node:crypto` ve `node:child_process` yalnızca Node yerleşikleri.

## 8. Talepler (orkestratör kararı gerekir)

1. **i18n anahtarı:** `run.handover_stuck` (M54 devir mesajı) `packages/config/locales`'a eklenmeli.
   Bu paket anahtarı üretiyor, metni üretmiyor (M104).
2. **`.maestro.yaml` şeması:** `protected_paths` ve lint/build/test komutları için henüz bir Zod
   şeması yok (M71 `.maestro.yaml`'ı repo-öz bilgilerle sınırlıyor). Bu paket ikisini de düz
   `string[]` / `CommandSpec[]` olarak alıyor; şema `contracts`'a girerse buradaki tipler ona
   bağlanmalı — **arayüz değişikliği olduğu için karar orkestratörde**.
3. **M53 (bağımlılık sınırı) bu pakette YOK.** Kapsamda "yapan rolün oturumu" vardı; onaylı-liste
   kontrolü ve lockfile değişimi işaretlemesi lockfile diff'i okumayı gerektiriyor ve doğal yeri
   Dalga 2'nin `scanners` paketi ya da Dalga 3'ün PR adımı. Nereye konacağına karar verilmeli.
4. **Kota muhasebesi ve `--max-budget-usd`:** abonelik sürücüsünde maliyet dolar değil kota (M55),
   bu yüzden `--max-budget-usd` **bilerek geçilmiyor**. `result.total_cost_usd` ayrıştırılıyor ama
   `LlmCallLog.usd` gateway'de `null` kalıyor; bu tutarlı, sadece kayda geçiyor.
5. **Oturum ilerlemesinin journal'a akıtılması:** `onStdoutLine` ucu var ve `nodeSpawn` besliyor,
   ancak bu paket ondan journal kaydı üretmiyor (M30 "yaşayan özet" `memory` paketinin işi). Bağlantı
   Dalga 2 `memory` paketiyle kurulmalı.
