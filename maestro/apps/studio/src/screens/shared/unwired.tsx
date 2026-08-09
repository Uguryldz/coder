import type { ReactNode } from "react";
import { ApiError } from "../../api/errors.ts";
import { NotAvailable, QueryState } from "./QueryState.tsx";

/**
 * Renders a screen section whose BFF read model may not exist yet.
 *
 * Several cluster C screens are written against endpoints the BFF has not built
 * (the write surfaces were deliberately deferred; the read models for variants,
 * eval, cache, greenfield, routing, pii and the decision ledger are simply not
 * there yet). Those routes answer 404.
 *
 * A plain 404 renders through the error path as "record not found", which tells
 * the operator the wrong thing: the record is not missing, the endpoint was
 * never built. This wrapper distinguishes the two — a 404/501 becomes cluster
 * A's `<NotAvailable>` ("not published yet, deliberately blank rather than
 * invented"), while every other failure keeps its translated error.
 *
 * The screens behind this are complete. When a route lands, its screen starts
 * rendering real data with no further change; nothing here needs deleting.
 *
 * NOTE this is a presentation fallback, not a pretence that the call succeeded:
 * no placeholder rows are shown, and the request is still made, so the moment
 * the server answers the screen is live.
 */
export interface MaybeUnwiredProps {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly isEmpty?: boolean;
  readonly emptyTitle?: string;
  readonly onRetry?: (() => void) | undefined;
  readonly skeletonRows?: number;
  readonly children: ReactNode;
}

/** True when a failure means "this endpoint does not exist", not "it broke". */
export function isNotBuilt(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}

export function MaybeUnwired({
  isPending,
  error,
  isEmpty = false,
  emptyTitle,
  onRetry,
  skeletonRows = 4,
  children,
}: MaybeUnwiredProps): ReactNode {
  if (!isPending && isNotBuilt(error)) return <NotAvailable />;

  return (
    <QueryState
      isPending={isPending}
      error={error}
      isEmpty={isEmpty}
      {...(emptyTitle === undefined ? {} : { emptyTitle })}
      {...(onRetry === undefined ? {} : { onRetry })}
      skeletonRows={skeletonRows}
    >
      {children}
    </QueryState>
  );
}
