import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button } from "../../ui/index.ts";

/**
 * Cursor paging for the BFF's `{ items, nextCursor }` envelope.
 *
 * The server hands out an opaque cursor for the NEXT page only, so "previous"
 * is remembered here: every cursor the operator moved past is kept on a stack
 * and popped to go back. `reset()` returns to page one — a changed filter is a
 * different question, and the old cursor would page through the wrong answer.
 */
export interface CursorPager {
  /** Cursor for the page currently shown; null is page one. */
  readonly cursor: string | null;
  readonly hasPrev: boolean;
  readonly next: (nextCursor: string) => void;
  readonly prev: () => void;
  readonly reset: () => void;
}

export function useCursorPager(): CursorPager {
  const [stack, setStack] = useState<readonly (string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  return {
    cursor,
    hasPrev: stack.length > 0,
    next: (nextCursor) => {
      setStack([...stack, cursor]);
      setCursor(nextCursor);
    },
    prev: () => {
      const previous = stack.at(-1);
      setStack(stack.slice(0, -1));
      setCursor(previous ?? null);
    },
    reset: () => {
      setStack([]);
      setCursor(null);
    },
  };
}

export interface PagerProps {
  readonly pager: CursorPager;
  /** The cursor the current page returned; null means this is the last page. */
  readonly nextCursor: string | null | undefined;
  readonly busy?: boolean;
}

/** Two buttons and nothing else; hidden entirely when there is only one page. */
export function Pager({ pager, nextCursor, busy = false }: PagerProps): ReactNode {
  const t = useT();
  const hasNext = nextCursor !== null && nextCursor !== undefined;
  if (!pager.hasPrev && !hasNext) return null;
  return (
    <nav className="scr-row" aria-label={t("audit.pager.label")} style={{ justifyContent: "flex-end", padding: "8px 14px" }}>
      <Button size="sm" disabled={!pager.hasPrev || busy} onClick={pager.prev}>
        {t("audit.pager.prev")}
      </Button>
      <Button size="sm" disabled={!hasNext || busy} onClick={() => hasNext && pager.next(nextCursor)}>
        {t("audit.pager.next")}
      </Button>
    </nav>
  );
}
