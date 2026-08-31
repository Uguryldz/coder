import type { FlowDecision } from "./flow-decision.js";

/**
 * "Bu ticket'a NE OLDU?" — bir alım kararının tek yerde, okunabilir dökümü.
 *
 * ── HANGİ SORUYU CEVAPLIYOR ─────────────────────────────────────────────────
 * Operatörün kendi cümlesi: "analysisdeki kuralları tanımladım ticket gelmede,
 * ai ajan çalışmıyor, ajan tanımlarını varsayılanla bağlamamışsın, dinleme
 * kurallarınıda". Bu şikayetin altında TEK bir teşhis sorusu var: ticket
 * geldiğinde HANGİ kural eşleşti, HANGİ akış seçildi, HANGİ ajan koştu?
 *
 * Bugün bu sorunun cevabı üç ayrı yere dağılmış durumda: akış kararı
 * `RUN_STARTED` denetim satırının `meta`sında, ajan iğnesi `WorkflowRun`
 * satırında, model uyarısı ise `variantAwareModelFrom`'un `console.warn`
 * satırında. Üçü de VAR, ama hiçbiri bir arada değil — ve eşleşme HİÇ
 * olmadığında (bankada olan tam olarak bu) ortada bir koşu, dolayısıyla bir
 * `WorkflowRun` satırı bile yok. Operatör "ajan çalışmıyor" diyor, çünkü
 * çalışmadığını gösteren şey hiçbir ekranda yazmıyor.
 *
 * ── NEDEN DOSYA DEĞİL DE ÖNCE METİN ─────────────────────────────────────────
 * Bu modül SAF: bir karardan bir metin üretir, hiçbir yere yazmaz. Gerekçe,
 * `evidence-file.ts`'in gerekçesinin aynısı — üreten ile saklayan ayrılınca,
 * aynı metin log satırına da, `.md` dosyasına da, ileride bir denetim satırına
 * da aynı şekilde gidebilir ve üçü asla birbiriyle çelişmez.
 *
 * Metin TÜRKÇE, çünkü okuyucusu bankadaki operatör; ve markdown, çünkü
 * kullanıcının istediği çıktı bir `.md`.
 */

/** Bir alım kararının, dökümü yazmak için gereken her parçası. */
export interface IntakeDecisionFacts {
  readonly ticket: string;
  readonly projectKey: string;
  /** Ticket'ı hangi yol getirdi: webhook, tarama (keşif), komut, panel. */
  readonly source: string;
  /**
   * Kural eşleşmesinin baktığı üç alan, ticket'tan OKUNDUĞU haliyle.
   *
   * `null` "bu yol bu alanı bilmiyor" demek — ve bu, dökümün en önemli
   * satırı: `flow-decision.ts` bilinmeyen bir alanı HİÇBİR kuralla
   * eşleştirmez, yani buradaki bir `null` tek başına "hiçbir kural eşleşmedi"
   * sonucunu açıklayabilir.
   */
  readonly status: string | null;
  readonly issueType: string | null;
  readonly assignee: string | null;
  /**
   * Ticket'ın ETİKETLERİ — dördüncü tetikleme tipinin (0023) baktığı alan.
   *
   * `null` ile `[]` FARKLI cevaplardır ve dökümün bu ayrımı koruması şart:
   * `[]` "bu ticket'ın etiketi yok" der (etiket kuralı haklı olarak
   * eşleşmez), `null` "bu yol etiketleri okumadı" der (kural eşleşemez, ama
   * sebep ticket'ta değil yolda). İkisini aynı satırla anlatmak, operatörü
   * yanlış yere — ticket'ı etiketlemeye — gönderirdi.
   */
  readonly labels?: readonly string[] | null;
  readonly decision: FlowDecision;
  /** Kaç dinleme kuralı okundu — sıfır ise sorun kuralda değil, kural YOKluğunda. */
  readonly rulesConsidered: number;
  /**
   * STATÜ KAPISININ bu ticket'a ne dediği, kural kural (0024).
   *
   * Dökümün en çok sorulacak satırı, çünkü kapının kapattığı ticket bir koşu
   * ÜRETMEZ: operatör ticket'ı bota atar, hiçbir şey olmaz ve panelde bakacak
   * bir koşu satırı yoktur. "Neden hiçbir kural eşleşmedi?" sorusunun cevabı
   * artık çoğu zaman burada — ve "kuralın statüsü tutmadı" ile "kural yok"
   * birbirinden ayrılabilir olmak zorunda.
   *
   * Yalnızca statü yüzünden ELENEN kurallar yazılır; eşleşen kural için ayrı
   * bir satıra gerek yok, kararın kendisi zaten onu söylüyor. Boş liste
   * "statü yüzünden eleme olmadı" demek.
   */
  readonly statusBlocked?: readonly {
    readonly ruleId: string;
    /** Kuralın izin verdiği statüler — operatörün panelde göreceği adlar. */
    readonly allowed: readonly string[];
  }[];
  /**
   * STATÜ KISITI OLMAYAN kurallar (0024 öncesinden kalanlar).
   *
   * Görünürlüğün karşılığı bu satır. Bu kurallar ÇALIŞIR — mevcut kurulumu
   * sessizce durdurmamak için — ama çalıştıkları her ticket'ta dökümde
   * adlandırılırlar, çünkü sessiz bir fail-open, statü kapısının kapatmak için
   * var olduğu deliğin ta kendisi olurdu.
   */
  readonly ungatedRuleIds?: readonly string[];
  /** Koşuya iğnelenen analist ajanı, biliniyorsa. */
  readonly analystVariantId?: string | null;
  /** Koşuya iğnelenen mühendis ajanı, biliniyorsa. */
  readonly engineerVariantId?: string | null;
  /** Alım kabul edildi mi; edilmediyse sebebi. */
  readonly accepted: boolean;
  readonly refusedReason?: string;
}

