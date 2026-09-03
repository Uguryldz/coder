/**
 * The Jira status map — the optional "this rule also MOVES the ticket" half of
 * a listening rule, shared by the two surfaces that can write one.
 *
 * It lived inside `Listening.tsx` while that screen was the only way to reach
 * it. The setup wizard (`screens/setup/`) now writes the same map for a
 * first-time operator, and the one thing that must never diverge between the
 * two is the rule about what "no map" looks like on the wire: `null`, never
 * `{}` and never a map with empty strings in it. Two copies of that rule is two
 * chances for one of them to start sending `""` and 400 the whole rule, so the
 * shape, the point list and the builder live here and both screens import them.
 */

/**
 * Mirrors `StatusMapSchema` in the BFF's listening-store. Every point is
 * optional on purpose: an empty field means "bu adımda ticket'ı oynatma", so an
 * operator can move the ticket at two points and leave the other three to the
 * comment-only default.
 */
export interface StatusMap {
  readonly onStart?: string;
  readonly onNeedInfo?: string;
  readonly onReview?: string;
  readonly onRejected?: string;
  readonly onDone?: string;
  /**
   * OKUMA tarafı: operatör ticket'ı buraya taşırsa kapı ONAYLANMIŞ sayılır —
   * `/approve` yorumuyla aynı sonuç. Yukarıdaki beş alanla aynı belgede ama
   * TERS yönde: onlar "Maestro nereye taşısın", bu "operatörün taşıması ne
   * demek".
   */
  readonly gateApproveStatus?: string;
  /**
   * OKUMA tarafı: operatör ticket'ı buraya taşırsa analiz turu YENİDEN çalışır.
   * Bir RET DEĞİL — ret sayacı artmaz, koşu devredilmez, Jira'ya "reddedildi"
   * yazılmaz, bağlam korunur.
   */
  readonly gateReturnStatus?: string;
  readonly reassignOnNeedInfo?: boolean;
}

/**
 * The five status points, in the order the flow actually walks them. Rendering
 * from this list rather than five hand-written blocks is what keeps the form,
 * the round-trip and the table cell from drifting apart when a sixth point is
 * added on the server.
 */
export const STATUS_POINTS = ["onStart", "onNeedInfo", "onReview", "onRejected", "onDone"] as const;
export type StatusPoint = (typeof STATUS_POINTS)[number];

/**
 * KAPI KARARININ STATÜYLE VERİLMESİ — okuma tarafının iki noktası.
 *
 * `STATUS_POINTS`ten AYRI bir liste, ve ayrı olması gerekiyor: o liste
 * "Maestro ticket'ı nereye taşısın" (yazma), bu ikisi "operatörün taşıması ne
 * anlama gelsin" (okuma). Aynı diziye koymak, `firesFor` / `deadPointsFor` /
 * `buildStatusMap` üçlüsünün akışa göre yaptığı elemeyi bunlara da uygulamak
 * demek olurdu ve o eleme burada YANLIŞ olurdu — bir düzeltme akışında analiz
 * kapısı yok, ama bir analiz akışında `onReview` "dead" değil.
 */
export const GATE_STATUS_POINTS = ["gateApproveStatus", "gateReturnStatus"] as const;
export type GateStatusPoint = (typeof GATE_STATUS_POINTS)[number];

export type GateStatusDraft = Readonly<Record<GateStatusPoint, string>>;

export const EMPTY_GATE_STATUS_DRAFT: GateStatusDraft = {
  gateApproveStatus: "",
  gateReturnStatus: "",
};

