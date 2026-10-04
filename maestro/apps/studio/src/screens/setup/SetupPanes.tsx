import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Input, Select } from "../../ui/index.ts";
import { englishAside, matchValueLabel } from "../common/jira-english.ts";
import { displayMatchValue, storedMatchValue, type MatchValueOption } from "../common/match-value.ts";
import {
  STATUS_POINTS,
  buildStatusMap,
  firesFor,
  gateMirror,
  type StatusPoint,
} from "../common/status-map.ts";
import {
  COMMAND_INTAKES,
  DATA_CLASSES,
  OFFERED_FLOW_TYPES,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  flowNeedsRepository,
  flowUnavailableReason,
  gateChoiceFor,
  intakePolls,
  intakeUnavailableReason,
  offeredGateChoices,
  type DataClass,
  type FlowType,
  type MatchKind,
  type SetupDraft,
} from "./model.ts";

/**
 * The wizard's panes. Presentational on purpose: every one of them takes the
 * single draft plus an `onChange`, so navigating between steps is a state
 * change in the container and never an unmount that could drop what was typed.
 *
 * They render CONTENT ONLY — the container wraps the active pane in one card
 * with the step's title and the Geri/İleri row, so a step is one box on the
 * screen rather than a card for the question and a second card for the
 * buttons.
 *
 * The register throughout is the one the whole wizard is for: a sentence about
 * what will HAPPEN, not the name of the field that causes it. "risk_tiered"
 * appears nowhere; "Maestro talebi inceleyip analiz belgesi hazırlasın" does.
 */

/** What each pane needs beyond the draft, gathered by the container. */
export interface PaneData {
  /** Jira connections, and the projects of the chosen one. */
  readonly jiraConnections: readonly { id: string; label: string }[];
  readonly jiraProjects: readonly { key: string; name: string }[];
  readonly jiraProjectsLoading: boolean;
  readonly jiraProjectsError: string | null;
  /** SCM connections, and the repos of the chosen one. */
  readonly scmConnections: readonly { id: string; label: string }[];
  /**
   * How many repository connections exist, or `null` while that is still
   * unknown (the request is in flight, or it failed). An empty array and an
   * unanswered question look identical in `scmConnections`, and the flow
   * cards have to tell them apart before accusing the install of having no
   * repository.
   */
  readonly scmConnectionCount: number | null;
  readonly scmRepos: readonly string[];
  readonly scmReposLoading: boolean;
  readonly scmReposError: string | null;
  readonly platforms: readonly string[];
  /** Live Jira values for the chosen project + match kind; empty → free text. */
  readonly matchValues: readonly string[];
  /**
   * The same values with their Jira ids, and whether the project is
   * team-managed — which decides whether the rule STORES the id or the name
   * (`common/match-value.ts`). The operator reads a name either way.
   */
  readonly matchValueOptions: readonly MatchValueOption[];
  readonly matchValuesTeamManaged: boolean;
  /** Set when `matchValues` came from the fallback source (other language). */
  readonly matchValuesNote: string | null;
  /** Live Jira STATUS names, for the status gate and the status map; empty → free text. */
  readonly statusNames: readonly string[];
  /** True once a connection has reported a bot account id (the assignee pre-fill). */
  readonly botKnown: boolean;
  /** Whether the work driver can read a comment thread; `undefined` while unknown. */
  readonly canReadComments: boolean | undefined;
  /** Whether a changed intake applies without a restart; `undefined` while unknown. */
  readonly intakeAppliesLive: boolean | undefined;
}

export interface PaneProps {
  readonly draft: SetupDraft;
  readonly data: PaneData;
  readonly onChange: (patch: Partial<SetupDraft>) => void;
}

