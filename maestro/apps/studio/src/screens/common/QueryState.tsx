import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, EmptyState, Skeleton } from "../../ui/index.ts";

export interface QueryStateProps {
  readonly isPending: boolean;
  readonly error: unknown;
  /** Re-runs the query; wired to the retry button in the failure state. */
  readonly onRetry?: () => void;
  /** Rows shown while loading. */
  readonly skeletonRows?: number;
  /** Rendered only once the query has succeeded. */
  readonly children: ReactNode;
}

/**
 * The three states every screen owes the operator — loading, failed, loaded —
 * written once so no screen forgets the middle one.
 *
 * The failure branch prints `t(messageKeyOf(error))` and nothing else: the BFF
 * answers a failure with `{error:"<code>"}`, and a screen that rendered that
 * code (or any server string) would be leaking machine text into a bank's
 * operator console. `messageKeyOf` maps unknown codes to `error.unexpected`, so
 * there is no path where raw text reaches the DOM.
 */
export function QueryState({
  isPending,
  error,
  onRetry,
  skeletonRows = 5,
  children,
}: QueryStateProps): ReactNode {
  const t = useT();

  if (error !== null && error !== undefined) {
    return (
      <EmptyState
        icon="⚠"
        title={t(messageKeyOf(error))}
        {...(onRetry
          ? {
              action: (
                <Button variant="primary" size="sm" onClick={onRetry}>
                  {t("action.retry")}
                </Button>
              ),
            }
          : {})}
      />
    );
  }

  if (isPending) return <Skeleton rows={skeletonRows} />;

  return <>{children}</>;
}
