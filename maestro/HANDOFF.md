# HANDOFF

## DURUM
Pilot emekli ediliyor, analiz hattı Temporal'a taşınıyor (plan: `.claude/plans/binary-greeting-giraffe.md`).
Bu oturumda **Temporal ilk kez canlıda uçtan uca çalıştı**. Kullanıcı ara verdi; iş yarıda değil,
tutarlı noktada — her şey derleniyor, testler yeşil.

## Bu oturumda düzeltilen 5 GERÇEK hata (hepsi canlı koşuda bulundu)

1. **`WorkflowRun.step` hiç güncellenmiyordu.** `goto` yalnız workflow state'ini değiştiriyordu,
   Studio ise Postgres'ten okur → her koşu ekranlarda "adım 0". `journal` activity'si artık
   adımı satıra yazıyor (`packages/workflows/src/impl/gate.ts`, `stepOfTitle`).
   `RunContext`/`RunUpdate`/`RunRow`'a `step` alanı eklendi.

2. **Kapı rol adı ≠ dizin grup adı.** `GATE_OWNER` `product-owners` der; Jira sitesinde grup
   `jira-users-uyildiz`. BFF grubu doğrulayıp onaylıyor, worker rolü bekleyip reddediyordu —
   aynı onay bir tarafta kabul, diğerinde ret, kapı sonsuza dek açık.
   Çözüm: `DirectoryReader.groupForRole` (yeni), `roleResolver(env.source)` BFF+worker'da PAYLAŞILIR,
   `openGate` çözülmüş grubu DÖNDÜRÜR ve `canCloseGate` onu `openedAgainst` olarak alır
   (workflow içinde dizine sorulamaz — determinizm).

3. **Jira Cloud üyeliği hiç doğrulanamıyordu.** Cloud üyesinde `name`/`key`/`emailAddress` yok,
   yalnız `accountId`. Üstelik denetim sözleşmesi `:` kabul etmediği için BFF onu
   `712020.b836…@corp`'a çeviriyor → iki string hiç eşleşmiyordu.
   `packages/adapter-jira/src/cloud/work-port.ts` + `src/work-port.ts` (DC) ikisi de artık
   accountId'yi ve nokta-normalize halini eşliyor.

4. **Geçmişe dönük onay TÜM workflow'u öldürüyordu.** Poller restart sonrası yorum dizisini baştan
   okur; kapı açılmadan önce yazılmış `/approve`, `closedAt >= openedAt` CHECK'ini ihlal eder —
   bu retry edilemez bir hata, `recordGateDecision` 3 denemeyi yakar ve **workflow FAILED** olur.
   OPS-36 böyle öldü. `PrismaGateStore.close` artık `closedAt`'i `openedAt`'e kenetliyor
   (denetim izi kararın gerçek zamanını zaten tutuyor).

5. **Analiz akışı yoktu — `analiz` ticket'ı mühendislik hattına giriyordu.** OPS-38 iki kapıyı da
   geçti, sonra `runEngineering`'de öldü (`mcpServers were requested but no --mcp-config`).
   `planFor(flow)` pilottan `packages/workflows/src/gates.ts`'e taşındı; `FlowType` contracts'a
   taşındı; `ticketWorkflow` mühendislikten ÖNCE `deliverAnalysis` + `closeTicket` ile `done` biter.

## Canlı kanıt
- **OPS-38**: ticket → analiz → kapı 4 açıldı → Jira `/approve` ile KAPANDI → kapı 5 açıldı → KAPANDI.
  DB `step` her adımda doğru ilerledi. (Sonra mühendislik hattında öldü — 5. madde bunun düzeltmesi,
  düzeltme sonrası YENİ ticket ile doğrulanmadı.)
- OPS-34, OPS-36 ölü/eski koşular; onlara bakma, geçmişleri eski kodla yazıldı.

## SIRADAKİ İŞ (öncelik sırasıyla)
1. **Yeni ticket ile analiz akışını uçtan uca doğrula.** `MAESTRO_PROFILE=analiz` olduğu için
   `flowOf(env)` → `defaultFlow: "analiz"` → koşu kapı 5'ten sonra teslim edip kapanmalı.
   Beklenen: Jira'ya "analiz teslim edildi" yorumu + ticket talep sahibine atanır + status `done`.
2. **Word/PDF teslimi.** `deliverAnalysis` şu an yorum + atama yapıyor; `renderDocx`/`renderPdf`
   (`packages/publish`) ÇAĞRILMIYOR. Pilot deseni: `apps/pilot/src/docs.ts:112` `analysisToDocs`.
3. **Dinleme kuralı → flow** (plan Faz 4/19). Şu an flow DEPLOYMENT düzeyinde (`MAESTRO_PROFILE`
   veya `MAESTRO_FLOW`). Ticket başına karar için pilot `listening.ts:140` `ruleFor` taşınmalı.
4. Faz 5 (Studio ekranlarını Temporal'a geçir) ve Faz 6 (pilot sil) hiç başlamadı.

## Servisler (setsid ile ayrık — terminal kapansa da yaşarlar)
- worker: `cd apps/deploy && ./node_modules/.bin/tsx src/bin/worker.ts`, log `/tmp/worker-v5.log`
- bff: aynı dizin `src/bin/bff.ts`, port **7091**, log `/tmp/bff-v5.log`
- env: `set -a; source /tmp/analiz-env.sh; set +a` — PATH'e nvm ekle:
  `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`
- Yeniden başlatma sonrası poller `seen` setini sıfırlar ve ESKİ yorumları yeniden okur (4. madde).

## Tuzaklar
- `contracts`/`ports`/`llm-gateway` FROZEN — ama `FlowType` bu oturumda contracts'a EKLENDİ
  (common.ts). Gerekliydi: workflows paketi BFF'i import edemez (M44).
- `pkill -f "src/bin/worker.ts"` yazarsan kendi kabuğunu da vurur; `\.ts` diye kaçır.
- Turbo'yu worker+BFF+Temporal koşarken `--concurrency` vermeden çalıştırma: kaynak baskısından
  ALAKASIZ paketler kırmızı olur (storage/secrets/studio). `--concurrency=3` ile temiz.
- Jira Cloud auth **Basic** (`email:token`), DC **Bearer** — iki ayrı sürücü, karıştırma.
- Bot hesabı (`712020.b836c135-…@corp`) test kolaylığı için `User` tablosuna `maestro-admins`
  üyesi olarak eklendi (dört-göz muafiyeti). **Bankaya giderken bu satır SİLİNMELİ.**
- `admin/admin123` → `POST /auth/login`, token GÖVDEDE döner, `Authorization: Bearer` ile kullan
  (cookie değil).
