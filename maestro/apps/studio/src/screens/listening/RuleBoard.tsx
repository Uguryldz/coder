import type { ReactNode } from "react";
import { SELECTABLE_GATES } from "@maestro/contracts";
import { useT } from "../../i18n/I18nProvider.tsx";
import type { StatusPoint } from "../common/status-map.ts";
import type { RuleDraft } from "./draft.ts";

/**
 * KURAL TAHTASI — kuralı bir form olarak değil, PANO olarak gösterir.
 *
 * Dikey bir form operatöre "hangi alan hangi anı anlatıyor" sorusunu her
 * seferinde yeniden sordurtuyordu: `onReview` bir metin kutusuydu, kapı 5 bir
 * onay kutusu, ve ikisinin AYNI ANI anlattığı hiçbir yerde yazmıyordu. Tahta
 * o ilişkiyi yerleşimle söylüyor: solda Jira'nın gerçek statüleri, sağda o
 * statünün hizasında koşacak adımlar.
 *
 * Tahta bir GÖRÜNÜM: `RuleDraft`e yeni alan eklemez, veri sözleşmesine
 * dokunmaz. Yazdığı tek şey `gateSteps` — o zaten kaydedilen gerçek bir ayar.
 */

/** Bir adımın tahtadaki kimliği — `STEP_IDS`in bu ekranı ilgilendiren dilimi. */
type BoardStepId = "2" | "2b" | "3o" | "3" | "4" | "5" | "6a" | "6c" | "9" | "11" | "12" | "13";

/**
 * Adımı hangi ajan koşar — rozet buradan çizilir.
 *
 * Plancının KENDİ ADIMI YOK ama rozeti VAR, ve bu ayrım bilerek: motorda plan
 * ayrı bir adım değil, analiz adımının (`3`) ikinci yarısı — analist belgeyi
 * yazar, plancı planı onun üstüne ekler (`impl/analysis.ts`, `writePlan`).
 * Ona kendi kutusunu vermek koşmayan bir adım göstermek olurdu; rozetini
 * gizlemek ise o adımda İKİ ajanın çalıştığını saklamak olurdu. Bu yüzden
 * adım başına rozet LİSTESİ tutuluyor, tek rozet değil.
 */
type AgentKind = "analyst" | "planner" | "developer" | "verifier";

/**
 * Adımı hangi statü noktasının hizasına koyacağız.
 *
 * `statusMap` beş nokta taşır ama tahtanın kullandığı üçü var: akış o üç anda
 * ticket'ı taşır ve adımlar o taşımaların ARASINDA koşar. Eşleme boşsa adım
 * "taşıma yok" grubuna düşer — uydurma bir statüye yerleştirmek, kaydedilmemiş
 * bir yapılandırmayı kaydedilmiş gibi göstermek olurdu.
 */
type LanePoint = Extract<StatusPoint, "onStart" | "onReview" | "onDone">;

interface BoardStep {
  readonly id: BoardStepId;
  /** i18n anahtarı — kod adı değil ANLAM (M104). */
  readonly titleKey: string;
  readonly lane: LanePoint;
  /** Adımı koşan ajan; yoksa insan adımı ya da sistem adımı. */
  readonly agent?: AgentKind;
  /**
   * Aynı adımda koşan İKİNCİ ajan — bugün yalnız analiz adımı (`3`) için:
   * analist belgeyi yazar, plancı planı onun üstüne ekler. Sürüklenip
   * çıkarılamaz, çünkü kendi adımı yok; yalnız kimin koştuğunu söyler.
   */
  readonly also?: AgentKind;
  /** Onay kapısı: seçilebilir, seçimi `gateSteps`e yazılır. */
  readonly gate?: boolean;
  /** İnsanın beklendiği adım (kapı ya da soru) — rozet yerine "insan" yazar. */
  readonly human?: boolean;
  /** Yalnız kod yazan akışlarda (`duzeltme`/`gelistirme`) görünür. */
  readonly engineering?: boolean;
  /** Yalnız analiz kapısı olan akışlarda (`analiz`/`gelistirme`) görünür. */
  readonly analysisGate?: boolean;
}

/**
 * Tahtanın adım sözlüğü, akış sırasında.
 *
 * `engineering` / `analysisGate` bayrakları `packages/workflows/src/gates.ts`
 * içindeki `planFor`ın iki alanının aynısı ve eleme de orada tarif edildiği
 * gibi yapılır (bkz. `boardStepsFor`). İki liste ayrışırsa tahta motorun
 * koşmayacağı bir adımı gösterir — bu ekranın düzeltmek için var olduğu
 * görünmezliğin ta kendisi, ters yönden.
 */
