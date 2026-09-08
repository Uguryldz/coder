/**
 * KURAL TASLAĞI — formun tuttuğu şey ile tele giden şey arasındaki çeviri.
 *
 * Saf fonksiyonlar: React yok, istek yok. Form yalnız `RuleDraft`i düzenler;
 * "Düzenle" `draftFromRule` ile doldurur, "Kaydet" `bodyFromDraft` ile gönderir,
 * "Test et" `probeDraftOf` ile sorar. Üç çevirinin tek dosyada durması, test
 * edilen kural ile kaydedilen kuralın ayrışmasını imkânsız kılar — ki bu
 * ekranın var olma sebebi tam olarak o ayrışmayı önlemek.
 */
import {
  EMPTY_GATE_STATUS_DRAFT,
  EMPTY_STATUS_DRAFT,
  GATE_STATUS_POINTS,
  STATUS_POINTS,
  buildStatusMap,
  gatePointsOf,
  type GateStatusDraft,
  type StatusDraft,
  type StatusMap,
} from "../common/status-map.ts";
import {
  ASSIGNED_MATCH_VALUE,
  DEFAULT_PRIORITY,
  type FlowType,
  type ListeningRule,
  type MatchKind,
  type ProbeDraft,
  type RepoMap,
  type RuleBody,
} from "./types.ts";

/** One row of the repo map as typed; empty rows are dropped on save. */
export interface RepoMapRowDraft {
  readonly value: string;
  readonly appId: string;
  readonly targetBranch: string;
}
export const EMPTY_REPO_MAP_ROW: RepoMapRowDraft = { value: "", appId: "", targetBranch: "" };

export interface RuleDraft {
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  /** Operatör bot alanına dokundu — bağlantıdan gelen otomatik dolgu artık üzerine yazmaz. */
  readonly assigneeTouched: boolean;
  /**
   * Değer/statü listelerinin okunacağı Jira bağlantısı — YALNIZ EKRAN İÇİN,
   * tele gitmez. Kuralın kendisi bağlantı taşımaz; bot hesabı taşır ve
   * bağlantı ondan bulunur (`connectionFor`). Birden çok Jira bağlantısında
   * operatör burada seçer.
   */
  readonly jiraConnectionId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  readonly flowType: FlowType;
  readonly analystVariantId: string;
  readonly engineerVariantId: string;
  readonly allowedStatuses: readonly string[];
  /**
   * ONAY KAPILARI — iki durum, iki ayrı alan: `gatesCustom=false` "seçim yok"
   * (`null` gider); `true` ise seçim OLDUĞU GİBİ gider, boş dizi dahil.
   */
  readonly gatesCustom: boolean;
  readonly gateSteps: readonly string[];
  readonly gateOwnerless: boolean;
  /** Kapı bölümü açık mı — yalnız ekran; kaydedilmez. */
  readonly gatePanelOpen: boolean;
  /** Depo eşlemesi: açık mı, hangi Jira alanı, satırlar. */
  readonly repoMapOn: boolean;
  readonly repoMapField: string;
  readonly repoMapFieldName: string;
  readonly repoMapRows: readonly RepoMapRowDraft[];
  readonly repoMapPanelOpen: boolean;
  /** Durum eşlemesi açık mı (yazma tarafı). */
  readonly statusOn: boolean;
  /**
   * Durum bölümü açık mı — `statusOn`dan AYRI: operatör bölümü okumak için
   * açar, kapatması "kapat" demek değildir. Yalnız ekran; kaydedilmez.
   */
  readonly statusPanelOpen: boolean;
  readonly statusDraft: StatusDraft;
  /** Eski kurallardan taşınan açık kapı statüleri — formda sorulmaz, korunur. */
  readonly gateStatusDraft: GateStatusDraft;
  readonly reassignOnNeedInfo: boolean;
  readonly enabled: boolean;
  /** Metin olarak: boş = varsayılan (100). Sayıya çevirme `bodyFromDraft`ta. */
  readonly priority: string;
}

export function emptyDraft(projectKey = ""): RuleDraft {
  return {
    projectKey,
    assigneeAccountId: "",
    assigneeTouched: false,
    jiraConnectionId: "",
    matchKind: "issuetype",
    matchValue: "",
    flowType: "analiz",
    analystVariantId: "",
    engineerVariantId: "",
    allowedStatuses: [],
    gatesCustom: false,
    gateSteps: [],
    gateOwnerless: false,
    gatePanelOpen: false,
    repoMapOn: false,
    repoMapField: "",
    repoMapFieldName: "",
    repoMapRows: [EMPTY_REPO_MAP_ROW],
    repoMapPanelOpen: false,
    statusOn: false,
    statusPanelOpen: false,
    statusDraft: EMPTY_STATUS_DRAFT,
    gateStatusDraft: EMPTY_GATE_STATUS_DRAFT,
    reassignOnNeedInfo: false,
    enabled: true,
    priority: "",
  };
}

