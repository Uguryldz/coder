# RAPOR — `apps/runner-agent` (Dalga 4, görev #11)

**Branch:** `worktree-agent-aa6785d2676b86c23`
**Taban commit:** `cbcf9cd` (wave-3 sonu)
**Kapı:** `pnpm run gate` → **exit 0**, 50/50 görev, **2986 test** yeşil.
**Bu paketin testleri:** **88** (8 dosya).

---

## 1. Mimari özet

Geliştirici makinesinde (Windows/macOS) çalışan, platforma **yalnız dışarı doğru**
bağlanan servis. Bu uygulamada sunucu, dinleyici veya port **yoktur** — M22'nin
dayandığı güvenlik özelliği budur.

| Dosya | Satır | Sorumluluk |
|---|---:|---|
| `src/config.ts` | 164 | env + dosya; eksik zorunlu ayarda **açılmaz**. |
| `src/token.ts` | 78 | Sırrı **referanstan** çözer (env / `SecretPort`), TTL'li önbellek. |
| `src/platform-client.ts` | 160 | Tek dışa kanal; sır yalnız `register`'da. |
| `src/protocol.ts` | 133 | Donmuş şemada **olmayan** mesajlar (aşağıya bkz.). |
| `src/kill-switch.ts` | 79 | `pause_intake` / `stop_all` + çalışan işlere erişim. |
| `src/lease-manager.ts` | 148 | Kiralama: yenileme, süre dolması, geri bırakma. |
| `src/job-runner.ts` | 183 | Sandbox aç → çalıştır → topla → **her yolda** yık. |
| `src/execute-job.ts` | 82 | Bir işin uçtan uca raporlanması. |
| `src/agent.ts` | 286 | Kayıt, heartbeat, çekme döngüsü, zarif kapanma. |
| `src/main.ts` | 101 | Kompozisyon kökü: env, sinyaller, zamanlayıcılar. |

Sandbox **yazılmadı**: `@maestro/runners`'ın `RunnerPort` API'si kullanıldı
(`acquire` / `runSession` / `release`), talimat gereği.

### Kill switch iki noktada (görev #5)
1. **İş çekiminde** — `pull` cevabındaki seviye, işler başlatılmadan **önce**.
2. **Çalışan işin adım geçişlerinde** — `acquire`, `run`, `collect` sınırları.
   `lease_renew` cevabı da seviyeyi taşır; uzun bir build ortasında durur.

### Kiralama (görev #3)
İş devredilmez, süreli kiralanır. Ajan çökerse kiralama **dolar** ve iş yeniden
planlanır; yenilemesi **reddedilen** ajan işi bitiremeden durur. İkisi de test
edildi.

