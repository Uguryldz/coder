import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { issueDetailsOf, messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, ButtonLink, Card, useToast } from "../ui/index.ts";
import {
  type DryRunResult,
  type JiraConnection,
  type JiraProjectsResult,
  type OnboardingOptions,
  type ScmConnection,
  type ScmReposResult,
} from "./common/index.ts";
import { DryRunPanel } from "./onboard/DryRunPanel.tsx";
import { type OnboardingDraft, OnboardingSteps } from "./onboard/OnboardingSteps.tsx";
import { QueryState } from "./shared/QueryState.tsx";

/** Mirrors the BFF's `ONBOARDING_ROLES`: every `/onboarding/*` read and write. */
const ONBOARDING_ROLES = ["admin", "tech-lead"] as const;

const EMPTY_DRAFT: OnboardingDraft = {
  jiraConnectionId: "",
  jiraProject: "",
  connectionId: "",
  repoFullName: "",
  platform: "",
  /**
   * NOT A SETTING — a constant the wire still requires (0023). A trigger is
   * defined only on a listening rule; `DraftBody` still marks `triggerMode`
   * required and `JiraProjectBinding.trigger` is NOT NULL. Nothing branches on
   * the value. Do not surface it, and do not read it back.
   */
  triggerMode: "opt_in",
  gateSet: "risk_tiered",
  mergeMode: "human",
  // The safe-but-WORKABLE class: `gizli` is what the server assumes when the
  // field is absent, and on an install with no on-prem model that silently
  // disables analysis (SAM1-12). `acik` is never a default.
  dataClass: "dahili",
};

/**
 * Self-service onboarding (M93), the EXPERT form: connecting a new application
 * to the platform in the platform's own vocabulary. The guided path is the
 * wizard (`/setup`), which also writes the first listening rule; this form
 * stays for an operator who knows exactly which binding they want.
 *
 * The form produces a PROPOSAL, not a live configuration: binding a Jira
 * project to a repository decides where an agent will be allowed to push
 * code, so a second admin approves it. The dry run (M102) is a precondition —
 * until the operator has seen where the last N tickets WOULD have landed, the
 * submit button stays disabled.
 */

/**
 * Does this draft name a COMPLETE repository half? All three or none:
 * `DraftBody` refuses `adoRepo` without `platform` (and the reverse). An
 * analysis-only draft answers false and sends no repo at all.
 */
function repoComplete(draft: OnboardingDraft): boolean {
  return draft.repoFullName !== "" && draft.connectionId !== "" && draft.platform !== "";
}

