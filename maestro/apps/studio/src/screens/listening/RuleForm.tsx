import type { ReactNode, RefObject } from "react";
import { SELECTABLE_GATES } from "@maestro/contracts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card, FieldGroup, Input, Select } from "../../ui/index.ts";
import { matchValueLabel } from "../common/jira-english.ts";
import {
  STATUS_POINTS,
  deadStatusEntries,
  firesFor,
  gateStatusConflicts,
  type StatusPoint,
} from "../common/status-map.ts";
import { gateMirrorOf, type RuleDraft } from "./draft.ts";
import { RuleProbe } from "./RuleProbe.tsx";
import {
  FLOW_TYPES,
  MATCH_KINDS,
  type JiraConnectionOption,
  type MatchKind,
  type ProbeResult,
  type VariantOption,
} from "./types.ts";

export interface RuleFormProps {
  readonly draft: RuleDraft;
  readonly patch: (changes: Partial<RuleDraft>) => void;
  /** Düzenlenen kuralın kimliği; yeni kuralda null. */
  readonly editingRuleId: string | null;
  readonly boundProjects: readonly string[];
  /** Bağlantı testinin öğrendiği bot hesabı — alan bununla otomatik dolar. */
  readonly botAccountId: string | null;
  /** Etkin Jira bağlantıları; birden çoksa hangi bağlantıdan okunacağı sorulur. */
  readonly jiraConnections: readonly JiraConnectionOption[];
  /** Jira'dan canlı okunan değerler (statü/iş tipi), `matchKind`e göre. */
  readonly valueOptions: readonly string[];
  readonly valuesDegradedKey: string | undefined;
  /** Projenin statü adları — statü kapısı ve durum eşlemesi için. */
  readonly statusOptions: readonly string[];
  readonly analystOptions: readonly VariantOption[];
  readonly engineerOptions: readonly VariantOption[];
  readonly onSubmit: () => void;
  readonly onTest: () => void;
  readonly onCancelEdit: () => void;
  readonly submitting: boolean;
  readonly testing: boolean;
  readonly probe: { readonly result: ProbeResult; readonly stale: boolean } | null;
  readonly formRef: RefObject<HTMLDivElement | null>;
}

/**
 * KURAL FORMU — zorunlu alanlar önde, isteğe bağlı bölümler katlanmış ama
 * boşken ne anlama geldikleri katlı hâlde de okunur.
 *
 * Dört blok: tetikleme (proje, bot, koşul, statü kapısı), ne yapılsın (akış,
 * ajanlar, etkin/öncelik), onay kapıları (katlı), Jira durumu (katlı, içinde
 * kapı aynası). "Test et" ile "Kaydet" AYNI alanları okur — test edilen ile
 * kaydedilen arasında ikinci bir form olsaydı ikisi er ya da geç ayrışırdı.
 */
export function RuleForm(props: RuleFormProps): ReactNode {
  const t = useT();
  const { draft, editingRuleId } = props;
  const editing = editingRuleId !== null;
  const trigger =
    draft.matchKind === "assigned" ? t("listening.match.assigned") : draft.matchValue;

  return (
    <div ref={props.formRef}>
      <Card
        title={editing ? t("listening.form.title_edit") : t("listening.form.title")}
        subtitle={t("listening.form.sub")}
        actions={
          editing ? (
            <Button size="sm" variant="ghost" onClick={props.onCancelEdit}>
              {t("listening.action.cancel_edit")}
            </Button>
          ) : undefined
        }
      >
        <div className="scr-stack">
          {/* HANGİ kural düzenleniyor — başlık tek başına söylemiyor, ve yanlış
              kuralı kaydettikten sonra fark etmek bu ekranın en pahalı hatası. */}
          {editing && (
            <div className="scr-note">
              {t("listening.form.editing_which", { project: draft.projectKey, trigger })}
            </div>
          )}

          <TriggerGroup {...props} />
          <ActionGroup {...props} />
          <GatesSection {...props} />
          <StatusSection {...props} />

          <div className="scr-actions">
            <Button busy={props.testing} onClick={props.onTest}>
              {t("listening.probe.run")}
            </Button>
            <Button variant="primary" busy={props.submitting} onClick={props.onSubmit}>
              {editing ? t("listening.action.save") : t("listening.action.add")}
            </Button>
          </div>

          {props.probe !== null && (
            <RuleProbe
              result={props.probe.result}
              stale={props.probe.stale}
              onRetest={props.onTest}
              busy={props.testing}
            />
          )}
        </div>
      </Card>
    </div>
  );
}

