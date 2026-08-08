# RAPOR — `@maestro/runners` (Dalga 2)

`RunnerPort`'un **docker-linux** sürücüsü (M21): efemer, sertleştirilmiş konteyner (M23/M24),
egress proxy'si (M26), dijest-pinli imaj (M27), 3 katmanlı cache'in ① ve ② katmanları (M31),
çalışma alanı yaşam döngüsü (M65) ve win/mac ajanları için **yalnız protokol iskeleti** (M22).
Kod/yorum/test adları İngilizce (M59); bu rapor Türkçe.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/deps.ts` | Enjekte edilen işbirlikçiler: `Clock`, `Timer` (iptal edilebilir gecikme), `IdSource`, **`DockerTransport`** (bayt boru hattı), `AuditSink` + `RUNNER_ACTOR`. Paketin tamamı bu arayüzlerin üstünde durduğu için varsayılan test paketi **hiç soket açmaz**. |
| `src/errors.ts` | Tipli hatalar: `RunnerConfigError`, `RunnerCapacityError`, `RunnerLeaseError`, `RunnerKeyError`, `DockerHttpError`, `DockerResponseError`, `AgentProtocolError`. **Kural:** hata metni ne sorulduğunu (konteyner adı, imaj, durum kodu) söyler, işin `env`'ini/komut yükünü ASLA taşımaz (kısa ömürlü token'lar orada — M80). |
| `src/config.ts` | Zod yapılandırması: `SandboxProfile`, `EgressConfig`, `WorkspaceConfig`, `PlatformSlot`, `DockerRunnerConfig`, `ImageRef` (dijest zorunlu), `isProductionStage`, **`profileIssues`** (sertleştirme kapısı, şemadan ayrı ve doğrudan test edilebilir). |
| `src/http.ts` | Elle yazılmış minimal HTTP/1.1: `encodeRequest` · `decodeResponse` (content-length **ve** chunked **ve** close-delimited) · `query`. `dockerode` YOK. |
| `src/docker-client.ts` | Engine API'sinin dar dilimi: create/start/wait/kill/remove · logs (+`demultiplex`) · volume create/remove · image inspect · `_ping`. Durum→hata eşlemesi, gövde kırpma, `tail()`. **exec / image push / swarm bilinçli olarak yok** (M24 dar API). |
| `src/unix-transport.ts` | `node:net` ile unix soket taşıması — ağa dokunan **tek** dosya. |
| `src/sandbox.ts` | **`buildContainerSpec`**: yapılandırma+iş → Docker create yükü. Saf fonksiyon; profil bir güvenlik kontrolü olduğu için konteyner başlatmadan doğrulanabilmesi şart. `sandboxEnv`, `sandboxBinds`, `egressNetworkMode`, `containerName` de saf. |
| `src/pool.ts` | `RunnerPool`: platform başına slot, `acquire` (kuyruk yok, fail-closed), `slotOf` (bilinmeyen/serbest bırakılmış/yabancı lease ayrımı), `beginSession`/`endSession` (meşgul runner'a ikinci iş verilmez), **idempotent `release`**, `attachCache`, `snapshot`. |
| `src/docker-runner.ts` | `DockerLinuxRunner implements RunnerPort`: `acquire`/`runSession`/`mountCache`/`release` + port dışı `removeWorkspace`, `sweepExpiredWorkspaces`, `ping`, `snapshot`. M23 zaman aşımı yarışı ve öldürme burada. |
| `src/agent-protocol.ts` | M22 şemaları (`AgentRegister`/`AgentHeartbeat`/`AgentBye` → `AgentMessage`; `RegisterAccepted`/`HeartbeatAck` → `PlatformReply`) + **`AgentRegistry`** (kayıt, heartbeat, süre dolumu, kapasite görünümü). **Sunucu/dinleyici yok** — taşıma Dalga 3. |
| `src/register.ts` | `registerRunnerDrivers(registry, deps)` (M44 DI), `createDockerLinuxRunner`, `resolvePinnedImage` (tag → dijest, dağıtım aracı için). |
| `src/index.ts` | Dış yüzey. **`DockerClient` yalnız TİP olarak** dışa verilir (aşağıda §4). |
| `fixtures/*.http` | **Gerçek Docker Engine 29.4'ten kaydedilmiş ham HTTP yanıtları** (create/start/wait/logs/remove/404/volume/ping/image inspect + `containers-start-bad-seccomp.http`). Testler hiçbir yanıt şeklini uydurmuyor. |

## 2. Sertleştirilmiş profil (M23/M24/M26/M27)

Hiçbir şey söylemeyen bir yapılandırmanın ürettiği konteyner:
`ReadonlyRootfs: true` · `CapDrop: ["ALL"]`, `CapAdd: []` · `no-new-privileges:true` ·
`User: 10001:10001` · `Memory`/`MemorySwap` eşit (**swap kapalı** — swap'layabilen limit, limit değildir) ·
`NanoCpus` · `PidsLimit` · `nofile` ulimit · `/tmp` için `rw,noexec,nosuid,nodev,size=…` tmpfs ·
`Init: true` · `RestartPolicy: no`, `AutoRemove: false` (kaldırmayı biz yönetiyoruz) ·
**`NetworkMode: "none"`** · imaj `repo@sha256:…` veya `sha256:…` olmak zorunda.

**Gevşetme açıkça istenir, üretimde hiç mümkün değildir.** Bir anahtarı kapatmak
`sandbox.allowUnsafeProfile` listesinde adını yazmayı gerektirir (`readonly-rootfs`,
`no-new-privileges`, `cap-add`, `seccomp`, `direct-egress`); `NODE_ENV` üretimse kaçış anahtarı da
çalışmaz. Tanınmayan `NODE_ENV` değerleri **üretim sayılır** (fail-closed).
**`uid 0` her koşulda reddedilir** — kaçış anahtarı yok. Kapı hem Zod'da hem `buildContainerSpec`
içinde koşar: kodda elle kurulan bir profil de kapıyı atlayamaz.

**Egress (M26):** proxy yoksa ağ da yok. Proxy varsa `HTTP(S)_PROXY`/`NO_PROXY` iki yazımıyla da
enjekte edilir ve **iş kendi egress'ini yeniden yönlendiremez**: `HTTP_PROXY` vb. adları platformun,
`LD_PRELOAD`/`LD_LIBRARY_PATH`/`LD_AUDIT`/`NODE_OPTIONS`/`BASH_ENV` ise yasaklı (komuttan önce kod
çalıştırma yolları). Ağ tanımlı ama proxy tanımsızsa yapılandırma reddedilir.

**Zaman aşımı (M23):** `runSession` konteynerin çıkışını enjekte edilen zamanlayıcıyla yarıştırır;
bütçe kazanırsa konteyner **SIGKILL** ile öldürülür, loglar yine çekilir ve **kısmi çıktı**
`exitCode = 124` (`timeout(1)` konvansiyonu) ile döner. Sessizce takılma yok. Zaman aşımı bütçesi
`maxTimeoutSeconds` tavanının üstündeyse **kırpılmaz, reddedilir** ve bu doğrulama slot "meşgul"
işaretlenmeden önce yapılır (reddedilen bir iş lease'i kilitli bırakmaz).

## 3. Çalışma alanı ve cache (M31 / M65)

- **Katman ① bağımlılık cache'i:** `dependencyCacheKey({platform, tool, repo, lockfileHash})` — saf,
  ticket'a değil **repo+lockfile**'a bağlı; lockfile değişince anahtar değişir (bayat set yeniden
  kullanılamaz). `mountCache(lease, keys)` volume'ü oluşturur ve lease'e iliştirir; sonraki
  `runSession` onu **varsayılan olarak `:ro`** bağlar (bir ticket diğerinin cache'ini zehirleyemez).
  İş başına en çok 8 cache.
- **Katman ② ticket çalışma alanı:** `workspaceVolumeName(key)` saf ve **injektif** (slug + tam
  anahtarın sha256'sının 12 hanesi) — iki ticket aynı volume'e düşemez. Volume, bind'in otomatik
  oluşturmasına bırakılmaz; `workspace.volumeDriver` + `volumeOptions` ile **açıkça** oluşturulur ki
  M31'in şifreli diskine (LUKS/fscrypt) yerleşsin ve M65 süpürücüsünün aradığı etiketleri taşısın.
- **Yaşam döngüsü:** `expiredWorkspaces(records, now, maxAgeDays=60)` saf; okunamayan tarihte
  **silmez** (fail-closed). `removeWorkspace(key, reason)` ve `sweepExpiredWorkspaces()` volume'ü
  siler ve `RETENTION_ARCHIVE` audit kaydı bırakır. `SANDBOX_CREATE`/`SANDBOX_DESTROY` kayıtları
  `AuditSink` üzerinden yayılır (paket `@maestro/audit`'e bağımlı değil; zinciri kompozisyon kökü kurar).

## 4. Dış yüzey kararı

`DockerClient` **değer olarak dışa verilmez** (yalnız tip). Sebep `@maestro/secrets`'taki
`VaultClient` ile aynı: istemci **herhangi bir** spec'ten konteyner oluşturabilir, yani onu dışarı
vermek bu paketin var oluş sebebi olan sertleştirilmiş profili atlamanın yolunu vermek olurdu.
Kompozisyon kökünün ihtiyacı olan her şey `registerRunnerDrivers` / `createDockerLinuxRunner` /
`resolvePinnedImage` üzerinden erişilebilir.

## 5. Gerçek Docker'a karşı doğrulama (ve bulunan 2 gerçek hata)

Fikstürler gerçek daemon'dan (Engine 29.4.1, API 1.54) ham baytlar hâlinde kaydedildi; opsiyonel
duman testi (`MAESTRO_DOCKER_IT=1`) gerçek konteyner koşturur. Bu iki adım, yalnız birim testiyle
**yeşil görünüp üretimde çalışmayacak** iki hatayı yakaladı:

1. **`SecurityOpt: ["seccomp=default"]` konteyneri başlatmıyor.** Engine `seccomp=` değerini bir
   profil dokümanı olarak ayrıştırıyor: `"Decoding seccomp profile failed"` (HTTP 500,
   `fixtures/containers-start-bad-seccomp.http`). Varsayılan seccomp filtresini **açık tutmanın**
   yolu bu anahtarı hiç göndermemek; `seccomp=unconfined` yalnız açıkça izin verilen gevşetmede yazılır.
2. **İsteği `socket.end()` ile göndermek HTTP 499 üretiyor.** Yazma yönünü yarı kapatmak daemon'a
   isteğin terk edildiğini düşündürüyor. Taşıma artık `socket.write()` kullanıyor; yanıtı bitiren şey
   `Connection: close`.

Duman testi ayrıca profilin spec'te değil **konteynerin içinde** de geçerli olduğunu doğruluyor
(`id -u` → `10001`), 300 saniyelik bir işin 2 saniyelik bütçede gerçekten öldürüldüğünü ve
konteyner/volume artığı kalmadığını gösteriyor.

## 6. Test özeti

`pnpm -F @maestro/runners test` → **178 test yeşil, 1 atlandı** (9 dosya + opsiyonel entegrasyon).
Kök kapısı: `pnpm lint` · `pnpm typecheck` · `pnpm test` → 26/26 görev yeşil.

| Dosya | Test | Neyi çiviliyor |
|---|---|---|
| `http.test.ts` | 16 | İstek çerçeveleme, chunked/content-length/close-delimited çözme, **kısa gövdeyi reddetme** (kesik `wait` temiz çıkış gibi okunamaz), bozuk girdiyi tahmin etmeme |
| `docker-client.test.ts` | 25 | Uç şekilleri (kayıtlı yanıtlara karşı), durum→hata eşlemesi, gövde kırpma, çoklama çözme (TTY yedeği dahil), `tail` bayt sayımı |
| `config.test.ts` | 14 | En katı varsayılanlar, dijest-pin kabul/ret matrisi, gevşetme kapısı, üretimde kaçış yok, **uid 0 asla**, tanınmayan `NODE_ENV` = üretim |
| `sandbox.test.ts` | 24 | Profil alanlarının tamamı, seccomp kararı, egress modu, env yasakları, bind'ler ve **çivilenmiş volume adı**, etiketler, konteyner adı |
| `workspace.test.ts` | 18 | Anahtar dilbilgisi (traversal/flag/boşluk), injektiflik, cache anahtarı türetimi, M65 seçimi + okunamayan tarihte silmeme |
| `pool.test.ts` | 14 | Kapasite, meşgul runner, yabancı/serbest bırakılmış lease ayrımı, **idempotent release**, slot geri dönüşümü |
| `docker-runner.test.ts` | 34 | Uçtan uca çağrı sırası, zaman aşımında öldürme + kısmi çıktı + audit anahtarı, tavan reddi, hata yollarında temizlik, cache/workspace volume **adı üretenle tüketenin aynı olması**, başarısız temizliğin kaydı |
| `agent-protocol.test.ts` | 22 | Şema sınırları, sürüm reddi, tek canlı oturum, **ajan saatine güvenmeme**, süre dolumunda lease iadesi, uygunluk listesi |
| `register.test.ts` | 11 | M44 kaydı, yapılandırma hatalarının toplu raporu, `DockerClient` sızmıyor, **kaynakta sunucu/dinleyici yok** (M22 yön kontrolü) |
| `docker-it.test.ts` | 1 (atlanır) | `MAESTRO_DOCKER_IT=1` ile gerçek daemon duman testi |

Belirlenimcilik: saat, zamanlayıcı, id üreteci ve taşıma enjekte edilir; hiçbir test gerçek zaman
beklemez, `sleep` kullanmaz, ağ/soket açmaz.

## 7. Varsayımlar

1. **Docker soketi yalnız Runner Servisi'nde** (M24). Paket soketi yalnız `unix-transport.ts` içinden
   açar; yetkilendirme dosya sistemi izniyle (docker grubu) sağlanır — kod tarafında ek auth yok.
2. `RunJob.workspaceKey` iş akışından gelir ve ticket ömrü boyunca aynıdır (M30 resume bunun üstünde durur).
3. `Entrypoint: []` gönderilir: `RunJob.command` tam argv'dir, imajın entrypoint sarmalayıcısı devrede değildir.
4. Konteyner `HOME=/workspace` ile koşar (root olmayan kullanıcının yazabildiği tek kalıcı yer).
5. Log okunamazsa boş tail dönülür (çıkış kodu maskelenmez) ve bu durum audit'e `logsUnavailable`
   olarak yazılır; konteyner silinemezse `removeFailed` kaydı düşer — sessiz yetim yok.
6. Üretim kodu **1271 etkin satır** (yorum/boş satır hariç; ham 1810). Tavan ~1200'ün biraz üstünde:
   fark, gerçek Docker'a karşı doğrulanmış HTTP/1.1 kodlayıcı-çözücüsünden geliyor (`dockerode`
   yasağının bedeli). Dosya başına tavan (≤300) her dosyada sağlanıyor.

## 8. Talepler (orkestratöre)

1. **M104 katalog anahtarı — `runner.session_timeout`.** Zaman aşımıyla biten oturum audit meta'sında
   bu anahtarı taşıyor; `packages/config/locales/{tr,en}.json` içine eklenmeli (config paketi
   düzenlenmedi). Önerilen TR metni: *"İş, tanımlı süre sınırında tamamlanamadı ve durduruldu"*.
   Kod tarafında kullanıcı metni **gömülü değil**, yalnız anahtar taşınıyor.
2. **`packages/ports/src/runner.ts` (DONUK — değiştirilmedi) için iki öneri:**
   - `RunResult`'ta zaman aşımı bilgisi yok. Şu an `exitCode: 124` konvansiyonuyla ifade ediliyor;
     temizi `RunResult.timedOut: boolean` olurdu (124'ü gerçekten döndüren bir iş ile ayırt edilemiyor).
   - `mountCache(lease, keys): Promise<void>` hangi anahtarların gerçekten bağlandığını döndürmüyor;
     `Promise<string[]>` olsaydı kısmi/az bağlanma iş akışında görünür olurdu.
   İkisi de bu turda **gerekli değil**; karar orkestratörde.
3. **Dağıtım gereksinimleri (kod değil, ortam):**
   - Egress proxy'si ve yalnız ona çıkan bir Docker ağı (`egress.networkName` + `proxyUrl`) — M26.
   - Çalışma alanı volume'lerinin **şifreli diskte** durması: `workspace.volumeDriver` /
     `volumeOptions` bunun için var, şifrelemenin kendisi host provizyonu (LUKS/fscrypt) — M31.
   - Kurumsal imaj deposundan **dijest-pinli** imaj referansları; `resolvePinnedImage` tag→dijest
     çevirisini dağıtım anında yapmak için var (çalışma anında tag çözülmez) — M27.
   - gVisor kullanılacaksa (`sandbox.runtime: "runsc"`) daemon'a runtime tanımı — M23 Aşama 3.
4. **Kök kapısı hakkında uyarı (bu paketle ilgisiz).** Dal güncel `main` üzerine rebase edildi;
   kökten `pnpm typecheck` 35 görevin 34'ünde yeşil, tek kırmızı **`@maestro/execution:typecheck`**
   (7 hata, `@maestro/pii` ile arayüz uyuşmazlığı: `Masked<SessionReport>` / `PiiBoundaryResult` /
   `LoadedPiiPolicy`). Bu hatalar **`main`'in kendisinde de aynen** var — `packages/runners`
   eklenmeden önce doğrulandı. Dalga 2 entegrasyon kapısında execution↔pii turu gerekiyor.
5. **Dalga 3'e bırakılanlar:** ajan taşıması (outbound gRPC/WebSocket), iş teklifi/sonucu mesajları,
   `agent-macos`/`agent-windows` sürücüleri. Bu pakette yalnız şemalar + kayıt/heartbeat mantığı var
   ve **içeri port açan hiçbir kod yok** (`register.test.ts` bunu kaynak taramasıyla koruyor).

## 9. Bağımlılıklar

Yeni çalışma zamanı bağımlılığı **yok**: `@maestro/contracts`, `@maestro/ports`, `zod` (mevcut),
ve Node yerleşikleri `node:crypto` (isim hash'i) + `node:net` (unix soket). `dockerode` eklenmedi —
Engine API istemcisi bu paket içinde, enjekte edilebilir taşımayla yazıldı.