/** Karar sebebinin operatör diliyle karşılığı. */
const REASON_TR: Readonly<Record<FlowDecision["reason"], string>> = {
  rule: "bir dinleme kuralı eşleşti",
  rule_conflict: "birden çok kural çakıştı, en dar akış seçildi",
  default: "hiçbir kural eşleşmedi, kurulum varsayılanı uygulandı",
  none: "hiçbir kural eşleşmedi ve kurulum bir varsayılan akış tanımlamıyor",
};

/** Bilinmeyen bir alanı, boş string ile karıştırılmayacak şekilde yazar. */
function orUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? "(bilinmiyor)" : trimmed;
}

/**
 * Bir ajan iğnesi: kuralın SEÇTİĞİ ajan mı, yoksa kurulum varsayılanı mı.
 *
 * `orUnknown` burada yanlış cevap verirdi — "(bilinmiyor)" okuyan operatör
 * dökümün bir şeyi ölçemediğini sanır, oysa ölçüm net: kural ajan SEÇMEDİ ve
 * koşu kurulumun etkin varyantına düştü. İkisini ayırt etmek bu dökümün varlık
 * sebebi; "seçtiğim ajan koşuyor mu?" sorusu ancak bu ayrımla cevaplanır.
 */
function agentPin(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === ""
    ? "kural seçmedi → kurulum varsayılanı (Ajan tanımları ekranındaki etkin varyant)"
    : `${trimmed} (kuralın seçtiği)`;
}

/**
 * Akışın adı ve ne yaptığı — "analiz" ile "tam boru hattı" arasındaki fark
 * operatörün gördüğü farkın ta kendisi olduğu için, adı tek başına yetmiyor.
 */
function flowLine(flow: FlowDecision["flow"]): string {
  switch (flow) {
    case "analiz":
      return "analiz — yalnızca analiz belgesi yazılır, kod YAZILMAZ";
    case "duzeltme":
      return "duzeltme — analiz kapısı atlanır, kod yazılır";
    case "gelistirme":
      return "gelistirme — analiz + kod";
    default:
      return "(seçilmedi) — TAM BORU HATTI çalışır: analiz + kod. " +
        "Bir 'analiz' kuralı tanımladıysanız bu satır o kuralın UYGULANMADIĞINI gösterir.";
  }
}

/**
 * Dökümün en kritik bölümü: kural eşleşmedi ise NEDEN eşleşmemiş olabilir.
 *
 * Tahmin değil, ölçüm: `flow-decision.ts` `matches()` bir alanı `null` ise o
 * kuralı ELEDİĞİ için, hangi alanın bilinmediğini söylemek doğrudan sebebi
 * söylemektir. Bu satır olmadan operatörün elinde yalnızca "eşleşmedi" var,
 * ki bu da onu kuralı tekrar tekrar düzenlemeye götürüyor — kuralda bir sorun
 * olmadığı halde.
 */
