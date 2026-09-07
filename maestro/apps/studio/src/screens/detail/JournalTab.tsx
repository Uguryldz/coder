import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { JournalActor, JournalEntry } from "@maestro/contracts";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { Badge } from "../../ui/index.ts";
import { QueryState } from "../shared/QueryState.tsx";
import { dateTimeLabel } from "../shared/format.ts";
import { useJournal, useRunDetail } from "../shared/runs.ts";
import { recentErrorsOf } from "./run-state.ts";

/**
 * The append-only ticket journal (M30) — the raw material of the evidence
 * package and the source of the living summary.
 *
 * Reads `GET /studio/runs/:ticket/journal`, which returns the shared page
 * envelope `{ items, nextCursor }`. Only the first page is rendered today; the
 * cursor is deliberately not followed, because silently concatenating pages
 * would make "the journal" mean a different number of entries on every render.
 * A failed request renders the translated error — never a fabricated history.
 *
 * Error lines are marked: every `handover` entry, and every entry the detail
 * header lists under `recentErrors` — the same lines the step list shows, so
 * the two tabs never disagree about which entry was "the error". The
 * classification itself lives in the BFF (`isErrorEntry`) and is not repeated
 * here.
 */

const ACTOR_ICON: Readonly<Record<JournalActor, string>> = {
  ai: "🤖",
  human: "👤",
  system: "⚙",
};

const ACTORS: readonly (JournalActor | "all")[] = ["all", "ai", "human", "system"];

export function JournalTab({ ticket }: { readonly ticket: string }): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const [actor, setActor] = useState<JournalActor | "all">("all");
  const { data, isPending, error, refetch } = useJournal(ticket);
  // Already in the cache: the detail screen fetched it to render its header.
  const { data: detail } = useRunDetail(ticket);
  const errorSeqs = useMemo(
    () => new Set((detail === undefined ? [] : recentErrorsOf(detail)).map((e) => e.seq)),
    [detail],
  );

  const entries = useMemo(() => data?.items ?? [], [data]);
  const rows = useMemo(
    () => (actor === "all" ? entries : entries.filter((entry) => entry.actor === actor)),
    [entries, actor],
  );

  const counts = useMemo(
    () => ({
      all: entries.length,
      ai: entries.filter((entry) => entry.actor === "ai").length,
      human: entries.filter((entry) => entry.actor === "human").length,
      system: entries.filter((entry) => entry.actor === "system").length,
    }),
    [entries],
  );

  return (
    <QueryState
      isPending={isPending}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={entries.length === 0}
      emptyTitle={t("journal.empty")}
      emptyDescription={t("journal.empty_hint")}
    >
      <div className="scr-stack">
      <div className="scr-filters">
        {ACTORS.map((id) => (
          <button
            key={id}
            type="button"
            className="scr-chip"
            aria-pressed={actor === id}
            onClick={() => setActor(id)}
          >
            {t(`journal.actor.${id}`, { n: String(counts[id]) })}
          </button>
        ))}
      </div>

      <div className="scr-journal">
        {rows.map((entry) => (
          <JournalRow
            key={`${entry.runId}-${entry.seq}`}
            entry={entry}
            locale={locale}
            isError={entry.kind === "handover" || errorSeqs.has(entry.seq)}
          />
        ))}
      </div>
      <p className="scr-hint">{t("journal.append_only")}</p>
      </div>
    </QueryState>
  );
}

function JournalRow({
  entry,
  locale,
  isError,
}: {
  readonly entry: JournalEntry;
  readonly locale: string;
  readonly isError: boolean;
}): ReactNode {
  const t = useT();
  return (
    <div className="scr-journal__row">
      <span className="scr-hint scr-mono">{dateTimeLabel(entry.at, locale)}</span>
      <span aria-label={t(`journal.actor.${entry.actor}.label`)} title={t(`journal.actor.${entry.actor}.label`)}>
        {ACTOR_ICON[entry.actor]}
      </span>
      <div>
        <div className="scr-row">
          <b>{entry.title}</b>
          {isError && <Badge tone="red">{t("journal.error_badge")}</Badge>}
        </div>
        {entry.detail !== "" && (
          // An error's detail is the explanation; it wraps and is never cut.
          <div
            className={isError ? undefined : "scr-hint"}
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {entry.detail}
          </div>
        )}
      </div>
    </div>
  );
}
