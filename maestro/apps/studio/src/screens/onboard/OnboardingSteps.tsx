import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, Select } from "../../ui/index.ts";
import type { OnboardingOptions } from "../common/index.ts";

export interface OnboardingDraft {
  readonly jiraProject: string;
  readonly adoRepo: string;
  readonly platform: string;
  readonly triggerMode: "opt_in" | "automatic";
  readonly gateSet: "risk_tiered" | "always_six";
  readonly mergeMode: "human" | "auto";
}

export interface OnboardingStepsProps {
  readonly step: number;
  readonly draft: OnboardingDraft;
  readonly options: OnboardingOptions;
  readonly onChange: (patch: Partial<OnboardingDraft>) => void;
}

/**
 * The four wizard panes. Every choice is a Select over a server-supplied or
 * closed list — never a free-text field. A mistyped repository name here would
 * either fail late or, worse, match a different repository, and a project's
 * ticket routing is not something to spell by hand.
 *
 * The defaults are the safe ones: opt-in triggering (a project does not start
 * receiving agents because somebody connected it), risk-tiered gates, and
 * human merge.
 */
export function OnboardingSteps({
  step,
  draft,
  options,
  onChange,
}: OnboardingStepsProps): ReactNode {
  const t = useT();

  if (step === 1) {
    return (
      <Card title={t("onboard.card.jira")} subtitle={t("onboard.card.jira_sub")}>
        <div className="scr-grid scr-grid--2">
          <Select
            label={t("onboard.field.jira_project")}
            value={draft.jiraProject}
            onChange={(event) => onChange({ jiraProject: event.target.value })}
            options={withPlaceholder(options.jiraProjects, t("onboard.field.choose"))}
          />
          <Select
            label={t("onboard.field.ado_repo")}
            value={draft.adoRepo}
            onChange={(event) => onChange({ adoRepo: event.target.value })}
            options={withPlaceholder(options.adoRepos, t("onboard.field.choose"))}
          />
        </div>
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("onboard.note.no_silent_routing")}
        </div>
      </Card>
    );
  }

  if (step === 2) {
    return (
      <Card title={t("onboard.card.repo")} subtitle={t("onboard.card.repo_sub")}>
        <Select
          label={t("onboard.field.platform")}
          value={draft.platform}
          onChange={(event) => onChange({ platform: event.target.value })}
          options={withPlaceholder(options.platforms, t("onboard.field.choose"))}
        />
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("onboard.note.branch_policy")}
        </div>
      </Card>
    );
  }

  if (step === 3) {
    return (
      <Card title={t("onboard.card.yaml")} subtitle={t("onboard.card.yaml_sub")}>
        <p className="scr-prose">{t("onboard.yaml.explain")}</p>
        <div className="scr-note">{t("onboard.yaml.policies_elsewhere")}</div>
      </Card>
    );
  }

  return (
    <Card title={t("onboard.card.gates")} subtitle={t("onboard.card.gates_sub")}>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("onboard.field.trigger_mode")}
          value={draft.triggerMode}
          onChange={(event) =>
            onChange({ triggerMode: event.target.value as OnboardingDraft["triggerMode"] })
          }
          options={[
            { value: "opt_in", label: t("onboard.trigger.opt_in") },
            { value: "automatic", label: t("onboard.trigger.automatic") },
          ]}
          hint={t("onboard.field.trigger_hint")}
        />
        <Select
          label={t("onboard.field.gate_set")}
          value={draft.gateSet}
          onChange={(event) =>
            onChange({ gateSet: event.target.value as OnboardingDraft["gateSet"] })
          }
          options={[
            { value: "risk_tiered", label: t("onboard.gate_set.risk_tiered") },
            { value: "always_six", label: t("onboard.gate_set.always_six") },
          ]}
        />
        <Select
          label={t("onboard.field.merge_mode")}
          value={draft.mergeMode}
          onChange={(event) =>
            onChange({ mergeMode: event.target.value as OnboardingDraft["mergeMode"] })
          }
          options={[
            { value: "human", label: t("onboard.merge.human") },
            { value: "auto", label: t("onboard.merge.auto") },
          ]}
          hint={t("onboard.field.merge_hint")}
        />
      </div>
    </Card>
  );
}

/**
 * An unselected Select must not silently mean "the first option". The empty
 * placeholder makes "nothing chosen" a state the submit guard can see, rather
 * than a project binding nobody picked.
 */
function withPlaceholder(
  values: readonly string[],
  placeholder: string,
): readonly { value: string; label: string }[] {
  return [{ value: "", label: placeholder }, ...values.map((value) => ({ value, label: value }))];
}
