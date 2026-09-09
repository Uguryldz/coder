/**
 * The listening-rule store seam ("dinleme kuralları" surface).
 *
 * A `ListeningRule` says: in project `projectKey`, a ticket assigned to
 * `assigneeAccountId` (the Maestro Bot) whose `matchKind` field equals
 * `matchValue` should be picked up and run as `flowType`. It turns Maestro's
 * hard-coded, single-project, type-blind discovery (`apps/pilot/src/config.ts`
 * `discoveryJql`) into rows an admin edits from Studio — the "tüm ayarlar UI'dan"
 * posture.
 *
 * Structural, like every other store the composition root supplies (M44): no
 * file under `src/routes` imports Prisma, and every test drives an in-memory
 * fake. The rule types live HERE, not in `@maestro/contracts`: the frozen
 * `RuleCondition` only knows always|component|label, and `flowType`/`matchKind`
 * are a presentation vocabulary, so they are new types in the BFF rather than an
 * edit to the frozen schema (matching how the Jira-workflow read model was put
 * outside contracts for the same reason).
 */

import { z } from "zod";
import { APPROVAL_GATE_STEPS } from "@maestro/contracts";

/** The three flows Maestro can run a ticket through. Mirrors the DB CHECK. */
export type FlowType = "analiz" | "duzeltme" | "gelistirme";

/**
 * Which ticket field a rule matches on — THE trigger. Mirrors the DB CHECK
 * (migrations 0020, 0023).
 *
 * `assigned` is the odd one and is deliberately in the same enum rather than a
 * separate flag: it matches NO field at all. The rule fires on the assignment
 * alone — "whatever this ticket is, a human handed it to the bot, work it" —
 * which is the trigger most first-time operators actually want and the one the
 * two-member domain made unsayable. See `ASSIGNED_MATCH_VALUE` for why such a
 * rule still carries a value.
 *
 * `label` (0023) is the second odd one, for the opposite reason: it is the only
 * MANY-VALUED field. A ticket has one status and one issue type, but any number
 * of labels, so `flow-decision.ts` matches it by MEMBERSHIP, not equality.
 *
 * It arrived here from somewhere else. The opt-in label used to live on the
 * PROJECT BINDING (`JiraProjectBinding.triggerLabel`) as a gate in FRONT of the
 * rules: a ticket without that one label was refused before any rule was even
 * consulted. Two trigger definitions that did not know about each other gave
 * the same ticket two different answers — the sweep passed `explicit: true` and
 * skipped the gate, the webhook did not and dropped the ticket as
 * `not_opted_in`. One trigger, defined in one place, is the fix; the gate is
 * gone from `runIntake` and the label is a rule kind like the other three.
 */
export type MatchKind = "status" | "issuetype" | "assigned" | "label";

export const FLOW_TYPES: readonly FlowType[] = ["analiz", "duzeltme", "gelistirme"];
export const MATCH_KINDS: readonly MatchKind[] = ["status", "issuetype", "assigned", "label"];

/**
 * The value an `assigned` rule stores. NOT a wildcard anybody interprets — no
 * matcher ever reads it — but the column is NOT NULL and the unique index on
 * (projectKey, assigneeAccountId, matchKind, matchValue) is what makes "one
 * catch-all rule per project and bot" a database fact instead of a convention
 * the UI is trusted to keep. A NULL would defeat that index outright, since
 * NULLs never collide in Postgres.
 */
export const ASSIGNED_MATCH_VALUE = "*";

/**
 * A status NAME as a rule may name it. Names, never Jira transition ids: an id
 * belongs to one project's workflow, so a rule copied to a second project would
 * silently drive the wrong transitions, whereas the name is the same string the
 * operator reads on their own board.
 */
const StatusName = z.string().trim().min(1).max(128);

