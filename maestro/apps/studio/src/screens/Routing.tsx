import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import { useEnumLabel, usePhrase } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";

/**
 * Screen: routing — Jira binding, ticket→application matching and LLM routing
 * policy.
 *
 * The routing policy is configuration, not code (routing.yaml). Each rule's
 * outcome is shown with the same vocabulary as the cost and llm screens, so
 * "quota exhausted → queue" reads identically wherever it appears.
 */

interface ProjectBinding {
  readonly projectKey: string;
  /** "auto" | "label" | "command" — how a ticket enters the flow. */
  readonly trigger: string;
  readonly apps: readonly string[];
  /** Catalog key for the note, chosen by the server from the binding's state. */
  readonly noteKey?: string;
  readonly noteParams?: Readonly<Record<string, string>>;
}

interface RoutingRule {
  readonly ruleId: string;
  /** Catalog key for the condition, plus its substitutions. */
  readonly conditionKey?: string;
  readonly conditionParams?: Readonly<Record<string, string>>;
  readonly backend: string;
  readonly model: string;
  /** What happens when this rule fires: ok | queued | degraded | blocked. */
  readonly outcome: string;
}

interface RoutingResponse {
  readonly projects: readonly ProjectBinding[];
  readonly rules: readonly RoutingRule[];
}

export function RoutingScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();
  const phrase = usePhrase();

  const query = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingResponse>("/routing", { signal }),
  });

  return (
    <>
      <Card title={t("routing.projects")} subtitle={t("routing.projects_sub")} padded={false}>
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.projects ?? []).length === 0}
          emptyTitle={t("routing.no_projects")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "project",
                header: t("routing.col.project"),
                cell: (row: ProjectBinding) => row.projectKey,
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
            rows={query.data?.projects ?? []}
            rowKey={(row) => row.projectKey}
            emptyLabel={t("routing.no_projects")}
          />
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("routing.policy")} subtitle={t("routing.policy_sub")} padded={false}>
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(query.data?.rules ?? []).length === 0}
            emptyTitle={t("routing.no_rules")}
          >
            <Table
              columns={[
                {
                  key: "condition",
                  header: t("routing.col.condition"),
                  cell: (row: RoutingRule) => phrase(row.conditionKey, row.conditionParams),
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
              rows={query.data?.rules ?? []}
              rowKey={(row) => row.ruleId}
              emptyLabel={t("routing.no_rules")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("routing.config_note")}
      </p>
    </>
  );
}