/**
 * KAPI NOKTALARI, BEŞ ALANLIK HATTAN TÜRETİLMİŞ — panelin sunucuyla aynı
 * cevabı vermesi için.
 *
 * `apps/bff/src/gate-status-reentry.ts`'teki `gateStatusesOf`in ekran tarafı.
 * İki kopya olması hoş değil ama alternatifi daha kötüydü: BFF'in modülü
 * `@maestro/adapter-jira` ve Temporal bağımlılıkları taşıyor, ve onu tarayıcı
 * paketine sokmak birkaç megabaytlık bir sunucu ağacını panele taşımak
 * olurdu. Ayrışmayı testler tutuyor (`screens-listening.test.tsx` ile
 * `gate-status-reentry.test.ts` aynı örnekleri sınıyor).
 *
 * Geri düşüş kuralı sunucununkiyle BİREBİR:
 *   onay        = gateApproveStatus ?? onDone
 *   geri gönder = gateReturnStatus  ?? onRejected ?? onStart
 */
export function gatePointsOf(
  draft: StatusDraft,
  gateDraft: GateStatusDraft,
): { approve: string; approveFrom: StatusPoint | GateStatusPoint | null; return: string; returnFrom: StatusPoint | GateStatusPoint | null } {
  const pick = (
    candidates: readonly (readonly [StatusPoint | GateStatusPoint, string])[],
  ): { value: string; from: StatusPoint | GateStatusPoint | null } => {
    const hit = candidates.find(([, value]) => value.trim() !== "");
    return hit === undefined ? { value: "", from: null } : { value: hit[1].trim(), from: hit[0] };
  };
  const approve = pick([
    ["gateApproveStatus", gateDraft.gateApproveStatus],
    ["onDone", draft.onDone],
  ]);
  const returned = pick([
    ["gateReturnStatus", gateDraft.gateReturnStatus],
    ["onRejected", draft.onRejected],
    ["onStart", draft.onStart],
  ]);
  return {
    approve: approve.value,
    approveFrom: approve.from,
    return: returned.value,
    returnFrom: returned.from,
  };
}

/**
 * KAPI NOKTASI `onReview` İLE ÇAKIŞIYOR MU — kalan TEK yasak.
 *
 * ── Bu fonksiyon eskiden ÇOK DAHA GENİŞTİ, ve o yüzden yanlıştı ───────────
 * Önceki hâli kapı alanlarının BEŞ yazma noktasından herhangi biriyle
 * çakışmasını uyarıyordu. Operatörün gerçek akışında — `todo → analiz →
 * analysisapproval → development` — aynı statünün iki rol taşıması ZORUNLU:
 * `development` hem `onDone` hem "onayla", `analiz` hem `onStart` hem "geri
 * gönder". Yani uyarı, operatörün DOĞRU yapılandırmasına "çakışık" diyordu ve
 * sunucu o alanları düşürüyordu.
 *
 * Kalan tek yasak `onReview`: kapı ORADA açılıyor, dolayısıyla oradan bir
 * karar okunamaz — ticket'ın kapının beklediği yerde olması bir karar değil,
 * kapının kendi hâlidir. Gerekçenin tamamı sunucu modülünde ölçümüyle birlikte.
 */
export function gateStatusConflicts(
  draft: StatusDraft,
  gateDraft: GateStatusDraft,
): readonly { point: GateStatusPoint | StatusPoint; clashesWith: StatusPoint }[] {
  const fold = (value: string): string => value.trim().toLowerCase();
  const review = fold(draft.onReview);
  if (review === "") return [];
  const points = gatePointsOf(draft, gateDraft);
  const out: { point: GateStatusPoint | StatusPoint; clashesWith: StatusPoint }[] = [];
  if (points.approveFrom !== null && fold(points.approve) === review) {
    out.push({ point: points.approveFrom, clashesWith: "onReview" });
  }
  if (points.returnFrom !== null && fold(points.return) === review) {
    out.push({ point: points.returnFrom, clashesWith: "onReview" });
  }
  return out;
}

/**
 * The three flows a listening rule can run as. Spelled out here rather than
 * imported from `setup/model.ts` or `Listening.tsx` because both of those
 * already import from THIS module — and because which points a flow can reach
 * is a property of the flow itself, not of either screen that asks.
 */
export type StatusFlowType = "analiz" | "duzeltme" | "gelistirme";

