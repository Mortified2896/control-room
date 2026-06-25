"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Error boundary for the Router A/B panel.
 *
 * The panel reads `useAuiState((s) => s.message.parts)` and rehydrates
 * `GET /api/router-ab/session/[id]`. If a persisted `data-router-ab`
 * part from an older schema fails to validate, or if any other panel
 * helper throws, we want to keep the rest of the chat UI working rather
 * than ship a white blank page.
 *
 * The fallback is a small unobtrusive notice that says the panel is
 * temporarily unavailable — the chat thread keeps rendering above
 * unchanged.
 */
export class PanelErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[RouterAbPanel] crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          data-testid="router-ab-panel-error"
          className="aui-router-ab-panel-error mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-700 dark:text-amber-300"
          role="alert"
        >
          Router A/B panel hit an error and is unavailable for this message. Side A still streamed
          normally; click{" "}
          <button
            type="button"
            className="underline"
            onClick={() => this.setState({ error: null })}
          >
            retry
          </button>{" "}
          to re-render the panel.
        </div>
      );
    }
    return this.props.children;
  }
}