/** Proje · bot · (bağlantı) · koşul · değer · statü kapısı. */
function TriggerGroup(props: RuleFormProps): ReactNode {
  const t = useT();
  const { draft, patch } = props;
  const conditioned = draft.matchKind !== "assigned";
  return (
    <FieldGroup legend={t("listening.form.group_trigger")} columns={2}>
      {props.boundProjects.length > 0 ? (
        <Select
          label={t("listening.form.project")}
          value={draft.projectKey}
          onChange={(e) => patch({ projectKey: e.target.value })}
          placeholder={t("listening.form.project_choose")}
          options={props.boundProjects.map((key) => ({ value: key, label: key }))}
          hint={t("listening.form.project_hint")}
        />
      ) : (
        // Bağlı proje yok: boş bir açılır liste yerine metin kutusu, ve sebebi.
        <Input
          label={t("listening.form.project")}
          value={draft.projectKey}
          onChange={(e) => patch({ projectKey: e.target.value.trim().toUpperCase() })}
          hint={t("listening.form.project_none_hint")}
        />
      )}
      <Input
        label={t("listening.form.assignee")}
        value={draft.assigneeAccountId}
        onChange={(e) => patch({ assigneeAccountId: e.target.value, assigneeTouched: true })}
        placeholder="712020:…"
        hint={
          props.botAccountId ? t("listening.form.assignee_hint_auto") : t("listening.form.assignee_hint")
        }
      />
      {/* Birden çok Jira bağlantısı: değer listeleri HANGİSİNDEN okunsun. Tek
          bağlantıda soru yok — cevabı belli. */}
      {props.jiraConnections.length > 1 && (
        <Select
          label={t("listening.form.jira_connection")}
          value={draft.jiraConnectionId}
          onChange={(e) => patch({ jiraConnectionId: e.target.value })}
          options={props.jiraConnections.map((c) => ({
            value: c.id,
            label: c.displayName ?? c.id,
          }))}
          hint={t("listening.form.jira_connection_hint")}
        />
      )}
      <Select
        label={t("listening.form.matchKind")}
        value={draft.matchKind}
        // Soru değişince cevap geçersiz: iş tipi adı statü adı değildir.
        onChange={(e) => patch({ matchKind: e.target.value as MatchKind, matchValue: "" })}
        options={MATCH_KINDS.map((kind) => ({ value: kind, label: t(`listening.match.${kind}`) }))}
        hint={t(`listening.match.hint.${draft.matchKind}`)}
      />
      {/* "Bota atanan her ticket"ın değeri yok: alan gri değil, YOK. */}
      {conditioned &&
        (props.valueOptions.length > 0 ? (
          <Select
            label={t("listening.form.matchValue")}
            value={draft.matchValue}
            onChange={(e) => patch({ matchValue: e.target.value })}
            placeholder={t("listening.form.matchValue_choose")}
            // `value` Jira'nın sunduğu ve kuralın sakladığı ad; `label` yanına
            // İngilizcesini ekler. BİLEREK farklı: "Görev (Task)" değerli bir
            // kural hiçbir ticket'a uymaz.
            options={props.valueOptions.map((v) => ({ value: v, label: matchValueLabel(v) }))}
            hint={
              props.valuesDegradedKey !== undefined
                ? t(props.valuesDegradedKey)
                : t("listening.form.matchValue_hint_auto")
            }
          />
        ) : (
          <Input
            label={t("listening.form.matchValue")}
            value={draft.matchValue}
            onChange={(e) => patch({ matchValue: e.target.value })}
            placeholder={t(`listening.form.matchValue_placeholder.${draft.matchKind}`)}
            hint={t(
              draft.matchKind === "label"
                ? "listening.form.matchValue_hint_label"
                : "listening.form.matchValue_hint",
            )}
          />
        ))}
      <AllowedStatuses {...props} />
    </FieldGroup>
  );
}

/**
 * STATÜ KAPISI — her kuralda, katlı bir bölümde DEĞİL: durum eşlemesi isteğe
 * bağlı bir çıktıdır, bu ise giriş şartı. Seçenekler Jira'dan; boş seçim
 * sessiz geçmez.
 */
