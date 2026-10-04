import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { LlmCallLog, SubscriptionAccount } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, TabPanel, Table, Tabs } from "../ui/index.ts";
import { Pager, useCursorPager } from "./audit/Pager.tsx";
import type { CostPage, QuotaResponse } from "./common/admin-api.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { dateTimeLabel } from "./shared/format.ts";
import { poolOutcome, outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";
import { useRuns } from "./shared/runs.ts";

/**
 * Screen: AI usage & cost (/cost) — one page, two views of the SAME two
 * endpoints (`/studio/cost` + `/studio/quota`).
 *
 *   Maliyet — what it costs: spend and token KPIs over the gateway call log,
 *             and the call log itself (each row links to its run)
 *   Trafik  — the subscription pool: the accounts, their windows, and whether
 *             new work is served or queued
 *
 * "Maliyet & kota" and "LLM Gateway" used to be two menu rows rendering the
 * same table twice. The call log is shown ONCE (Maliyet); the pool ONCE
 * (Trafik). The old /llm path redirects here with the traffic tab selected.
 *
 * Money rules (M55/M16): subscription drivers cost QUOTA and carry `usd: null`;
 * API drivers cost DOLLARS. The two are never summed into one number — a
 * null-priced call folded into a dollar total would report the platform as
 * cheaper than it is. Totals are computed from the page the log returned, and
 * the screen says so.
 */

const VIEWS = ["cost", "traffic"] as const;
type ViewId = (typeof VIEWS)[number];

function isView(v: string | null): v is ViewId {
  return v === "cost" || v === "traffic";
}

const ACCOUNT_TONE = (state: string): "green" | "amber" | "red" | "gray" => {
  switch (state) {
    case "ready":
      return "green";
    case "cooling":
      return "amber";
    case "exhausted":
      return "red";
    default:
      return "gray";
  }
};

/** Dollars in the viewer's locale — "$12,30" in tr (ICU keeps the sign first, the comma is the tell), "$12.30" in en. */
function usdLabel(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
}

export function AiUsageScreen(): ReactNode {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const view: ViewId = isView(params.get("view")) ? (params.get("view") as ViewId) : "cost";

  const select = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("view", id);
    // A tab switch is not a navigation: replace, so "back" leaves the screen
    // instead of stepping through every tab clicked.
    setParams(next, { replace: true });
  };

  return (
    <div className="scr-stack">
      <Tabs
        label={t("aiusage.tabs.label")}
        active={view}
        onChange={select}
        items={VIEWS.map((id) => ({ id, label: t(`aiusage.tab.${id}`) }))}
      />
      <TabPanel id="cost" active={view}>
        <CostTab />
      </TabPanel>
      <TabPanel id="traffic" active={view}>
        <TrafficTab />
      </TabPanel>
    </div>
  );
}