/** A radio CARD — the whole card is the label so the outcome sentence is part of the click. */
function ChoiceCard({
  name,
  value,
  checked,
  onPick,
  label,
  desc,
  meta,
  blocked,
}: {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly onPick: () => void;
  readonly label: string;
  readonly desc: string;
  readonly meta: string;
  readonly blocked: string | null;
}): ReactNode {
  return (
    <label
      className={
        "setup-choice" + (checked ? " setup-choice--on" : "") + (blocked === null ? "" : " setup-choice--blocked")
      }
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onPick} />
      <span className="setup-choice__body">
        <span className="setup-choice__label">{label}</span>
        <span className="setup-choice__desc">{desc}</span>
        <span className="setup-choice__meta">{meta}</span>
        {blocked !== null && <span className="scr-note scr-note--warn setup-choice__blocked">{blocked}</span>}
      </span>
    </label>
  );
}

/**
 * Step 1 — the Jira project and the data class. Nothing about a repository:
 * whether one is needed depends on the flow, and the flow is asked on the
 * next step right above the repository field, so the two stay together.
 */
export function ProjectPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  // The live list has four faces to tell apart: nothing picked yet, loading,
  // a provider error, an empty result. One "seçiniz" for all four is how
  // "hiçbir şey çıkmıyor" tickets happen.
  const projectPlaceholder =
    draft.jiraConnectionId === ""
      ? t("setup.project.pick_jira_conn_first")
      : data.jiraProjectsLoading
        ? t("setup.common.loading")
        : (data.jiraProjectsError ??
          (data.jiraProjects.length === 0 ? t("setup.project.no_projects") : t("setup.common.choose")));

  return (
    <>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("setup.project.jira_connection")}
          value={draft.jiraConnectionId}
          onChange={(e) => onChange({ jiraConnectionId: e.target.value, jiraProject: "" })}
          options={[
            { value: "", label: t("setup.common.choose") },
            ...data.jiraConnections.map((c) => ({ value: c.id, label: c.label })),
          ]}
          hint={t("setup.project.jira_connection_hint")}
        />
        <Select
          label={t("setup.project.jira_project")}
          value={draft.jiraProject}
          // A new project resets the answers that were read off the old one:
          // the trigger value, and the status gate whose names are the old
          // project's board vocabulary.
          onChange={(e) => onChange({ jiraProject: e.target.value, matchValue: "", allowedStatuses: [] })}
          disabled={draft.jiraConnectionId === "" || data.jiraProjectsLoading || data.jiraProjects.length === 0}
          options={[
            { value: "", label: projectPlaceholder },
            ...data.jiraProjects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
          hint={t("setup.project.jira_project_hint")}
        />
      </div>

      {/* The data class (M18): one select, and the CONSEQUENCE of the current
          answer as its hint — the policy name appears nowhere. `gizli` is the
          answer that can stop the product working, so it gets a warning block
          the operator cannot scroll past, shown only once chosen. */}
      <div className="scr-grid scr-grid--2 scr-mt-2">
        <Select
          label={t("setup.dataclass.heading")}
          value={draft.dataClass}
          onChange={(e) => onChange({ dataClass: e.target.value as DataClass })}
          options={DATA_CLASSES.map((cls) => ({ value: cls, label: t(`setup.dataclass.name.${cls}`) }))}
          hint={`${t(`setup.dataclass.desc.${draft.dataClass}`)} ${t(`setup.dataclass.meta.${draft.dataClass}`)}`}
        />
      </div>
      {draft.dataClass === "gizli" && (
        <div className="scr-note scr-note--warn scr-mt-2">{t("setup.dataclass.gizli_warning")}</div>
      )}
    </>
  );
}

/**
 * The repository, asked on the tickets step right under the flow choice.
 *
 * REQUIRED when the flow writes code, an OFFER when it only analyses — same
 * field, different label, so the operator never meets a separate "depo
 * bağlama" concept. The answer is written to the RULE's repo map, never to
 * the binding (see the save mutation): the binding's repo used to be a silent
 * last-resort default that made a broken map look like a working one.
 */