/**
 * The OPTIONAL Jira status map ("durum eşlemesi").
 *
 * Two modes, distinguished by presence alone:
 *
 *   mode A (map is NULL)  comment-only. Maestro narrates progress in comments
 *                         and never moves the ticket. This is what every rule
 *                         written before this map existed does, and it stays
 *                         the default — driving somebody's board uninvited is
 *                         the kind of surprise that gets an automation banned.
 *   mode B (map present)  transition mode, for the points the operator mapped.
 *
 * EVERY field is optional, and that is load-bearing rather than lenient: an
 * absent field means "do not move the ticket at that point", so an operator who
 * only cares that finished work lands in 'Tamam' writes `{ onDone: "Tamam" }`
 * and Maestro leaves the rest of their workflow alone. There is no partially
 * valid map — either the document parses whole, or the rule falls back to
 * comment-only.
 *
 * `.strict()` because an unknown key here is never harmless: `onDoneX` would be
 * silently dropped and the operator would watch tickets never reach 'Tamam'
 * with nothing in the UI to explain it. A 400 at write time is the only place
 * that typo is cheap to fix.
 */
export const StatusMapSchema = z
  .object({
    /** Moving to work — e.g. "Devam Ediyor". */
    onStart: StatusName.optional(),
    /** Maestro needs more information from the reporter — e.g. "Yapılacaklar". */
    onNeedInfo: StatusName.optional(),
    /** Analysis published, awaiting human approval — e.g. "İNCELEMEDE". */
    onReview: StatusName.optional(),
    /** An approver rejected; the work goes back to analysis — e.g. "Devam Ediyor". */
    onRejected: StatusName.optional(),
    /** Delivered — e.g. "Tamam". */
    onDone: StatusName.optional(),
    /**
     * ── OKUMA TARAFI: kapı kararının STATÜYLE verilmesi ──────────────────────
     *
     * Yukarıdaki beş alan YAZMA tarafı: "Maestro ticket'ı şu noktada oraya
     * TAŞISIN". Aşağıdaki ikisi OKUMA tarafı: "operatör ticket'ı oraya
     * taşıdığında Maestro bunu KARAR saysın". İki yön aynı belgede duruyor
     * çünkü operatörün gözünde tek bir şey: "bu kuralda kapı hangi
     * statülerle işler".
     *
     * NEDEN MEVCUT ALANLAR YENİDEN KULLANILMADI — değerlendirildi ve reddedildi:
     *
     *  · `onReview` KULLANILIYOR ama okuma alanı olarak değil: kapı zaten o
     *    statüde açılıyor, yani "kapının beklediği yer" ondan okunuyor. Buraya
     *    ayrı bir alan koymak, aynı gerçeği iki yere yazıp ayrışmalarına izin
     *    vermek olurdu.
     *  · `onRejected` KULLANILMADI. O, Maestro'nun ret sonrası ticket'ı
     *    taşıdığı yer (çıktı). Aynı alanı "operatör buraya taşırsa geri
     *    gönderme say" diye de okumak, bir DÖNGÜ kurardı: Maestro geri
     *    gönderme sonrası ticket'ı oraya taşır, o taşıma yeni bir geri gönderme
     *    olarak okunur. Zaman eşiği bunu bir turluk yakalar ama tasarımın
     *    kendisi yanlış olurdu.
     *  · `onDone` KULLANILMADI, ve bu en net olanı: `onDone` "iş BİTTİ"dir ve
     *    analiz akışında ticket teslim edildikten SONRA yazılır. Kapıdaki
     *    "onaylandı, ilerle" ile aynı an DEĞİL — analiz onayı akışın sonu
     *    değil, ortasıdır. İkisini aynı statüye bağlamak, onaylanan analizin
     *    ticket'ı "Tamam"a düşürmesi demek olurdu.
     *
     * İkisi de opsiyonel, ve yokluk `/approve` yolunu HİÇ etkilemez: yorum
     * kanalı bu alanlardan bağımsız çalışmaya devam eder. Bu alanlar yalnız
     * İKİNCİ bir kanal AÇAR, birincisini kapatmaz.
     */
    /**
     * Operatör ticket'ı bu statüye taşırsa kapı ONAYLANMIŞ sayılır — e.g.
     * "Geliştirme". Yani `/approve` yorumuyla aynı sonuç.
     *
     * Grup üyeliği kontrolü BU YOLDA DA yapılır (`decideGate`): statüyü
     * değiştirmek, yetkiyi atlamanın yolu değildir.
     */
    gateApproveStatus: StatusName.optional(),
    /**
     * Operatör ticket'ı bu statüye taşırsa analiz turu YENİDEN çalışır — e.g.
     * "Analiz". Bir RET DEĞİL: sayaç artmaz, koşu devredilmez, Jira'ya
     * "reddedildi" yazılmaz. `GateDecision.decision = "return_analysis"`.
     */
    gateReturnStatus: StatusName.optional(),
    /**
     * Whether asking for information also hands the ticket BACK to its reporter.
     * Separate from `onNeedInfo` on purpose: a board where "waiting on the
     * reporter" is a status and one where it is an assignee are both real, and
     * an operator may want either, both, or neither.
     */
    reassignOnNeedInfo: z.boolean().optional(),
  })
  .strict();

