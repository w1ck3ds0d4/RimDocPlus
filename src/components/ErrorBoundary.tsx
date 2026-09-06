import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Catches a render crash and shows it.
 *
 * Without this a thrown render blanks the page, which says nothing about what broke. A
 * tool whose whole job is explaining failures should not fail silently itself.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? "" });
    console.error("RimDoc+ render error", error, info);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <main>
        <div className="empty">
          <h2>Something in the interface threw</h2>
          <p>
            The analysis itself is unaffected, and nothing on your install has been touched. This is the
            error, verbatim.
          </p>
          <code style={{ whiteSpace: "pre-wrap" }}>
            {error.name}: {error.message}
          </code>
          {stack && (
            <details className="trace" open>
              <summary>
                Component stack
                <span className="trace-meta">where it was rendering</span>
              </summary>
              <div className="trace-body">
                <code style={{ whiteSpace: "pre-wrap" }}>{stack.trim()}</code>
              </div>
            </details>
          )}
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="btn" type="button" onClick={() => this.setState({ error: null, stack: "" })}>
              Try again
            </button>
            <button className="btn" type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </main>
    );
  }
}