/**
 * Which of the five points can actually FIRE for a given flow.
 *
 * The truth this restates lives in the engine: `planFor`
 * (packages/workflows/src/gates.ts) gives `duzeltme` no analysis gate, and
 * `ticket-workflow.ts` calls `moveStatus("review", …)` only on the way into
 * that gate set and `moveStatus("rejected", …)` only inside it. A düzeltme run
 * therefore walks start → (need_info) → done, and the two analysis-approval
 * moments never occur — a rule that maps them maps nothing, silently, forever.
 * That silence was a live audit finding: both forms offered all five points
 * for every flow, the summary confirmed the mapping, and the ticket never
 * moved, with no warning anywhere.
 *
 * ONE list, consumed by the wizard's step 4, the review summary, the listening
 * form and the table cell alike — the defect was two surfaces agreeing with
 * each other about something the engine does not do, and a helper each screen
 * re-derived would just be the same drift waiting to happen again. A fourth
 * flow or a sixth point gets its truth stated here, and only here.
 */
export function firesFor(flow: StatusFlowType): readonly StatusPoint[] {
  return flow === "duzeltme"
    ? STATUS_POINTS.filter((point) => point !== "onReview" && point !== "onRejected")
    : STATUS_POINTS;
}

/** The complement of `firesFor`: the points this flow can never reach. */
export function deadPointsFor(flow: StatusFlowType): readonly StatusPoint[] {
  const live = new Set(firesFor(flow));
  return STATUS_POINTS.filter((point) => !live.has(point));
}

/**
 * The dead-point values a map actually CARRIES — rules written before the
 * forms learned to gate by flow can hold `onReview: "İNCELEMEDE"` on a
 * düzeltme rule. Those values are not junk to be swallowed: the table marks
 * them and the edit form warns about them before a save stops storing them,
 * because a stored configuration disappearing without a word is the same
 * dishonesty this module exists to end, pointed the other way.
 */
export function deadStatusEntries(
  map: StatusMap | null | undefined,
  flow: StatusFlowType,
): readonly { point: StatusPoint; value: string }[] {
  if (!map) return [];
  return deadPointsFor(flow)
    .map((point) => ({ point, value: map[point] ?? "" }))
    .filter((entry) => entry.value !== "");
}

/** A form's own view of the map: every point a string, "" meaning unset. */
export type StatusDraft = Readonly<Record<StatusPoint, string>>;

export const EMPTY_STATUS_DRAFT: StatusDraft = {
  onStart: "",
  onNeedInfo: "",
  onReview: "",
  onRejected: "",
  onDone: "",
};

/**
 * Turn a form's five text fields into the wire shape — or into `null`.
 *
 * `null` is not a stylistic choice: it is the ONE representation of
 * "comment-only mode" the BFF and the store agree on. Sending `{}` would be a
 * second, differently-shaped way to say the same thing, and a rule that had a
 * map and then had every field cleared has to end up indistinguishable from a
 * rule that never had one — otherwise an operator who emptied the form would
 * look at the table and still see a rule that claims to move tickets. (The BFF
 * normalises `{}` to null as well; we send null anyway so the request says
 * plainly what it means rather than relying on the far side to clean up.)
 *
 * Empty fields are OMITTED rather than sent as "": `StatusMapSchema` requires
 * a non-empty string, so an empty one is a 400 for the whole rule instead of
 * the intended "bu adımda ticket'ı oynatma".
 *
 * Only the points `firesFor(flow)` says can fire are written. The forms
 * disable the dead ones, but a draft can still hold a value there — typed
 * under one flow before the operator switched to düzeltme, or loaded from a
 * rule stored before the forms gated by flow — and writing it would put a
 * claim on the wire the engine will never honour. The draft itself keeps the
 * value (switching flows must never eat what was typed); only the wire drops
 * it, and the forms say so on screen before any save.
 */