function RepoFields({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const required = flowNeedsRepository(draft.flowType);
  // No connection on an analysis-only install: nothing to offer, and the
  // prerequisite banner already covers the code-writing case.
  if (!required && data.scmConnectionCount === 0) {
    return <p className="scr-hint scr-mt-3">{t("setup.project.repo_optional_analiz")}</p>;
  }
  const reposReady = draft.connectionId !== "" && !data.scmReposLoading && data.scmReposError === null;
  const repoPlaceholder =
    draft.connectionId === ""
      ? t("setup.project.pick_scm_conn_first")
      : data.scmReposLoading
        ? t("setup.common.loading")
        : (data.scmReposError ??
          (data.scmRepos.length === 0
            ? t("setup.project.no_repos")
            : required
              ? t("setup.common.choose")
              : t("setup.tickets.repo_none")));

  return (
    <>
      <p className="scr-hint scr-mt-3">
        {t(required ? "setup.project.repo_moved_to_rule" : "setup.project.repo_optional_analiz")}
      </p>
      <div className="scr-grid scr-grid--2">
        {/* The sole connection is pre-selected by the container and not asked
            again; the select only appears when there is a real choice. */}
        {data.scmConnections.length !== 1 && (
          <Select
            label={t("setup.project.scm_connection")}
            value={draft.connectionId}
            onChange={(e) => onChange({ connectionId: e.target.value, repoFullName: "" })}
            options={[
              { value: "", label: t("setup.common.choose") },
              ...data.scmConnections.map((c) => ({ value: c.id, label: c.label })),
            ]}
            hint={t("setup.project.scm_connection_hint")}
          />
        )}
        <Select
          label={t(required ? "setup.project.scm_repo" : "setup.tickets.repo_optional_label")}
          value={draft.repoFullName}
          onChange={(e) => onChange({ repoFullName: e.target.value })}
          disabled={!reposReady || data.scmRepos.length === 0}
          options={[
            { value: "", label: repoPlaceholder },
            ...data.scmRepos.map((r) => ({ value: r, label: r })),
          ]}
        />
      </div>
      {/*
        PLATFORM: TEK PROFİL VARSA SORULMAZ.

        Bu kurulumda tanımlı profil bir taneyse operatöre sorulacak bir şey yok
        — cevabı zaten belli, ve zorunlu bir "seçiniz" kutusu yalnız fazladan
        bir tıklama demek. Tahmin EDİLMİYOR: liste gerçekten tek elemanlıysa o
        seçiliyor ve satır altında hangisi olduğu YAZILIYOR. Birden fazlaysa
        kutu duruyor — yanlış tahmin `platform_mismatch`e çıkardı.
      */}
      {draft.repoFullName !== "" &&
        (data.platforms.length === 1 ? (
          <p className="scr-hint scr-mt-2">
            {t("setup.project.platform_single", { platform: t(`platform.${data.platforms[0]!}`) })}
          </p>
        ) : (
          <div className="scr-grid scr-grid--2 scr-mt-2">
            <Select
              label={t("setup.project.platform")}
              value={draft.platform}
              onChange={(e) => onChange({ platform: e.target.value })}
              options={[
                { value: "", label: t("setup.common.choose") },
                ...data.platforms.map((p) => ({ value: p, label: t(`platform.${p}`) })),
              ]}
              hint={t("setup.project.platform_hint")}
            />
          </div>
        ))}
    </>
  );
}

/**
 * Step 2 — what Maestro does, where the code lives, and which tickets it
 * picks up: the flow, the repository, the trigger, the status gate, the bot
 * account and the human approvals.
 */
export function TicketsPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  // "Bota atanan her ticket" has no second question, so the value field is GONE
  // rather than greyed out: an absent field reads as an answered question.
  const anyAssigned = draft.matchKind === "assigned";
  // The pre-filled bot account is a read-only line until the operator asks to
  // change it: a GUID in an editable box invites a typo nobody asked for.
  const [assigneeEditing, setAssigneeEditing] = useState(false);
  const toggleAllowed = (name: string): void =>
    onChange({
      allowedStatuses: draft.allowedStatuses.includes(name)
        ? draft.allowedStatuses.filter((s) => s !== name)
        : [...draft.allowedStatuses, name],
    });
  // A STATUS trigger is itself a status the ticket must be in, so it joins the
  // gate on its own — an operator who picked "Analiz Bekliyor" as the trigger
  // must not also have to tick it below to make the rule fire. The gate holds
  // NAMES, so a stored id is mapped back to its name first.
  const setMatchValue = (value: string): void => {
    const name = displayMatchValue(value, data.matchValueOptions);
    onChange({
      matchValue: value,
      ...(draft.matchKind === "status" && name !== "" && !draft.allowedStatuses.includes(name)
        ? { allowedStatuses: [...draft.allowedStatuses, name] }
        : {}),
    });
  };
  const english = englishAside(draft.matchValue);

  return (
    <>
      {/* 1 — the flow. A radio list, not a dropdown: the two flows differ in
          what Maestro is ALLOWED to do, and the difference has to be visible
          before the click. `duzeltme` is not offered (see OFFERED_FLOW_TYPES). */}
      <h4 className="scr-h">{t("setup.tickets.flow_heading")}</h4>
      <div className="setup-choices" role="radiogroup" aria-label={t("setup.tickets.flow_heading")}>
        {OFFERED_FLOW_TYPES.map((flow) => {
          // A flow this install cannot run is shown, selectable and explained —
          // never hidden — and "İleri" stops until the gap is resolved.
          const blocked = flowUnavailableReason(flow, data.scmConnectionCount);
          return (
            <ChoiceCard
              key={flow}
              name="setup-flow"
              value={flow}
              checked={draft.flowType === flow}
              // An approval answer the new flow does not offer falls back to
              // the one it does, rather than surviving unseen.
              onPick={() => onChange({ flowType: flow as FlowType, gateChoice: gateChoiceFor(flow, draft.gateChoice) })}
              label={t(`setup.flow.name.${flow}`)}
              desc={t(`setup.flow.desc.${flow}`)}
              meta={t(`setup.flow.meta.${flow}`)}
              blocked={blocked === null ? null : t(blocked)}
            />
          );
        })}
      </div>

      {/* 2 — the repository: required or offered, by the flow just picked. */}
      <RepoFields draft={draft} data={data} onChange={onChange} />

      {/* 3 — the trigger. */}
      <div className="scr-grid scr-grid--2 scr-mt-3">
        <Select
          label={t("setup.tickets.match_kind")}
          value={draft.matchKind}
          // Switching the question invalidates the answer: an issue-type name is
          // not a status name, and a leftover value would save a rule that can
          // never match a ticket.
          onChange={(e) => onChange({ matchKind: e.target.value as MatchKind, matchValue: "" })}
          options={[
            { value: "status", label: t("setup.tickets.kind.status") },
            { value: "assigned", label: t("setup.tickets.kind.assigned") },
            { value: "label", label: t("setup.tickets.kind.label") },
            { value: "issuetype", label: t("setup.tickets.kind.issuetype") },
          ]}
          hint={t(`setup.tickets.kind_hint.${draft.matchKind}`)}
        />
        {anyAssigned ? null : data.matchValues.length > 0 ? (
          <Select
            label={t("setup.tickets.match_value")}
            value={draft.matchValue}
            // The option's VALUE is what the rule stores — the name Jira serves,
            // or on a team-managed project the id JQL insists on; only its
            // LABEL carries the name and the English aside.
            onChange={(e) => setMatchValue(e.target.value)}
            options={[
              { value: "", label: t("setup.common.choose") },
              ...data.matchValues.map((v) => ({
                value: storedMatchValue(v, data.matchValueOptions, data.matchValuesTeamManaged),
                label: matchValueLabel(v),
              })),
            ]}
            hint={
              data.matchValuesNote ??
              t(
                data.matchValuesTeamManaged
                  ? "listening.form.matchValue_hint_team_managed"
                  : "setup.tickets.match_value_hint_live",
              )
            }
          />
        ) : (
          <Input
            label={t("setup.tickets.match_value")}
            value={draft.matchValue}
            onChange={(e) => setMatchValue(e.target.value)}
            hint={
              english === null
                ? t("setup.tickets.match_value_hint_manual")
                : t("setup.tickets.match_value_hint_english", { english })
            }
          />
        )}
      </div>
      {anyAssigned && <div className="scr-note scr-mt-2">{t("setup.tickets.assigned_note")}</div>}

      {/* The status GATE (0024): which board columns a ticket may be in to be
          picked up. Asked here because the wizard used to skip it, and every
          rule it wrote then opened on the listening screen flagged "statü
          kısıtı yok". Names come from the project's live Jira board; free text
          only when the board could not be read. */}
      <fieldset className="scr-fieldset scr-mt-2">
        <legend className="setup-legend">{t("setup.tickets.allowed_statuses")}</legend>
        {data.statusNames.length > 0 ? (
          <div className="scr-checks">
            {data.statusNames.map((name) => (
              <label key={name} className="scr-check">
                <input
                  type="checkbox"
                  checked={draft.allowedStatuses.includes(name)}
                  onChange={() => toggleAllowed(name)}
                />
                {name}
              </label>
            ))}
          </div>
        ) : (
          <Input
            label={t("setup.tickets.allowed_statuses_manual")}
            value={draft.allowedStatuses.join(", ")}
            onChange={(e) =>
              onChange({
                allowedStatuses: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter((v) => v !== ""),
              })
            }
            hint={t(draft.jiraProject === "" ? "setup.tickets.allowed_statuses_pick_project" : "setup.tickets.allowed_statuses_unavailable")}
          />
        )}
        <p className="scr-hint">
          {t(draft.allowedStatuses.length === 0 ? "setup.tickets.allowed_statuses_none" : "setup.tickets.allowed_statuses_hint")}
        </p>
      </fieldset>

      {/* The bot account: pre-filled from the tested connection, shown as a
          line rather than a box until the operator asks to change it. */}
      <div className="scr-mt-2">
        {data.botKnown && draft.assigneeAccountId !== "" && !assigneeEditing ? (
          <>
            <p className="scr-prose">
              {t("setup.tickets.assignee")}: <span className="scr-mono">{draft.assigneeAccountId}</span>{" "}
              <Button size="sm" onClick={() => setAssigneeEditing(true)}>
                {t("setup.tickets.assignee_change")}
              </Button>
            </p>
            <p className="scr-hint">{t("setup.tickets.assignee_hint_auto")}</p>
          </>
        ) : (
          <Input
            label={t("setup.tickets.assignee")}
            value={draft.assigneeAccountId}
            onChange={(e) => onChange({ assigneeAccountId: e.target.value })}
            placeholder="712020:…"
            hint={data.botKnown ? t("setup.tickets.assignee_hint_auto") : t("setup.tickets.assignee_hint")}
          />
        )}
      </div>

      {/*
        HANGİ ONAYLAR BEKLENSİN — TEK SORU, en çok ÜÇ CEVAP.

        Burası bir dönem altı kutuluk bir liste ve "risk seviyesine göre mi, ben
        mi seçiyorum" diye ikinci bir soruydu. Operatörün istediği şey ise
        basitti: "PR'ı istersem kapatabileyim."

        Cevapların karşılıkları `GATE_STEPS_BY_CHOICE`ta. "Analiz + PR öncesi"
        yalnız kod yazan akışta sunulur: analiz akışı hiç PR açmaz, o kapı hiç
        gelmez (`offeredGateChoices`).

        Katlanmış DEĞİL: bir dönem `<details>` içindeydi ve operatör seçeneğin
        var olduğunu hiç öğrenmiyordu.
      */}
      <h4 className="scr-h scr-mt-3">{t("setup.gates.heading")}</h4>
      <div className="scr-checklist">
        {offeredGateChoices(draft.flowType).map((choice) => (
          <div key={choice}>
            <label className="scr-check">
              <input
                type="radio"
                name="setup-gate-choice"
                checked={draft.gateChoice === choice}
                onChange={() => onChange({ gateChoice: choice })}
              />
              {t(`setup.gates.choice.${choice}`)}
            </label>
            <p className="scr-hint setup-indent">{t(`setup.gates.choice.${choice}.hint`)}</p>
          </div>
        ))}
      </div>
      <p className="scr-hint">{t("setup.gates.risk_note")}</p>
      <p className="scr-hint">{t("setup.tickets.note")}</p>
    </>
  );
}

