import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LlmCallLog } from "@maestro/contracts";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { Table } from "../../ui/index.ts";
import type { Column } from "../../ui/index.ts";
import { useEnumLabel } from "../common/label.ts";
import { QueryState } from "../shared/QueryState.tsx";
import { dateTimeLabel } from "../shared/format.ts";
import { MAX_RUN_PAGE } from "../shared/runs.ts";
import { moneyLabel } from "./run-state.ts";

/**
 * Per-run model consumption — `GET /studio/runs/:ticket/cost`.
 *
 * Rows are the gateway call log filtered to this run's id; the totals are a
 * sum of rows that exist, computed server-side. `usd` is null on subscription
 * drivers (the call was served from a quota window, not billed), and stays
 * null here: a dollar figure invented for it would be a number nobody paid.
 */
interface CostResponse {
  readonly items: readonly LlmCallLog[];
  readonly nextCursor: string | null;
  readonly totals: {
    readonly usd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly calls: number;
  };
}

export function CostTab({ ticket }: { readonly ticket: string }): ReactNode {
  const api = useApi();
  const t = useT();
  const { locale } = useI18n();
  const enumLabel = useEnumLabel();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["studio-run-cost", ticket],
    queryFn: ({ signal }) =>
      api.get<CostResponse>(`/studio/runs/${encodeURIComponent(ticket)}/cost`, {
        query: { limit: MAX_RUN_PAGE },
        signal,
      }),
    retry: false,
  });

  const items = data?.items ?? [];

  const columns: readonly Column<LlmCallLog>[] = [
    {
      key: "at",
      header: t("detail.cost.col.at"),
      cell: (row) => <span className="scr-mono">{dateTimeLabel(row.at, locale)}</span>,
    },
    {
      key: "role",
      header: t("detail.cost.col.role"),
      // The gateway's role vocabulary grows on its own; an unknown one must
      // not blank the table.
      cell: (row) => enumLabel("llm.role", row.role).text,
    },
    {
      key: "model",
      header: t("detail.cost.col.model"),
      cell: (row) => (
        <>
          <span className="scr-mono">{row.model}</span>
          <div className="scr-hint">{row.driver}</div>
        </>
      ),
    },
    {
      key: "tokens",
      header: t("detail.cost.col.tokens"),
      align: "right",
      cell: (row) => `${row.tokensIn} / ${row.tokensOut}`,
    },
    {
      key: "usd",
      header: t("detail.cost.col.usd"),
      align: "right",
      cell: (row) => (row.usd === null ? t("detail.cost.quota") : moneyLabel(row.usd, locale)),
    },
  ];

  return (
    <QueryState
      isPending={isPending}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={items.length === 0}
      emptyTitle={t("detail.cost.empty")}
      emptyDescription={t("detail.cost.empty_hint")}
    >
      <div className="scr-stack">
        {data !== undefined && (
          <p className="scr-mini">
            {t("detail.cost.totals", {
              calls: String(data.totals.calls),
              in: String(data.totals.tokensIn),
              out: String(data.totals.tokensOut),
              usd: moneyLabel(data.totals.usd, locale),
            })}
          </p>
        )}
        <Table
          columns={columns}
          rows={items}
          rowKey={(row) => `${row.at}:${row.role}:${row.variantId}:${row.tokensIn}`}
          emptyLabel={t("detail.cost.empty")}
        />
        {data?.nextCursor !== null && data?.nextCursor !== undefined && (
          <p className="scr-hint">{t("detail.cost.capped", { n: String(MAX_RUN_PAGE) })}</p>
        )}
        <p className="scr-hint">{t("detail.cost.source")}</p>
      </div>
    </QueryState>
  );
}