/** The parsed Jira status map. `null` on a rule means comment-only mode. */
export type StatusMap = z.infer<typeof StatusMapSchema>;

/**
 * ── Depo eşlemesi (repo map) ────────────────────────────────────────────────
 * Which application (repository) a ticket goes to, decided by the VALUE of a
 * Jira field on the ticket — the bank's "İş Ailesi" custom field. One rule,
 * one field, many rows: "Krediler → bank/kredi", "Kartlar → bank/kart". A
 * ticket whose value matches no row keeps the project binding's application,
 * exactly as before this map existed. `targetBranch` is the optional
 * environment branch the work lands on (develop/test), per row.
 */
const FieldId = z.string().trim().min(1).max(128);
export const RepoMapSchema = z
  .object({
    /** Jira field id (`customfield_10234`) or a mappable system field (`components`). */
    field: FieldId,
    /** The field's display name, for the screen; never used to match. */
    fieldName: z.string().trim().max(128).optional(),
    entries: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(256),
            appId: z.string().trim().min(1).max(200),
            targetBranch: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type RepoMap = z.infer<typeof RepoMapSchema>;

/** Parse a `repoMapJson` column value, FAIL-SAFE: unreadable = no map. */
export function parseRepoMap(value: unknown, onInvalid?: (reason: string) => void): RepoMap | null {
  if (value === null || value === undefined) return null;
  const parsed = RepoMapSchema.safeParse(value);
  if (!parsed.success) {
    onInvalid?.(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    return null;
  }
  return parsed.data;
}

/** Turkish-aware, whitespace-tolerant equality for a mapped value. */
export function repoMapValueMatches(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase("tr") === b.trim().toLocaleLowerCase("tr");
}

/**
 * `field: "*"` — no Jira field at all: EVERY ticket of this rule goes to the
 * one application in the first row. The "this rule → this repo" mapping an
 * operator wants when the trigger (issue type, label, status) already tells
 * the repository apart, without a custom field.
 */
export const FIXED_APP_FIELD = "*";
export function isFixedRepoMap(map: RepoMap): boolean {
  return map.field === FIXED_APP_FIELD;
}

/** The row a ticket's field value selects, or null; a fixed map's row needs no value. */
export function resolveRepoMapEntry(
  map: RepoMap,
  fieldValue: string | undefined,
): RepoMap["entries"][number] | null {
  if (isFixedRepoMap(map)) return map.entries[0] ?? null;
  if (fieldValue === undefined) return null;
  return map.entries.find((entry) => repoMapValueMatches(entry.value, fieldValue)) ?? null;
}

/**
 * HANGİ STATÜDEKİ ticket bu kuralla işlenebilir — statü KAPISI (0024).
 *
 * `StatusMapSchema` ile karıştırılmamalı ve karıştırılması kolay olduğu için
 * burada yazıyor: `statusMap` "ticket'ı NEREYE taşıyayım" der (çıktı),
 * `allowedStatuses` ise "ticket NEREDEYSE işleyebilirim" der (giriş kapısı).
 * Biri panoyu sürer, diğeri işi almaya izin verir.
 *
 * Liste, çünkü bir kural birden çok statüye meşru olarak izin verebilir
 * ("Yapılacaklar" ve "Analiz Bekliyor"); operatörü aynı akış/ajan/eşleme
 * ayarlarını iki ayrı kurala kopyalamaya zorlamak, o iki kopyanın zamanla
 * ayrışmasını garanti etmek olurdu.
 */
export const AllowedStatusesSchema = z.array(StatusName);

/** İzin verilen statü adları. `null` = "statü kısıtı yok" — aşağıdaki nota bakın. */
export type AllowedStatuses = readonly string[];

/**
 * Bir `allowedStatusesJson` kolon değerini okur, FAIL-SAFE.
 *
 * `parseStatusMap` ile aynı duruş ve aynı gerekçe: okuma yolu, teşhis ettiği
 * işi düşüremez. Elle SQL ile yazılmış, gelecekteki bir sürümden gelmiş ya da
 * içine string konmuş bir değer `null`'a düşer.
 *
 * VE BURADA `null`'A DÜŞMEK GENİŞLETİCİDİR — statü kapısını kaldırır. Bu
 * yüzden `onInvalid` isteğe bağlı değil, çağıranın raporlaması gereken bir şey:
 * bozuk bir satır yüzünden kapının sessizce açılması, bu kapının var olma
 * sebebinin tam tersidir. `parseStatusMap`'te bozulma DARALTICIYDI (yorum
 * moduna düşerdi), burada GENİŞLETİCİ; fark, uyarının neden zorunlu olduğudur.
 *
 * Boş dizi `null`'a normalize edilir: "hiçbir statüye izin verilmedi" ile
 * "statü kısıtı yok" iki ayrı cevap gibi durup tek bir davranışa (kural hiç
 * çalışmaz / kural her statüde çalışır) indiğinde, hangisinin kastedildiğini
 * kimse söyleyemez. Bir temsil, bir anlam: yok = kısıt yok.
 */
export function parseAllowedStatuses(
  value: unknown,
  onInvalid?: (reason: string) => void,
): AllowedStatuses | null {
  if (value === null || value === undefined) return null;
  const parsed = AllowedStatusesSchema.safeParse(value);
  if (!parsed.success) {
    onInvalid?.(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    return null;
  }
  const cleaned = parsed.data.map((name) => name.trim()).filter((name) => name !== "");
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Bir kuralın statü kapısı YOK mu — panelin, dökümün ve tarama günlüğünün
 * aynı soruyu aynı şekilde sorması için tek yer.
 *
 * 0024 öncesi yazılmış her `assigned`/`issuetype`/`label` kuralı bu durumda ve
 * bunlar ÇALIŞMAYA DEVAM EDER (bkz. `flow-decision.ts` `matches`). Çalışmaya
 * devam etmeleri, görünmez olmaları demek değil: bu yüklem, o kuralı işaretleyen
 * her yüzeyin okuduğu şey.
 */
export function hasNoStatusGate(rule: {
  allowedStatuses?: AllowedStatuses | null;
}): boolean {
  const allowed = rule.allowedStatuses;
  return allowed === null || allowed === undefined || allowed.length === 0;
}

/**
 * Parse a `statusMapJson` column value, FAIL-SAFE.
 *
 * The read path must never be the thing that takes discovery down. A map that
 * does not parse — hand-edited SQL, a shape from a future version, a column
 * someone filled with a string — degrades to `null`, which is comment-only
 * mode: Maestro keeps running the flow and simply stops moving the ticket. The
 * alternative, throwing, would mean one malformed row stops every rule from
 * being read, and the blast radius of a bad map has to be smaller than that.
 *
 * `onInvalid` is how the caller reports the degradation, because silently
 * downgrading a rule an operator deliberately configured is its own failure —
 * the store logs it so the map's absence is explainable, not mysterious.
 */
export function parseStatusMap(
  value: unknown,
  onInvalid?: (reason: string) => void,
): StatusMap | null {
  // NULL column and the JSON literal `null` are the same thing here: no map.
  if (value === null || value === undefined) return null;
  const parsed = StatusMapSchema.safeParse(value);
  if (!parsed.success) {
    onInvalid?.(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    return null;
  }
  // An empty object maps nothing, so it is indistinguishable from comment-only
  // mode in behaviour. Normalising it to null keeps ONE representation of "this
  // rule does not move tickets" rather than two that read differently.
  return Object.keys(parsed.data).length === 0 ? null : parsed.data;
}

/**
 * ONAY KAPILARI — "bu kuralda hangi onaylar beklensin", ve "kapı bir grubun
 * adına mı açılsın".
 *
 * ── `statusMap` ile karıştırılmamalı ────────────────────────────────────────
 * Üç ayrı soru, üç ayrı belge, ve panelde üç ayrı bölüm:
 *   `allowedStatuses` — ticket NEREDEYSE işleyebilirim (giriş kapısı)
 *   `statusMap`       — ticket'ı NEREYE taşıyayım / hangi statü karar sayılsın
 *   `gateSteps`       — hangi onayları BEKLEYEYİM
 *
 * ── BOŞ DİZİ İLE YOKLUK AYNI ŞEY DEĞİL ──────────────────────────────────────
 * Bu şemanın tek zor kararı, ve `StatusMapSchema`nın verdiği kararın TERSİ:
 *
 *   yok / `null`     → "kural kapı dizisi SEÇMEDİ". Varsayılana düşülür
 *                      (`gates.risk_tiers` parametresi, o da yoksa
 *                      `GATES_BY_RISK`). 0027 öncesi yazılmış her satır ve
 *                      geriye dönük uyumun TAMAMI bu daldır.
 *   `steps: []`      → "onay kapısı İSTEMİYORUM". Hiçbir kapı açılmaz.
 *
 * `statusMap`te boş nesne `null`'a indirgeniyordu çünkü orada iki temsil TEK
 * bir davranışa iniyordu ("ticket'ı hiç taşıma"). Burada iki temsil İKİ AYRI
 * davranış: "varsayılan neyse o" ile "hiçbiri" aynı şey değil, ve operatörün
 * akışında ikincisi meşru bir cevap — onay Jira'da statü taşıyarak veriliyor.
 *
 * ── `ownerless` neden AYNI belgede, ama AYRI bir soru ───────────────────────
 * Operatörün gözünde tek bölüm ("onaylar nasıl işler"), ama iki bağımsız
 * cevap: diziyi daraltıp grubu isteyen de, tam diziyi isteyip grubu olmayan da
 * meşru kurulumlar. Bu yüzden `steps` boş olduğunda `ownerless` anlamsız değil,
 * sadece etkisiz — ve o durumda da saklanır, çünkü operatör kapı ekleyince
 * cevabını yeniden vermek zorunda kalmamalı.
 */
export const GateStepsSchema = z
  .object({
    /**
     * Hangi kapılar. Adım kimlikleri (`4`/`5`/`9`/`11`/`12`), operatöre asla
     * bu haliyle gösterilmez — panel `gates.meaning.*` katalog anahtarlarını
     * yazar (M104). Kimliklerin burada olmasının sebebi, workflow tarafındaki
     * `StepId` ile AYNI sözlük olmaları: iki ayrı sözlük, er ya da geç
     * birbirinden ayrışır.
     */
    steps: z.array(z.enum(APPROVAL_GATE_STEPS)),
    /**
     * Kapı bir onay grubunun adına AÇILMASIN mı. Yokluk = `false` = bugünkü
     * davranış, yani 0027 öncesi her kural ve bu kutuyu hiç görmemiş her
     * operatör eski dalda kalır.
     */
    ownerless: z.boolean().optional(),
  })
  .strict();

/** Bir kuralın kapı seçimi. `null` = seçim yok, varsayılana düşülür. */
export type GateSteps = z.infer<typeof GateStepsSchema>;

/**
 * Bir `gateStepsJson` kolon değerini okur, FAIL-SAFE.
 *
 * ── Bozulmanın YÖNÜ, ve neden bu yön ────────────────────────────────────────
 * `parseStatusMap` bozulunca DARALIYOR (yorum moduna düşer, ticket
 * taşınmaz); `parseAllowedStatuses` bozulunca GENİŞLİYOR (statü kapısı
 * kalkar) ve bu yüzden orada uyarı zorunlu.
 *
 * Burada bozulma FAIL-CLOSED: `null`, yani "seçim yok", yani risk katmanının
 * varsayılan dizisi — operatörün seçtiğinden DAHA ÇOK onay beklenmesi
 * ihtimali var, daha AZ onay beklenmesi ihtimali yok. Bozuk bir satırın
 * kimseyi onaysız geçirmemesi gerekir, ve `[]` (hiç kapı) ile karışması tam
 * olarak o olurdu.
 *
 * `onInvalid` yine de raporlanır: sessizce daha çok onay beklemek, operatörün
 * "kapıları kapattım ama hâlâ soruyor" diye günlerce arayacağı bir şeydir.
 */
export function parseGateSteps(
  value: unknown,
  onInvalid?: (reason: string) => void,
): GateSteps | null {
  if (value === null || value === undefined) return null;
  const parsed = GateStepsSchema.safeParse(value);
  if (!parsed.success) {
    onInvalid?.(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    return null;
  }
  // Yinelenenler ayıklanır ve akış sırasına sokulur: aynı kapıyı iki kez açmak
  // diye bir şey yok, ve operatörün kutuları hangi sırayla işaretlediği
  // saklanan belgeyi değiştirmemeli — iki özdeş seçim iki farklı JSON olarak
  // saklanırsa, "kural değişti mi" sorusunu hiçbir yüzey doğru cevaplayamaz.
  const steps = APPROVAL_GATE_STEPS.filter((step) => parsed.data.steps.includes(step));
  return {
    steps,
    ...(parsed.data.ownerless === true ? { ownerless: true } : {}),
  };
}

/** One listening rule as stored. */
export interface ListeningRuleRecord {
  ruleId: string;
  projectKey: string;
  /** The account a ticket must be assigned to (the Maestro Bot accountId). */
  assigneeAccountId: string;
  matchKind: MatchKind;
  /** The status name, issue-type name or LABEL that triggers this rule. */
  matchValue: string;
  /**
   * HANGİ STATÜDEKİ ticket işlenebilir — her kuralda sorulan STATÜ KAPISI
   * (0024), `matchKind`'dan bağımsız.
   *
   * `matches()` bu kapıyı HER ZAMAN kontrol eder: tetikleme tipi `assigned`
   * bile olsa, ticket bu listede olmayan bir statüdeyse kural eşleşmez.
   *
   * `null`/absent (0024 öncesi yazılmış kurallar) = "statü kısıtı yok". Kural
   * çalışır — mevcut kurulumu sessizce durdurmamak için — ama panelde, karar
   * dökümünde ve tarama günlüğünde bu eksiklik açıkça işaretlenir
   * (`hasNoStatusGate`). Sessiz bir fail-open, bu alanın var olma sebebinin
   * kendisi olurdu.
   */
  allowedStatuses?: AllowedStatuses | null;
  flowType: FlowType;
  priority: number;
  enabled: boolean;
  /**
   * Which agent variant runs the ANALYSIS side of this flow (Faz 3). `null` (or
   * absent, for rows written before the column existed) means "the default
   * agent" — the pilot picks its own. Optional so the Prisma delegate in
   * `apps/deploy` compiles before its column mapping lands.
   */
  analystVariantId?: string | null;
  /** Same as `analystVariantId`, for the ENGINEERING (coding) side. */
  engineerVariantId?: string | null;
  /**
   * The optional Jira status map. `null` (or absent, for rows written before the
   * column existed) is comment-only mode — Maestro narrates in comments and
   * never moves the ticket, which is what every rule did before this landed.
   * Non-null opts this rule into transition mode for the points it names.
   */
  statusMap?: StatusMap | null;
  /**
   * Bu kuralda hangi onay kapıları açılsın (0027). `null`/absent = "seçim yok",
   * yani varsayılana düşülür — 0027 öncesi yazılmış her satırın hâli ve geriye
   * dönük uyumun tamamı. `{ steps: [] }` bundan FARKLI: "onay kapısı
   * istemiyorum". Bkz. `GateStepsSchema`.
   */
  gateSteps?: GateSteps | null;
  /** Depo eşlemesi — bkz. `RepoMapSchema`. Absent/null = proje bağlamasının uygulaması. */
  repoMap?: RepoMap | null;
}

/**
 * The fields a caller supplies to create/replace a rule. `ruleId` is assigned by
 * the service on create; on update it is the path param, not the body.
 */
export type ListeningRuleWrite = Omit<ListeningRuleRecord, "ruleId">;

export interface ListeningStore {
  /** Every rule, ordered by (projectKey, priority) for a stable screen. */
  list(): Promise<readonly ListeningRuleRecord[]>;
  /** One rule, or null when it does not exist. */
  get(ruleId: string): Promise<ListeningRuleRecord | null>;
  /**
   * Create or replace a rule by id. The unique (projectKey, assigneeAccountId,
   * matchKind, matchValue) index means a duplicate trigger is rejected by the
   * database — the service maps that to a 409.
   */
  put(record: ListeningRuleRecord): Promise<void>;
  /** Remove a rule. Returns false when it did not exist. */
  remove(ruleId: string): Promise<boolean>;
}
