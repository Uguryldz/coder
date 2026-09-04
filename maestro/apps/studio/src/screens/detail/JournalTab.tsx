import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { JournalActor, JournalEntry } from "@maestro/contracts";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { QueryState } from "../shared/QueryState.tsx";
import { dateTimeLabel } from "../shared/format.ts";
import { useJournal } from "../shared/runs.ts";

/**
 * The append-only ticket journal (M30) — the raw material of the evidence
 * package and the source of the living summary.
 *
 * Reads `GET /studio/runs/:ticket/journal`, which returns the shared page
 * envelope `{ items, nextCursor }`. Only the first page is rendered today; the
 * cursor is deliberately not followed, because silently concatenating pages
 * would make "the journal" mean a different number of entries on every render.
 * A failed request renders the translated error — never a fabricated history.
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
          <JournalRow key={`${entry.runId}-${entry.seq}`} entry={entry} locale={locale} />
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
}: {
  readonly entry: JournalEntry;
  readonly locale: string;
}): ReactNode {
  const t = useT();
  return (
    <div className="scr-journal__row">
      <span className="scr-hint scr-mono">{dateTimeLabel(entry.at, locale)}</span>
      <span aria-label={t(`journal.actor.${entry.actor}.label`)} title={t(`journal.actor.${entry.actor}.label`)}>
        {ACTOR_ICON[entry.actor]}
      </span>
      <div>
        <b>{entry.title}</b>
        {entry.detail !== "" && <div className="scr-hint">{entry.detail}</div>}
      </div>
    </div>
  );
}
