/**
 * What a run is pinned to at the moment it opens: an agent variant and an
 * analysis template version (M38/M83).
 *
 * Both are read ONCE, when the row is written, and never again. Publishing a
 * new agent version or a new template mid-run must not change the rules under a
 * ticket that is already being analysed — and the document a reviewer approves
 * has to be the one the run was configured to produce.
 *
 * They live here rather than inline in `bin/bff.ts` because the value has a
 * fallback story that needs stating, and a fallback buried in a wiring
 * expression is a fallback nobody reviews.
 */

/** The variant every run falls back to when no rule names one. */
export const DEFAULT_ANALYST_VARIANT = "analyst-default";

/**
 * Mühendislik turunun düştüğü varsayılan ajan — `seedDefaultVariants`'in
 * plantladığı `engineer-default` ile aynı kimlik, ve pilotun `PILOT_ENGINEER_VARIANT`
 * ile aynı kimlik. Üç yerin aynı adı söylemesi tesadüf değil: farklı olsalardı,
 * aynı kurulumda pilot ile worker iki farklı ajanı çalıştırırdı.
 */
export const DEFAULT_ENGINEER_VARIANT = "engineer-default";

/** The template version a deployment with no published template pins to. */
export const UNVERSIONED_TEMPLATE = "unversioned";

