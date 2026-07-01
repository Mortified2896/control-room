"use client";

import type { FC } from "react";
import { BrainCircuit, Info } from "lucide-react";

/**
 * Router/recommender engines callout.
 *
 * Rendered at the very top of the Router Settings page, above all
 * other content, so the user immediately understands what the page
 * controls and why these settings matter.
 *
 * Key messages:
 *   - These are DECISION ENGINES, not chat execution models.
 *   - The fallback is attempted only if the primary fails.
 *   - If both fail, recommendation blocks loudly — no silent fallback.
 *   - The main chat UI does NOT expose these controls; they live here
 *     in Settings.
 */

export const RouterEnginesCallout: FC = () => {
  return (
    <div
      className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4"
      data-testid="router-engines-callout"
      role="note"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/20">
          <BrainCircuit className="size-4 text-blue-600 dark:text-blue-400" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-sm font-semibold text-blue-700 dark:text-blue-300">
            Router/recommender engines
          </h2>
          <p className="text-xs text-muted-foreground">
            These are <strong className="font-medium">decision engines</strong> — they read your
            prompt and recommend a chat execution model. They are{" "}
            <em>not</em> the model that answers your question.
          </p>
          <div className="space-y-1.5">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0 text-blue-500" aria-hidden />
              <span>
                <strong className="font-medium">Primary engine</strong>: first recommender tried for
                every chat send. Codex subscription is the safe default.
              </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0 text-blue-500" aria-hidden />
              <span>
                <strong className="font-medium">Fallback engine</strong>: attempted only if the
                primary recommender fails. If both fail, recommendation{" "}
                <strong className="font-medium">blocks loudly</strong> — no silent substitution.
              </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0 text-blue-500" aria-hidden />
              <span>
                <strong className="font-medium">Coding harness</strong>: uses the same routing
                settings unless a separate coding lane is configured. See the coding model routing
                section below.
              </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0 text-blue-500" aria-hidden />
              <span>
                <strong className="font-medium">Long-prompt lane</strong>: when enabled, the router
                selects a separate lane for prompts exceeding the token threshold. See the lane
                selector explanation in the legacy A/B section below.
              </span>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Edit the engine, fallback, and reasoning/thinking options in the{" "}
            <strong className="font-medium text-foreground">Recommender engine</strong> section
            below. Provider model discovery lives further down the page.
          </p>
        </div>
      </div>
    </div>
  );
};
