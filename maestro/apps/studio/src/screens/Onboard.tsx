import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, ButtonLink, Card, Select, Table, useToast } from "../ui/index.ts";
import {
  type ApplicationRecord,
  type OnboardingOptions,
  type Page,
  type RoutingView,
  type ScmConnection,
  type ScmReposResult,
} from "./common/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";

/** Mirrors the BFF's `ONBOARDING_ROLES`: every `/onboarding/*` read and write. */
const ONBOARDING_ROLES = ["admin", "tech-lead"] as const;

/**
 * "Depolar" — the repositories registered under the bound projects, and a
 * form that registers one more.
 *
 * This file was the EXPERT onboarding form: Jira connection + project + SCM
 * connection + repo + platform + gate set + merge mode + data class + dry run
 * + "send for admin approval". It did the wizard's job a second time and
 * contradicted it ("depo bağlama diye bir şey olmasın"): a project binding
 * binds a JIRA PROJECT to Maestro (the wizard does that, once), a repository
 * comes from a listening rule's repo map, and the binding's settings (merge
 * mode, data class, state) are edited in the "Düzenle" panel of the bound
 * list. None of that belongs on a repository page, so none of it is here.
 *
 * What IS here: the inventory the repo map picks from. `POST /onboarding/apps
 * {jiraProject, adoRepo, platform}` files a repository under an already-bound
 * project — no proposal, no second approval: the project's approval stands,
 * the repo is inventory. The listening screen registers an unknown repo the
 * same way when a rule is saved; this tab lets an operator do it ahead of
 * time and see what is registered.
 *
 * Sources: the bound projects and their app ids come from `/routing`
 * (`projects[].apps` — the same list the bound table and the rule form's
 * app picker read, so the three never disagree); the platform of each app is
 * looked up in the registry (`/studio/apps`). Pickers: SCM connections
 * (`/onboarding/scm-connections`), the live repo list of the chosen one
 * (`/onboarding/scm-repos?connectionId=`), the platform profiles the BFF
 * offers (`/onboarding/options.platforms`). A picker with ONE choice does not
 * ask: it fills itself and hides.
 */

interface RepoDraft {
  readonly jiraProject: string;
  readonly connectionId: string;
  readonly repoFullName: string;
  readonly platform: string;
}

const EMPTY_DRAFT: RepoDraft = { jiraProject: "", connectionId: "", repoFullName: "", platform: "" };