const BOARD_STEPS: readonly BoardStep[] = [
  { id: "2", titleKey: "steps.2", lane: "onStart" },
  { id: "2b", titleKey: "steps.2b", lane: "onStart", human: true },
  { id: "3o", titleKey: "steps.3o", lane: "onStart", agent: "analyst" },
  { id: "3", titleKey: "steps.3", lane: "onStart", agent: "analyst", also: "planner" },
  { id: "4", titleKey: "steps.4", lane: "onReview", gate: true, human: true, analysisGate: true },
  { id: "5", titleKey: "steps.5", lane: "onReview", gate: true, human: true, analysisGate: true },
  { id: "6a", titleKey: "steps.6a", lane: "onReview", agent: "developer", engineering: true },
  { id: "6c", titleKey: "steps.6c", lane: "onReview", agent: "verifier", engineering: true },
  { id: "9", titleKey: "steps.9", lane: "onReview", gate: true, human: true, engineering: true },
  { id: "11", titleKey: "steps.11", lane: "onReview", gate: true, human: true, engineering: true },
  { id: "12", titleKey: "steps.12", lane: "onDone", gate: true, human: true, engineering: true },
  { id: "13", titleKey: "steps.13", lane: "onDone" },
];

/**
 * Bu akışta tahtada hangi adımlar durur — `planFor`ın ekran karşılığı.
 *
 * `analiz`: analiz kapısı var, mühendislik yok → 6a/6c/9/11/12 hiç çizilmez.
 * `duzeltme`: mühendislik var, analiz kapısı yok → 4/5 çizilmez.
 * `gelistirme`: ikisi de var.
 */
export function boardStepsFor(flow: RuleDraft["flowType"]): readonly BoardStep[] {
  const engineering = flow !== "analiz";
  const analysisGate = flow !== "duzeltme";
  return BOARD_STEPS.filter(
    (step) =>
      (step.engineering !== true || engineering) && (step.analysisGate !== true || analysisGate),
  );
}

/**
 * `statusMap`in bir noktası hangi statüye bakıyor — kutu boşsa `null`.
 *
 * Not: taslak değeri okunur, tel değeri değil. Operatör kutuyu doldurup henüz
 * kaydetmediyse tahtanın ONU göstermesi gerekir; kaydedilmiş hâli göstermek,
 * ekranın yaptığı değişikliği yok saymak olurdu.
 */
function laneStatusOf(draft: RuleDraft, point: LanePoint): string | null {
  if (!draft.statusOn) return null;
  const value = draft.statusDraft[point].trim();
  return value === "" ? null : value;
}

export interface RuleBoardProps {
  readonly draft: RuleDraft;
  readonly patch: (changes: Partial<RuleDraft>) => void;
  /** Jira'dan canlı okunan statü adları; boşsa çağıran tahtayı hiç çizmez. */
  readonly statusOptions: readonly string[];
  /** Seçili adım — sağdaki panel bunun ayarlarını gösterir. */
  readonly selectedStep: string | null;
  readonly onSelectStep: (step: string | null) => void;
}

/**
 * SÜRÜKLE-BIRAK YALNIZ AÇ/KAPA, VE ŞİMDİLİK YALNIZ GÖRSEL.
 *
 * Ajanlar adımlara SABİT bağlı (analist keşif+analizde, geliştirici kodda,
 * doğrulayıcı doğrulamada): bir ajanı başka adıma taşımak diye bir şey yok,
 * çünkü motorda öyle bir kavram yok. Yapılabilen tek şey ajanı KENDİ adımından
 * çıkarmak — o adım atlanır — ve geri takmak.
 *
 * Ve o "atlanan adım" bugün HİÇBİR YERDE saklanmıyor: `RuleDraft`te alanı yok,
 * `RuleBody`de karşılığı yok. Taslağa bir alan eklemek sözleşmeyi değiştirirdi;
 * uydurma bir kalıcılık göstermek ise daha kötüsü olurdu — operatör ajanı
 * çıkarır, kaydeder, ve adım koşmaya devam ederdi. Bu yüzden çıkarma yalnız bu
 * oturumda duruyor ve rozetin altında öyle yazıyor.
 */