export function OnboardScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const allowed = hasAnyRole(session, ONBOARDING_ROLES);

  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  // The field-level violations of a refused submit, kept beside the button.
  const [submitIssues, setSubmitIssues] = useState<readonly string[]>([]);

  const options = useQuery({
    queryKey: ["onboarding-options"],
    queryFn: ({ signal }) => api.get<OnboardingOptions>("/onboarding/options", { signal }),
    enabled: allowed,
  });
  const jiraConnections = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly JiraConnection[] }>("/onboarding/jira-connections", { signal }),
    enabled: allowed,
  });
  const jiraProjects = useQuery({
    queryKey: ["onboarding-jira-projects", draft.jiraConnectionId],
    enabled: allowed && draft.jiraConnectionId !== "",
    queryFn: ({ signal }) =>
      api.get<JiraProjectsResult>(
        `/onboarding/jira-projects?connectionId=${encodeURIComponent(draft.jiraConnectionId)}`,
        { signal },
      ),
  });
  const scmConnections = useQuery({
    queryKey: ["onboarding-scm-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ScmConnection[] }>("/onboarding/scm-connections", { signal }),
    enabled: allowed,
  });
  const scmRepos = useQuery({
    queryKey: ["onboarding-scm-repos", draft.connectionId],
    enabled: allowed && draft.connectionId !== "",
    queryFn: ({ signal }) =>
      api.get<ScmReposResult>(`/onboarding/scm-repos?connectionId=${encodeURIComponent(draft.connectionId)}`, {
        signal,
      }),
  });

  const runDryRun = useMutation({
    mutationFn: (input: OnboardingDraft) =>
      api.post<DryRunResult>("/onboarding/dry-run", {
        jiraProject: input.jiraProject,
        // The rehearsal is about the project; an empty repo is refused by the schema.
        ...(input.repoFullName === "" ? {} : { adoRepo: input.repoFullName }),
      }),
    onSuccess: (result) => setDryRun(result),
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = useMutation({
    mutationFn: (input: OnboardingDraft) =>
      api.post<{ proposalId: string }>("/onboarding", {
        jiraProject: input.jiraProject,
        // Sent together or not at all — `DraftBody` refuses one without the other.
        ...(repoComplete(input) ? { adoRepo: input.repoFullName, platform: input.platform } : {}),
        triggerMode: input.triggerMode,
        gateSet: input.gateSet,
        mergeMode: input.mergeMode,
        // The operator's ANSWER. Absent, the BFF writes `gizli` — the known
        // production failure this field closes.
        dataClass: input.dataClass,
      }),
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setDryRun(null);
      setSubmitIssues([]);
      // The approver's queue and the bound list read from these; a proposal
      // that does not show up there looks like a failed submit.
      void queryClient.invalidateQueries({ queryKey: ["onboarding-pending"] });
      void queryClient.invalidateQueries({ queryKey: ["routing"] });
      toast.show("success", t("onboard.toast.submitted"));
      void navigate("/projects?tab=routing");
    },
    onError: (error) => {
      setSubmitIssues(issueDetailsOf(error));
      toast.show("error", t(messageKeyOf(error)));
    },
  });

  // A new draft invalidates the evidence: the dry run answered a question
  // about the OLD rules.
  const update = (patch: Partial<OnboardingDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setDryRun(null);
    setSubmitIssues([]);
  };

  if (!allowed) {
    return (
      <Card title={t("onboard.intro.title")}>
        <p className="scr-prose">{t("projects.roles.body")}</p>
      </Card>
    );
  }

  const reposBody = scmRepos.data;
  const scm = {
    connections: scmConnections.data?.connections ?? [],
    repos: reposBody?.ok === true ? reposBody.repos : [],
    reposLoading: draft.connectionId !== "" && scmRepos.isFetching,
    reposError:
      reposBody !== undefined && reposBody.ok === false
        ? t(reposBody.messageKey, reposBody.messageParams ?? {})
        : scmRepos.isError
          ? t(messageKeyOf(scmRepos.error))
          : null,
  };
  const projectsBody = jiraProjects.data;
  const jira = {
    connections: jiraConnections.data?.connections ?? [],
    projects: projectsBody?.ok === true ? projectsBody.projects : [],
    projectsLoading: draft.jiraConnectionId !== "" && jiraProjects.isFetching,
    projectsError:
      projectsBody !== undefined && projectsBody.ok === false
        ? t(projectsBody.messageKey, projectsBody.messageParams ?? {})
        : jiraProjects.isError
          ? t(messageKeyOf(jiraProjects.error))
          : null,
  };

  // A repository is an ENRICHMENT, not a gate: an analysis-only install owns
  // none. The pair is still all-or-nothing, because the wire contract is.
  const repoHalf = draft.repoFullName !== "" || draft.connectionId !== "" || draft.platform !== "";
  const complete = draft.jiraProject !== "" && (!repoHalf || repoComplete(draft));
  const maySubmit = complete && dryRun !== null;
  // The connection lists could not be read at all — said, not left as an empty select.
  const listFailure = jiraConnections.isError
    ? jiraConnections.error
    : scmConnections.isError
      ? scmConnections.error
      : null;

  return (
    <div className="scr-stack">
      {/* The guided path first: the wizard asks the same questions in outcome
          language and writes the first listening rule too. */}
      <Card
        title={t("onboard.intro.title")}
        subtitle={t("onboard.intro.sub")}
        actions={
          <ButtonLink size="sm" variant="primary" to="/setup">
            {t("onboard.intro.wizard")}
          </ButtonLink>
        }
      >
        <p className="scr-prose">{t("onboard.intro.short")}</p>
        {listFailure !== null && (
          <div className="scr-note scr-note--danger">
            {t(messageKeyOf(listFailure))}{" "}
            <Button
              size="sm"
              onClick={() => {
                void jiraConnections.refetch();
                void scmConnections.refetch();
              }}
            >
              {t("action.retry")}
            </Button>
          </div>
        )}
      </Card>

      <QueryState isPending={options.isPending} error={options.error} onRetry={() => void options.refetch()}>
        {options.data !== undefined && (
          <OnboardingSteps draft={draft} options={options.data} scm={scm} jira={jira} onChange={update} />
        )}
      </QueryState>

      {/* Dry run + submit sit together at the bottom: run the mandatory check, then send. */}
      <DryRunPanel
        result={dryRun}
        busy={runDryRun.isPending}
        // The rehearsal replays a PROJECT's tickets; it never touches a repository.
        ready={draft.jiraProject !== ""}
        onRun={() => runDryRun.mutate(draft)}
      />

      <Card title={t("onboard.card.actions")}>
        <Button variant="success" busy={submit.isPending} disabled={!maySubmit} onClick={() => submit.mutate(draft)}>
          {t("onboard.action.submit")}
        </Button>
        {submitIssues.length > 0 && (
          <div className="scr-note scr-note--danger scr-mt-2">
            {t("onboard.error.refused_fields")}
            <ul className="scr-list">
              {submitIssues.map((issue) => (
                <li key={issue} className="scr-mono">
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!maySubmit && (
          <div className="scr-note scr-note--warn scr-mt-2">
            {complete ? t("onboard.blocked.dry_run") : t("onboard.blocked.incomplete")}
          </div>
        )}
        <p className="scr-hint">{t("onboard.note.admin_approval")}</p>
      </Card>
    </div>
  );
}
