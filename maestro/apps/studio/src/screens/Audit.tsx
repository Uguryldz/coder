import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AuditEvent } from "@maestro/contracts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table } from "../ui/index.ts";
import { assess, type ChainVerification } from "./audit/verification.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { shortHash } from "./shared/format.ts";

/**
 * Screen: audit — the hash-chained audit trail (M33).
 *
 * SECURITY: the chain's own claim is not evidence about itself. This screen
 * never renders a bare `ok: true` as a green badge; it shows the verdict
 * together with what it rests on — how many records were re-hashed — and
 * downgrades an `ok` that checked nothing to amber. It also states plainly that
 * recomputation shows internal consistency, not tamper-proofing, because the
 * endpoint reports no external anchor. See ./audit/verification.ts.
 *
 * Both endpoints are auditor-only in the BFF (403 for everyone else); that
 * failure surfaces translated, like any other.
 */

/** `GET /studio/audit` — a page of the trail. */
interface AuditPage {
  readonly items: readonly AuditEvent[];
  readonly nextCursor: string | null;
}

const ACTION_TONE = (action: string): "green" | "red" | "amber" | "gray" => {
  if (action.includes("APPROVE") || action.includes("PASS") || action.includes("MERGED")) return "green";
  if (action.includes("REJECT") || action.includes("FAIL") || action.includes("KILL")) return "red";
  if (action.includes("WARN") || action.includes("HANDOVER")) return "amber";
  return "gray";
};

export function AuditScreen(): ReactNode {
  const t = useT();
  const api = useApi();

  const events = useQuery({
    queryKey: ["audit", "events"],
    queryFn: ({ signal }) => api.get<AuditPage>("/studio/audit", { signal }),
  });

  /**
   * The verification is a GET because it changes nothing — it recomputes and
   * compares. It is a separate query so a broken trail still renders its rows:
   * the events are the evidence an auditor came for, and withholding them
   * because the integrity check failed would be exactly backwards.
   */
  const verification = useQuery({
    queryKey: ["audit", "verification"],
    queryFn: ({ signal }) => api.get<ChainVerification>("/studio/audit/verification", { signal }),
  });

  const verdict = assess(verification.data);

  return (
    <>
      <Card
        title={t("audit.chain")}
        subtitle={t("audit.chain_sub")}
        actions={
          <Button
            variant="primary"
            busy={verification.isFetching}
            onClick={() => void verification.refetch()}
          >
            {t("audit.verify_now")}
          </Button>
        }
      >
        <QueryState
          isPending={verification.isPending}
          error={verification.error}
          onRetry={() => void verification.refetch()}
        >
          <p>
            <Badge tone={verdict.tone}>{t(`audit.assessment.${verdict.assessment}`)}</Badge>
          </p>
          <ul className="tpl-keyline" style={{ marginTop: 8 }}>
            {verdict.basis.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          {verification.data !== undefined && (
            <p className="tpl-keyline">
              {t("audit.checked_n", { n: String(verification.data.checked) })}
              {verification.data.brokenAtSeq !== null &&
                ` · ${t("audit.broken_at_seq", { seq: String(verification.data.brokenAtSeq) })}`}
            </p>
          )}
        </QueryState>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("audit.events")} padded={false}>
          <QueryState
            isPending={events.isPending}
            error={events.error}
            isEmpty={(events.data?.items ?? []).length === 0}
            emptyTitle={t("audit.no_events")}
            onRetry={() => void events.refetch()}
          >
            <Table
              columns={[
                {
                  key: "seq",
                  header: t("audit.col.seq"),
                  cell: (row: AuditEvent) => String(row.seq),
                  align: "right",
                },
                { key: "at", header: t("audit.col.at"), cell: (row) => row.at },
                { key: "actor", header: t("audit.col.actor"), cell: (row) => row.actor },
                {
                  key: "action",
                  header: t("audit.col.action"),
                  cell: (row) => <Badge tone={ACTION_TONE(row.action)}>{row.action}</Badge>,
                },
                { key: "subject", header: t("audit.col.subject"), cell: (row) => row.subject },
                {
                  key: "hash",
                  header: t("audit.col.hash"),
                  cell: (row) => <code>{shortHash(row.hash)}</code>,
                },
              ]}
              rows={events.data?.items ?? []}
              rowKey={(row) => String(row.seq)}
              emptyLabel={t("audit.no_events")}
            />
          </QueryState>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("audit.single_writer_note")}
      </p>
    </>
  );
}