export function buildStatusMap(
  enabled: boolean,
  draft: StatusDraft,
  reassignOnNeedInfo: boolean,
  flow: StatusFlowType,
  /**
   * Kapı statüleri — OKUMA tarafı. Opsiyonel; verilmezse alanlar hiç yazılmaz
   * ve kural bugünkü davranışını korur.
   */
  gateDraft?: GateStatusDraft,
): StatusMap | null {
  const map: Record<string, string | boolean> = {};
  /**
   * ── KAPI STATÜLERİ `enabled`E BAĞLI DEĞİL, VE BU BİR HATA DÜZELTMESİ ──────
   *
   * Önceden `if (!enabled) return null` en başta duruyordu, yani "Jira
   * durumunu değiştirsin" KAPALIYKEN kapı statüleri de yazılmıyordu. Sahada
   * bu bir kısır döngü üretti: operatörün kurulumunda `statusMapJson` NULL,
   * dolayısıyla anahtar kapalı açılıyor, dolayısıyla alanlar hiç çizilmiyor,
   * dolayısıyla eşleme boş kalıyor. Operatörün "kapı statüleri dinleme
   * ayarlarında YOK" demesinin sebebi tam olarak bu.
   *
   * İki yön ZATEN ayrı şeyler (bkz. `GATE_STATUS_POINTS`'in notu): anahtar
   * "Maestro ticket'ı taşısın mı" diye soruyor — YAZMA. Kapı statüsü ise
   * "operatörün taşıması ne anlama gelsin" — OKUMA. Yorum-yalnız kipte kalmak
   * isteyen ama kapıyı statüyle kapatmak isteyen bir kurulum tamamen tutarlı
   * ve şimdiye kadar imkânsızdı.
   */
  if (enabled) {
    for (const point of firesFor(flow)) {
      const value = draft[point].trim();
      if (value !== "") map[point] = value;
    }
  }
  /**
   * Kapı statüleri AKIŞA GÖRE ELENMEZ, ve bu `firesFor`la aradaki asıl fark.
   *
   * `firesFor` bir noktanın Maestro tarafından ÇALIŞTIRILIP çalıştırılmadığını
   * söylüyor. Kapı statüsü ise Maestro'nun çalıştırdığı bir şey değil,
   * operatörün yaptığı bir hareketin anlamı — ve `duzeltme` akışında analiz
   * kapısı hiç açılmadığı için o kuralda zaten hiçbir kapı kararı okunmaz.
   * Yani eleme gereksiz; yapılsaydı, akışı sonradan `analiz`e çeviren
   * operatörün yazdığı değer sessizce kaybolurdu.
   */
  if (gateDraft !== undefined) {
    for (const point of GATE_STATUS_POINTS) {
      const value = gateDraft[point].trim();
      if (value !== "") map[point] = value;
    }
  }
  // `reassignOnNeedInfo` alone is a real configuration: hand the ticket back to
  // its reporter without moving it on the board. It counts as a filled map.
  // Yazma tarafına ait, dolayısıyla anahtara bağlı kalır.
  if (enabled && reassignOnNeedInfo) map.reassignOnNeedInfo = true;
  return Object.keys(map).length === 0 ? null : (map as StatusMap);
}

/**
 * The one-glance answer to "does this rule move tickets?".
 *
 * Deliberately compact — the flow order, arrows between the statuses that are
 * actually set, nothing for the points left blank. A rule with no map returns
 * an empty list so the caller can say "yorum" outright rather than leaving a
 * blank that could read as "not loaded yet".
 *
 * Only the points that can fire for the rule's flow are listed: a düzeltme
 * rule holding a stored `onReview` must not show a status the ticket will
 * never reach as if it were part of the walk. The dead values are not hidden
 * either — `deadStatusEntries` hands them to the caller to mark separately.
 */
export function statusSummary(
  map: StatusMap | null | undefined,
  flow: StatusFlowType,
): readonly string[] {
  if (!map) return [];
  return firesFor(flow)
    .map((point) => map[point])
    .filter((value): value is string => typeof value === "string" && value !== "");
}
