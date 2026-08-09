import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: eval — golden-ticket regression testing.
 *
 * Prompt and knowledge changes are regression-tested against a reference set of
 * real past tickets before a variant version is published. A score that DROPPED
 * against the baseline is called out explicitly: the whole point of the gate is
 * that a regression is visible before publishing, not after.
 */

interface GoldenTicket {
  readonly goldenId: string;
  readonly sourceTicket: string;
  readonly kind: string;
  readonly expectation: string;
  readonly lastScore: number | null;
}

interface EvalRunResult {
  readonly goldenId: string;
  readonly baselineScore: number | null;
  readonly candidateScore: number | null;
}

interface EvalRun {
  readonly runId: string;
  readonly baselineVersion: number;
  readonly candidateVersion: number;
  readonly variantId: string;
  readonly at: string;
  readonly results: readonly EvalRunResult[];
}

interface EvalResponse {
  readonly goldenTickets: readonly GoldenTicket[];
  /** null when no eval has been run yet. */
  readonly lastRun: EvalRun | null;
}

/** Regression = the candidate scored strictly worse than the baseline. */
function isRegression(result: EvalRunResult): boolean {
  return (
    result.baselineScore !== null &&
    result.candidateScore !== null &&
    result.candidateScore < result.baselineScore
  );
}

export function EvalScreen(): ReactNode {
  const t = useT();
  const api = useApi();

  const query = useQuery({
    queryKey: ["eval"],
    queryFn: ({ signal }) => api.get<EvalResponse>("/eval", { signal }),
  });

  const lastRun = query.data?.lastRun ?? null;
  const regressions = (lastRun?.results ?? []).filter(isRegression).length;

  return (
    <>
      <Card title={t("eval.pool")} subtitle={t("eval.pool_sub")} padded={false}>
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.goldenTickets ?? []).length === 0}
          emptyTitle={t("eval.no_golden")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              { key: "id", header: t("eval.col.id"), cell: (row: GoldenTicket) => row.goldenId },
              { key: "source", header: t("eval.col.source"), cell: (row) => row.sourceTicket },
              {
                key: "kind",
                header: t("eval.col.kind"),
                cell: (row) => <Badge tone="gray">{row.kind}</Badge>,
              },
              {
                key: "expectation",
                header: t("eval.col.expectation"),
                cell: (row) => row.expectation,
              },
              {
                key: "score",
                header: t("eval.col.last_score"),
                cell: (row) =>
                  row.lastScore === null ? (
                    <Badge tone="gray">{t("variants.never_evaluated")}</Badge>
                  ) : (
                    <Badge tone={row.lastScore >= 90 ? "green" : "amber"}>{String(row.lastScore)}</Badge>
                  ),
                align: "right",
              },
            ]}
            rows={query.data?.goldenTickets ?? []}
            rowKey={(row) => row.goldenId}
            emptyLabel={t("eval.no_golden")}
          />
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("eval.last_run")}
          subtitle={
            lastRun === null
              ? undefined
              : t("eval.last_run_sub", {
                  variant: lastRun.variantId,
                  from: String(lastRun.baselineVersion),
                  to: String(lastRun.candidateVersion),
                  at: lastRun.at,
                })
          }
          actions={
            regressions > 0 ? (
              <Badge tone="red">{t("eval.regressions_n", { n: String(regressions) })}</Badge>
            ) : undefined
          }
          padded={false}
        >
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={lastRun === null || lastRun.results.length === 0}
            emptyTitle={t("eval.never_run")}
          >
            <Table
              columns={[
                {
                  key: "id",
                  header: t("eval.col.id"),
                  cell: (row: EvalRunResult) => row.goldenId,
                },
                {
                  key: "baseline",
                  header: t("eval.col.baseline"),
                  cell: (row) => (row.baselineScore === null ? "—" : String(row.baselineScore)),
                  align: "right",
                },
                {
                  key: "candidate",
                  header: t("eval.col.candidate"),
                  cell: (row) => (row.candidateScore === null ? "—" : String(row.candidateScore)),
                  align: "right",
                },
                {
                  key: "delta",
                  header: t("eval.col.verdict"),
                  cell: (row) =>
                    isRegression(row) ? (
                      <Badge tone="red">{t("eval.regressed")}</Badge>
                    ) : (
                      <Badge tone="green">{t("eval.no_regression")}</Badge>
                    ),
                },
              ]}
              rows={lastRun?.results ?? []}
              rowKey={(row) => row.goldenId}
              emptyLabel={t("eval.never_run")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("eval.gate_note")}
      </p>
    </>
  );
}