/**
 * Step 3 — the Jira status map, OFF by default, and the gate MIRROR under it.
 *
 * CLOSED, the step is one checkbox and one sentence: every explanation lives
 * behind the switch, because an operator who is going to skip the step should
 * not have to read three paragraphs to learn that they can.
 *
 * The mirror reads the map exactly as it will go on the wire — built by
 * `buildStatusMap` from the switch, the flow and the five fields — and says
 * what the server will make of it. A mirror that read the five fields
 * directly told an operator with the switch OFF that moving the ticket would
 * approve the gate; the server, given `null`, would have done nothing.
 */
export function StatusPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const setPoint = (point: StatusPoint, value: string): void =>
    onChange({ statusDraft: { ...draft.statusDraft, [point]: value } });
  const livePoints = new Set(firesFor(draft.flowType));
  const mirror = gateMirror(
    buildStatusMap(draft.statusOn, draft.statusDraft, draft.reassignOnNeedInfo, draft.flowType),
  );
  const gateEmpty = mirror.approve === null && mirror.return === null;
  // See RuleForm: a blank `onReview` means the analysis never moves to the
  // approval column, and the engine says nothing about it.
  const reviewMissing =
    draft.statusOn && livePoints.has("onReview") && draft.statusDraft.onReview.trim() === "";

  return (
    <>
      <label className="scr-check">
        <input
          type="checkbox"
          checked={draft.statusOn}
          // Turning it off never rewrites the draft; only what the wire builds
          // depends on the flag, and ticking it again brings the values back.
          onChange={(e) => onChange({ statusOn: e.target.checked })}
        />
        {t("setup.status.enable")}
      </label>

      {/* OFF: the one sentence that says what the gate then runs on. */}
      {!draft.statusOn && <p className="scr-hint">{t("setup.gate_status.off_warning")}</p>}

      {draft.statusOn && (
        <>
          <p className="scr-hint">{t("setup.status.exact")}</p>
          <div className="scr-grid scr-grid--2 scr-mt-1">
            {STATUS_POINTS.map((point) => {
              // A dead point is disabled, never hidden, with the REASON as its
              // hint. A value the draft still holds there stays visible;
              // `buildStatusMap` keeps it off the wire and the mirror never
              // counts it.
              const dead = !livePoints.has(point);
              const hint = dead ? t("setup.status.dead_hint") : t(`setup.status.hint.${point}`);
              return data.statusNames.length > 0 ? (
                <Select
                  key={point}
                  label={t(`setup.status.point.${point}`)}
                  value={draft.statusDraft[point]}
                  onChange={(e) => setPoint(point, e.target.value)}
                  disabled={dead}
                  options={[
                    { value: "", label: t("setup.status.skip") },
                    ...data.statusNames.map((v) => ({ value: v, label: v })),
                  ]}
                  hint={hint}
                />
              ) : (
                <Input
                  key={point}
                  label={t(`setup.status.point.${point}`)}
                  value={draft.statusDraft[point]}
                  onChange={(e) => setPoint(point, e.target.value)}
                  disabled={dead}
                  hint={hint}
                />
              );
            })}
          </div>
          <label className="scr-check scr-mt-2">
            <input
              type="checkbox"
              checked={draft.reassignOnNeedInfo}
              onChange={(e) => onChange({ reassignOnNeedInfo: e.target.checked })}
            />
            {t("setup.status.reassign")}
          </label>
          <p className="scr-hint">{t("setup.status.reassign_hint")}</p>

          {/* The gate, read back from the wire. Not an input: the five fields
              above draw the line, this says what moving the ticket along it
              will mean — and says "nothing" out loud when that is the answer. */}
          <div className="setup-mirror">
            <p className="setup-mirror__h">{t("setup.gate_status.title")}</p>
            <p className="scr-hint">{t("setup.gate_status.intro")}</p>
            <ul className="scr-list">
              <li>
                {t("listening.gate_status.derived_approve", {
                  status: mirror.approve ?? t("listening.gate_status.derived_none"),
                  from: mirror.approveFrom === null ? "" : t(`listening.gate_status.from.${mirror.approveFrom}`),
                })}
              </li>
              <li>
                {t("listening.gate_status.derived_return", {
                  status: mirror.return ?? t("listening.gate_status.derived_none"),
                  from: mirror.returnFrom === null ? "" : t(`listening.gate_status.from.${mirror.returnFrom}`),
                })}
              </li>
            </ul>
            {mirror.conflicts.length > 0 && (
              <div className="scr-note scr-note--warn scr-mt-2">
                {t("listening.gate_status.review_clash", {
                  values: mirror.conflicts.map((c) => t(`listening.gate_status.from.${c.point}`)).join(", "),
                })}
              </div>
            )}
            {gateEmpty && (
              <div className="scr-note scr-note--warn scr-mt-2">{t("listening.gate_status.empty_warning")}</div>
            )}
            {reviewMissing && (
              <div className="scr-note scr-note--warn scr-mt-2">{t("listening.gate_status.review_missing")}</div>
            )}
            <p className="scr-hint">{t("listening.gate_status.approval_note")}</p>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Step 4 — "Jira ile iletişim": the platform-wide command intake, asked as ONE
 * question with three answers because webhook and polling are alternatives,
 * not a checklist. It is about how `/approve` COMMANDS reach Maestro — not
 * about which approvals are required, which step 2 asks.
 */
export function IntakePane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const polls = intakePolls(draft.commandIntake);

  return (
    <>
      <p className="scr-prose">{t("setup.intake.intro")}</p>
      <div className="setup-choices" role="radiogroup" aria-label={t("setup.intake.title")}>
        {COMMAND_INTAKES.map((intake) => {
          const blocked = intakeUnavailableReason(intake, data.canReadComments);
          return (
            <ChoiceCard
              key={intake}
              name="setup-intake"
              value={intake}
              checked={draft.commandIntake === intake}
              onPick={() => onChange({ commandIntake: intake })}
              label={t(`setup.intake.name.${intake}`)}
              desc={t(`setup.intake.desc.${intake}`)}
              meta={t(`setup.intake.meta.${intake}`)}
              blocked={blocked === null ? null : t(blocked)}
            />
          );
        })}
      </div>

      {/* The interval, asked only when it will be used. */}
      {polls && (
        <div className="scr-grid scr-grid--2 scr-mt-2">
          <Input
            label={t("setup.intake.seconds")}
            type="number"
            min={MIN_POLL_SECONDS}
            max={MAX_POLL_SECONDS}
            value={String(draft.pollSeconds)}
            // An empty field parses to NaN rather than 0: 0 MEANS "off" here
            // and typing over the value must not pass through it.
            onChange={(e) => onChange({ pollSeconds: Number.parseInt(e.target.value, 10) })}
            hint={t("setup.intake.seconds_hint", {
              min: String(MIN_POLL_SECONDS),
              max: String(MAX_POLL_SECONDS),
            })}
          />
          <div className="scr-note scr-note--warn">{t("setup.intake.load_warning")}</div>
        </div>
      )}
      {draft.commandIntake === "both" && <p className="scr-hint">{t("setup.intake.double_guard")}</p>}
      <p className="scr-hint">
        {data.intakeAppliesLive === undefined
          ? t("setup.intake.applies_unknown")
          : data.intakeAppliesLive
            ? t("setup.intake.applies_live")
            : t("setup.intake.applies_restart")}
      </p>
      {/* This one answer is not about the project the operator just configured. */}
      <div className="scr-note scr-note--warn scr-mt-2">{t("setup.intake.global_note")}</div>
    </>
  );
}
