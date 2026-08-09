import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { LlmRole } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, EmptyState, TabPanel, Table, Tabs } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { TextArea } from "./shared/TextArea.tsx";

/**
 * Screen: variant — one agent variant in detail (persona, knowledge, versions).
 *
 * Which variant is shown comes from `?id=`; without it the screen says so
 * rather than silently picking one, because "the first variant in the list" is
 * not the variant the operator asked for.
 *
 * The persona editor is read-only here: publishing a new version must run the
 * golden-ticket eval first (see the eval screen), and there is no BFF endpoint
 * for it yet. A save button that did nothing would be a dead path.
 */

interface VariantVersion {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly note: string;
  readonly evalScore: number | null;
}

interface KnowledgeLink {
  readonly docId: string;
  readonly fileName: string;
  readonly category: string;
  readonly version: number;
}

interface VariantDetail {
  readonly variantId: string;
  readonly role: LlmRole;
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly persona: string;
  readonly knowledge: readonly KnowledgeLink[];
  readonly versions: readonly VariantVersion[];
}

export function VariantScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();
  const [params] = useSearchParams();
  const variantId = params.get("id");
  const [tab, setTab] = useState("persona");

  const query = useQuery({
    queryKey: ["variant", variantId],
    enabled: variantId !== null,
    queryFn: ({ signal }) =>
      api.get<VariantDetail>(`/variants/${encodeURIComponent(variantId ?? "")}`, { signal }),
  });

  if (variantId === null) {
    return (
      <Card title={t("variant.detail")}>
        <EmptyState icon="🤖" title={t("variant.pick_first")} description={t("variant.pick_hint")} />
      </Card>
    );
  }

  const data = query.data;

  return (
    <Card
      title={data === undefined ? t("variant.detail") : data.variantId}
      subtitle={
        data === undefined
          ? undefined
          : t("variant.subtitle", {
              role: enumLabel("llm.role", data.role).text,
              platform: data.platform,
              version: String(data.activeVersion),
            })
      }
    >
      <MaybeUnwired isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <Tabs
              label={t("variant.tabs")}
              active={tab}
              onChange={setTab}
              items={[
                { id: "persona", label: t("variant.tab.persona") },
                { id: "knowledge", label: t("variant.tab.knowledge"), count: data.knowledge.length },
                { id: "versions", label: t("variant.tab.versions"), count: data.versions.length },
              ]}
            />

            <TabPanel id="persona" active={tab}>
              <TextArea
                label={t("variant.persona")}
                rows={14}
                readOnly
                value={data.persona}
                hint={t("variant.persona_readonly")}
              />
              <p className="tpl-keyline">{t("variant.model_is", { model: data.model })}</p>
            </TabPanel>

            <TabPanel id="knowledge" active={tab}>
              <Table
                columns={[
                  {
                    key: "file",
                    header: t("knowledge.col.file"),
                    cell: (row: KnowledgeLink) => row.fileName,
                  },
                  {
                    key: "category",
                    header: t("knowledge.col.category"),
                    cell: (row) => <Badge tone="gray">{row.category}</Badge>,
                  },
                  {
                    key: "version",
                    header: t("knowledge.col.version"),
                    cell: (row) => <Badge tone="blue">v{row.version}</Badge>,
                  },
                ]}
                rows={data.knowledge}
                rowKey={(row) => row.docId}
                emptyLabel={t("variant.no_knowledge")}
              />
            </TabPanel>

            <TabPanel id="versions" active={tab}>
              <Table
                columns={[
                  {
                    key: "version",
                    header: t("variant.col.version"),
                    cell: (row: VariantVersion) => (
                      <Badge tone={row.version === data.activeVersion ? "green" : "gray"}>
                        v{row.version}
                      </Badge>
                    ),
                  },
                  { key: "at", header: t("variant.col.published_at"), cell: (row) => row.publishedAt },
                  { key: "by", header: t("variant.col.published_by"), cell: (row) => row.publishedBy },
                  {
                    key: "eval",
                    header: t("variant.col.eval"),
                    cell: (row) =>
                      row.evalScore === null
                        ? t("variants.never_evaluated")
                        : String(row.evalScore),
                    align: "right",
                  },
                  { key: "note", header: t("variant.col.note"), cell: (row) => row.note },
                ]}
                rows={data.versions}
                rowKey={(row) => String(row.version)}
                emptyLabel={t("variant.no_versions")}
              />
            </TabPanel>
          </>
        )}
      </MaybeUnwired>
    </Card>
  );
}
