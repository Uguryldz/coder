import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, Select } from "../../ui/index.ts";
import type { JiraConnection, JiraProject, OnboardingOptions, ScmConnection, ScmRepo } from "../common/index.ts";
import { DATA_CLASSES, type DataClass } from "../setup/model.ts";

export interface OnboardingDraft {
  /** The chosen Jira connection (cloud/dc) the project is listed from. */
  readonly jiraConnectionId: string;
  readonly jiraProject: string;
  /** The chosen SCM connection (github/ado) the repo is listed from. */
  readonly connectionId: string;
  /** "owner/repo" (GitHub) or "project/repo" (ADO) — the picked repository. */
  readonly repoFullName: string;
  readonly platform: string;
  readonly triggerMode: "opt_in" | "automatic";
  readonly gateSet: "risk_tiered" | "always_six";
  readonly mergeMode: "human" | "auto";
  /**
   * The binding's data class (M18). The BFF falls back to `gizli` when the
   * field is ABSENT — and `gizli` on an install with no on-prem model silently
   * stops analysis (SAM1-12). This form used to omit the field; it is now asked
   * with its consequence, exactly as the wizard asks it.
   */
  readonly dataClass: DataClass;
}

/** The live SCM state the form renders: the connections, and the repos of the chosen one. */
export interface ScmPickerState {
  readonly connections: readonly ScmConnection[];
  readonly repos: readonly ScmRepo[];
  readonly reposLoading: boolean;
  /** A localized failure line for the repo listing, or null. */
  readonly reposError: string | null;
}

/** The live Jira state the form renders: the connections, and the projects of the chosen one. */
export interface JiraPickerState {
  readonly connections: readonly JiraConnection[];
  readonly projects: readonly JiraProject[];
  readonly projectsLoading: boolean;
  /** A localized failure line for the project listing, or null. */
  readonly projectsError: string | null;
}

export interface OnboardingStepsProps {
  readonly draft: OnboardingDraft;
  readonly options: OnboardingOptions;
  readonly scm: ScmPickerState;
  readonly jira: JiraPickerState;
  readonly onChange: (patch: Partial<OnboardingDraft>) => void;
}

/**
 * The expert onboarding form — ONE page, not a stepper. Every choice is a
 * Select over a server-supplied or closed list, never free text: a mistyped
 * repository name would fail late or match the wrong repository. The defaults
 * are the safe ones: risk-tiered gates, human merge, `dahili` data.
 */
export function OnboardingSteps({ draft, options, scm, jira, onChange }: OnboardingStepsProps): ReactNode {
  const t = useT();

  // Each live Select has three faces to tell apart: no connection picked yet,
  // loading, a provider error.
  const projectLabel =
    draft.jiraConnectionId === ""
      ? t("onboard.jira.pick_connection_first")
      : jira.projectsLoading
        ? t("onboard.jira.loading")
        : (jira.projectsError ?? (jira.projects.length === 0 ? t("onboard.jira.no_projects") : t("onboard.jira.choose")));
  const repoLabel =
    draft.connectionId === ""
      ? t("onboard.scm.pick_connection_first")
      : scm.reposLoading
        ? t("onboard.scm.loading")
        : (scm.reposError ?? (scm.repos.length === 0 ? t("onboard.scm.no_repos") : t("onboard.field.choose")));

  return (
    <Card title={t("onboard.card.jira")} subtitle={t("onboard.card.jira_sub")}>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("onboard.field.jira_connection")}
          value={draft.jiraConnectionId}
          onChange={(event) => onChange({ jiraConnectionId: event.target.value, jiraProject: "" })}
          options={[
            { value: "", label: t("onboard.field.choose") },
            ...jira.connections.map((c) => ({ value: c.id, label: `${c.displayName} · ${t(`onboard.jira.kind.${c.kind}`)}` })),
          ]}
          hint={t("onboard.field.jira_connection_hint")}
        />
        <Select
          label={t("onboard.field.jira_project")}
          value={draft.jiraProject}
          onChange={(event) => onChange({ jiraProject: event.target.value })}
          disabled={draft.jiraConnectionId === "" || jira.projectsLoading || jira.projects.length === 0}
          options={[
            { value: "", label: projectLabel },
            ...jira.projects.map((p: JiraProject) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
        />
      </div>
      <div className="scr-grid scr-grid--2 scr-mt-2">
        <Select
          label={t("onboard.field.scm_connection")}
          value={draft.connectionId}
          onChange={(event) => onChange({ connectionId: event.target.value, repoFullName: "" })}
          options={[
            { value: "", label: t("onboard.field.choose") },
            ...scm.connections.map((c) => ({ value: c.id, label: `${c.displayName} · ${t(`onboard.scm.kind.${c.kind}`)}` })),
          ]}
          hint={t("onboard.field.scm_connection_hint")}
        />
        <Select
          label={t("onboard.field.scm_repo")}
          value={draft.repoFullName}
          onChange={(event) => onChange({ repoFullName: event.target.value })}
          disabled={draft.connectionId === "" || scm.reposLoading || scm.repos.length === 0}
          options={[
            { value: "", label: repoLabel },
            ...scm.repos.map((r: ScmRepo) => ({ value: r.fullName, label: r.fullName })),
          ]}
        />
      </div>
      <p className="scr-hint">{t("onboard.note.no_silent_routing")}</p>

      {/* The build profile — a readable name per profile, not the raw slug. */}
      <h4 className="onb-group">{t("onboard.card.repo")}</h4>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("onboard.field.platform")}
          value={draft.platform}
          onChange={(event) => onChange({ platform: event.target.value })}
          options={[
            { value: "", label: t("onboard.field.choose") },
            ...options.platforms.map((value) => ({ value, label: t(`platform.${value}`) })),
          ]}
          hint={t("onboard.field.platform_hint")}
        />
      </div>

      {/* Gates, merge and the data class. The trigger mode is NOT here (0023):
          a trigger is defined only on a listening rule, and the constant the
          wire still needs travels from the draft's default. */}
      <h4 className="onb-group">{t("onboard.card.gates")}</h4>
      <div className="scr-grid scr-grid--3">
        <Select
          label={t("onboard.field.gate_set")}
          value={draft.gateSet}
          onChange={(event) => onChange({ gateSet: event.target.value as OnboardingDraft["gateSet"] })}
          options={[
            { value: "risk_tiered", label: t("onboard.gate_set.risk_tiered") },
            { value: "always_six", label: t("onboard.gate_set.always_six") },
          ]}
        />
        <Select
          label={t("onboard.field.merge_mode")}
          value={draft.mergeMode}
          onChange={(event) => onChange({ mergeMode: event.target.value as OnboardingDraft["mergeMode"] })}
          options={[
            { value: "human", label: t("onboard.merge.human") },
            { value: "auto", label: t("onboard.merge.auto") },
          ]}
          hint={t("onboard.field.merge_hint")}
        />
        <Select
          label={t("setup.dataclass.heading")}
          value={draft.dataClass}
          onChange={(event) => onChange({ dataClass: event.target.value as DataClass })}
          options={DATA_CLASSES.map((cls) => ({ value: cls, label: t(`setup.dataclass.name.${cls}`) }))}
          hint={t(`setup.dataclass.meta.${draft.dataClass}`)}
        />
      </div>
      {draft.dataClass === "gizli" && (
        <div className="scr-note scr-note--warn scr-mt-2">{t("setup.dataclass.gizli_warning")}</div>
      )}

      {/* `.maestro.yaml` is the one-line fact it always was — proposed as a PR after approval. */}
      <p className="scr-hint">{t("onboard.yaml.oneliner")}</p>
    </Card>
  );
}
