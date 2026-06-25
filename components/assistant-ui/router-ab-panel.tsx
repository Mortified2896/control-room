"use client";

import {
  AlertTriangleIcon,
  CheckIcon,
  Columns2Icon,
  EqualIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FC } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AbFeedbackRating } from "@/lib/repo/types";
import type { ReasoningLevel } from "@/lib/providers/types";
import { useAuiState } from "@assistant-ui/react";

/**
 * Public DTO that the panel consumes. It is hydrated either:
 *   - from a `data-router-ab` data part on the assistant message (live chat),
 *   - or from `GET /api/router-ab/session/[id]` (page reload re-hydration).
 *
 * Both sources produce the same shape so the panel renders identically.
 */
export type RouterAbPanelPayload = {
  sessionId: string;
  sideA: { modelId: string; reasoningLevel: ReasoningLevel };
  sideB: { modelId: string; reasoningLevel: ReasoningLevel } | null;
  shortReason: string | null;
  taskType: string | null;
  confidence: number | null;
  usedFallback: boolean;
  fallbackReason: string | null;
  skipReason: string | null;
  sideBText: string | null;
  sideBLatencyMs: number | null;
  feedback: AbFeedbackRating | null;
};

export type RouterAbPanelProps = {
  /** Initial payload, if known from the data part or `initialMessages` rehydration. */
  initialPayload?: RouterAbPanelPayload | null;
};

const FEEDBACK_OPTIONS: ReadonlyArray<{
  rating: AbFeedbackRating;
  label: string;
  icon: FC<{ className?: string }>;
}> = [
  { rating: "prefer_a", label: "Prefer A", icon: ThumbsUpIcon },
  { rating: "prefer_b", label: "Prefer B", icon: SparklesIcon },
  { rating: "tie", label: "Tie", icon: EqualIcon },
  { rating: "bad_router", label: "Bad router", icon: ThumbsDownIcon },
];