function whyNoMatch(facts: IntakeDecisionFacts): readonly string[] {
  if (facts.decision.reason === "rule" || facts.decision.reason === "rule_conflict") return [];

  const notes: string[] = [];
  /**
   * STATÜ KAPISI ÖNCE, çünkü bu listede cevap olduğunda cevap BUDUR.
   *
   * Aşağıdaki maddeler "bu alan okunmadı" der ve operatörü yolu düzeltmeye
   * gönderir. Statü kapısı ise bir ÖLÇÜM: kural okundu, ticket okundu, ikisi
   * karşılaştırıldı ve statü tutmadı. Bunu "durum bilinmiyor" tahminlerinin
   * altına koymak, doğru cevabı yanlış cevapların arkasına saklamak olurdu.
   */
  for (const blocked of facts.statusBlocked ?? []) {
    notes.push(
      `Ticket statüsü ${JSON.stringify(orUnknown(facts.status))}, ` +
        `\`${blocked.ruleId}\` kuralı yalnızca ` +
        `${blocked.allowed.map((name) => JSON.stringify(name)).join(", ")} ` +
        "statüsünde çalışır. Ticket bota ATANMIŞ olsa bile statü tutmadığı için " +
        "işlenmedi — kuralın izin verdiği statüler bu ticket'ın statüsünü " +
        "içermiyor. Ya ticket'ı o statüye taşıyın, ya da Dinleme Kuralları " +
        "ekranından kurala bu statüyü ekleyin.",
    );
  }
  if (facts.rulesConsidered === 0) {
    notes.push(
      "Hiç dinleme kuralı okunamadı (0 kural). Kural tanımlı ise BFF kuralları " +
        "okuyamıyor demektir; tanımlı değilse önce Dinleme Kuralları ekranından bir kural ekleyin.",
    );
  }
  if (facts.status === null) {
    notes.push(
      "Ticket'ın DURUMU bu yolda bilinmiyor. `matchKind: \"status\"` olan bir kural " +
        "bu ticket'ı ASLA eşleştiremez — durum bilinmeden karşılaştırma yapılmaz.",
    );
  }
  if (facts.issueType === null) {
    notes.push(
      "Ticket'ın TİPİ bu yolda bilinmiyor. `matchKind: \"issuetype\"` olan bir kural eşleşemez.",
    );
  }
  if (facts.assignee === null) {
    notes.push(
      "Ticket'ın ATANANI bu yolda bilinmiyor. Bot hesabı yazılmış her kural elenir — " +
        "kural, ticket'ın bota atandığını doğrulayamaz.",
    );
  }
  if (facts.labels === null || facts.labels === undefined) {
    notes.push(
      "Ticket'ın ETİKETLERİ bu yolda okunmadı. `matchKind: \"label\"` olan bir kural " +
        "eşleşemez — sorun ticket'ın etiketinde değil, bu yolun etiketi hiç sormamasında.",
    );
  } else if (facts.labels.length === 0) {
    notes.push(
      "Ticket'ın HİÇ etiketi yok. Etiketle tetikleyen bir kural yazdıysanız, kuralın " +
        "beklediği etiketi ticket'a eklemeniz gerekir.",
    );
  }
  return notes;
}

/**
 * Tek satırlık log özeti — operatörün ilk baktığı yer.
 *
 * Bir satır, çünkü ticket başına bir satır: `[keşif]` turlarının yanına
 * düşecek ve orada okunacak. Uzun döküm `.md`de.
 */
export function decisionLogLine(facts: IntakeDecisionFacts): string {
  const rule = facts.decision.ruleId ?? "yok";
  const flow = facts.decision.flow ?? "secilmedi";
  // Tek satırda "varsayilan" — uzun cümle `.md`de; burada okunan şey bir grep
  // sonucu, ve `analist=varsayilan` ile `analist=analyst-kredi` arasındaki fark
  // operatörün aradığı farkın ta kendisi.
  const analyst = facts.analystVariantId?.trim() || "varsayilan";
  const engineer = facts.engineerVariantId?.trim() || "varsayilan";
  const verdict = facts.accepted ? "alındı" : `alınmadı (${facts.refusedReason ?? "sebep yok"})`;
  // Statü kapısı tek satırda da görünür: `grep statu-elendi` ile "bota atadım,
  // hiçbir şey olmadı" şikayetinin cevabı doğrudan bulunabilmeli.
  const blocked = facts.statusBlocked ?? [];
  const ungated = facts.ungatedRuleIds ?? [];
  return (
    `[karar] ${facts.ticket}: ${verdict} · kural=${rule} · sebep=${facts.decision.reason} · ` +
    `akis=${flow} · analist=${analyst} · muhendis=${engineer}` +
    (blocked.length === 0
      ? ""
      : ` · statu-elendi=${blocked.map((entry) => entry.ruleId).join(",")}` +
        ` (ticket=${facts.status ?? "bilinmiyor"})`) +
    (ungated.length === 0 ? "" : ` · statu-kisiti-yok=${ungated.join(",")}`)
  );
}

/**
 * Kararın tam dökümü, markdown.
 *
 * Başlıklar operatörün sorduğu sıraya göre: önce "ne oldu", sonra "neden",
 * sonra "hangi ajan". Sondaki "ne yapmalı" bölümü, dökümün bir teşhis aracı
 * olmasının şartı — bir rapor, okuyanı bir sonraki adıma götürmüyorsa bir
 * rapor değil, bir kayıttır.
 */
