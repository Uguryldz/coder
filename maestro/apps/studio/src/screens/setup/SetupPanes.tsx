import { useState } from "react";
import type { ReactNode } from "react";
import { SELECTABLE_GATES } from "@maestro/contracts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Input, Select } from "../../ui/index.ts";
import { englishAside, matchValueLabel } from "../common/jira-english.ts";
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
  FLOW_TYPES,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  flowNeedsRepository,
  flowUnavailableReason,
  intakePolls,
  intakeUnavailableReason,
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
 * buttons. Required answers come first; the optional ones (repository on an
 * analysis flow, approval gates) sit behind a collapsed disclosure, so each
 * step fits one screen.
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
   * unanswered question look identical in `scmConnections`, and step 1 has to
   * tell them apart before accusing the install of having no repository.
   */
  readonly scmConnectionCount: number | null;
  readonly scmRepos: readonly string[];
  readonly scmReposLoading: boolean;
  readonly scmReposError: string | null;
  readonly platforms: readonly string[];
  /** Live Jira values for the chosen project + match kind; empty → free text. */
  readonly matchValues: readonly string[];
  /** Set when `matchValues` came from the fallback source (other language). */
  readonly matchValuesNote: string | null;
  /** Live Jira STATUS names, for the status gate and the status map; empty → free text. */
  readonly statusNames: readonly string[];
  /** True once a connection has reported a bot account id (step 3's pre-fill). */
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
 * Step 1 — "Ne yapmak istiyorsun?". A radio list, not a dropdown: the three
 * flows differ in what Maestro is ALLOWED to do, and the difference has to be
 * visible before the click.
 */
export function FlowPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  return (
    <div className="setup-choices" role="radiogroup" aria-label={t("setup.flow.title")}>
      {FLOW_TYPES.map((flow) => {
        // A flow this install cannot run is shown, selectable and explained —
        // never hidden — and "İleri" stops until the gap is resolved.
        const blocked = flowUnavailableReason(flow, data.scmConnectionCount);
        return (
          <ChoiceCard
            key={flow}
            name="setup-flow"
            value={flow}
            checked={draft.flowType === flow}
            onPick={() => onChange({ flowType: flow as FlowType })}
            label={t(`setup.flow.name.${flow}`)}
            desc={t(`setup.flow.desc.${flow}`)}
            meta={t(`setup.flow.meta.${flow}`)}
            blocked={blocked === null ? null : t(blocked)}
          />
        );
      })}
    </div>
  );
}

/**
 * Step 2 — the Jira project, the data class, and the repository the work lands
 * in. The repository is REQUIRED for the two code-writing flows and an offer
 * for `analiz`, where it sits behind a collapsed disclosure.
 */
export function ProjectPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const repoRequired = flowNeedsRepository(draft.flowType);
  // The optional disclosure opens itself when the operator already started a
  // pick (a repo chosen under another flow must not vanish behind a closed
  // summary), and otherwise remembers what the operator did with it.
  const [repoOpen, setRepoOpen] = useState(draft.connectionId !== "");

  // Each live list has four faces to tell apart: nothing picked yet, loading,
  // a provider error, an empty result. One "seçiniz" for all four is how
  // "hiçbir şey çıkmıyor" tickets happen.
  const projectPlaceholder =
    draft.jiraConnectionId === ""
      ? t("setup.project.pick_jira_conn_first")
      : data.jiraProjectsLoading
        ? t("setup.common.loading")
        : (data.jiraProjectsError ??
          (data.jiraProjects.length === 0 ? t("setup.project.no_projects") : t("setup.common.choose")));
  const repoPlaceholder =
    draft.connectionId === ""
      ? t("setup.project.pick_scm_conn_first")
      : data.scmReposLoading
        ? t("setup.common.loading")
        : (data.scmReposError ??
          (data.scmRepos.length === 0 ? t("setup.project.no_repos") : t("setup.common.choose")));

  const repoFields = (
    <>
      <div className="scr-grid scr-grid--2">
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
        <Select
          label={t("setup.project.scm_repo")}
          value={draft.repoFullName}
          onChange={(e) => onChange({ repoFullName: e.target.value })}
          disabled={draft.connectionId === "" || data.scmReposLoading || data.scmRepos.length === 0}
          options={[
            { value: "", label: repoPlaceholder },
            ...data.scmRepos.map((r) => ({ value: r, label: r })),
          ]}
        />
      </div>
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
    </>
  );

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

      {repoRequired ? (
        <>
          <h4 className="scr-h">{t("setup.project.repo_heading")}</h4>
          {repoFields}
        </>
      ) : (
        <details className="scr-adv scr-mt-3" open={repoOpen} onToggle={(e) => setRepoOpen(e.currentTarget.open)}>
          <summary className="scr-adv__summary">{t("setup.project.repo_optional_summary")}</summary>
          <div className="scr-adv__body">
            <p className="scr-hint">{t("setup.project.repo_optional_analiz")}</p>
            <div className="scr-mt-2">{repoFields}</div>
          </div>
        </details>
      )}
    </>
  );
}

/**
 * Step 3 — which tickets Maestro picks up: the trigger, the status gate, the
 * bot account, and (collapsed) the approval gates.
 */
