import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Kpi, Table } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { QueryState } from "./shared/QueryState.tsx";

/**
 * Screen: pii — PII masking overview (M20/M63).
 *
 * SECURITY, NON-NEGOTIABLE: masking happens on the SERVER. This screen can
 * neither unmask nor request an unmasked value, and it must never render a
 * masked value's plaintext. It reports WHAT was masked as COUNTS and by RULE
 * only.
 *
 * The v1 audit finding was exactly this shape: an unmasked "second copy" of the
 * value was kept for display. So the response type below deliberately has no
 * field that could carry a sample value, and no sample is requested. If a
 * future BFF version starts returning one, this screen still cannot show it —
 * add nothing here.
 *
 * What is deliberately NOT shown, and why. `GET /pii` also answers
 * `exemptVariants: []`, `archiveMasked: true` and a per-rule `strategy: "hash"`
 * — all three are constants in the reader (deploy `read-governance.ts`), not
 * measurements: the policy loader forbids exemptions, the archive path masks
 * by construction, and every detector mints a reversible token. Rendering a
 * constant as a green status tile or a column would be a setting nobody can
 * change dressed up as a check somebody ran; the facts are stated once, in
 * words, instead.
 */

interface PiiRule {
  readonly ruleId: string;
  /** "field" | "regex" — what the rule matches on. */
  readonly kind: string;
  /** The detector type or field name being matched. NOT a value. */
  readonly matcher: string;
  /** How many times this rule fired. A count, never a value. */
  readonly hits: number;
}

interface PiiSummary {
  readonly maskedCalls: number;
  readonly totalCalls: number;
  readonly maskedFields: number;
  /** Calls in the `gizli` class — routed to the on-prem model, never leaving. */
  readonly onPremCalls: number;
}

interface PiiResponse {
  readonly summary: PiiSummary;
  readonly rules: readonly PiiRule[];
}

export function PiiScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const enumLabel = useEnumLabel();

  const query = useQuery({
    queryKey: ["pii"],
    queryFn: ({ signal }) => api.get<PiiResponse>("/pii", { signal }),
  });

  const summary = query.data?.summary;
  const pct =
    summary !== undefined && summary.totalCalls > 0
      ? Math.round((summary.maskedCalls / summary.totalCalls) * 100)
      : 0;

  return (
    <div className="scr-stack">
      <Card title={t("pii.summary")} subtitle={t("pii.summary_sub")}>
        <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {summary !== undefined && (
            <div className="scr-chips">
              <Kpi
                label={t("pii.masked_calls")}
                value={`${summary.maskedCalls} / ${summary.totalCalls}`}
                note={t("pii.masked_pct", { pct: String(pct) })}
              />
              <Kpi label={t("pii.masked_fields")} value={String(summary.maskedFields)} />
              <Kpi
                label={t("pii.confidential_calls")}
                value={String(summary.onPremCalls)}
                note={t("pii.confidential_note")}
              />
            </div>
          )}
        </QueryState>
      </Card>

      <Card title={t("pii.rules")} subtitle={t("pii.rules_sub")} padded={false}>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.rules ?? []).length === 0}
          emptyTitle={t("pii.no_rules")}
        >
          <Table
            columns={[
              {
                key: "kind",
                header: t("pii.col.kind"),
                cell: (row: PiiRule) => <Badge tone="gray">{enumLabel("pii.kind", row.kind).text}</Badge>,
              },
              { key: "matcher", header: t("pii.col.matcher"), cell: (row) => <code>{row.matcher}</code> },
              { key: "hits", header: t("pii.col.hits"), cell: (row) => String(row.hits), align: "right" },
            ]}
            rows={query.data?.rules ?? []}
            rowKey={(row) => row.ruleId}
            emptyLabel={t("pii.no_rules")}
          />
        </QueryState>
      </Card>

      <p className="scr-hint">{t("pii.no_unmask_note")}</p>
    </div>
  );
}