export function RuleBoard(props: RuleBoardProps): ReactNode {
  const t = useT();
  const { draft, patch } = props;
  const steps = boardStepsFor(draft.flowType);

  // Havuzdaki (adımından çıkarılmış) ajanlar — yalnız bu oturum, kaydedilmez.

  const toggleGate = (step: BoardStepId): void => {
    const picked = draft.gateSteps.includes(step);
    patch({
      // Kapıya DOKUNMAK bir seçimdir: "risk seviyesine göre" modunda kalıp
      // kutuyu işaretlemek, seçimin tele gitmemesi demek olurdu.
      gatesCustom: true,
      gateSteps: picked ? draft.gateSteps.filter((s) => s !== step) : [...draft.gateSteps, step],
    });
  };


  /**
   * Statü şeritleri: Jira'nın verdiği sıra korunur — operatörün panosunda
   * hangi sırayla duruyorsa tahtada da o sırayla dursun.
   *
   * Bir statüye eşlenmemiş adımlar en sonda "taşıma yok" şeridinde toplanır.
   */
  const lanePointsOf = (status: string): readonly LanePoint[] =>
    (["onStart", "onReview", "onDone"] as const).filter(
      (point) => laneStatusOf(draft, point) === status,
    );
  const mappedPoints = new Set(
    props.statusOptions.flatMap((status) => lanePointsOf(status)),
  );
  const lanes = props.statusOptions
    .map((status) => ({ status, points: lanePointsOf(status) }))
    .filter((lane) => lane.points.length > 0);
  const unmapped = steps.filter((step) => !mappedPoints.has(step.lane));

  const renderStep = (step: BoardStep): ReactNode => {
    const agent = step.agent;
    const off = step.gate === true && draft.gatesCustom && !draft.gateSteps.includes(step.id);
    const selected = props.selectedStep === step.id;
    const classes = [
      "scr-board__step",
      step.gate === true ? "scr-board__step--gate" : "",
      off ? "scr-board__step--off" : "",
      selected ? "scr-board__step--sel" : "",
    ]
      .filter((c) => c !== "")
      .join(" ");
    return (
      <div key={step.id} className={classes}>
        <button
          type="button"
          className="scr-board__pick"
          aria-pressed={selected}
          onClick={() => props.onSelectStep(selected ? null : step.id)}
        >
          <b>{t(step.titleKey)}</b>
        </button>
        {agent !== undefined && (
          <span className="scr-board__agent">{t(`listening.board.role.${step.id}`)}</span>
        )}
          {step.also !== undefined && (
            <span className="scr-board__agent scr-board__agent--fixed">
              {t(`listening.board.role.${step.id}_also`)}
            </span>
          )}
        {step.human === true && agent === undefined && (
          <span className="scr-board__who">{t("listening.board.human")}</span>
        )}
        {step.gate === true && (
          <button
            type="button"
            className={off ? "scr-board__gate scr-board__gate--off" : "scr-board__gate"}
            aria-pressed={!off}
            onClick={() => toggleGate(step.id)}
          >
            {off ? t("listening.board.gate_off") : t("listening.board.gate_on")}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="scr-board">
      <p className="scr-hint" style={{ margin: 0 }}>
        {t("listening.board.intro")}
      </p>
      {/*
        HANGİ AJANLARIN KOŞTUĞU, AKIŞ TİPİNE GÖRE — ve neden diğerlerinin
        GÖRÜNMEDİĞİ. Tahta koşmayacak bir adımı çizmiyor (doğru), ama bunu
        söylemeden çizmemek operatöre "dört ajan vardı, ikisi nerede" dedirtti:
        `analiz` akışında kod hiç yazılmadığı için geliştirici ve doğrulayıcı
        koşmaz, `duzeltme` akışında analiz kapıları açılmaz. Eksikliği
        adlandırmak, onu görünmez bırakmaktan iyidir.
      */}
      <p className="scr-hint scr-board__flow" style={{ margin: 0 }}>
        {t(`listening.board.flow_note.${draft.flowType}`)}
      </p>

      <div className="scr-board__heads">
        <span>{t("listening.board.col_status")}</span>
        <span>{t("listening.board.col_steps")}</span>
      </div>

      {lanes.map((lane) => (
        <div key={lane.status} className="scr-board__lane">
          <div className="scr-board__status">
            <b>{lane.status}</b>
            <i>
              {lane.points.map((point) => t(`listening.status.${point}`)).join(" · ")}
            </i>
          </div>
          <div className="scr-board__steps">
            {steps.filter((step) => lane.points.includes(step.lane)).map(renderStep)}
          </div>
        </div>
      ))}

      {unmapped.length > 0 && (
        <div className="scr-board__lane">
          <div className="scr-board__status scr-board__status--none">
            <b>{t("listening.board.no_move")}</b>
            <i>{t("listening.board.no_move_hint")}</i>
          </div>
          <div className="scr-board__steps">{unmapped.map(renderStep)}</div>
        </div>
      )}

      {/* Seçilen adım bir kapıysa panelde ne anlama geldiği yazar; kapı olmayan
          adımın burada söylenecek ayarı yok, ve o da SÖYLENİR. */}
      {props.selectedStep !== null && (
        <div className="scr-note">
          <p className="scr-hint" style={{ margin: 0, fontWeight: 600 }}>
            {t(BOARD_STEPS.find((s) => s.id === props.selectedStep)?.titleKey ?? "steps.2")}
          </p>
          <p className="scr-hint" style={{ margin: 0 }}>
            {SELECTABLE_GATES.some((g) => g.step === props.selectedStep)
              ? t(`${SELECTABLE_GATES.find((g) => g.step === props.selectedStep)!.titleKey}.hint`)
              : t("listening.board.step_no_settings")}
          </p>
        </div>
      )}

      <div className="scr-board__legend">
        <span>
          <i className="scr-board__sw scr-board__sw--bot" /> {t("listening.board.legend_agent")}
        </span>
        <span>
          <i className="scr-board__sw scr-board__sw--human" /> {t("listening.board.legend_human")}
        </span>
        <span>
          <i className="scr-board__sw scr-board__sw--off" /> {t("listening.board.legend_off")}
        </span>
      </div>
    </div>
  );
}
