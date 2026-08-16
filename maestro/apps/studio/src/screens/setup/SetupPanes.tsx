import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, Input, Select } from "../../ui/index.ts";
import { STATUS_POINTS, type StatusPoint } from "../common/status-map.ts";
import { FLOW_TYPES, type FlowType, type MatchKind, type SetupDraft } from "./model.ts";

/**
 * The wizard's panes. Presentational on purpose: every one of them takes the
 * single draft plus an `onChange`, so navigating between steps is a state
 * change in the container and never an unmount that could drop what was typed.
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
  readonly scmRepos: readonly string[];
  readonly scmReposLoading: boolean;
  readonly scmReposError: string | null;
  readonly platforms: readonly string[];
  /** Live Jira values for the chosen project + match kind; empty → free text. */
  readonly matchValues: readonly string[];
  /**
   * Set when `matchValues` came from the FALLBACK source, whose issue-type
   * names can be a different localisation from the ones on the tickets. The
   * dropdown still shows — a list beats a blank box — but it says so.
   */
  readonly matchValuesNote: string | null;
  /** Live Jira STATUS names, for the status map; empty → free text. */
  readonly statusNames: readonly string[];
  /** True once a connection has reported a bot account id (step 3's pre-fill). */
  readonly botKnown: boolean;
}

export interface PaneProps {
  readonly draft: SetupDraft;
  readonly data: PaneData;
  readonly onChange: (patch: Partial<SetupDraft>) => void;
}

/**
 * Step 1 — "Ne yapmak istiyorsun?".
 *
 * A radio list, not a dropdown. The three flows differ in what Maestro is
 * ALLOWED to do (write code or not, merge or not), and a collapsed select shows
 * one option at a time — an operator would pick the first one without ever
 * reading that the other two open pull requests. Each option carries its
 * outcome sentence beside the label so the difference is visible before the
 * click, not after.
 */
export function FlowPane({ draft, onChange }: PaneProps): ReactNode {
  const t = useT();
  return (
    <Card title={t("setup.flow.title")} subtitle={t("setup.flow.sub")}>
      <p className="scr-prose">{t("setup.flow.intro")}</p>
      <div className="setup-choices" role="radiogroup" aria-label={t("setup.flow.title")}>
        {FLOW_TYPES.map((flow) => (
          <label
            key={flow}
            className={
              "setup-choice" + (draft.flowType === flow ? " setup-choice--on" : "")
            }
          >
            <input
              type="radio"
              name="setup-flow"
              value={flow}
              checked={draft.flowType === flow}
              onChange={() => onChange({ flowType: flow as FlowType })}
            />
            <span className="setup-choice__body">
              <span className="setup-choice__label">{t(`setup.flow.name.${flow}`)}</span>
              <span className="setup-choice__desc">{t(`setup.flow.desc.${flow}`)}</span>
              {/* What the choice COSTS, spelled out: which gates run, whether a
                  repository is touched. An operator picking "geliştirme" should
                  learn here that it opens pull requests, not from the summary. */}
              <span className="setup-choice__meta">{t(`setup.flow.meta.${flow}`)}</span>
            </span>
          </label>
        ))}
      </div>
    </Card>
  );
}

/**
 * Step 2 — the Jira project and the repository the work lands in.
 *
 * Same four selects as the expert onboarding form, fed by the same endpoints,
 * but WITHOUT the trigger/gate/merge trio: those three are derived from step 1
 * and shown back as sentences on the summary. Asking a first-time operator to
 * choose a gate set is the thing this wizard exists not to do.
 */