/** The two delegates these lookups use, and no more. */
export interface RunPinDb {
  variant: {
    findFirst(args: {
      where: { role: "analyst" | "engineer" };
      orderBy: { id: "asc" };
    }): Promise<{ id: string } | null>;
    /**
     * Bir varyantın HÂLÂ VAR OLUP OLMADIĞI — `pinnedOr`'un tek sorusu.
     *
     * `findFirst` bu işi göremez: o "bu rolde bir varyant ver" diye sorar,
     * bu ise "bu KİMLİK duruyor mu" diye. İkisini birbirine karıştırmak,
     * silinmiş bir ajanın yerine sessizce bir başkasını koymak olurdu.
     */
    findUnique(args: {
      where: { id: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  analysisTemplateVersion: {
    findFirst(args: { orderBy: { version: "desc" } }): Promise<{ version: number } | null>;
  };
}

/**
 * The analyst variant this run will use.
 *
 * `intake` has no variant of its own — the pilot runs its intake against the
 * analyst's variant too (`apps/pilot/src/run.ts`), and splitting them here
 * would mean two agents could drift apart for one ticket.
 *
 * Falling back to a literal is safe in a way that falling back to `""` is not:
 * an empty variant fails the gateway's contract on the first model call, three
 * activity retries deep, where it reads as a model problem rather than a run
 * opened without saying which agent it runs.
 */
export async function activeAnalystVariantId(db: RunPinDb): Promise<string> {
  const row = await db.variant.findFirst({ where: { role: "analyst" }, orderBy: { id: "asc" } });
  return row?.id ?? DEFAULT_ANALYST_VARIANT;
}

/**
 * The ENGINEER variant this run will use — the missing half of the pin.
 *
 * `activeAnalystVariantId` above asks for `role = 'analyst'` explicitly, and
 * that was the ONLY variant a run pinned. Every later step then read that one
 * column, the engineering turn included, so a deployment whose admin had
 * defined a separate `engineer-*` agent in "Ajan tanımları" — its own model,
 * its own persona — ran the code-writing turn on the ANALYST's agent and said
 * nothing about it. The pilot has resolved both since Faz 3
 * (`apps/pilot/src/run.ts`, `engineerVariantId`); the Temporal path — which is
 * what the bank runs — had half of it.
 *
 * Same "name it rather than blank it" rule as its neighbour, and the same
 * reason: an empty variant reaches the gateway as a contract violation on the
 * first model call, three activity retries deep, where it reads as a model
 * problem rather than as a run opened without saying which agent writes the code.
 */
export async function activeEngineerVariantId(db: RunPinDb): Promise<string> {
  const row = await db.variant.findFirst({ where: { role: "engineer" }, orderBy: { id: "asc" } });
  return row?.id ?? DEFAULT_ENGINEER_VARIANT;
}

/**
 * The newest published analysis template, as the string the workflow compares.
 *
 * `assertDocument` (packages/workflows/src/impl/analysis.ts) rejects an analysis
 * whose `templateVersion` differs from the run's, so this value and the one the
 * analyst stamps must be produced the same way. A deployment that has published
 * no template pins to `unversioned` rather than to `""`, so the mismatch error
 * names something an operator can look for.
 */
export async function activeTemplateVersion(db: RunPinDb): Promise<string> {
  const row = await db.analysisTemplateVersion.findFirst({ orderBy: { version: "desc" } });
  return row === null ? UNVERSIONED_TEMPLATE : String(row.version);
}

/**
 * Kuralın İĞNELEDİĞİ ajan, hâlâ duruyorsa; yoksa kurulumun etkin varyantı.
 *
 * ── NEDEN BİR DOĞRULAMA ADIMI VAR ───────────────────────────────────────────
 * Dinleme kuralı bir varyant KİMLİĞİNİ metin olarak taşır; kimliği taşıdığı
 * satır ile varyantın kendisi arasında yabancı anahtar YOKTUR. Yani panelde
 * bir ajanı silen ya da yeniden adlandıran admin, o ajanı seçmiş kuralı
 * geride ölü bir kimlikle bırakır. Doğrulamadan geçirilse, o kimlik koşunun
 * `variantId` sütununa yazılır ve zincir boyunca taşınır: `variantAwareModelFrom`
 * onu tabloda bulamaz, bağlantı panelindeki modele düşer ve bir `console.warn`
 * yazar — koşu ilerler, ama YANLIŞ modelle, ve kural ekranı hâlâ operatörün
 * seçtiği ajanı gösterir. Yani "seçtiğim ajan koşuyor" sanısı, tam olarak bu
 * projenin kapatmaya çalıştığı sessiz-yanlış.
 *
 * ── NEDEN DURDURMUYOR DA DÜŞÜYOR ────────────────────────────────────────────
 * Ajan seçimi bir DARALTMA'dır, bir kapı değil: seçilmemiş bir kural bugün
 * varsayılanla koşuyor ve koşmaya devam etmeli. Silinmiş bir ajan da aynı
 * yere düşer — ama SESSİZCE değil. Fark `onWarn`: düşüş, sebebini ve iki
 * kimliği birden söyleyen bir satır bırakır. Koşuyu reddetmek, bir panel
 * temizliğini bir üretim durması hâline getirirdi.
 *
 * Boş/whitespace kimlik "kural seçmedi" ile aynı cevaba iner ve doğrulama
 * sorgusu HİÇ yapılmaz — yoklukta aranacak bir kimlik yoktur.
 */
export async function pinnedOr(
  db: RunPinDb,
  pinned: string | null | undefined,
  fallback: () => Promise<string>,
  onMissing: (pinnedId: string, used: string) => void = () => {},
): Promise<string> {
  const id = pinned?.trim() ?? "";
  if (id === "") return fallback();

  let exists: { id: string } | null;
  try {
    exists = await db.variant.findUnique({ where: { id }, select: { id: true } });
  } catch {
    // Sorgu PATLARSA iğneye GÜVENİLİR: bir doğrulama adımının kendisi
    // erişilemez olduğunda, operatörün açıkça seçtiği ajanı bir veritabanı
    // aksaklığı yüzünden değiştirmek, doğrulamanın önlemeye çalıştığı hatanın
    // ta kendisini yapmak olur. `variantAwareModelFrom` aynı ayrımı yapıyor:
    // hata ≠ yokluk.
    return id;
  }
  if (exists !== null) return id;

  const used = await fallback();
  onMissing(id, used);
  return used;
}
