import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ScanFinding } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { bySeverity, severityTone, toSeverity } from "./shared/severity.ts";

/**
 * Screen: security — findings from the 6b scan stage (M27).
 *
 * Findings are shown most-severe first and none are hidden or collapsed by
 * default.
 *
 * The stage is fail-closed, and this screen preserves that: `outcome: "error"`
 * means the scanner could not run, which is NOT a clean result. It is rendered
 * in the same red register as a failure, never folded in with the passes,
 * because a scanner that never ran reporting as green is precisely the v1 bug
 * M27 exists to prevent.
 */

/** One row of `GET /studio/scans`. */
interface ScanRecord {
  readonly ticketKey: string;
  readonly finding: ScanFinding;
  readonly outcome: "pass" | "fail" | "error";
  readonly at: string;
}

interface ScanPage {
  readonly items: readonly ScanRecord[];
  readonly nextCursor: string | null;
}

const OUTCOME_TONE = { pass: "green", fail: "red", error: "red" } as const;

export function SecurityScreen(): ReactNode {
  const t = useT();
  const api = useApi();

  const query = useQuery({
    queryKey: ["scans"],
    queryFn: ({ signal }) => api.get<ScanPage>("/studio/scans", { signal }),
  });

  const rows = bySeverity(query.data?.items ?? [], (row) => row.finding.severity);
  const blocked = rows.filter((row) => row.outcome !== "pass").length;

  return (
    <>
      <Card
        title={t("security.findings")}
        subtitle={t("security.findings_sub")}
        actions={
          blocked > 0 ? (
            <Badge tone="red">{t("security.blocking_n", { n: String(blocked) })}</Badge>
          ) : undefined
        }
        padded={false}
      >
        <QueryState
          isPending={query.isPending}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle={t("security.no_findings")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "severity",
                header: t("security.col.severity"),
                cell: (row: ScanRecord) => (
                  <Badge tone={severityTone(row.finding.severity)}>
                    {t(`severity.${toSeverity(row.finding.severity)}`)}
                  </Badge>
                ),
              },
              { key: "ticket", header: t("security.col.ticket"), cell: (row) => row.ticketKey },
              {
                key: "tool",
                header: t("security.col.tool"),
                cell: (row) => <Badge tone="gray">{row.finding.tool}</Badge>,
              },
              {
                key: "finding",
                header: t("security.col.finding"),
                cell: (row) => row.finding.message,
              },
              {
                key: "location",
                header: t("security.col.location"),
                // file/line are optional in the contract: a secret found in git
                // history has no file to point at.
                cell: (row) =>
                  row.finding.file === undefined ? (
                    "—"
                  ) : (
                    <code>
                      {row.finding.file}
                      {row.finding.line === undefined ? "" : `:${row.finding.line}`}
                    </code>
                  ),
              },
              {
                key: "outcome",
                header: t("security.col.status"),
                // "error" is not a pass: a scanner that could not run must never
                // read as clean.
                cell: (row) => (
                  <Badge tone={OUTCOME_TONE[row.outcome]}>{t(`security.outcome.${row.outcome}`)}</Badge>
                ),
              },
              { key: "at", header: t("security.col.at"), cell: (row) => row.at },
            ]}
            rows={rows}
            rowKey={(row) => `${row.ticketKey}:${row.finding.tool}:${row.finding.ruleId}:${row.at}`}
            emptyLabel={t("security.no_findings")}
          />
        </QueryState>
      </Card>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("security.fail_closed_note")}
      </p>
    </>
  );
}
