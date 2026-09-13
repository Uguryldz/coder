import { z } from "zod";
import { AppId, IsoDateTime, NonEmpty, ProjectKey, TicketKey, WorkMode } from "./common.js";

/**
 * Jira-shaped snapshot of a work item as adapters deliver it to the core.
 * Field names intentionally mirror Jira DC issue fields (M46/M102).
 */
export const TicketSnapshot = z.object({
  key: TicketKey,
  projectKey: ProjectKey,
  issueType: NonEmpty, // e.g. Story, Bug, Task — pass-through, no mapping forced (M98)
  /**
   * `fields.issuetype.id` — the SAME issue type, as Jira's own numeric id.
   *
   * ── CANLI BULGU ─────────────────────────────────────────────────────────────
   * Takım yönetimli (`style: "next-gen"`) bir projede JQL adları çözmüyor:
   * `issuetype = "Görev"` sıfır ticket döner, `issuetype = 10008` on dört. O tür
   * projede dinleme kuralı bu yüzden ADI değil İD'yi tutar
   * (`apps/deploy/src/jira-discovery.ts` `jqlFor`), ve eşleşme
   * (`apps/bff/src/flow-decision.ts` `matches`) sayısal bir `matchValue`'yu
   * ticket'ın İD'siyle karşılaştırır. Snapshot yalnızca adı taşısaydı, elde
   * ticket'ı bulan bir sorgu ve onu eleyen bir filtre kalırdı — ikisi de sessiz.
   *
   * OPSİYONEL, ve yokluğu `undefined`: bu alandan önce yazılmış her çağıran
   * (elle başlatma, `/ai-start`, MCP araçları) id'yi okumamış olabilir ve o
   * durumda eşleşme ADA düşer — bugünkü davranışın aynısı. `.default(null)`
   * VERİLMİYOR, çünkü "Jira id vermedi" ile "bu yol id'yi hiç sormadı" ayrı
   * cevaplar ve `labels`'ın `null`/`[]` ayrımıyla aynı gerekçeyle korunuyor.
   */
  issueTypeId: NonEmpty.optional(),
  /**
   * `fields.status.name` ve `fields.status.id` — ticket'ın O ANKİ statüsü.
   *
   * ── CANLI BULGU ─────────────────────────────────────────────────────────────
   * Bu iki alan bir dönem BİLEREK yoktu ("donmuş anlık görüntü statü taşımaz")
   * ve o karar bir yolu sessizce kırıyordu: yeniden başlatma
   * (`restartDeadRun` → `classifyingFields`) ticket'ı anlık görüntüden okur,
   * yani statüsüz okurdu. Statü kapısı taşıyan bir kural
   * (`allowedStatuses`) ise bilinmeyen statüde KAPANIR (`statusGateOf`,
   * fail-closed) — dolayısıyla yeniden başlatmada HİÇBİR KURAL eşleşmez.
   *
   * Zincirin tamamı ölçüldü (OPS-123): kural eşleşmeyince `ruleId` yok, o
   * yüzden depo eşlemesi HİÇ SORULMAZ ve koşu proje bağlamasının varsayılan
   * deposuyla açılır. Aynı ticket webhook yolundan `tecnoi-global/wendoc`
   * alırken, yeniden başlatma yolundan `maestro-pilot` alıyordu — tek fark
   * giriş yoluydu. Operatörün gördüğü ise "yeniden başlat aynı çıktıyı
   * veriyor" ve "eşleme çalışmıyor" oluyordu.
   *
   * OPSİYONEL ve yokluğu `undefined`: bu alanlardan önce yazılmış bir çağıran
   * statüyü okumamış olabilir ve o durumda davranış eskisi gibi kalır.
   * `issueTypeId` ile birebir aynı gerekçe — "Jira vermedi" ile "bu yol hiç
   * sormadı" ayrı cevaplardır.
   */
  status: NonEmpty.optional(),
  statusId: NonEmpty.optional(),
  summary: NonEmpty,
  description: z.string().default(""),
  reporter: NonEmpty,
  assignee: NonEmpty.nullable().default(null),
  components: z.array(NonEmpty).default([]),
  labels: z.array(NonEmpty).default([]),
  parentKey: TicketKey.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TicketSnapshot = z.infer<typeof TicketSnapshot>;

/** Jira comment commands (mock "Jira komut seti" screen is the reference UX). */
export const CommandName = z.enum([
  "approve",
  "reject",
  "status",
  "ai-explain",
  "ai-start",
  "ai-assign",
  "mode-change",
  "ai-takeover",
]);
export type CommandName = z.infer<typeof CommandName>;

export const ParsedCommand = z.discriminatedUnion("name", [
  z.object({ name: z.literal("approve") }),
  z.object({ name: z.literal("reject"), reason: NonEmpty }),
  z.object({ name: z.literal("status") }),
  z.object({ name: z.literal("ai-explain") }),
  z.object({ name: z.literal("ai-start") }),
  z.object({ name: z.literal("ai-assign"), appId: AppId }),
  z.object({ name: z.literal("mode-change"), mode: WorkMode }),
  z.object({ name: z.literal("ai-takeover") }),
]);
export type ParsedCommand = z.infer<typeof ParsedCommand>;

export const CommandEnvelope = z.object({
  ticketKey: TicketKey,
  author: NonEmpty,
  at: IsoDateTime,
  command: ParsedCommand,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
