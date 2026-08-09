import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
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
 * The message shown here is the ONE place raw English text is allowed: if the
 * catalog itself is broken, a catalog lookup cannot describe the problem.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[studio] render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          margin: 20,
          padding: 16,
          border: "1px solid var(--red)",
          background: "var(--red-bg)",
          color: "var(--red)",
          borderRadius: 9,
          fontSize: 13,
        }}
      >
        <strong>Studio failed to render this screen.</strong>
        <pre style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
          {error.name}: {error.message}
        </pre>
      </div>
    );
  }
}
