import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Table } from "../ui/index.ts";
import { partitionByDataClass, resolveDataClass, type KnowledgeDoc } from "./knowledge/classify.ts";
import { QueryState } from "./shared/QueryState.tsx";

/**
 * Screen: knowledge — search over the shared knowledge library.
 *
 * SECURITY, two layers and both wanted:
 *
 *  1. The BFF filters by data class on the way out and returns `withheld`, the
 *     count it removed for this session's clearance. That is the real control —
 *     withheld documents never reach the browser at all.
 *  2. This screen ALSO fails closed on whatever does arrive: a record whose
 *     `dataClass` is missing or unrecognised is treated as `gizli` and dropped
 *     here (see ./knowledge/classify.ts) rather than shown as public. The server
 *     promises the field is always set; the client should not stake a leak on
 *     that promise surviving every future change.
 *
 * Both counts are surfaced, so an omission is visible rather than a quietly
 * short list.
 *
 * `q` is REQUIRED by the endpoint — it is a search, not a listing — so with an
 * empty box this screen asks for nothing and says so, instead of rendering an
 * inviting empty table for data it never requested.
 */

interface KnowledgeResponse {
  readonly items: readonly KnowledgeDoc[];
  readonly nextCursor: string | null;
  /** How many results the SERVER withheld for this session's clearance. */
  readonly withheld: number;
}

const CLASS_TONE = { acik: "gray", dahili: "blue", gizli: "red" } as const;

export function KnowledgeScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const [text, setText] = useState("");

  const query = text.trim();
  const search = useQuery({
    queryKey: ["knowledge", query],
    enabled: query !== "",
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<KnowledgeResponse>("/studio/knowledge", { query: { q: query }, signal }),
  });

  // Server-side withholding, plus this screen's own fail-closed pass.
  const { visible, withheld: droppedHere } = partitionByDataClass(search.data?.items ?? []);
  const withheldTotal = (search.data?.withheld ?? 0) + droppedHere;

  return (
    <>
      <Card title={t("knowledge.library")} subtitle={t("knowledge.library_sub")}>
        <Input
          label={t("knowledge.search")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          hint={t("knowledge.search_hint")}
        />
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("knowledge.results")}
          actions={
            withheldTotal > 0 ? (
              <Badge tone="red">{t("knowledge.withheld_n", { n: String(withheldTotal) })}</Badge>
            ) : undefined
          }
          padded={query === ""}
        >
          {query === "" ? (
            <p className="tpl-keyline">{t("knowledge.type_to_search")}</p>
          ) : (
            <QueryState
              isPending={search.isPending}
              error={search.error}
              isEmpty={visible.length === 0}
              emptyTitle={t("knowledge.empty")}
              onRetry={() => void search.refetch()}
            >
              <Table
                columns={[
                  {
                    key: "title",
                    header: t("knowledge.col.file"),
                    cell: (row: KnowledgeDoc) => row.title,
                  },
                  { key: "source", header: t("knowledge.col.source"), cell: (row) => row.source },
                  {
                    key: "class",
                    header: t("knowledge.col.class"),
                    cell: (row) => {
                      const cls = resolveDataClass(row.dataClass);
                      return <Badge tone={CLASS_TONE[cls]}>{t(`data_class.${cls}`)}</Badge>;
                    },
                  },
                  { key: "app", header: t("knowledge.col.app"), cell: (row) => row.appId ?? "—" },
                  {
                    key: "updated",
                    header: t("knowledge.col.updated"),
                    cell: (row) => `${row.updatedBy} · ${row.updatedAt}`,
                  },
                ]}
                rows={visible}
                rowKey={(row) => row.id}
                emptyLabel={t("knowledge.empty")}
              />
            </QueryState>
          )}
        </Card>
      </div>

      {withheldTotal > 0 && (
        <p className="tpl-keyline" style={{ marginTop: 12 }}>
          {t("knowledge.withheld_note")}
        </p>
      )}
    </>
  );
}
