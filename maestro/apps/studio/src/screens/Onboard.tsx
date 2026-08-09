import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, Card, useToast } from "../ui/index.ts";
import { type DryRunResult, type OnboardingOptions, QueryState } from "./common/index.ts";
import { DryRunPanel } from "./onboard/DryRunPanel.tsx";
import { type OnboardingDraft, OnboardingSteps } from "./onboard/OnboardingSteps.tsx";

const STEP_KEYS = [
  "onboard.step.jira",
  "onboard.step.repo",
  "onboard.step.yaml",
  "onboard.step.gates",
] as const;

const EMPTY_DRAFT: OnboardingDraft = {
  jiraProject: "",
  adoRepo: "",
  platform: "",
  triggerMode: "opt_in",
  gateSet: "risk_tiered",
  mergeMode: "human",
};

/**
 * Self-service onboarding (M93): connecting a new application to the platform.
 *
 * The wizard produces a PROPOSAL, not a live configuration. Its last step sends
 * a package — routing rule, a `.maestro.yaml` pull request, a draft pipeline —
 * for an admin to approve, because binding a Jira project to a repository
 * decides where an agent will be allowed to push code.
 *
 * The dry run (M102) is a precondition, not a preview. Until the operator has
 * seen where the last N tickets WOULD have landed under these rules, the submit
 * button stays disabled: a routing rule that silently sends the wrong project's
 * tickets into a payment repository is exactly the mistake this step exists to
 * catch (M14/M99).
 */
export function OnboardScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();

  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);

  const options = useQuery({
    queryKey: ["onboarding-options"],
    queryFn: ({ signal }) => api.get<OnboardingOptions>("/onboarding/options", { signal }),
  });

  const runDryRun = useMutation({
    mutationFn: (input: OnboardingDraft) =>
      api.post<DryRunResult>("/onboarding/dry-run", {
        jiraProject: input.jiraProject,
        adoRepo: input.adoRepo,
      }),
    onSuccess: (result) => setDryRun(result),
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = useMutation({
    mutationFn: (input: OnboardingDraft) => api.post<{ proposalId: string }>("/onboarding", input),
    onSuccess: () => {
      setStep(1);
      setDraft(EMPTY_DRAFT);
      setDryRun(null);
      toast.show("success", t("onboard.toast.submitted"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // A new draft invalidates the evidence: the dry run answered a question about
  // the OLD rules, and showing it beside changed ones would authorise a
  // configuration nobody actually previewed.
  const update = (patch: Partial<OnboardingDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setDryRun(null);
  };

  const complete =
    draft.jiraProject !== "" && draft.adoRepo !== "" && draft.platform !== "";
  const maySubmit = complete && dryRun !== null;

  return (
    <div className="scr-stack">
      <ol className="scr-wiz">
        {STEP_KEYS.map((key, index) => (
          <li
            key={key}
            className={`scr-wiz__step${
              step === index + 1 ? " scr-wiz__step--on" : step > index + 1 ? " scr-wiz__step--done" : ""
            }`}
          >
            {t(key)}
          </li>
        ))}
      </ol>

      <QueryState
        isPending={options.isPending}
        error={options.error}
        onRetry={() => void options.refetch()}
      >
        {options.data !== undefined && (
          <OnboardingSteps
            step={step}
            draft={draft}
            options={options.data}
            onChange={update}
          />
        )}
      </QueryState>

      {step === 1 && (
        <DryRunPanel
          result={dryRun}
          busy={runDryRun.isPending}
          ready={draft.jiraProject !== "" && draft.adoRepo !== ""}
          onRun={() => runDryRun.mutate(draft)}
        />
      )}

      <Card title={t("onboard.card.actions")}>
        <div className="scr-row">
          {step > 1 && <Button onClick={() => setStep(step - 1)}>{t("onboard.action.back")}</Button>}
          {step < STEP_KEYS.length && (
            <Button variant="primary" onClick={() => setStep(step + 1)}>
              {t("onboard.action.next")}
            </Button>
          )}
          {step === STEP_KEYS.length && (
            <Button
              variant="success"
              busy={submit.isPending}
              disabled={!maySubmit}
              onClick={() => submit.mutate(draft)}
            >
              {t("onboard.action.submit")}
            </Button>
          )}
        </div>
        {step === STEP_KEYS.length && !maySubmit && (
          <div className="scr-note scr-note--warn" style={{ marginTop: 11 }}>
            {complete ? t("onboard.blocked.dry_run") : t("onboard.blocked.incomplete")}
          </div>
        )}
        <div className="scr-note" style={{ marginTop: 11 }}>
          {t("onboard.note.admin_approval")}
        </div>
      </Card>
    </div>
  );
}