function CostTab(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const api = useApi();
  const enumLabel = useEnumLabel();
  const pager = useCursorPager();

  const calls = useQuery({
    queryKey: ["cost", "calls", pager.cursor],
    queryFn: ({ signal }) =>
      api.get<CostPage>("/studio/cost", { signal, query: { cursor: pager.cursor ?? undefined } }),
  });

  // A call log row carries the run id, the Detail route wants the ticket. The
  // run list already on the operator's board maps one to the other; a row
  // whose run is not on it shows the id as text rather than a dead link.
  const runs = useRuns(200);
  const ticketByRun = new Map<string, string>();
  for (const run of runs.data?.runs ?? []) {
    if (run.runId !== null) ticketByRun.set(run.runId, run.ticketKey);
  }

  const items = calls.data?.items ?? [];
  // Dollars only from the rows that actually carry a price; quota-priced calls
  // are counted separately, never folded into the money figure.
  const apiCalls = items.filter((row) => row.usd !== null);
  const apiSpend = apiCalls.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  const quotaCalls = items.length - apiCalls.length;
  const tokens = items.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0);

  return (
    <>
      <Card title={t("cost.overview")} subtitle={t("cost.overview_sub")}>
        <QueryState isPending={calls.isPending} error={calls.error} onRetry={() => void calls.refetch()}>
          <div className="scr-chips">
            <Kpi
              label={t("cost.api_spend")}
              value={usdLabel(apiSpend, locale)}
              note={t("cost.api_spend_note", { n: String(apiCalls.length) })}
            />
            <Kpi label={t("cost.quota_calls")} value={String(quotaCalls)} note={t("cost.quota_calls_note")} />
            <Kpi label={t("cost.tokens")} value={tokens.toLocaleString(locale)} />
          </div>
          <p className="scr-hint" style={{ marginTop: 8 }}>{t("cost.page_scope", { n: String(items.length) })}</p>
        </QueryState>
      </Card>

      <Card title={t("cost.calls")} subtitle={t("cost.calls_sub")} padded={false}>
        <QueryState
          isPending={calls.isPending}
          error={calls.error}
          isEmpty={items.length === 0}
          emptyTitle={t("cost.no_calls")}
          onRetry={() => void calls.refetch()}
        >
          <Table
            columns={[
              {
                key: "at",
                header: t("llm.col.at"),
                cell: (row: LlmCallLog) => dateTimeLabel(row.at, locale),
              },
              {
                key: "run",
                header: t("cost.col.run"),
                // A call with no runId is platform overhead, not a run's cost.
                cell: (row) => {
                  if (row.runId === null) return <span className="scr-hint">{t("cost.no_run")}</span>;
                  const ticket = ticketByRun.get(row.runId);
                  return ticket === undefined ? (
                    <code>{row.runId}</code>
                  ) : (
                    <Link className="scr-link scr-mono" to={`/detail/${encodeURIComponent(ticket)}`}>
                      {ticket}
                    </Link>
                  );
                },
              },
              {
                key: "role",
                header: t("llm.col.role"),
                // The gateway's role vocabulary grows independently of this
                // build; an unrecognised one must not blank the table.
                cell: (row) => enumLabel("llm.role", row.role).text,
              },
              { key: "driver", header: t("llm.col.driver"), cell: (row) => <Badge tone="blue">{row.driver}</Badge> },
              { key: "model", header: t("llm.col.model"), cell: (row) => <code>{row.model}</code> },
              {
                key: "tokens",
                header: t("llm.col.tokens"),
                cell: (row) => `${row.tokensIn} / ${row.tokensOut}`,
                align: "right",
              },
              {
                key: "usd",
                header: t("llm.col.cost"),
                // Subscription drivers have no dollar cost: the cost is quota.
                // Rendering $0.00 there would misstate a real spend as free.
                cell: (row) => (row.usd === null ? t("llm.cost_is_quota") : usdLabel(row.usd, locale)),
                align: "right",
              },
              {
                key: "class",
                header: t("llm.col.class"),
                // "gizli" stays red on the raw value, not on the label: the
                // classification must keep its warning colour even if this
                // build has no translation for some other class.
                cell: (row) => (
                  <Badge tone={row.dataClass === "gizli" ? "red" : "gray"}>
                    {enumLabel("data_class", row.dataClass).text}
                  </Badge>
                ),
              },
            ]}
            rows={items}
            rowKey={(row) => `${row.at}:${row.role}:${row.variantId}`}
            emptyLabel={t("cost.no_calls")}
          />
        </QueryState>
        <Pager pager={pager} nextCursor={calls.data?.nextCursor} busy={calls.isFetching} />
      </Card>
    </>
  );
}

function TrafficTab(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => api.get<QuotaResponse>("/studio/quota", { signal }),
  });

  const pool = quota.data?.pool;
  const outcome = poolOutcome(pool?.hasCapacity);

  return (
    <>
      <Card
        title={t("llm.pool")}
        subtitle={t("llm.pool_sub")}
        actions={
          pool === undefined ? undefined : (
            <Badge tone={outcomeTone(outcome)}>{t(outcomeKey(outcome))}</Badge>
          )
        }
        padded={false}
      >
        <QueryState
          isPending={quota.isPending}
          error={quota.error}
          isEmpty={(quota.data?.accounts ?? []).length === 0}
          emptyTitle={t("llm.no_accounts")}
          onRetry={() => void quota.refetch()}
        >
          {/* Shown as ACCOUNTS, not as one average: one exhausted account among
              three ready ones is not a platform at 100%. */}
          <Table
            columns={[
              { key: "account", header: t("llm.col.account"), cell: (row: SubscriptionAccount) => row.accountId },
              { key: "driver", header: t("llm.col.driver"), cell: (row) => <Badge tone="blue">{row.driver}</Badge> },
              {
                key: "state",
                header: t("llm.col.state"),
                // ACCOUNT_TONE already falls through to grey for an unknown
                // state; the label needs the same treatment or the row throws.
                cell: (row) => (
                  <Badge tone={ACCOUNT_TONE(row.state)}>{enumLabel("llm.account_state", row.state).text}</Badge>
                ),
              },
              {
                key: "windows",
                header: t("llm.col.windows"),
                cell: (row) =>
                  row.windows
                    .map((w) => t("llm.window", { kind: w.kind, pct: String(Math.round(w.usedPct)) }))
                    .join(" · "),
              },
              {
                key: "resets",
                header: t("llm.col.resets"),
                cell: (row) => row.windows.map((w) => dateTimeLabel(w.resetsAt, locale)).join(" · "),
              },
            ]}
            rows={quota.data?.accounts ?? []}
            rowKey={(row) => row.accountId}
            emptyLabel={t("llm.no_accounts")}
          />
        </QueryState>
      </Card>

      {pool !== undefined && (
        <p className="scr-hint">
          {t("llm.pool_counts", {
            ready: String(pool.ready),
            cooling: String(pool.cooling),
            exhausted: String(pool.exhausted),
            disabled: String(pool.disabled),
          })}{" "}
          {t(outcomeExplanationKey(outcome))}
        </p>
      )}
    </>
  );
}
