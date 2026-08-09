import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import type { LlmRole } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: variants — the agent variant catalogue (7 roles × platform).
 *
 * Versions are immutable: a new version is published and can be rolled back in
 * one step, and running workflows finish on the version they started with.
 */

export interface AgentVariant {
  readonly variantId: string;
  readonly role: LlmRole;
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly knowledgeFiles: number;
  /** Latest golden-ticket eval score, or null when never evaluated. */
  readonly evalScore: number | null;
}

export function VariantsScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) => api.get<{ variants: readonly AgentVariant[] }>("/variants", { signal }),
  });

  return (
    <>
      <Card title={t("variants.catalogue")} subtitle={t("variants.catalogue_sub")} padded={false}>
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.variants ?? []).length === 0}
          emptyTitle={t("variants.empty")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "variant",
                header: t("variants.col.variant"),
                cell: (row: AgentVariant) => row.variantId,
              },
              { key: "role", header: t("variants.col.role"), cell: (row) => t(`llm.role.${row.role}`) },
              { key: "platform", header: t("variants.col.platform"), cell: (row) => row.platform },
              {
                key: "model",
                header: t("variants.col.model"),
                cell: (row) => <code>{row.model}</code>,
              },
              {
                key: "version",
                header: t("variants.col.version"),
                cell: (row) => <Badge tone="blue">v{row.activeVersion}</Badge>,
              },
              {
                key: "knowledge",
                header: t("variants.col.knowledge"),
                cell: (row) => t("variants.n_files", { n: String(row.knowledgeFiles) }),
                align: "right",
              },
              {
                key: "eval",
                header: t("variants.col.eval"),
                // null is "never evaluated", which is not the same as a score of
                // zero and must not be rendered as one.
                cell: (row) =>
                  row.evalScore === null ? (
                    <Badge tone="gray">{t("variants.never_evaluated")}</Badge>
                  ) : (
                    <Badge tone={row.evalScore >= 90 ? "green" : "amber"}>{String(row.evalScore)}</Badge>
                  ),
                align: "right",
              },
            ]}
            rows={query.data?.variants ?? []}
            rowKey={(row) => row.variantId}
            onRowClick={(row) => void navigate(`/variant?id=${encodeURIComponent(row.variantId)}`)}
            emptyLabel={t("variants.empty")}
          />
        </MaybeUnwired>
      </Card>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("variants.immutable_note")}
      </p>
    </>
  );
}
