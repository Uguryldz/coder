import type { ReactNode } from "react";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { QueryState } from "../shared/QueryState.tsx";
import { dateTimeLabel } from "../shared/format.ts";
import { useJournal } from "../shared/runs.ts";

/**
 * The analysis the run produced, read back from the ticket journal.
 *
 * There is no `GET /runs/:ticket/analysis`, and this tab used to say so — in
 * the words "Bu bölüm henüz yayında değil", which an operator reasonably read
 * as "the product is unfinished". It was the wrong sentence twice over: the
 * analysis is not missing, and it is not unbuilt. `packages/workflows`'
 * analysis turn writes it to the journal as a `kind: "analysis"` entry and
 * then publishes it as a Jira comment (impl/analysis.ts — "analiz yazıldı",
 * then "analiz yayımlandı"). Measured on the live database: forty such entries
 * across the board, the text sitting in `JournalEntry.detail` the whole time
 * Studio was claiming there was nothing to show.
 *
 * So this reads the journal it was already fetching for the neighbouring tab
 * and filters to that one kind. No new endpoint, no second source that could
 * disagree with the defter beside it, and — the point — no screen telling a
 * reviewer their analysis does not exist while it sits one tab away.
 */
export function AnalysisTab({ ticket }: { readonly ticket: string }): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const { data, isPending, error, refetch } = useJournal(ticket);

  const entries = (data?.items ?? []).filter((entry) => entry.kind === "analysis");

  return (
    <QueryState
      isPending={isPending}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={entries.length === 0}
      emptyTitle={t("detail.analysis.empty")}
      emptyDescription={t("detail.analysis.empty_hint")}
      emptyIcon="📄"
    >
      <div className="screen-journal">
        {entries.map((entry) => (
          <div className="screen-journal__row" key={`${entry.runId}-${entry.seq}`}>
            <span className="screen-note screen-mono">{dateTimeLabel(entry.at, locale)}</span>
            <span aria-hidden="true">📄</span>
            <div>
              <b>{entry.title}</b>
              {entry.detail !== "" && (
                // `pre-wrap`: the analysis is written as prose with its own
                // paragraph breaks, and collapsing them would run a risk
                // assessment together into one unreadable block.
                <div className="screen-note" style={{ whiteSpace: "pre-wrap" }}>
                  {entry.detail}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="screen-note">{t("detail.analysis.source")}</p>
    </QueryState>
  );
}
