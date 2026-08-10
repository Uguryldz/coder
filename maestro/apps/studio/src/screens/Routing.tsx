import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type {
  ApplicationRecord,
  DataClassPolicy,
  Page,
  ParamPutResult,
  RoutingUpdate,
  RoutingView,
} from "./common/index.ts";
import { useEnumLabel, usePhrase } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";
import { RoutingPolicyEditor } from "./routing/RoutingPolicyEditor.tsx";

/**
 * Screen: routing — Jira binding, ticket→application matching and the LLM
 * routing policy (M99/M100/M102).
 *
 * The two tables answer different questions. The bindings are rows written by
 * the onboarding flow (which project is live, how a ticket enters). The policy
 * is the GUARDED `dataclass.policy` parameter — editable here, but every save
 * takes four eyes because it decides whether a `gizli` ticket may reach a cloud
 * model. The Application Registry below is the TARGET of a match: each row is a
 * repo an agent may be told to push to, so it is shown, never implied.
 */

export function RoutingScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const enumLabel = useEnumLabel();
  const phrase = usePhrase();

  const [editing, setEditing] = useState(false);
  const [pendingBy, setPendingBy] = useState<string | null>(null);

  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });

  // The Application Registry (M100). Read here so the admin can see the targets
  // a match resolves to without opening another screen.
  const apps = useQuery({
    queryKey: ["studio-apps"],
    queryFn: ({ signal }) => api.get<Page<ApplicationRecord>>("/studio/apps", { signal }),
  });

  const canEdit = hasRole(session, "admin");

  /**
   * The current policy, taken VERBATIM from the server.
   *
   * It must never be reconstructed from the rendered `rules`: the outcome is
   * lossy (`degrade_ai_assist` and `masked_cloud` both read as `degraded`), so a
   * guessed `whenOnpremMissing` PUT back on a save that never touched the field
   * silently downgrades the stored policy — a strict `block` on the `gizli`
   * class becoming `degrade_ai_assist` — and four-eyes cannot catch it because
   * the two proposals agree with each other. The raw value round-trips exactly.
   */
  const currentPolicy: DataClassPolicy | null = routing.data?.policy ?? null;

  const save = useMutation({
    mutationFn: (policy: DataClassPolicy) =>
      api.put<ParamPutResult>("/routing", { policy } satisfies RoutingUpdate),
    onSuccess: (result) => {
      setEditing(false);
      if (result.status === "applied") {
        setPendingBy(null);
        void queryClient.invalidateQueries({ queryKey: ["routing"] });
        toast.show("success", t("routing.policy.toast.applied"));
      } else {
        setPendingBy(result.pending.proposedBy);
        toast.show("warning", t("routing.policy.toast.pending"));
      }
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  return (
    <>
      <Card title={t("routing.mechanics.title")} subtitle={t("routing.mechanics.sub")}>
        <div className="scr-grid scr-grid--2">
          <div>
            <b style={{ fontSize: 13 }}>{t("routing.mechanics.webhook")}</b>
            <p className="scr-mini">{t("routing.mechanics.webhook_body")}</p>
          </div>
          <div>
            <b style={{ fontSize: 13 }}>{t("routing.mechanics.binding")}</b>
            <p className="scr-mini">{t("routing.mechanics.binding_body")}</p>
          </div>
        </div>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("routing.projects")}
          subtitle={t("routing.projects_sub")}
          padded={false}
          actions={
            <Button size="sm" onClick={() => (window.location.hash = "#onboard")}>
              {t("routing.action.bind")}
            </Button>
          }
        >
          <MaybeUnwired
            isPending={routing.isPending}
            error={routing.error}
            isEmpty={(routing.data?.projects ?? []).length === 0}
            emptyTitle={t("routing.no_projects")}
            onRetry={() => void routing.refetch()}
          >
            <Table
              columns={[
                {
                  key: "project",
                  header: t("routing.col.project"),
                  cell: (row) => row.projectKey,
                },
                {
                  key: "trigger",
                  header: t("routing.col.trigger"),
                  cell: (row) => {
                    const label = enumLabel("routing.trigger", row.trigger);
                    return <Badge tone={label.unknown ? "gray" : "blue"}>{label.text}</Badge>;
                  },
                },
                {
                  key: "apps",
                  header: t("routing.col.apps"),
                  cell: (row) =>
                    row.apps.length === 0 ? t("routing.no_apps") : row.apps.join(", "),
                },
                {
                  key: "note",
                  header: t("routing.col.note"),
                  cell: (row) => phrase(row.noteKey, row.noteParams),
                },
              ]}
              rows={routing.data?.projects ?? []}
              rowKey={(row) => row.projectKey}
              emptyLabel={t("routing.no_projects")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("routing.policy")}
          subtitle={t("routing.policy_sub")}
          padded={false}
          actions={
            canEdit ? (
              <Button
                size="sm"
                variant="primary"
                disabled={currentPolicy === null}
                onClick={() => setEditing(true)}
              >
                {t("routing.policy.action.edit")}
              </Button>
            ) : undefined
          }
        >
          <MaybeUnwired
            isPending={routing.isPending}
            error={routing.error}
            isEmpty={(routing.data?.rules ?? []).length === 0}
            emptyTitle={t("routing.no_rules")}
          >
            <Table
              columns={[
                {
                  key: "condition",
                  header: t("routing.col.condition"),
                  cell: (row) => phrase(row.conditionKey, row.conditionParams),
                },
                {
                  key: "backend",
                  header: t("routing.col.backend"),
                  cell: (row) => <Badge tone="teal">{row.backend}</Badge>,
                },
                { key: "model", header: t("routing.col.model"), cell: (row) => <code>{row.model}</code> },
                {
                  key: "outcome",
                  header: t("routing.col.outcome"),
                  cell: (row) => (
                    <Badge tone={outcomeTone(row.outcome)}>{t(outcomeKey(row.outcome))}</Badge>
                  ),
                },
                {
                  key: "meaning",
                  header: t("routing.col.meaning"),
                  cell: (row) => t(outcomeExplanationKey(row.outcome)),
                },
              ]}
              rows={routing.data?.rules ?? []}
              rowKey={(row) => row.ruleId}
              emptyLabel={t("routing.no_rules")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("routing.registry")} subtitle={t("routing.registry_sub")} padded={false}>
          <MaybeUnwired
            isPending={apps.isPending}
            error={apps.error}
            isEmpty={(apps.data?.items ?? []).length === 0}
            emptyTitle={t("routing.registry_empty")}
            onRetry={() => void apps.refetch()}
          >
            <Table
              columns={[
                {
                  key: "app",
                  header: t("routing.registry.col.app"),
                  cell: (row) => <b>{row.displayName}</b>,
                },
                {
                  key: "repo",
                  header: t("routing.registry.col.repo"),
                  cell: (row) => (
                    <code className="scr-mono">{`${row.adoProject}/_git/${row.adoRepo}`}</code>
                  ),
                },
                {
                  key: "platform",
                  header: t("routing.registry.col.platform"),
                  cell: (row) => <Badge tone="gray">{row.platform}</Badge>,
                },
                {
                  key: "yaml",
                  header: t("routing.registry.col.yaml"),
                  cell: (row) =>
                    row.maestroYamlPresent ? (
                      <Badge tone="green">{t("routing.registry.yaml_present")}</Badge>
                    ) : (
                      <Badge tone="amber">{t("routing.registry.yaml_absent")}</Badge>
                    ),
                },
                {
                  key: "source",
                  header: t("routing.registry.col.source"),
                  cell: (row) => t(`routing.registry.source.${row.createdVia}`),
                },
              ]}
              rows={apps.data?.items ?? []}
              rowKey={(row) => row.appId}
              emptyLabel={t("routing.registry_empty")}
            />
          </MaybeUnwired>
          <p className="scr-mini" style={{ margin: "9px 14px 12px" }}>
            {t("routing.registry_note")}
          </p>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("routing.config_note")}
      </p>

      {currentPolicy !== null && (
        <RoutingPolicyEditor
          open={editing}
          current={currentPolicy}
          pendingBy={pendingBy}
          busy={save.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(policy) => save.mutate(policy)}
        />
      )}
    </>
  );
}
