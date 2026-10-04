# Komut alımı (webhook / yoklama / ikisi) — kurulum sihirbazı adımı

Kurulum sihirbazına 5. adım eklendi: **"Onaylar Maestro'ya nasıl ulaşsın?"**.
Operatör `JIRA_POLL_MS` diye bir ortam değişkeni bilmek zorunda değil; seçim
panelden yapılır, parametre olarak saklanır ve yoklayıcı **servis yeniden
başlatılmadan** o seçime göre çalışır.

## Kalan tek iş: kompozisyon kökü bağlantısı

`apps/deploy/src/bin/bff.ts` bu tur PARALEL BİR AJANIN alanındaydı (DC
`listComments` işi), o yüzden oraya dokunulmadı. Mantığın tamamı
`apps/deploy/src/command-intake.ts` içinde, test edilmiş ve dışa açık
(`@maestro/deploy`). Bağlamak için `bff.ts`'te bugünkü `JIRA_POLL_MS` bloğunun
(yaklaşık 388–453. satırlar) yerine şu geçmeli:

```ts
const intake = startCommandIntake({
  // İki parametreyi HER turda yeniden okur — ayarın yeniden başlatma
  // gerektirmemesinin sebebi budur.
  readStored: async () => {
    const [mode, seconds] = await Promise.all([
      db.paramVersion.findFirst({
        where: { key: "jira.command_intake" },
        orderBy: { version: "desc" },
      }),
      db.paramVersion.findFirst({
        where: { key: "jira.poll_seconds" },
        orderBy: { version: "desc" },
      }),
    ]);
    return { mode: mode?.valueJson, pollSeconds: seconds?.valueJson };
  },
  // Geriye uyum: kayıtlı parametre yoksa bu değişken hâlâ geçerli.
  envPollMs: env.source["JIRA_POLL_MS"],
  canReadComments: commentReader !== null,
  startPoller: (intervalMs) =>
    startJiraPoller({
      deps: resolveDeps(deps),
      comments: commentReader!,
      intervalMs,
      openTickets: async () =>
        (
          await db.workflowRun.findMany({
            where: { status: { notIn: ["done", "cancelled"] } },
            orderBy: { startedAt: "desc" },
            take: 50,
          })
        ).map((row) => row.ticketKey as TicketKey),
    }),
});
```

Sonra `deps` nesnesine (`discoveryStatus`'ın yanına) tek satır:

```ts
commandIntakeStatus: () => intake.status(),
```

`deps` yoklayıcıdan ÖNCE kurulduğu için `discoveryRun`'ın yaptığı gibi bir
tutucu üzerinden okunması gerekir — `commandIntakeStatus: () => holder?.status()
?? { mode: "webhook", pollSeconds: 0, canReadComments: false, appliesLive:
false, source: "default" }` da olur; BFF route'u zaten bu muhafazakâr cevabı
kendi de üretebiliyor.

Bağlanana kadar `GET /studio/command-intake` muhafazakâr cevabı döner
(webhook, yoklama yok, yeniden başlatma gerekir) ve sihirbaz **yoklamayı hiç
önermez** — sessizce kabul edip çalışmama durumu oluşmaz.

## Nerede ne var

| Katman | Dosya |
| --- | --- |
| Parametre tanımları | `packages/db/src/params-defaults.ts` (`jira.command_intake`, `jira.poll_seconds`) |
| Çözümleme + denetleyici döngü | `apps/deploy/src/command-intake.ts` |
| Yetenek/durum uç noktası | `apps/bff/src/routes/listening.ts` → `GET /studio/command-intake` |
| Sihirbaz adımı | `apps/studio/src/screens/setup/SetupPanes.tsx` → `IntakePane` |
| Adım mantığı | `apps/studio/src/screens/setup/model.ts` |
| Metinler | `packages/config/locales/{tr,en}.json` |

## Öncelik kuralı

1. Kayıtlı parametre varsa **o kazanır** (operatörün panelden verdiği cevap).
2. Parametre yoksa `JIRA_POLL_MS` okunur — bugün yoklayan kurulumlar
   yükseltmeden sonra da yoklamaya devam eder.
3. İkisi de yoksa yalnızca webhook.

Sürücü yorum okuyamıyorsa (`canReadComments === false`) kayıtlı cevap ne olursa
olsun yoklama başlatılmaz; sihirbaz seçeneği gösterir ama nedenini yazıp
"İleri"yi kapatır.