function AllowedStatuses(props: RuleFormProps): ReactNode {
  const t = useT();
  const { draft, patch } = props;
  const toggle = (name: string): void =>
    patch({
      allowedStatuses: draft.allowedStatuses.includes(name)
        ? draft.allowedStatuses.filter((s) => s !== name)
        : [...draft.allowedStatuses, name],
    });
  const empty = draft.allowedStatuses.length === 0;
  return (
    <div style={{ gridColumn: "1 / -1" }}>
      <div className="ui-field__label">{t("listening.form.allowed_statuses")}</div>
      {props.statusOptions.length > 0 ? (
        <div className="scr-chips" style={{ marginTop: 4 }}>
          {props.statusOptions.map((name) => (
            <label key={name} className="scr-check">
              <input
                type="checkbox"
                checked={draft.allowedStatuses.includes(name)}
                onChange={() => toggle(name)}
              />
              <span>{name}</span>
            </label>
          ))}
        </div>
      ) : (
        // Liste alınamadı, ve bu sessiz geçmez: boş kutu listesi "bu projede
        // statü yok" gibi okunur. Neden seçilemediği yazılır; elle yazmak kalır.
        <Input
          label={t("listening.form.allowed_statuses_manual_label")}
          value={draft.allowedStatuses.join(", ")}
          onChange={(e) =>
            patch({
              allowedStatuses: e.target.value
                .split(",")
                .map((v) => v.trim())
                .filter((v) => v !== ""),
            })
          }
          hint={`${t(
            draft.projectKey.trim() === ""
              ? "listening.form.allowed_statuses_pick_project"
              : "listening.form.allowed_statuses_unavailable",
          )} ${t("listening.form.allowed_statuses_manual")}`}
        />
      )}
      <p className={empty ? "scr-hint scr-hint--warn" : "scr-hint"}>
        {t(empty ? "listening.form.allowed_statuses_empty_warning" : "listening.form.allowed_statuses_hint")}
      </p>
    </div>
  );
}

