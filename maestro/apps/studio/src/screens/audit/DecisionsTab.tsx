import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Card, Input, Table } from "../../ui/index.ts";
import { useEnumLabel } from "../common/label.ts";
import { QueryState } from "../shared/QueryState.tsx";
import { dateTimeLabel } from "../shared/format.ts";
import { bySeverity, severityTone, toSeverity } from "../shared/severity.ts";
import { Pager, useCursorPager } from "./Pager.tsx";

/**
 * The decision ledger (karar defteri) — the "Kararlar" tab of the audit trail.
 *
 * Every decision somebody made, derived from the same hash chain the trail
 * shows, most-severe first. `GET /decisions` pages on the chain sequence; the
 * filter box narrows the PAGE, and the unfiltered page total stays visible so a
 * narrow filter can never be mistaken for "there is nothing else".
 *
 * `chainVerified` is the server recomputing the chain per request — shown as a
 * badge because a ledger read off a chain that no longer reconciles is not
 * evidence, and hiding that flag would make it look like one.
 */

interface Decision {
  readonly decisionId: string;
  readonly question: string;
  /** The audit action and who took it; the sentence is composed here. */
  readonly action: string;
  readonly actor: string;
  readonly severity: string;
  readonly status: string;
  readonly decidedAt: string;
}

interface DecisionsPage {
  readonly decisions: readonly Decision[];
  readonly nextCursor: string | null;
  readonly chainVerified: boolean;
}

export function DecisionsTab(): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const api = useApi();
  const enumLabel = useEnumLabel();
  const [filter, setFilter] = useState("");
  const pager = useCursorPager();

  const query = useQuery({
    queryKey: ["issues", pager.cursor],
    queryFn: ({ signal }) =>
      api.get<DecisionsPage>("/decisions", { signal, query: { cursor: pager.cursor ?? undefined } }),
  });

  const all = query.data?.decisions ?? [];
  const needle = filter.trim().toLowerCase();
  const matched =
    needle === ""
      ? all
      : all.filter(
          (d) =>
            // Matched against what the operator can SEE as well as the raw
            // enum, so both "Kapı onaya açıldı" and `GATE_OPEN` find the row.
            enumLabel("audit.action", d.action).text.toLowerCase().includes(needle) ||
            d.action.toLowerCase().includes(needle) ||
            d.actor.toLowerCase().includes(needle) ||
            d.question.toLowerCase().includes(needle),
        );
  const rows = bySeverity(matched, (d) => d.severity);

  return (
    <Card
      title={t("issues.ledger")}
      subtitle={t("issues.counts", { shown: String(rows.length), total: String(all.length) })}
      actions={
        <div className="scr-row" style={{ alignItems: "flex-end" }}>
          {query.data !== undefined && all.length > 0 && (
            <Badge tone={query.data.chainVerified ? "green" : "red"}>
              {t(query.data.chainVerified ? "issues.chain.verified" : "issues.chain.unverified")}
            </Badge>
          )}
          <Input
            label={t("issues.filter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      }
      padded={false}
    >
      <QueryState
        isPending={query.isPending}
        error={query.error}
        isEmpty={rows.length === 0}
        emptyTitle={needle === "" ? t("issues.empty") : t("issues.no_match")}
        onRetry={() => void query.refetch()}
      >
        <Table
          columns={[
            {
              key: "severity",
              header: t("issues.col.severity"),
              cell: (row: Decision) => (
                <Badge tone={severityTone(row.severity)}>
                  {t(`severity.${toSeverity(row.severity)}`)}
                </Badge>
              ),
            },
            { key: "question", header: t("issues.col.question"), cell: (row) => row.question },
            {
              key: "decision",
              header: t("issues.col.decision"),
              // Composed from two machine fields rather than received pre-joined:
              // that is what let `GATE_OPEN · maestro-worker` reach an auditor
              // untranslated.
              cell: (row) =>
                t("issues.decision_by", {
                  action: enumLabel("audit.action", row.action).text,
                  actor: row.actor,
                }),
            },
            {
              key: "status",
              header: t("issues.col.status"),
              cell: (row) => enumLabel("issues.status", row.status).text,
            },
            {
              key: "at",
              header: t("issues.col.at"),
              align: "right",
              cell: (row) => dateTimeLabel(row.decidedAt, locale),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.decisionId}
          emptyLabel={t("issues.empty")}
        />
      </QueryState>
      {needle !== "" && <p className="scr-hint" style={{ padding: "0 14px 8px" }}>{t("issues.filter_hint")}</p>}
      <Pager pager={pager} nextCursor={query.data?.nextCursor} busy={query.isFetching} />
    </Card>
  );
}