export const RouterAbPanel: FC<RouterAbPanelProps> = ({ initialPayload }) => {
  const [payload, setPayload] = useState<RouterAbPanelPayload | null>(initialPayload ?? null);
  const [submittingRating, setSubmittingRating] = useState<AbFeedbackRating | null>(null);

  // Live data parts from the assistant-ui runtime state. The data-router-ab
  // and data-router-ab-side-b parts are attached to the assistant message
  // when /api/chat emits them; reading them here keeps the panel reactive
  // without a network round-trip.
  const liveParts = useAuiState((s) => s.message.parts);
  // Derive the effective payload from the live parts, falling back to the
  // initial payload (from persisted initial messages) when the live state
  // has not yet produced a data-router-ab part.
  const livePayload = useMemo(() => payloadFromMessageParts(liveParts), [liveParts]);
  useEffect(() => {
    if (!livePayload) return;
    setPayload((prev) => {
      // Prefer live state when it has more recent data (e.g. Side B text)
      // than the initial payload.
      if (!prev) return livePayload;
      if (livePayload.sideBText && !prev.sideBText) return livePayload;
      return prev;
    });
  }, [livePayload]);

  // Extract the streamed Side A text from the message parts so the panel's
  // Side A column shows the actual answer rather than a "Streaming..."
  // placeholder. Without this the panel's left column looks half-empty
  // (the real text is rendered above by <MessagePrimitive.Parts>) and the
  // side-by-side comparison reads as broken.
  const sideAText = useMemo(() => {
    if (!Array.isArray(liveParts)) return null;
    const textParts: string[] = [];
    for (const part of liveParts) {
      // The assistant-ui internal PartState shape is the source of truth;
      // text parts carry `{ type: "text", text, state? }`. We skip parts
      // that aren't text (data-router-ab, data-router-ab-side-b, step-start, ...)
      // and join the rest with newlines so multi-paragraph answers render
      // readably in the column.
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        textParts.push(candidate.text);
      }
    }
    const joined = textParts.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }, [liveParts]);
  // While Side A is streaming, the last text part has `state: "streaming"`.
  // Use that as the "pending" signal for the Side A column so its empty
  // placeholder renders the same pulsing dot as the Side B column.
  const sideAIsStreaming = useMemo(() => {
    if (!Array.isArray(liveParts)) return false;
    for (let i = liveParts.length - 1; i >= 0; i -= 1) {
      const candidate = liveParts[i] as { type?: unknown; text?: unknown; state?: unknown };
      if (candidate.type === "text") {
        return candidate.state === "streaming";
      }
    }
    return false;
  }, [liveParts]);

  // If we only got a sessionId up front (the data part is emitted before
  // Side B resolves), re-hydrate from /api/router-ab/session/[id] so we
  // pick up Side B text + feedback on a slow connection or after reload.
  useEffect(() => {
    if (!payload) return;
    // Always re-hydrate when the session is real (has a UUID-shaped id),
    // not just when sideBText is missing. Re-hydration is what brings back
    // the persisted feedback rating after a page reload; initialPayload
    // doesn't carry the feedback.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sessionId))
      return;
    const sessionId = payload.sessionId;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/router-ab/session/${sessionId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data: {
          session?: {
            id: string;
            sideAModelId: string;
            sideAReasoningLevel: ReasoningLevel;
            sideBModelId: string | null;
            sideBReasoningLevel: ReasoningLevel | null;
            shortReason: string | null;
            taskType: string | null;
            confidence: number | null;
            usedFallback: boolean;
            fallbackReason: string | null;
            skipReason: string | null;
            sideBText: string | null;
            sideBLatencyMs: number | null;
          } | null;
          feedback?: AbFeedbackRating | null;
        } = await res.json();
        if (cancelled || !data.session) return;
        setPayload((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            sideBText: data.session!.sideBText ?? prev.sideBText,
            sideBLatencyMs: data.session!.sideBLatencyMs ?? prev.sideBLatencyMs,
            feedback: data.feedback ?? prev.feedback,
            sideB:
              data.session!.sideBModelId && data.session!.sideBReasoningLevel
                ? {
                    modelId: data.session!.sideBModelId,
                    reasoningLevel: data.session!.sideBReasoningLevel,
                  }
                : prev.sideB,
            skipReason: data.session!.skipReason ?? prev.skipReason,
          };
        });
      } catch {
        // Re-hydration failure is silent — the live data part already
        // carries the same information once Side B resolves.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run when the sessionId changes (e.g. fresh load with a new session).
    // The setter merges server state with local state, so re-running on the
    // same sessionId is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.sessionId]);

  const submitFeedback = useCallback(
    async (rating: AbFeedbackRating) => {
      if (!payload) return;
      const sessionId = payload.sessionId;
      setSubmittingRating(rating);
      const prevFeedback = payload.feedback;
      // Optimistic update.
      setPayload((p) => (p ? { ...p, feedback: rating } : p));
      try {
        const res = await fetch(`/api/router-ab/feedback`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ abSessionId: sessionId, rating }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: { rating: AbFeedbackRating } = await res.json();
        setPayload((p) => (p ? { ...p, feedback: data.rating } : p));
      } catch {
        // Roll back on error so the user can re-click.
        setPayload((p) => (p ? { ...p, feedback: prevFeedback } : p));
      } finally {
        setSubmittingRating(null);
      }
    },
    [payload],
  );

  if (!payload) return null;

  return (
    <div
      data-testid="router-ab-panel"
      data-session-id={payload.sessionId}
      // The assistant-ui action bar above uses `-mb-7.5` to "float" the
      // thumbs-up/copy/refresh icons upward so they overlap the message body
      // slightly. Our mt-3 isn't enough to clear that float, so the icons
      // and the Router A/B header end up touching. mt-10 (40px) clears the
      // 30px negative margin plus the action bar's icon height with
      // breathing room.
      className="aui-router-ab-panel mt-10 rounded-xl border border-border/60 bg-muted/20 p-3 shadow-sm"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <Columns2Icon className="size-3.5 text-muted-foreground" aria-hidden />
        <h3 className="text-xs font-semibold text-foreground">Router A/B</h3>
        {payload.usedFallback && (
          <span
            data-testid="router-ab-fallback-badge"
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
            title={payload.fallbackReason ?? "Router fallback used"}
          >
            <AlertTriangleIcon className="size-2.5" aria-hidden /> Fallback
          </span>
        )}
        {payload.taskType && (
          <span className="inline-flex items-center rounded-full border border-border/60 bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {payload.taskType}
          </span>
        )}
        {typeof payload.confidence === "number" && (
          <span className="text-[10px] text-muted-foreground">
            conf {Math.round(payload.confidence * 100)}%
          </span>
        )}
      </header>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Side
          label="Your selected model"
          labelTestId="router-ab-side-a-header"
          modelId={payload.sideA.modelId}
          reasoningLevel={payload.sideA.reasoningLevel}
          textTestId="router-ab-side-a-text"
          text={sideAText}
          emptyText="Waiting for Side A…"
          pending={sideAIsStreaming && !sideAText}
        />
        <Side
          label="Router recommendation"
          labelTestId="router-ab-side-b-header"
          modelId={payload.sideB?.modelId ?? null}
          reasoningLevel={payload.sideB?.reasoningLevel ?? null}
          textTestId="router-ab-side-b-text"
          text={payload.sideBText}
          emptyText={
            payload.skipReason
              ? "Side B was skipped for this prompt."
              : payload.sideB
                ? "Router is generating Side B…"
                : "No Side B picked."
          }
          pending={!payload.sideBText && !payload.skipReason && Boolean(payload.sideB)}
        />
      </div>

      {payload.skipReason && (
        <div
          data-testid="router-ab-skip-notice"
          className="mb-3 flex items-start gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-[11px] text-muted-foreground"
        >
          <AlertTriangleIcon className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            <strong className="text-foreground">Side B skipped.</strong>{" "}
            {humanSkipReason(payload.skipReason)}
          </span>
        </div>
      )}

      {payload.shortReason && (
        <p
          data-testid="router-ab-reason"
          className="mb-3 text-[11px] leading-relaxed text-muted-foreground"
        >
          <span className="font-medium text-foreground">Router says: </span>
          {payload.shortReason}
        </p>
      )}

      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Side-by-side feedback"
      >
        {FEEDBACK_OPTIONS.map((opt) => {
          const isActive = payload.feedback === opt.rating;
          const isSubmitting = submittingRating === opt.rating;
          const Icon = opt.icon;
          return (
            <Button
              key={opt.rating}
              type="button"
              data-testid={`router-ab-feedback-${opt.rating.replace("_", "-")}`}
              variant="ghost"
              size="xs"
              aria-pressed={isActive}
              disabled={isSubmitting}
              onClick={() => void submitFeedback(opt.rating)}
              className={cn(
                "h-7 gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
                isActive
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              {isActive ? (
                <CheckIcon className="size-3" aria-hidden />
              ) : (
                <Icon className="size-3" aria-hidden />
              )}
              <span>{opt.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
};

const Side: FC<{
  label: string;
  labelTestId: string;
  modelId: string | null;
  reasoningLevel: ReasoningLevel | null;
  textTestId: string;
  text: string | null;
  emptyText: string;
  pending?: boolean;
}> = ({ label, labelTestId, modelId, reasoningLevel, textTestId, text, emptyText, pending }) => {
  return (
    <div className="rounded-lg border border-border/60 bg-background p-2.5">
      <div data-testid={labelTestId} className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {modelId ?? "—"} · {reasoningLevel ?? "—"}
        </span>
      </div>
      <div
        data-testid={textTestId}
        className="min-h-12 whitespace-pre-wrap text-xs leading-relaxed text-foreground"
      >
        {text ? (
          text
        ) : (
          <span className={cn("italic text-muted-foreground/70", pending && "animate-pulse")}>
            {emptyText}
          </span>
        )}
      </div>
    </div>
  );
};

function humanSkipReason(reason: string): string {
  if (reason.includes("exceeds max")) {
    return "Router comparison skipped because it exceeded the configured budget.";
  }
  if (reason.includes("expensive model excluded for long prompt")) {
    return "Router comparison skipped because the prompt was too long for an expensive model.";
  }
  return reason;
}

/**
 * Build the initial panel payload from the SSE data part emitted by the
 * `/api/chat` route. Returns `null` when the data is not yet present.
 */
export function buildPanelPayloadFromDataPart(data: unknown): RouterAbPanelPayload | null {
  if (data == null || typeof data !== "object") return null;
  const d = data as {
    sessionId?: string;
    sideA?: { modelId?: string; reasoningLevel?: ReasoningLevel };
    sideB?: { modelId?: string; reasoningLevel?: ReasoningLevel } | null;
    shortReason?: string | null;
    taskType?: string | null;
    confidence?: number | null;
    usedFallback?: boolean;
    fallbackReason?: string | null;
    skipReason?: string | null;
  };
  if (
    typeof d.sessionId !== "string" ||
    d.sideA == null ||
    typeof d.sideA.modelId !== "string" ||
    typeof d.sideA.reasoningLevel !== "string"
  ) {
    return null;
  }
  return {
    sessionId: d.sessionId,
    sideA: { modelId: d.sideA.modelId, reasoningLevel: d.sideA.reasoningLevel },
    sideB:
      d.sideB && typeof d.sideB.modelId === "string" && typeof d.sideB.reasoningLevel === "string"
        ? { modelId: d.sideB.modelId, reasoningLevel: d.sideB.reasoningLevel }
        : null,
    shortReason: d.shortReason ?? null,
    taskType: d.taskType ?? null,
    confidence: typeof d.confidence === "number" ? d.confidence : null,
    usedFallback: Boolean(d.usedFallback),
    fallbackReason: d.fallbackReason ?? null,
    skipReason: d.skipReason ?? null,
    sideBText: null,
    sideBLatencyMs: null,
    feedback: null,
  };
}

/**
 * Merge a `data-router-ab-side-b` data part into the existing payload.
 * Returns a new payload object — does not mutate.
 */
export function applySideBTextToPayload(
  payload: RouterAbPanelPayload,
  data: unknown,
): RouterAbPanelPayload {
  if (data == null || typeof data !== "object") return payload;
  const d = data as { sessionId?: string; sideBText?: string; sideBLatencyMs?: number };
  if (typeof d.sessionId !== "string" || d.sessionId !== payload.sessionId) return payload;
  return {
    ...payload,
    sideBText: typeof d.sideBText === "string" ? d.sideBText : payload.sideBText,
    sideBLatencyMs:
      typeof d.sideBLatencyMs === "number" ? d.sideBLatencyMs : payload.sideBLatencyMs,
  };
}

/**
 * Build a payload from a `/api/router-ab/session/[id]` response. Used on
 * page reload when the live SSE stream is gone.
 */
export function buildPanelPayloadFromSessionResponse(data: unknown): RouterAbPanelPayload | null {
  if (data == null || typeof data !== "object") return null;
  const d = data as {
    session?: {
      id: string;
      sideAModelId: string;
      sideAReasoningLevel: ReasoningLevel;
      sideBModelId: string | null;
      sideBReasoningLevel: ReasoningLevel | null;
      shortReason: string | null;
      taskType: string | null;
      confidence: number | null;
      usedFallback: boolean;
      fallbackReason: string | null;
      skipReason: string | null;
      sideBText: string | null;
      sideBLatencyMs: number | null;
    } | null;
    feedback?: AbFeedbackRating | null;
  };
  if (!d.session) return null;
  const s = d.session;
  return {
    sessionId: s.id,
    sideA: { modelId: s.sideAModelId, reasoningLevel: s.sideAReasoningLevel },
    sideB:
      s.sideBModelId && s.sideBReasoningLevel
        ? { modelId: s.sideBModelId, reasoningLevel: s.sideBReasoningLevel }
        : null,
    shortReason: s.shortReason,
    taskType: s.taskType,
    confidence: typeof s.confidence === "number" ? s.confidence : null,
    usedFallback: Boolean(s.usedFallback),
    fallbackReason: s.fallbackReason,
    skipReason: s.skipReason,
    sideBText: s.sideBText,
    sideBLatencyMs: typeof s.sideBLatencyMs === "number" ? s.sideBLatencyMs : null,
    feedback: d.feedback ?? null,
  };
}

/**
 * Walk the parts of an assistant message looking for our router A/B data
 * parts. Returns the latest merged payload, or null if no data part was
 * found yet.
 *
 * We can't rely on `useAssistantDataUI` because (a) it requires a global
 * data-part registration that interferes with the rest of the app and
 * (b) the message may have both a `router-ab` and a `router-ab-side-b`
 * data part emitted at different times — merging them in one place keeps
 * the panel simple.
 */
export function payloadFromMessageParts(
  parts: ReadonlyArray<{ type: string; name?: string; data?: unknown }>,
): RouterAbPanelPayload | null {
  let payload: RouterAbPanelPayload | null = null;
  for (const part of parts) {
    // assistant-ui normalizes data parts to `{ type: "data", name, data }`
    // regardless of the wire-format `data-${name}` type.
    if (part.type === "data" && part.name === "router-ab") {
      const next = buildPanelPayloadFromDataPart(part.data);
      if (next) payload = next;
    } else if (part.type === "data" && part.name === "router-ab-side-b" && payload) {
      payload = applySideBTextToPayload(payload, part.data);
    }
  }
  return payload;
}

void useMemo; // keep import for future memoization hooks