export function decisionLogMarkdown(facts: IntakeDecisionFacts, at: Date): string {
  const d = facts.decision;
  const notes = whyNoMatch(facts);

  const lines: string[] = [
    `# Alım kararı — ${facts.ticket}`,
    "",
    `- **Zaman:** ${at.toISOString()}`,
    `- **Proje:** ${facts.projectKey}`,
    `- **Ticket'ı getiren yol:** ${facts.source}`,
    `- **Sonuç:** ${facts.accepted ? "ALINDI, koşu başlatıldı" : `ALINMADI — ${facts.refusedReason ?? "sebep bildirilmedi"}`}`,
    "",
    "## Kural eşleşmesi",
    "",
    `- **Okunan kural sayısı:** ${String(facts.rulesConsidered)}`,
    `- **Eşleşen kural:** ${d.ruleId ?? "yok"}`,
    `- **Sebep:** ${d.reason} — ${REASON_TR[d.reason]}`,
  ];

  if (d.conflictingRuleIds !== undefined && d.conflictingRuleIds.length > 0) {
    lines.push(`- **Çakışan kurallar:** ${d.conflictingRuleIds.join(", ")}`);
  }

  const blocked = facts.statusBlocked ?? [];
  const ungated = facts.ungatedRuleIds ?? [];
  if (blocked.length > 0 || ungated.length > 0) {
    lines.push("", "### Statü kapısı", "");
    for (const entry of blocked) {
      lines.push(
        `- \`${entry.ruleId}\`: **statü yüzünden elendi.** Ticket ` +
          `${JSON.stringify(orUnknown(facts.status))} statüsünde; kural yalnızca ` +
          `${entry.allowed.map((name) => JSON.stringify(name)).join(", ")} statüsünde çalışır.`,
      );
    }
    for (const ruleId of ungated) {
      lines.push(
        `- \`${ruleId}\`: **bu kuralda statü kısıtı YOK** — bota atanan her ticket, ` +
          "panonun neresinde olursa olsun işlenir. 0024 öncesinden kalan bir kural; " +
          "Dinleme Kuralları ekranından izin verilen statüleri seçin.",
      );
    }
  }

  lines.push(
    "",
    "### Kuralın baktığı alanlar (ticket'tan okunduğu haliyle)",
    "",
    "| Alan | Değer |",
    "| --- | --- |",
    `| durum (status) | ${orUnknown(facts.status)} |`,
    `| tip (issuetype) | ${orUnknown(facts.issueType)} |`,
    `| atanan (assignee) | ${orUnknown(facts.assignee)} |`,
    // Etiketler tek bir hücrede, ama üç farklı cevabı ayrı ayrı: okunmadı /
    // yok / şunlar. "(bilinmiyor)" ile "(etiketi yok)" arasındaki fark,
    // operatörü ticket'ı etiketlemeye mi yoksa yolun neden etiket okumadığına
    // mı bakmaya göndereceğini belirler.
    `| etiketler (labels) | ${
      facts.labels === null || facts.labels === undefined
        ? "(bilinmiyor — bu yol etiketleri okumadı)"
        : facts.labels.length === 0
          ? "(etiketi yok)"
          : facts.labels.join(", ")
    } |`,
    "",
    "## Seçilen akış",
    "",
    `- **Akış:** ${flowLine(d.flow)}`,
    `- **Durum eşlemesi:** ${
      d.statusMap === undefined || d.statusMap === null
        ? "yok (yalnızca yorum modu — Maestro panoyu HİÇ oynatmaz)"
        : JSON.stringify(d.statusMap)
    }`,
    "",
    "## Koşan ajanlar",
    "",
    `- **Analist ajanı:** ${agentPin(facts.analystVariantId)}`,
    `- **Mühendis ajanı:** ${agentPin(facts.engineerVariantId)}`,
  );

  if (notes.length > 0) {
    lines.push("", "## Neden hiçbir kural eşleşmedi", "");
    for (const note of notes) lines.push(`- ${note}`);
  }

  lines.push(
    "",
    "## Ne yapmalı",
    "",
    ...(d.reason === "rule" || d.reason === "rule_conflict"
      ? ["- Kural eşleşti. Ajan hâlâ çalışmıyorsa sıradaki durak MODEL: Ayarlar & bağlantılar ekranında etkin bir model bağlantısı, Ajan tanımları ekranında ise ilgili ajan için seçilmiş bir model olmalı."]
      : [
          "- Yukarıdaki \"Neden hiçbir kural eşleşmedi\" maddelerini sırayla kapatın.",
          "- Eşleşme olmadan akış kurulum varsayılanına düşer; varsayılan yoksa TAM BORU HATTI koşar ve `analiz` kuralınız uygulanmaz.",
        ]),
    "",
  );

  return lines.join("\n");
}