/**
 * Kaydedilmiş kural → form. Kural BUGÜN ne yapıyorsa form onu gösterir:
 * kısıtsız kural boş statü listesiyle, seçimsiz kural "risk seviyesine göre"
 * ile, eşlemesiz kural kapalı bölümle açılır. Uydurma varsayılan yok.
 */
export function draftFromRule(rule: ListeningRule, jiraConnectionId: string): RuleDraft {
  const map = rule.statusMap ?? null;
  const gates = rule.gateSteps ?? null;
  return {
    projectKey: rule.projectKey,
    assigneeAccountId: rule.assigneeAccountId,
    assigneeTouched: true,
    jiraConnectionId,
    matchKind: rule.matchKind,
    matchValue: rule.matchKind === "assigned" ? "" : rule.matchValue,
    flowType: rule.flowType,
    analystVariantId: rule.analystVariantId ?? "",
    engineerVariantId: rule.engineerVariantId ?? "",
    allowedStatuses: rule.allowedStatuses ?? [],
    gatesCustom: gates !== null,
    gateSteps: gates?.steps ?? [],
    gateOwnerless: gates?.ownerless === true,
    gatePanelOpen: gates !== null,
    repoMapOn: (rule.repoMap ?? null) !== null,
    repoMapField: rule.repoMap?.field ?? "",
    repoMapFieldName: rule.repoMap?.fieldName ?? "",
    repoMapRows:
      rule.repoMap === undefined || rule.repoMap === null
        ? [EMPTY_REPO_MAP_ROW]
        : rule.repoMap.entries.map((e) => ({ value: e.value, appId: e.appId, targetBranch: e.targetBranch ?? "" })),
    repoMapPanelOpen: (rule.repoMap ?? null) !== null,
    statusOn: map !== null,
    // Eşlemesi olan kural AÇIK bölümle gelir: kapalı bir özetin ardına saklanmış
    // bir yapılandırma, bu ekranın düzeltmek için var olduğu görünmezliğin ta kendisi.
    statusPanelOpen: map !== null,
    statusDraft:
      map === null
        ? EMPTY_STATUS_DRAFT
        : (Object.fromEntries(STATUS_POINTS.map((p) => [p, map[p] ?? ""])) as StatusDraft),
    gateStatusDraft:
      map === null
        ? EMPTY_GATE_STATUS_DRAFT
        : (Object.fromEntries(
            GATE_STATUS_POINTS.map((p) => [p, map[p] ?? ""]),
          ) as GateStatusDraft),
    reassignOnNeedInfo: map?.reassignOnNeedInfo === true,
    enabled: rule.enabled,
    priority: rule.priority === DEFAULT_PRIORITY ? "" : String(rule.priority),
  };
}

/** Zorunlu alanlar dolu mu? `assigned` kuralın değeri yoktur, sorulmaz. */
export function draftIncomplete(d: RuleDraft): boolean {
  return (
    d.projectKey.trim() === "" ||
    d.assigneeAccountId.trim() === "" ||
    (d.matchKind !== "assigned" && d.matchValue.trim() === "")
  );
}

/** Öncelik alanı: boş → varsayılan; sayı değilse ya da aralık dışıysa `null`. */
export function priorityOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return DEFAULT_PRIORITY;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 0 && n <= 10_000 ? n : null;
}

/** Tele giden durum eşlemesi — formun BUGÜN kaydedeceği hâliyle. */
/** The map as it will be saved: only complete rows; null when off or empty. */
export function repoMapOf(d: RuleDraft): RepoMap | null {
  if (!d.repoMapOn || d.repoMapField.trim() === "") return null;
  const entries = d.repoMapRows
    .map((row) => ({ value: row.value.trim(), appId: row.appId.trim(), targetBranch: row.targetBranch.trim() }))
    .filter((row) => row.value !== "" && row.appId !== "")
    .map((row) => ({ value: row.value, appId: row.appId, ...(row.targetBranch === "" ? {} : { targetBranch: row.targetBranch }) }));
  if (entries.length === 0) return null;
  const fieldName = d.repoMapFieldName.trim();
  return { field: d.repoMapField.trim(), ...(fieldName === "" ? {} : { fieldName }), entries };
}