### Maskeleme (görev #6)
İki katman, **bu sırayla**: ① bilinen sırlar (ajan token'ı + iş ortam değerleri)
birebir `[REDACTED]`; ② `@maestro/pii` kurumsal sınırı. Sıra kritik: sır önce
silinmezse, hesap numarasına benzeyen bir token **geri çevrilebilir** bir
`[ACCOUNT_1]` jetonuna dönüşürdü.

---

## 2. Kod yazarken bulunan ve düzeltilen 3 gerçek hata

Testler yazılırken ortaya çıktı — hiçbiri "test yeşil olsun" diye gevşetilmedi:

1. **Kill switch, kiralama doğrulamasından sonra yeniden kontrol edilmiyordu.**
   `checkLease` bir `await`'tir ve cevabı kill switch seviyesini taşır; kontrol
   yalnız öncesinde yapıldığı için, platformun "dur" dediği bir iş yine de
   `runSession`'a giriyordu. `job-runner.ts`'e await sonrası ikinci kontrol
   eklendi.
2. **Başarısız tamamlama raporu kiralamayı kaybediyordu.** `forget()` rapordan
   **önce** çağrılıyordu; rapor gidemezse ajan kiralamayı ne yeniliyor ne de
   kapanışta geri veriyordu — iş, tam TTL dolana kadar öksüz kalıyordu. Sıra
   düzeltildi: önce raporla, sonra unut.
3. **`shutdownGraceSeconds` yapılandırılıyor ama uygulanmıyordu** (ölü ayar).
   Sınırlı bekleme eklendi: süre dolarsa sandbox'lar iptal edilip **beklenir**
   (iptalden sonraki bekleme, yıkımın gerçekten koştuğunun garantisi).

---

## 3. ARAYÜZ İSTEKLERİ

`packages/runners/src/agent-protocol.ts` **donmuş** ve yalnız
`register` / `heartbeat` / `bye` taşıyor. Görevin #3, #5 ve #6'sı için gereken
mesajlar orada **yok**. Donmuş dosyaya dokunmadım; şemaları
`apps/runner-agent/src/protocol.ts` içinde **uygulama-yerel** olarak tanımladım
(donmuş olanları fork etmeden, **import ederek**). Aşağıdakiler
`@maestro/runners`'a taşındığında o dosya silinir ve importlar pakete döner.

```ts
// packages/runners/src/agent-protocol.ts — EKLENMESİ İSTENEN

/** Ajanın gördüğü kill switch seviyesi (M58 + "temiz" durumu). */
export const AgentKillLevel = z.enum(["off", "pause_intake", "stop_all"]);

/** Platformun indirdiği iş; `RunJob` + onu taşıyan kiralama. */
export const LeasedJob = z.object({
  leaseId: NonEmpty,
  runId: NonEmpty,
  workspaceKey: NonEmpty,
  command: z.array(NonEmpty).min(1),
  timeoutSeconds: z.number().int().min(1),
  env: z.record(z.string(), z.string()).default({}),
  leaseExpiresAt: IsoDateTime,
});

/** ajan → platform: "kapasitem `max` kadar." */
export const PullRequest = z.object({
  type: z.literal("pull"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  max: z.number().int().min(1).max(16),
});

/** platform → ajan: verilen işler + kill switch seviyesi AYNI cevapta. */
export const PullReply = z.object({
  type: z.literal("pull_reply"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  jobs: z.array(LeasedJob).max(16).default([]),
  killLevel: AgentKillLevel,
  serverTime: IsoDateTime,
});

/** ajan → platform: hâlâ çalışılan kiralamayı uzat. */
export const LeaseRenew = z.object({
  type: z.literal("lease_renew"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  at: IsoDateTime,
});

/** platform → ajan: kiralama hâlâ senin mi + güncel kill seviyesi. */
export const LeaseRenewReply = z.object({
  type: z.literal("lease_renew_reply"),
  protocolVersion: z.number().int(),
  leaseId: NonEmpty,
  granted: z.boolean(),
  leaseExpiresAt: IsoDateTime.optional(),
  killLevel: AgentKillLevel,
  serverTime: IsoDateTime,
});

/** ajan → platform: sandbox çıktısının bir parçası (GÖNDERMEDEN ÖNCE maskeli). */
export const LogChunk = z.object({
  type: z.literal("log_chunk"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  runId: NonEmpty,
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
  at: IsoDateTime,
});

/** ajan → platform: işin nihai sonucu; kiralamayı serbest bırakır. */
export const JobCompletion = z.object({
  type: z.literal("job_completed"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  runId: NonEmpty,
  outcome: z.enum(["succeeded", "failed", "cancelled", "abandoned"]),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0),
  reasonKey: NonEmpty.optional(),
  at: IsoDateTime,
});
```

**Tasarım notu (platform tarafı için):** `killLevel`, `pull` ve `lease_renew`
cevaplarının **içine** konuldu, ayrı bir uç değil. Ayrı yoklama, başarısız
olabilecek tek istek olur; kill switch'i okuyamadığı için iş çekmeye devam eden
bir ajan, M58'in yasakladığı durumun ta kendisidir.

**Ayrıca:** `AgentRegistry` (platform tarafı) bu mesajların karşılığını henüz
sunmuyor — `assignLease` / `completeLease` var ama iş dağıtımı, kiralama süresi
ve kill switch yayını yok. Uçlar (`/agent/pull`, `/agent/lease/renew`,
`/agent/logs`, `/agent/job/complete`) BFF'te açılmalı.

---

## 4. Kapsam dışı bıraktıklarım ve nedenleri

- **Donmuş paketlere dokunmadım.** `contracts` / `ports` / `runners` değişmedi.
  `RunnerPort` kiralama yenileme veya iptal taşımıyor; ajan bunu kendi
  `LeaseManager`'ı + adım sınırı kontrolleriyle çözüyor.
- **Gerçek taşıma (gRPC/WebSocket) yok.** İstemci HTTP `fetch` üzerinden
  konuşuyor ve `fetch` enjekte ediliyor. Yön (dışa doğru) korunduğu sürece
  taşıma değiştirilebilir; plan gRPC/WS diyor, o seçim platform ucu açılırken
  yapılmalı.
- **PowerShell betikleri çalıştırılarak doğrulanmadı.** Bu makinede `pwsh` yok.
  Bash betikleri `bash -n` ile sözdizimi doğrulandı ve `chmod +x` yapıldı;
  `shellcheck` kurulu değil. PowerShell betikleri Windows'ta **gerçek kurulumla**
  denenmeli — sahte örnek değiller ama bu ortamda koşturulamadılar.
- **Ephemeral kullanıcı/çalışma alanı temizliği** (mac/win izolasyonunun
  telafisi) kurulum betiklerinde **hesap düzeyinde** var (yönetici olmayan
  ayrılmış hesap, dar ACL); iş başına ephemeral kullanıcı üretimi
  `@maestro/runners`'ın mac/win sürücüsüne ait, bu ajana değil.
- **`mountCache` çağrılmıyor.** `RunJob` cache anahtarı taşımıyor; hangi
  anahtarların bağlanacağına platform karar veriyor. Mesaj şeması genişleyince
  `LeasedJob.cacheKeys` eklenip bağlanmalı.

## 5. Yan değişiklikler (donmuş olmayan)

- `packages/config/locales/{tr,en}.json` — 9 yeni `runner_agent.*` anahtarı,
  tr+en parite.
- `packages/config/test/catalog-usage.test.ts` — koruma **`apps/` dizinini
  taramıyordu** ve `runner_agent` ad alanını tanımıyordu; ikisi de eklendi.
  Yani bir uygulamanın kataloğa olmayan anahtar yayması, süit yeşilken
  operatörün karşısında `MissingMessageError` olarak patlayabilirdi.