export function ProjectPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();

  // The two live lists each have four faces an operator has to tell apart: no
  // connection picked yet, loading, a provider error, and an empty result. A
  // single "seçiniz" for all four is how "hiçbir şey çıkmıyor" tickets happen.
  const projectPlaceholder =
    draft.jiraConnectionId === ""
      ? t("setup.project.pick_jira_conn_first")
      : data.jiraProjectsLoading
        ? t("setup.common.loading")
        : data.jiraProjectsError !== null
          ? data.jiraProjectsError
          : data.jiraProjects.length === 0
            ? t("setup.project.no_projects")
            : t("setup.common.choose");

  const repoPlaceholder =
    draft.connectionId === ""
      ? t("setup.project.pick_scm_conn_first")
      : data.scmReposLoading
        ? t("setup.common.loading")
        : data.scmReposError !== null
          ? data.scmReposError
          : data.scmRepos.length === 0
            ? t("setup.project.no_repos")
            : t("setup.common.choose");

  return (
    <Card title={t("setup.project.title")} subtitle={t("setup.project.sub")}>
      <p className="scr-prose">{t("setup.project.intro")}</p>
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
          onChange={(e) => onChange({ jiraProject: e.target.value, matchValue: "" })}
          disabled={
            draft.jiraConnectionId === "" ||
            data.jiraProjectsLoading ||
            data.jiraProjects.length === 0
          }
          options={[
            { value: "", label: projectPlaceholder },
            ...data.jiraProjects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
          hint={t("setup.project.jira_project_hint")}
        />
      </div>
      <div className="scr-grid scr-grid--2" style={{ marginTop: 12 }}>
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
          disabled={
            draft.connectionId === "" || data.scmReposLoading || data.scmRepos.length === 0
          }
          options={[
            { value: "", label: repoPlaceholder },
            ...data.scmRepos.map((r) => ({ value: r, label: r })),
          ]}
        />
      </div>
      <div className="scr-grid scr-grid--2" style={{ marginTop: 12 }}>
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
      <div className="scr-note" style={{ marginTop: 12 }}>
        {t("setup.project.four_eyes_note")}
      </div>
    </Card>
  );
}

/**
 * Step 3 — which tickets Maestro picks up.
 *
 * Two questions: whose queue (the bot account) and which tickets in it. The
 * value list is read LIVE off the project so "Hata" is picked rather than
 * spelled; when Jira cannot be read the field falls back to free text rather
 * than to an empty dropdown that would make the step impossible to finish.
 */
export function TicketsPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  return (
    <Card title={t("setup.tickets.title")} subtitle={t("setup.tickets.sub")}>
      <p className="scr-prose">{t("setup.tickets.intro")}</p>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("setup.tickets.match_kind")}
          value={draft.matchKind}
          onChange={(e) =>
            // Switching the question invalidates the answer: an issue-type name
            // is not a status name, and keeping it would silently save a rule
            // that can never match a ticket.
            onChange({ matchKind: e.target.value as MatchKind, matchValue: "" })
          }
          options={[
            { value: "issuetype", label: t("setup.tickets.kind.issuetype") },
            { value: "status", label: t("setup.tickets.kind.status") },
          ]}
          hint={t(`setup.tickets.kind_hint.${draft.matchKind}`)}
        />
        {data.matchValues.length > 0 ? (
          <Select
            label={t("setup.tickets.match_value")}
            value={draft.matchValue}
            onChange={(e) => onChange({ matchValue: e.target.value })}
            options={[
              { value: "", label: t("setup.common.choose") },
              ...data.matchValues.map((v) => ({ value: v, label: v })),
            ]}
            hint={data.matchValuesNote ?? t("setup.tickets.match_value_hint_live")}
          />
        ) : (
          <Input
            label={t("setup.tickets.match_value")}
            value={draft.matchValue}
            onChange={(e) => onChange({ matchValue: e.target.value })}
            hint={t("setup.tickets.match_value_hint_manual")}
          />
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <Input
          label={t("setup.tickets.assignee")}
          value={draft.assigneeAccountId}
          onChange={(e) => onChange({ assigneeAccountId: e.target.value })}
          placeholder="712020:…"
          hint={
            data.botKnown ? t("setup.tickets.assignee_hint_auto") : t("setup.tickets.assignee_hint")
          }
        />
      </div>
      <div className="scr-note" style={{ marginTop: 12 }}>
        {t("setup.tickets.note")}
      </div>
    </Card>
  );
}

/**
 * Step 4 — the Jira status map, OFF by default.
 *
 * The one step that is genuinely optional, and it says so in its own heading.
 * Off means comment-only, which is what every rule in the platform does today;
 * a wizard that started moving a bank's tickets because the operator clicked
 * "İleri" five times would be a defect, not a convenience.
 */
export function StatusPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const setPoint = (point: StatusPoint, value: string): void =>
    onChange({ statusDraft: { ...draft.statusDraft, [point]: value } });

  return (
    <Card title={t("setup.status.title")} subtitle={t("setup.status.sub")}>
      <p className="scr-prose">{t("setup.status.intro")}</p>
      <label className="scr-check" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          checked={draft.statusOn}
          // Turning it off never rewrites the draft — an operator who unticks it
          // to re-read the explanation and ticks it again gets their five values
          // back. Only what the summary builds depends on the flag.
          onChange={(e) => onChange({ statusOn: e.target.checked })}
        />
        {t("setup.status.enable")}
      </label>

      {draft.statusOn && (
        <>
          <p className="scr-note" style={{ marginTop: 12 }}>
            {t("setup.status.exact")}
          </p>
          <div className="scr-grid scr-grid--2" style={{ marginTop: 8 }}>
            {STATUS_POINTS.map((point) =>
              data.statusNames.length > 0 ? (
                <Select
                  key={point}
                  label={t(`setup.status.point.${point}`)}
                  value={draft.statusDraft[point]}
                  onChange={(e) => setPoint(point, e.target.value)}
                  options={[
                    { value: "", label: t("setup.status.skip") },
                    ...data.statusNames.map((v) => ({ value: v, label: v })),
                  ]}
                  hint={t(`setup.status.hint.${point}`)}
                />
              ) : (
                // Jira's status list could not be read. Free text rather than an
                // empty dropdown, so the step can still be completed — the
                // "birebir aynı yazın" warning above is what carries the risk.
                <Input
                  key={point}
                  label={t(`setup.status.point.${point}`)}
                  value={draft.statusDraft[point]}
                  onChange={(e) => setPoint(point, e.target.value)}
                  hint={t(`setup.status.hint.${point}`)}
                />
              ),
            )}
          </div>
          <label className="scr-check" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={draft.reassignOnNeedInfo}
              onChange={(e) => onChange({ reassignOnNeedInfo: e.target.checked })}
            />
            {t("setup.status.reassign")}
          </label>
          <p className="scr-note" style={{ marginTop: 6 }}>
            {t("setup.status.reassign_hint")}
          </p>
        </>
      )}
    </Card>
  );
}
