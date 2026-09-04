import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** Already-translated labels; absent when the boundary sits outside I18n. */
export interface ErrorBoundaryLabels {
  readonly title: string;
  readonly hint: string;
  readonly back: string;
}

interface Props {
  readonly children: ReactNode;
  /**
   * Changing this value clears a caught error. The Shell passes the route
   * path, so a screen that threw does not keep the NEXT screen dark: the
   * operator picks another menu entry and gets a working page.
   */
  readonly resetKey?: string;
  readonly labels?: ErrorBoundaryLabels;
  /** "Geri dön": what the back button does. Absent = no button. */
  readonly onBack?: () => void;
}

interface State {
  readonly error: Error | null;
}

/**
 * Catches render failures — most importantly MissingMessageError, thrown when a
 * screen asks for a catalog key nobody wrote. The catalog fails loudly by
 * design (no silent fallback to the key name), so this boundary is what turns
 * that throw into a visible red panel instead of a blank page.
 *
 * Two instances exist: one around the whole app (App.tsx, the last resort, no
 * labels because I18n may be the thing that broke) and one around the Shell's
 * <Outlet> (per screen, resets on navigation, offers "geri dön"). The second
 * is the one that matters day to day: before it existed one screen's missing
 * key turned the entire console red until a full reload.
 *
 * The message shown here is the ONE place raw English text is allowed: if the
 * catalog itself is broken, a catalog lookup cannot describe the problem. The
 * detail is scoped to match — a broken catalog needs the missing KEY on screen,
 * and a key is a build-time identifier we wrote ourselves. Every other error
 * shows its class and nothing more: an `ApiError`'s message is
 * `api ${status} ${code}`, and an HTTP status is not an end user's business.
 * The full error still goes to the console for an operator with devtools open.
 */

/** Names whose `message` is safe and necessary to show — see the note above. */
const DETAILED_ERRORS: readonly string[] = ["MissingMessageError"];

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[studio] render failed", error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const { labels, onBack } = this.props;

    return (
      <div role="alert" className="ui-errorpanel">
        {/*
          Bilingual fallback, hard-coded on purpose: this panel is what shows
          when the CATALOG is broken, so it cannot rely on `t()` — a lookup is
          exactly the thing that just failed. When labels ARE available (the
          per-screen boundary) they are used instead.
        */}
        {labels === undefined ? (
          <>
            <strong lang="tr">Studio bu ekranı görüntüleyemedi.</strong>
            <br />
            <strong lang="en">Studio failed to render this screen.</strong>
          </>
        ) : (
          <>
            <strong>{labels.title}</strong>
            <p className="ui-errorpanel__hint">{labels.hint}</p>
          </>
        )}
        <pre className="ui-errorpanel__detail">
          {DETAILED_ERRORS.includes(error.name) ? `${error.name}: ${error.message}` : error.name}
        </pre>
        {onBack !== undefined && (
          <button type="button" className="ui-btn ui-btn--sm" onClick={onBack}>
            {labels?.back ?? "Geri dön / Go back"}
          </button>
        )}
      </div>
    );
  }
}