export function ReposScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enumLabel = useEnumLabel();
  const { session } = useAuth();
  const allowed = hasAnyRole(session, ONBOARDING_ROLES);

  const [draft, setDraft] = useState<RepoDraft>(EMPTY_DRAFT);
  const update = (patch: Partial<RepoDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
    enabled: allowed,
  });
  const registry = useQuery({
    queryKey: ["studio-apps"],
    queryFn: ({ signal }) => api.get<Page<ApplicationRecord>>("/studio/apps", { signal }),
    enabled: allowed,
  });
  const options = useQuery({
    queryKey: ["onboarding-options"],
    queryFn: ({ signal }) => api.get<OnboardingOptions>("/onboarding/options", { signal }),
    enabled: allowed,
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

  // A picker with ONE choice fills itself: the question has one answer, and
  // asking it is one more click between the operator and the repo list.
  const connections = scmConnections.data?.connections ?? [];
  const soleConnection = connections.length === 1 ? connections[0] : undefined;
  useEffect(() => {
    if (soleConnection !== undefined && draft.connectionId === "") update({ connectionId: soleConnection.id });
  }, [soleConnection, draft.connectionId]);
  const platforms = options.data?.platforms ?? [];
  const solePlatform = platforms.length === 1 ? platforms[0] : undefined;
  useEffect(() => {
    if (solePlatform !== undefined && draft.platform === "") update({ platform: solePlatform });
  }, [solePlatform, draft.platform]);

  const add = useMutation({
    mutationFn: (input: RepoDraft) =>
      api.post<{ appId: string; projectKey: string }>("/onboarding/apps", {
        jiraProject: input.jiraProject,
        adoRepo: input.repoFullName,
        platform: input.platform,
      }),
    onSuccess: (result) => {
      // The project stays picked — the next repo usually goes under the same one.
      setDraft((current) => ({ ...current, repoFullName: "" }));
      // The bound list, the rule form's app picker and the registry all read
      // from these; a repo that does not show up there looks like a failed add.
      void queryClient.invalidateQueries({ queryKey: ["routing"] });
      void queryClient.invalidateQueries({ queryKey: ["studio-apps"] });
      void queryClient.invalidateQueries({ queryKey: ["onboarding-options"] });
      toast.show("success", t("onboard.repos.toast.added", { repo: result.appId, project: result.projectKey }));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  if (!allowed) {
    return (
      <Card title={t("onboard.repos.title")}>
        <p className="scr-prose">{t("projects.roles.body")}</p>
      </Card>
    );
  }

  const projects = routing.data?.projects ?? [];
  // Platform by app id, from the registry; an app `/routing` lists that the
  // registry does not know shows a blank, never a guessed profile.
  const platformOf = new Map((registry.data?.items ?? []).map((app) => [app.appId, app.platform]));
  const rows = projects.flatMap((project) =>
    project.apps.map((appId) => ({ projectKey: project.projectKey, appId, platform: platformOf.get(appId) ?? "" })),
  );

  const reposBody = scmRepos.data;
  const repos = reposBody?.ok === true ? reposBody.repos : [];
  const reposLoading = draft.connectionId !== "" && scmRepos.isFetching;
  const reposError =
    reposBody !== undefined && reposBody.ok === false
      ? t(reposBody.messageKey, reposBody.messageParams ?? {})
      : scmRepos.isError
        ? t(messageKeyOf(scmRepos.error))
        : null;
  const repoPlaceholder =
    draft.connectionId === ""
      ? t("onboard.scm.pick_connection_first")
      : reposLoading
        ? t("onboard.scm.loading")
        : (reposError ?? (repos.length === 0 ? t("onboard.scm.no_repos") : t("onboard.field.choose")));
  const complete = draft.jiraProject !== "" && draft.repoFullName !== "" && draft.platform !== "";

  return (
    <div className="scr-stack">
      {/* The registered repositories, grouped by the project they belong to. */}
      <Card
        title={t("onboard.repos.title")}
        subtitle={t("onboard.repos.sub")}
        padded={false}
        actions={
          <ButtonLink size="sm" to="/setup">
            {t("onboard.intro.wizard")}
          </ButtonLink>
        }
      >
        <QueryState
          isPending={routing.isPending}
          error={routing.error}
          isEmpty={rows.length === 0}
          emptyTitle={projects.length === 0 ? t("onboard.repos.no_projects") : t("onboard.repos.empty")}
          onRetry={() => void routing.refetch()}
        >
          <Table
            columns={[
              { key: "project", header: t("routing.col.project"), cell: (row) => <b>{row.projectKey}</b> },
              { key: "repo", header: t("onboard.repos.col.repo"), cell: (row) => <code className="scr-mono">{row.appId}</code> },
              {
                key: "platform",
                header: t("onboard.field.platform"),
                cell: (row) => (row.platform === "" ? "—" : <Badge tone="gray">{enumLabel("platform", row.platform).text}</Badge>),
              },
            ]}
            rows={rows}
            rowKey={(row) => `${row.projectKey}:${row.appId}`}
            emptyLabel={t("onboard.repos.empty")}
          />
        </QueryState>
        <p className="scr-mini routing-foot">{t("onboard.repos.note")}</p>
      </Card>

      {/* "+ Depo ekle": only under a BOUND project — binding is the wizard's. */}
      <Card title={t("onboard.repos.add.title")} subtitle={t("onboard.repos.add.sub")}>
        {scmConnections.isError && (
          <div className="scr-note scr-note--danger">
            {t(messageKeyOf(scmConnections.error))}{" "}
            <Button size="sm" onClick={() => void scmConnections.refetch()}>
              {t("action.retry")}
            </Button>
          </div>
        )}
        <div className="scr-grid scr-grid--2">
          <Select
            label={t("onboard.repos.add.project")}
            value={draft.jiraProject}
            onChange={(e) => update({ jiraProject: e.target.value })}
            placeholder={projects.length === 0 ? t("onboard.repos.no_projects") : t("onboard.jira.choose")}
            disabled={projects.length === 0}
            options={projects.map((project) => ({ value: project.projectKey, label: project.projectKey }))}
            hint={t("onboard.repos.add.project_hint")}
          />
          {soleConnection === undefined && (
            <Select
              label={t("onboard.field.scm_connection")}
              value={draft.connectionId}
              onChange={(e) => update({ connectionId: e.target.value, repoFullName: "" })}
              placeholder={t("onboard.field.choose")}
              options={connections.map((c) => ({
                value: c.id,
                label: `${c.displayName} · ${t(`onboard.scm.kind.${c.kind}`)}`,
              }))}
              hint={t("onboard.field.scm_connection_hint")}
            />
          )}
          <Select
            label={t("onboard.field.scm_repo")}
            value={draft.repoFullName}
            onChange={(e) => update({ repoFullName: e.target.value })}
            placeholder={repoPlaceholder}
            disabled={draft.connectionId === "" || reposLoading || repos.length === 0}
            options={repos.map((repo) => ({ value: repo.fullName, label: repo.fullName }))}
            {...(reposError !== null ? { error: reposError } : {})}
          />
          {solePlatform === undefined && (
            <Select
              label={t("onboard.field.platform")}
              value={draft.platform}
              onChange={(e) => update({ platform: e.target.value })}
              placeholder={platforms.length === 0 ? t("listening.repomap.platform_unavailable") : t("onboard.field.choose")}
              disabled={platforms.length === 0}
              options={platforms.map((p) => ({ value: p, label: enumLabel("platform", p).text }))}
              hint={t("onboard.field.platform_hint")}
            />
          )}
        </div>
        <div className="scr-actions">
          <Button variant="primary" busy={add.isPending} disabled={!complete} onClick={() => add.mutate(draft)}>
            {t("onboard.repos.add.submit")}
          </Button>
        </div>
        {!complete && <p className="scr-hint">{t("onboard.repos.add.incomplete")}</p>}
      </Card>
    </div>
  );
}