export function TicketsPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  // "Bota atanan her ticket" has no second question, so the value field is GONE
  // rather than greyed out: an absent field reads as an answered question.
  const anyAssigned = draft.matchKind === "assigned";
  const toggleAllowed = (name: string): void =>
    onChange({
      allowedStatuses: draft.allowedStatuses.includes(name)
        ? draft.allowedStatuses.filter((s) => s !== name)
        : [...draft.allowedStatuses, name],
    });
  // A STATUS trigger is itself a status the ticket must be in, so it joins the
  // gate on its own — an operator who picked "Analiz Bekliyor" as the trigger
  // must not also have to tick it below to make the rule fire.
  const setMatchValue = (value: string): void =>
    onChange({
      matchValue: value,
      ...(draft.matchKind === "status" && value !== "" && !draft.allowedStatuses.includes(value)
        ? { allowedStatuses: [...draft.allowedStatuses, value] }
        : {}),
    });
  const english = englishAside(draft.matchValue);

  return (
    <>
      <div className="scr-grid scr-grid--2">
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
            // The option's VALUE is the name Jira serves and the rule stores;
            // only its LABEL carries the English aside.
            onChange={(e) => setMatchValue(e.target.value)}
            options={[
              { value: "", label: t("setup.common.choose") },
              ...data.matchValues.map((v) => ({ value: v, label: matchValueLabel(v) })),
            ]}
            hint={data.matchValuesNote ?? t("setup.tickets.match_value_hint_live")}
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

      <div className="scr-mt-2">
        <Input
          label={t("setup.tickets.assignee")}
          value={draft.assigneeAccountId}
          onChange={(e) => onChange({ assigneeAccountId: e.target.value })}
          placeholder="712020:…"
          hint={data.botKnown ? t("setup.tickets.assignee_hint_auto") : t("setup.tickets.assignee_hint")}
        />
      </div>

      {/* Approval gates — the same choice the listening screen offers, and for
          the same reason it is HERE too: an operator who only ever walks the
          wizard never learns the choice exists. Collapsed, because the default
          ("risk seviyesine göre") is right for a first setup. */}
      <details className="scr-adv scr-mt-3" open={draft.gatesCustom || undefined}>
        <summary className="scr-adv__summary">
          {t("setup.tickets.gates_summary", {
            mode: draft.gatesCustom ? t("listening.gates.custom") : t("listening.gates.default"),
          })}
        </summary>
        <div className="scr-adv__body">
          <p className="scr-hint">{t("listening.gates.explain")}</p>
          {/* Two radios, not a checkbox: "seçim yok" and "hiç kapı istemiyorum"
              are different answers, and one box cannot carry both. */}
          <div className="scr-checklist scr-mt-2">
            <label className="scr-check">
              <input
                type="radio"
                name="setup-gates-mode"
                checked={!draft.gatesCustom}
                onChange={() => onChange({ gatesCustom: false })}
              />
              {t("listening.gates.default")}
            </label>
            <label className="scr-check">
              <input
                type="radio"
                name="setup-gates-mode"
                checked={draft.gatesCustom}
                onChange={() => onChange({ gatesCustom: true })}
              />
              {t("listening.gates.custom")}
            </label>
          </div>
          {draft.gatesCustom && (
            <div className="scr-checklist scr-mt-2 setup-indent">
              {SELECTABLE_GATES.map((gate) => {
                // The analysis flow never reaches the engineering gates; a ticked
                // one is SAID to be dead rather than hidden.
                const dead = draft.flowType === "analiz" && gate.step !== "4" && gate.step !== "5";
                const checked = draft.gateSteps.includes(gate.step);
                return (
                  <div key={gate.step}>
                    <label className={"scr-check" + (dead ? " scr-muted" : "")}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          onChange({
                            gateSteps: checked
                              ? draft.gateSteps.filter((step) => step !== gate.step)
                              : [...draft.gateSteps, gate.step],
                          })
                        }
                      />
                      {t(gate.titleKey)}
                    </label>
                    <p className="scr-hint setup-indent">
                      {t(`${gate.titleKey}.hint`)}
                      {dead && checked && ` ${t("listening.gates.engineering_only")}`}
                    </p>
                  </div>
                );
              })}
              {draft.gateSteps.length === 0 && <p className="scr-hint">{t("listening.gates.none_selected")}</p>}
            </div>
          )}
        </div>
      </details>
      <p className="scr-hint">{t("setup.tickets.note")}</p>
    </>
  );
}

/**
 * Step 4 — the Jira status map, OFF by default, and the gate MIRROR under it.
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

  return (
    <>
      <p className="scr-prose">{t("setup.status.intro")}</p>
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
        </>
      )}

      {/* The gate, read back from the wire. Not an input: the five fields
          above draw the line, this says what moving the ticket along it will
          mean — and says "nothing" out loud when that is the answer. */}
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
          <div className="scr-note scr-note--warn scr-mt-2">
            {t(draft.statusOn ? "listening.gate_status.empty_warning" : "setup.gate_status.off_warning")}
          </div>
        )}
        <p className="scr-hint">{t("listening.gate_status.approval_note")}</p>
      </div>
    </>
  );
}

/**
 * Step 5 — "Onaylar Maestro'ya nasıl ulaşsın?": the platform-wide command
 * intake, asked as ONE question with three answers because webhook and polling
 * are alternatives, not a checklist.
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