/** Akış · ajanlar · etkin · öncelik. */
function ActionGroup(props: RuleFormProps): ReactNode {
  const t = useT();
  const { draft, patch } = props;
  return (
    <FieldGroup legend={t("listening.form.group_action")} columns={3}>
      <Select
        label={t("listening.form.flow")}
        value={draft.flowType}
        onChange={(e) => patch({ flowType: e.target.value as RuleDraft["flowType"] })}
        options={FLOW_TYPES.map((flow) => ({ value: flow, label: t(`listening.flow.${flow}`) }))}
        hint={t(`listening.flow.hint.${draft.flowType}`)}
      />
      <Select
        label={t("listening.agent.analyst")}
        value={draft.analystVariantId}
        onChange={(e) => patch({ analystVariantId: e.target.value })}
        options={[
          { value: "", label: t("listening.agent.default") },
          ...props.analystOptions.map((v) => ({ value: v.variantId, label: v.variantId })),
        ]}
        hint={t("listening.agent.hint")}
      />
      <Select
        label={t("listening.agent.engineer")}
        value={draft.engineerVariantId}
        onChange={(e) => patch({ engineerVariantId: e.target.value })}
        options={[
          { value: "", label: t("listening.agent.default") },
          ...props.engineerOptions.map((v) => ({ value: v.variantId, label: v.variantId })),
        ]}
        hint={t("listening.agent.hint")}
      />
      <label className="scr-check" style={{ alignSelf: "end", paddingBottom: 6 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        {t("listening.form.enabled")}
      </label>
      <Input
        label={t("listening.form.priority")}
        type="number"
        min={0}
        max={10000}
        inputMode="numeric"
        value={draft.priority}
        onChange={(e) => patch({ priority: e.target.value })}
        placeholder="100"
        hint={t("listening.form.priority_hint")}
      />
    </FieldGroup>
  );
}

/**
 * ONAY KAPILARI — katlı, ama özet satırı seçimi söyler: "risk seviyesine göre",
 * "2 kapı", ya da uyarıyla "onay beklenmez". Kod adı değil ANLAM: operatör
 * "kapı 4" değil "Analiz onayı" görür.
 */
function GatesSection(props: RuleFormProps): ReactNode {
  const t = useT();
  const { draft, patch } = props;
  const toggleStep = (step: string): void =>
    patch({
      gateSteps: draft.gateSteps.includes(step)
        ? draft.gateSteps.filter((s) => s !== step)
        : [...draft.gateSteps, step],
    });
  const noneSelected = draft.gatesCustom && draft.gateSteps.length === 0;
  const summaryState = !draft.gatesCustom
    ? t("listening.gates.summary_default")
    : noneSelected
      ? t("listening.gates.summary_none")
      : t("listening.gates.summary_count", { count: String(draft.gateSteps.length) });

  return (
    <details
      className="scr-adv"
      open={draft.gatePanelOpen}
      onToggle={(e) => patch({ gatePanelOpen: (e.currentTarget as HTMLDetailsElement).open })}
    >
      <summary className="scr-adv__summary">
        <span>{t("listening.gates.title")}</span>{" "}
        <span className={noneSelected ? "scr-hint scr-hint--warn" : "scr-hint"} style={{ display: "inline", margin: 0 }}>
          {summaryState}
        </span>
      </summary>
      <div className="scr-stack" style={{ padding: "10px 2px 2px" }}>
        <p className="scr-hint" style={{ margin: 0 }}>
          {t("listening.gates.explain")}
        </p>
        {/* İki radyo, iki cümle: "seçim yok" ile "hiçbirini seçmedim" bir onay
            kutusuyla anlatılamaz. */}
        <div className="scr-checklist">
          <label className="scr-check">
            <input
              type="radio"
              name="gates-mode"
              checked={!draft.gatesCustom}
              onChange={() => patch({ gatesCustom: false })}
            />
            <span>{t("listening.gates.default")}</span>
          </label>
          <label className="scr-check">
            <input
              type="radio"
              name="gates-mode"
              checked={draft.gatesCustom}
              onChange={() => patch({ gatesCustom: true })}
            />
            <span>{t("listening.gates.custom")}</span>
          </label>
        </div>
        {draft.gatesCustom && (
          <div className="scr-checklist" style={{ paddingLeft: 20 }}>
            {SELECTABLE_GATES.map((gate) => {
              // Mühendislik kapıları analiz akışında seçilse de açılmaz. Seçim
              // ENGELLENMEZ (akış sonradan değişebilir) ama SÖYLENİR.
              const dead = draft.flowType === "analiz" && gate.step !== "4" && gate.step !== "5";
              const picked = draft.gateSteps.includes(gate.step);
              return (
                <div key={gate.step}>
                  <label className="scr-check">
                    <input type="checkbox" checked={picked} onChange={() => toggleStep(gate.step)} />
                    <span style={dead ? { color: "var(--muted)" } : undefined}>{t(gate.titleKey)}</span>
                  </label>
                  <p className="scr-hint" style={{ margin: "2px 0 0 24px" }}>
                    {t(`${gate.titleKey}.hint`)}
                  </p>
                  {dead && picked && (
                    <p className="scr-hint scr-hint--warn" style={{ margin: "4px 0 0 24px" }}>
                      {t("listening.gates.engineering_only")}
                    </p>
                  )}
                </div>
              );
            })}
            {noneSelected && (
              <p className="scr-hint scr-hint--warn" style={{ margin: 0 }}>
                {t("listening.gates.none_selected")}
              </p>
            )}
            <label className="scr-check">
              <input
                type="checkbox"
                checked={draft.gateOwnerless}
                onChange={(e) => patch({ gateOwnerless: e.target.checked })}
              />
              <span>{t("listening.gates.ownerless")}</span>
            </label>
            <p className="scr-hint" style={{ margin: "0 0 0 24px" }}>
              {t("listening.gates.ownerless_explain")}
            </p>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * JIRA DURUMU — katlı ve OPT-IN: her kuralın bugünkü davranışı yalnız yorum,
 * bir form çizildiği için bankanın ticket'larını taşımaya başlamamalı.
 * Bölümün sonunda KAPI AYNASI: operatörün çizdiği hattın kapıda ne anlama
 * geldiğini, kaydetmeden önce, kaydedilecek hâliyle geri söyler.
 */
function StatusSection(props: RuleFormProps): ReactNode {
  const t = useT();
  const { draft, patch } = props;
  const livePoints = new Set(firesFor(draft.flowType));
  const deadEntries = deadStatusEntries(draft.statusDraft, draft.flowType);
  const clashes = gateStatusConflicts(draft.statusDraft, draft.gateStatusDraft);
  const mirror = gateMirrorOf(draft);
  const setPoint = (point: StatusPoint, value: string): void =>
    patch({ statusDraft: { ...draft.statusDraft, [point]: value } });
  const summaryState = draft.statusOn
    ? t("listening.status.summary_on")
    : t("listening.status.summary_off");
  const gateEmpty = mirror.approve === "" && mirror.return === "";

  return (
    <details
      className="scr-adv"
      open={draft.statusPanelOpen}
      onToggle={(e) => patch({ statusPanelOpen: (e.currentTarget as HTMLDetailsElement).open })}
    >
      <summary className="scr-adv__summary">
        <span>{t("listening.status.summary")}</span>{" "}
        <span className="scr-hint" style={{ display: "inline", margin: 0 }}>
          {summaryState}
        </span>
      </summary>
      <div className="scr-stack" style={{ padding: "10px 2px 2px" }}>
        <p className="scr-hint" style={{ margin: 0 }}>
          {t("listening.status.intro")}
        </p>
        <label className="scr-check">
          <input
            type="checkbox"
            checked={draft.statusOn}
            // Kapatmak yazılanı silmez; yalnız tele giden şey anahtara bağlı.
            onChange={(e) => patch({ statusOn: e.target.checked })}
          />
          {t("listening.status.enable")}
        </label>

        {draft.statusOn && (
          <>
            <p className="scr-hint" style={{ margin: 0 }}>
              {t("listening.status.exact")}
            </p>
            <div className="scr-grid scr-grid--2">
              {STATUS_POINTS.map((point) => {
                // Bu akışta ölü nokta: gizli değil, kapalı, ve ipucu SEBEP.
                const dead = !livePoints.has(point);
                const hint = dead ? t("listening.status.dead_hint") : t(`listening.status.hint.${point}`);
                return props.statusOptions.length > 0 ? (
                  <Select
                    key={point}
                    label={t(`listening.status.${point}`)}
                    value={draft.statusDraft[point]}
                    onChange={(e) => setPoint(point, e.target.value)}
                    disabled={dead}
                    options={[
                      { value: "", label: t("listening.status.skip") },
                      ...props.statusOptions.map((v) => ({ value: v, label: v })),
                    ]}
                    hint={hint}
                  />
                ) : (
                  <Input
                    key={point}
                    label={t(`listening.status.${point}`)}
                    value={draft.statusDraft[point]}
                    onChange={(e) => setPoint(point, e.target.value)}
                    disabled={dead}
                    hint={hint}
                  />
                );
              })}
            </div>
            {/* Ölü noktada duran değerler: kayıt onları YAZMAZ, ve bu kayıttan
                önce, değerleri adlandırarak söylenir. */}
            {deadEntries.length > 0 && (
              <div className="scr-note scr-note--warn">
                {t("listening.status.dead_warning", {
                  values: deadEntries
                    .map((e) => `${t(`listening.status.${e.point}`)}: ${e.value}`)
                    .join(", "),
                })}
              </div>
            )}
            <label className="scr-check">
              <input
                type="checkbox"
                checked={draft.reassignOnNeedInfo}
                onChange={(e) => patch({ reassignOnNeedInfo: e.target.checked })}
              />
              {t("listening.status.reassign")}
            </label>
            <p className="scr-hint" style={{ margin: "0 0 0 24px" }}>
              {t("listening.status.reassign_hint")}
            </p>
          </>
        )}

        {/* ── KAPI AYNASI ── Bir girdi değil; kaydedilecek eşlemeden türetilir. */}
        <div className="scr-note">
          <p className="scr-hint" style={{ margin: 0, fontWeight: 600 }}>
            {t("listening.gate_status.title")}
          </p>
          {mirror.noGate ? (
            <p className="scr-hint">{t("listening.gate_status.no_gate_flow")}</p>
          ) : mirror.commentOnly ? (
            <p className="scr-hint">{t("listening.gate_status.comment_only")}</p>
          ) : (
            <>
              <p className="scr-hint">{t("listening.gate_status.intro")}</p>
              <ul className="scr-hint" style={{ paddingLeft: 18 }}>
                <li>
                  {t("listening.gate_status.derived_approve", {
                    status: mirror.approve === "" ? t("listening.gate_status.derived_none") : mirror.approve,
                    from: mirror.approveFrom === null ? "" : t(`listening.gate_status.from.${mirror.approveFrom}`),
                  })}
                </li>
                <li>
                  {t("listening.gate_status.derived_return", {
                    status: mirror.return === "" ? t("listening.gate_status.derived_none") : mirror.return,
                    from: mirror.returnFrom === null ? "" : t(`listening.gate_status.from.${mirror.returnFrom}`),
                  })}
                </li>
              </ul>
              {/* Kalan tek yasak: kapı kenarı `onReview` ile aynı olamaz — kapı
                  orada AÇILIYOR, oradan karar okunamaz. */}
              {clashes.length > 0 && (
                <p className="scr-hint scr-hint--warn">
                  {t("listening.gate_status.review_clash", {
                    values: clashes.map((c) => t(`listening.gate_status.from.${c.point}`)).join(", "),
                  })}
                </p>
              )}
              {gateEmpty && (
                <p className="scr-hint scr-hint--warn">{t("listening.gate_status.empty_warning")}</p>
              )}
              <p className="scr-hint">{t("listening.gate_status.approval_note")}</p>
            </>
          )}
        </div>
      </div>
    </details>
  );
}