/** On, with a field, but no complete row — the operator meant a map and has none. */
export function repoMapIncomplete(d: RuleDraft): boolean {
  return d.repoMapOn && repoMapOf(d) === null;
}

export function statusMapOf(d: RuleDraft): StatusMap | null {
  return buildStatusMap(d.statusOn, d.statusDraft, d.reassignOnNeedInfo, d.flowType, d.gateStatusDraft);
}

/** Formun ŞU ANKİ arama-taslağı — denemenin ve kaydın ortak yarısı. */
export function probeDraftOf(d: RuleDraft): ProbeDraft {
  return {
    projectKey: d.projectKey.trim(),
    assigneeAccountId: d.assigneeAccountId.trim(),
    matchKind: d.matchKind,
    matchValue: d.matchKind === "assigned" ? ASSIGNED_MATCH_VALUE : d.matchValue.trim(),
    allowedStatuses: d.allowedStatuses.length === 0 ? null : [...d.allowedStatuses],
  };
}

/**
 * Form → `POST`/`PUT` gövdesi.
 *
 * Normalizasyonlar sunucununkiyle birebir: boş ajan → `null`; boş statü
 * listesi → `null` ("kısıt yok" ile "hiçbirine izin yok" tek davranıştır);
 * kapı seçimi ise TERSİ — `gatesCustom` kapalıysa `null`, açıksa boş dizi
 * dahil olduğu gibi gider (boş dizi operatörün verdiği bir cevap).
 */
export function bodyFromDraft(d: RuleDraft, priority: number): RuleBody {
  const probe = probeDraftOf(d);
  return {
    ...probe,
    flowType: d.flowType,
    analystVariantId: d.analystVariantId === "" ? null : d.analystVariantId,
    engineerVariantId: d.engineerVariantId === "" ? null : d.engineerVariantId,
    statusMap: statusMapOf(d),
    gateSteps: d.gatesCustom
      ? { steps: [...d.gateSteps], ...(d.gateOwnerless ? { ownerless: true } : {}) }
      : null,
    repoMap: repoMapOf(d),
    enabled: d.enabled,
    priority,
  };
}

/**
 * KAPI AYNASI — sunucunun bu kuralda kapı kararını NASIL okuyacağı.
 *
 * Taslaktan değil, TELE GİDECEK eşlemeden türetilir: `statusOn` kapalıyken
 * yazılmayan bir "İş bittiğinde" değeri kapıyı açamaz, ve `duzeltme` akışında
 * hiç açılmayan bir kapının kararı yoktur. Ayna, formdaki kutuları değil
 * kaydedilecek kuralı yansıtır — eski ayna kutulara bakıp "Onay: X" diyordu
 * ve X hiç kaydedilmiyordu.
 */
export interface GateMirror {
  /** Bu akışta analiz kapısı hiç açılmaz; statüyle karar okunmaz. */
  readonly noGate: boolean;
  /** Durum eşlemesi kapalı ve taşınan açık kapı statüsü de yok — yalnız yorumla. */
  readonly commentOnly: boolean;
  readonly approve: string;
  readonly approveFrom: string | null;
  readonly return: string;
  readonly returnFrom: string | null;
}

/**
 * Kaydedilmiş (ya da kaydedilecek) eşlemeden kapının iki kenarı — sunucunun
 * `gateStatusesOf`i ile aynı geri düşüş sırası. Tablo ayrıntısı ve formdaki
 * ayna aynı fonksiyonu okur; ikisi ayrışamaz.
 */
export function gatePointsOfMap(map: StatusMap | null): ReturnType<typeof gatePointsOf> {
  const m = map ?? {};
  const draft = Object.fromEntries(STATUS_POINTS.map((p) => [p, m[p] ?? ""])) as StatusDraft;
  const gateDraft = Object.fromEntries(
    GATE_STATUS_POINTS.map((p) => [p, m[p] ?? ""]),
  ) as GateStatusDraft;
  return gatePointsOf(draft, gateDraft);
}

export function gateMirrorOf(d: RuleDraft): GateMirror {
  const points = gatePointsOfMap(statusMapOf(d));
  const commentOnly = !d.statusOn && points.approve === "" && points.return === "";
  return {
    noGate: d.flowType === "duzeltme",
    commentOnly,
    approve: points.approve,
    approveFrom: points.approveFrom,
    return: points.return,
    returnFrom: points.returnFrom,
  };
}
