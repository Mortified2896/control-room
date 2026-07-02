import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { RouterAbPanel, payloadFromMessageParts } from "@/components/assistant-ui/router-ab-panel";
import { PanelErrorBoundary } from "@/components/assistant-ui/panel-error-boundary";
import { Button } from "@/components/ui/button";
import { KbdHint } from "@/components/kbd-hint";
import { RecommenderToggle } from "@/components/assistant-ui/router-ab-controls";
import { cn } from "@/lib/utils";
import {
  formatRoutingDecisionMarkdown,
  routingDecisionAuditId,
  routingDecisionPart,
  routingDecisionTextPart,
  routingDecisionFromMessage,
  type RoutingDecisionPayload,
} from "@/lib/assistant-ui/routing-decision";
import { SHORTCUT_TARGETS } from "@/lib/shortcuts";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  Loader2,
  MessageCircleIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { flushSync } from "react-dom";

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

type NoteResponse = {
  note: { threadId: string; body: string; createdAt: string; updatedAt: string } | null;
  configured?: boolean;
};

type ThreadMode = "chat" | "coding_task";
type HandoffWorker = "pi" | "codex" | "opencode" | "minimax";
type HandoffTaskType = "implement" | "debug" | "inspect" | "refactor" | "test" | "review";

/**
 * Generic coding-harness id, mirroring `lib/harness/registry.ts`.
 * Used by the Composer + the generic harness approval card so the
 * UI can render Codex CLI / MiniMax CLI side-by-side.
 */
type CodingHarnessId = "codex_cli" | "minimax_cli";

/**
 * Snapshot of one registered coding harness as surfaced by the
 * `/api/coding-runs` GET handler (which itself calls
 * `probeHarnessStatuses()` server-side). The composer reads this to
 * render the Send-to-<harness> button enabled / disabled state.
 */
type HarnessRegistryView = {
  id: CodingHarnessId;
  displayName: string;
  providerPath: string;
  billingPath: string;
  requiresProjectFolder: boolean;
  canModifyFiles: boolean;
  supportsTokenUsage: boolean;
  supportsReasoningLevels: boolean;
  defaultModelId: string;
  allowedModelIds: ReadonlyArray<string>;
  defaultReasoningLevel: string;
  status: "available" | "unavailable" | "unknown";
  unavailableReason: string | null;
};

/**
 * Result of the generic coding-harness recommender
 * (`/api/coding-harness/recommend`). Drives the generic harness
 * approval card.
 */
type CodingHarnessRecommendation = {
  taskType: "coding" | "debugging" | "repo_edit" | "code_review" | "other";
  executionTarget: "coding_harness";
  recommendedHarness: CodingHarnessId;
  recommendedModelId: string;
  recommendedReasoningLevel: string;
  reason: string;
  requiresProjectFolder: true;
  requiresUserApproval: true;
  alternatives: Array<{
    harness: CodingHarnessId;
    modelId: string;
    reasoningLevel: string;
    reason: string;
  }>;
  fallback?: boolean;
  fallbackReason?: "model_not_listed" | "provider_call_failed" | "no_harness_available" | null;
};
/**
 * Provider-native reasoning-effort value (`"low"`, `"medium"`,
 * `"xhigh"`, `"none"`, etc.). The chat composer stores the
 * recommender's pick as this string and renders it via the chat
 * composer picker — the runtime adapter validates it against the
 * model's `reasoningCapability.options`.
 */
type ReasoningLevel = string;

type PendingRecommendedSend = { id: number; text: string };

type ProjectSummary = { id: string; name: string; localPath: string; repoPath?: string | null };

type RecommendationEta = {
  expected_latency_ms: number;
  upper_latency_ms: number;
  estimate_quality: "likely" | "uncertain" | "rough";
  started_at: string;
};

type DecisionErrorType =
  | "usage_limit"
  | "auth"
  | "provider_disabled"
  | "network"
  | "schema_parse"
  | "schema_validation"
  | "empty_output"
  | "provider_configuration_error"
  | "not_attempted"
  | "unknown";

type RouterDecisionErrorDetails = {
  primary_recommender_model_id: string | null;
  primary_provider_path: "openai" | "codex" | "minimax" | "unknown";
  primary_error_type: DecisionErrorType | null;
  primary_error_message_safe: string | null;
  fallback_recommender_model_id: string | null;
  fallback_provider_path: "openai" | "codex" | "minimax" | "unknown" | null;
  fallback_attempted: boolean;
  fallback_error_type: DecisionErrorType | null;
  fallback_error_message_safe: string | null;
  final_decision_source: "model" | "manual_after_model_error";
};

type RouterDecision = {
  runId: string | null;
  prompt: string;
  decision: "normal_chat" | "coding_task" | null;
  reason: string;
  ambiguity?: "low" | "medium" | "high" | null;
  signals?: string[];
  decision_source?: "model" | "manual_after_model_error";
  recommender_model_id?: string | null;
  /**
   * Structured per-rung failure trace from `/api/router/decision`.
   * The failure card renders this so the user can see whether
   * the fallback was attempted, which model handled the call,
   * and the sanitized error reason. Never contains secrets.
   */
  error_details?: RouterDecisionErrorDetails;
  estimate_quality: "likely" | "uncertain" | "rough";
  expected_latency_ms: number;
  upper_latency_ms: number;
  started_at: string;
};

type ModelRecommendation = {
  recommendedModelId: string;
  recommendedProvider: string;
  recommendedReasoningLevel: ReasoningLevel | null;
  reasoning: string;
  proposedSubscriptionFallbacks?: Array<{
    toModelId: string;
    toProviderId: string;
    displayLabel: string;
    reason: string;
  }>;
  loudFailure?: boolean;
  recommendationTelemetry?: RecommendationEta & {
    completed_at: string | null;
    actual_latency_ms: number | null;
    latency_deviation_ms: number | null;
    latency_deviation_pct: number | null;
    latency_result: string | null;
  };
  diagnostics?: { fallback?: boolean; fallbackReason?: string | null; recommenderModelId?: string };
};

export const Thread: FC<{
  threadId: string | null;
  activeProjectId?: string | null;
  activeProject?: ProjectSummary | null;
  threadMode?: ThreadMode;
  harness?: HandoffWorker | null;
  notesDisabled?: boolean;
  workflowContent?: ReactNode;
  showWelcome?: boolean;
  routerAbOn?: boolean;

  /**
   * When `true`, the chat composer intercepts the Send action and
   * fetches a model recommendation before letting the message go
   * through. The Accept/Decline buttons in the recommendation banner
   * then automatically trigger the actual send.
   *
   * When `false`, the composer behaves like a normal chat composer:
   * the user's manual model selection is used directly.
   */
  recommenderEnabled?: boolean;
  onToggleRecommender?: (next: boolean) => void;
  routerDecision?: RouterDecision | null;
  routerDecisionLoading?: boolean;
  routerDecisionEta?: RecommendationEta | null;
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  recommendationEta?: RecommendationEta | null;
  manualModelSummary?: string;
  recommenderEngineSummary?: string;
  fallbackEngineSummary?: string;
  onDecisionAction?: (
    action: "approved" | "corrected_to_coding_task" | "corrected_to_normal_chat" | "canceled",
    comment: string,
  ) => void;
  onRecommend?: (message: string) => void;
  onManualRoutingDecision?: (message: string) => RoutingDecisionPayload | null;
  onUseRecommendation?: (draftText?: string) => void;
  onKeepCurrent?: (draftText?: string) => void;
  pendingRecommendedSend?: PendingRecommendedSend | null;
  onPendingRecommendedSendConsumed?: (id: number) => void;
  /**
   * Routing decision the parent has already built for the next send.
   * Consumed (and captured into a local ref) right before
   * `composer.send()` runs, so the client can insert it as its own
   * assistant message bubble between the user message and the streamed
   * model output. Reading this prop inside `thread.runStart` directly
   * would race with the transport's `prepareSendMessagesRequest`
   * callback, which clears it synchronously after `sendMessage`.
   */
  pendingRoutingDecision?: RoutingDecisionPayload | null;
  /**
   * Called by the parent (ChatPane) after the transport has built the
   * request body containing the routing decision. The parent uses
   * this to clear React state that powered the one-shot ref lifecycle.
   */
  onRoutingDecisionRequestBodyPrepared?: (auditId: string | null) => void;
  onEnsureCodingThread?: () => Promise<string | null>;
  onCodingRunComplete?: (threadId: string | null) => void;
  /**
   * Live harness registry snapshot fetched by the parent. When
   * provided, the composer renders the Send-to-<harness> button
   * enabled/disabled according to the harness `status` field and
   * surfaces a clear reason when no harness is available.
   */
  harnessRegistry?: ReadonlyArray<HarnessRegistryView> | null;
  /**
   * Harness recommendation from `/api/coding-harness/recommend`,
   * shown after the user approves the first decision gate as a
   * coding task. Drives the generic harness approval card.
   */
  codingHarnessRecommendation?: CodingHarnessRecommendation | null;
  codingHarnessRecommendationLoading?: boolean;
  codingHarnessRecommendationEta?: RecommendationEta | null;
  /**
   * Sanitized error message from `/api/coding-harness/recommend`.
   * When set, the harness approval card renders a loud-failure
   * state ("Coding harness recommendation failed: <reason>")
   * instead of leaving the user stuck in the intermediate state
   * with no Send button. Never contains API keys.
   */
  codingHarnessRecommendationError?: string | null;
  /**
   * Set by the parent when the user approved / corrected the
   * router decision to `coding_task`. The composer uses this to
   * distinguish the "intermediate state" (decision approved,
   * harness not yet picked) from the legacy Codex-pill path
   * (thread opened directly as coding_task). In the intermediate
   * state we:
   *   - Hide the legacy handoff-draft button, which would
   *     otherwise fire "This coding task thread is missing a
   *     harness." when clicked.
   *   - Surface the harness approval card / loader / failure UI
   *     so the user can pick Codex CLI or MiniMax CLI.
   */
  decisionApproved?: "coding_task" | null;
  /**
   * Send-to-coding-harness action. The parent owns the API call so
   * the composer can stay UI-only. The composer reports the user
   * pick (which harness, which model, which reasoning level) and the
   * parent decides whether to dispatch through Codex CLI or
   * MiniMax CLI.
   */
  onSendToCodingHarness?: (input: {
    harnessId: CodingHarnessId;
    modelId: string;
    reasoningLevel: string;
  }) => void;
  /**
   * Triggered when the user clicks "Answer in chat instead" on the
   * generic harness approval card. The parent should switch the
   * composer back to the normal-chat flow without consuming the
   * coding-task thread state.
   */
  onAnswerInChatInstead?: () => void;
}> = ({
  threadId,
  activeProjectId = null,
  activeProject = null,
  threadMode = "chat",
  harness = null,
  notesDisabled = false,
  workflowContent,
  showWelcome = true,
  routerAbOn = false,
  recommenderEnabled = false,
  onToggleRecommender,
  routerDecision = null,
  routerDecisionLoading = false,
  routerDecisionEta = null,
  recommendation = null,
  recommendationLoading = false,
  recommendationEta = null,
  manualModelSummary,
  recommenderEngineSummary,
  fallbackEngineSummary,
  onDecisionAction,
  onRecommend,
  onManualRoutingDecision,
  onUseRecommendation,
  onKeepCurrent,
  pendingRecommendedSend = null,
  onPendingRecommendedSendConsumed,
  pendingRoutingDecision = null,
  onRoutingDecisionRequestBodyPrepared,
  onEnsureCodingThread,
  onCodingRunComplete,
  harnessRegistry = null,
  codingHarnessRecommendation = null,
  codingHarnessRecommendationLoading = false,
  codingHarnessRecommendationEta = null,
  codingHarnessRecommendationError = null,
  decisionApproved = null,
  onSendToCodingHarness,
  onAnswerInChatInstead,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-3 pt-4 sm:px-4",
            isEmpty && showWelcome && "justify-center",
          )}
        >
          {showWelcome && (
            <AuiIf condition={isNewChatView}>
              <ThreadWelcome />
            </AuiIf>
          )}

          <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
            {workflowContent}
            <ThreadPrimitive.Messages>
              {() => (
                <ThreadMessage
                  threadId={threadId}
                  notesDisabled={notesDisabled}
                  routerAbOn={routerAbOn}
                />
              )}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer safe-bottom bg-background flex flex-col gap-4 overflow-visible pb-3 md:pb-6",
              !isEmpty && "sticky bottom-0 mt-auto rounded-t-xl",
            )}
          >
            <ThreadScrollToBottom />
            <Composer
              threadId={threadId}
              activeProjectId={activeProjectId}
              activeProject={activeProject}
              threadMode={threadMode}
              harness={harness}
              recommenderEnabled={recommenderEnabled}
              onToggleRecommender={onToggleRecommender}
              routerDecision={routerDecision}
              routerDecisionLoading={routerDecisionLoading}
              routerDecisionEta={routerDecisionEta}
              recommendation={recommendation}
              recommendationLoading={recommendationLoading}
              recommendationEta={recommendationEta}
              manualModelSummary={manualModelSummary}
              recommenderEngineSummary={recommenderEngineSummary}
              fallbackEngineSummary={fallbackEngineSummary}
              onDecisionAction={onDecisionAction}
              onRecommend={onRecommend}
              onManualRoutingDecision={onManualRoutingDecision}
              onUseRecommendation={onUseRecommendation}
              onKeepCurrent={onKeepCurrent}
              pendingRecommendedSend={pendingRecommendedSend}
              onPendingRecommendedSendConsumed={onPendingRecommendedSendConsumed}
              pendingRoutingDecision={pendingRoutingDecision}
              onRoutingDecisionRequestBodyPrepared={onRoutingDecisionRequestBodyPrepared}
              onEnsureCodingThread={onEnsureCodingThread}
              onCodingRunComplete={onCodingRunComplete}
              harnessRegistry={harnessRegistry}
              codingHarnessRecommendation={codingHarnessRecommendation}
              codingHarnessRecommendationLoading={codingHarnessRecommendationLoading}
              codingHarnessRecommendationEta={codingHarnessRecommendationEta}
              codingHarnessRecommendationError={codingHarnessRecommendationError}
              decisionApproved={decisionApproved}
              onSendToCodingHarness={onSendToCodingHarness}
              onAnswerInChatInstead={onAnswerInChatInstead}
            />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC<{
  threadId: string | null;
  notesDisabled: boolean;
  routerAbOn: boolean;
}> = ({ threadId, notesDisabled, routerAbOn }) => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return (
    <AssistantMessage threadId={threadId} notesDisabled={notesDisabled} routerAbOn={routerAbOn} />
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-xl font-semibold duration-200 sm:text-2xl">
        How can I help you today?
      </h1>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
    </div>
  );
};

function formatEta(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTimer(ms: number): string {
  return formatEta(ms);
}

function formatSeconds(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDeviation(ms: number | null | undefined, pct: number | null | undefined): string {
  if (ms == null || pct == null) return "—";
  const sign = ms >= 0 ? "+" : "";
  return `${sign}${(ms / 1000).toFixed(1)}s / ${sign}${Math.round(pct)}%`;
}

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both w-full duration-200 sm:w-auto">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto w-full justify-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-normal whitespace-normal transition-colors sm:w-auto sm:whitespace-nowrap sm:py-1.5"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC<{
  threadId: string | null;
  activeProjectId: string | null;
  activeProject: ProjectSummary | null;
  threadMode: ThreadMode;
  harness: HandoffWorker | null;
  recommenderEnabled?: boolean;
  onToggleRecommender?: (next: boolean) => void;
  routerDecision?: RouterDecision | null;
  routerDecisionLoading?: boolean;
  routerDecisionEta?: RecommendationEta | null;
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  recommendationEta?: RecommendationEta | null;
  manualModelSummary?: string;
  recommenderEngineSummary?: string;
  fallbackEngineSummary?: string;
  onDecisionAction?: (
    action: "approved" | "corrected_to_coding_task" | "corrected_to_normal_chat" | "canceled",
    comment: string,
  ) => void;
  onRecommend?: (message: string) => void;
  onManualRoutingDecision?: (message: string) => RoutingDecisionPayload | null;
  onUseRecommendation?: (draftText?: string) => void;
  onKeepCurrent?: (draftText?: string) => void;
  pendingRecommendedSend?: PendingRecommendedSend | null;
  onPendingRecommendedSendConsumed?: (id: number) => void;
  pendingRoutingDecision?: RoutingDecisionPayload | null;
  onRoutingDecisionRequestBodyPrepared?: (auditId: string | null) => void;
  onEnsureCodingThread?: () => Promise<string | null>;
  onCodingRunComplete?: (threadId: string | null) => void;
  harnessRegistry?: ReadonlyArray<HarnessRegistryView> | null;
  codingHarnessRecommendation?: CodingHarnessRecommendation | null;
  codingHarnessRecommendationLoading?: boolean;
  codingHarnessRecommendationEta?: RecommendationEta | null;
  codingHarnessRecommendationError?: string | null;
  decisionApproved?: "coding_task" | null;
  onSendToCodingHarness?: (input: {
    harnessId: CodingHarnessId;
    modelId: string;
    reasoningLevel: string;
  }) => void;
  onAnswerInChatInstead?: () => void;
}> = ({
  threadId,
  activeProjectId,
  activeProject,
  threadMode,
  harness,
  recommenderEnabled = false,
  onToggleRecommender,
  routerDecision = null,
  routerDecisionLoading = false,
  routerDecisionEta = null,
  recommendation = null,
  recommendationLoading = false,
  recommendationEta = null,
  manualModelSummary,
  recommenderEngineSummary,
  fallbackEngineSummary,
  onDecisionAction,
  onRecommend,
  onManualRoutingDecision,
  onUseRecommendation,
  onKeepCurrent,
  pendingRecommendedSend = null,
  onPendingRecommendedSendConsumed,
  pendingRoutingDecision = null,
  onRoutingDecisionRequestBodyPrepared,
  onEnsureCodingThread,
  onCodingRunComplete,
  harnessRegistry = null,
  codingHarnessRecommendation = null,
  codingHarnessRecommendationLoading = false,
  codingHarnessRecommendationEta = null,
  codingHarnessRecommendationError = null,
  decisionApproved = null,
  onSendToCodingHarness,
  onAnswerInChatInstead,
}) => {
  const aui = useAui();
  const [error, setError] = useState<string | null>(null);
  const composerText = useAuiState((s) => s.composer.text);
  // useAuiState uses useSyncExternalStore, which reads the current store value
  // synchronously. Also keep an event-driven flag so the lock engages as soon as
  // runStart fires, before any textarea mutation can race the store render.
  const storeIsRunning = useAuiState((s) => s.thread.isRunning);
  const [eventIsRunning, setEventIsRunning] = useState(false);
  const [submitLocked, setSubmitLocked] = useState(false);
  const sawAsyncWorkAfterSubmitLockRef = useRef(false);
  const asyncWorkInProgress =
    routerDecisionLoading || recommendationLoading || codingHarnessRecommendationLoading;
  useAuiEvent("thread.runStart", () => setEventIsRunning(true));
  useAuiEvent("thread.runEnd", () => {
    setEventIsRunning(false);
    setSubmitLocked(false);
    sawAsyncWorkAfterSubmitLockRef.current = false;
  });
  useEffect(() => {
    if (!submitLocked) return;
    if (asyncWorkInProgress) {
      sawAsyncWorkAfterSubmitLockRef.current = true;
      return;
    }
    if (sawAsyncWorkAfterSubmitLockRef.current && !storeIsRunning && !eventIsRunning) {
      sawAsyncWorkAfterSubmitLockRef.current = false;
      setSubmitLocked(false);
    }
  }, [asyncWorkInProgress, eventIsRunning, storeIsRunning, submitLocked]);
  const isComposerLocked =
    storeIsRunning || eventIsRunning || submitLocked || asyncWorkInProgress;
  const preventComposerMutationWhenLocked = useCallback(
    (event: { preventDefault(): void; stopPropagation(): void }) => {
      if (!isComposerLocked) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [isComposerLocked],
  );
  const preventComposerEditKeyWhenLocked = useCallback(
    (event: {
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      preventDefault(): void;
      stopPropagation(): void;
    }) => {
      if (!isComposerLocked) return;
      const key = event.key.toLowerCase();
      const mutatingShortcut = (event.ctrlKey || event.metaKey) && ["x", "v", "z", "y"].includes(key);
      if (
        key === "backspace" ||
        key === "delete" ||
        key === "enter" ||
        mutatingShortcut
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [isComposerLocked],
  );
  const isCodingTask = threadMode === "coding_task";
  const worker = isCodingTask ? harness : null;

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      onSubmit={(event) => {
        if (isCodingTask) {
          event.preventDefault();
          return;
        }
        // When the recommend-model toggle is ON, intercept Send and
        // route the current draft through the recommender first. The
        // Accept/Decline buttons in the resulting banner will then
        // trigger the actual send via `ComposerAction.pendingSendAfterRecommend`.
        // We always re-fetch (even if a banner is already showing)
        // because the user might have edited the draft text after
        // seeing the previous recommendation.
        // Engage the lock in the same event turn as submit. Waiting for
        // thread.runStart/store/loading propagation leaves a window where the
        // textarea can still process Backspace/Delete before React re-renders.
        flushSync(() => setSubmitLocked(true));
        if (recommenderEnabled && composerText.trim().length > 0 && onRecommend) {
          event.preventDefault();
          onRecommend(composerText);
          return;
        }
      }}
    >
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="bg-background border-border/60 data-[dragging=true]:border-ring data-[dragging=true]:bg-accent/50 focus-within:border-border dark:border-muted-foreground/15 dark:bg-muted/30 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-3xl border p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed dark:shadow-none"
        >
          <ComposerAttachments />
          {isCodingTask && worker ? (
            <div className="flex flex-wrap items-center gap-2 px-2 pt-1 text-xs">
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 font-medium text-primary">
                Coding task ·{" "}
                {worker === "opencode"
                  ? "OpenCode"
                  : worker === "minimax"
                    ? "MiniMax"
                    : worker === "codex"
                      ? "Codex"
                      : "Pi"}
              </span>
            </div>
          ) : null}
          <ComposerPrimitive.Input
            placeholder="Message Control Room…  (press C to focus)"
            data-shortcut-target={SHORTCUT_TARGETS.focusComposer}
            className="aui-composer-input placeholder:text-muted-foreground/70 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none sm:text-[15px]"
            rows={1}
            autoFocus
            aria-label="Message input (press C to focus)"
            aria-disabled={isComposerLocked}
            disabled={isComposerLocked}
            readOnly={isComposerLocked}
            onBeforeInputCapture={preventComposerMutationWhenLocked}
            onBeforeInput={preventComposerMutationWhenLocked}
            onInputCapture={preventComposerMutationWhenLocked}
            onChange={preventComposerMutationWhenLocked}
            onPasteCapture={preventComposerMutationWhenLocked}
            onPaste={preventComposerMutationWhenLocked}
            onCutCapture={preventComposerMutationWhenLocked}
            onCut={preventComposerMutationWhenLocked}
            onDropCapture={preventComposerMutationWhenLocked}
            onDrop={preventComposerMutationWhenLocked}
            onKeyDownCapture={preventComposerEditKeyWhenLocked}
            onKeyDown={preventComposerEditKeyWhenLocked}
          />
          <ComposerAction
            isCodingTask={isCodingTask}
            worker={worker}
            taskType="implement"
            threadId={threadId}
            activeProjectId={activeProjectId}
            activeProject={activeProject}
            onError={setError}
            recommenderEnabled={recommenderEnabled}
            onToggleRecommender={onToggleRecommender}
            routerDecision={routerDecision}
            routerDecisionLoading={routerDecisionLoading}
            routerDecisionEta={routerDecisionEta}
            recommendation={recommendation}
            recommendationLoading={recommendationLoading}
            recommendationEta={recommendationEta}
            manualModelSummary={manualModelSummary}
            recommenderEngineSummary={recommenderEngineSummary}
            fallbackEngineSummary={fallbackEngineSummary}
            onDecisionAction={onDecisionAction}
            onRecommend={onRecommend}
            onManualRoutingDecision={onManualRoutingDecision}
            onUseRecommendation={onUseRecommendation}
            onKeepCurrent={onKeepCurrent}
            pendingRecommendedSend={pendingRecommendedSend}
            onPendingRecommendedSendConsumed={onPendingRecommendedSendConsumed}
            onRoutingDecisionRequestBodyPrepared={onRoutingDecisionRequestBodyPrepared}
            onEnsureCodingThread={onEnsureCodingThread}
            onCodingRunComplete={onCodingRunComplete}
            harnessRegistry={harnessRegistry}
            codingHarnessRecommendation={codingHarnessRecommendation}
            codingHarnessRecommendationLoading={codingHarnessRecommendationLoading}
            codingHarnessRecommendationEta={codingHarnessRecommendationEta}
            codingHarnessRecommendationError={codingHarnessRecommendationError}
            decisionApproved={decisionApproved}
            onSendToCodingHarness={onSendToCodingHarness}
            onAnswerInChatInstead={onAnswerInChatInstead}
          />
          {isCodingTask && error ? (
            <div className="px-2 text-xs font-medium text-destructive" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{
  isCodingTask: boolean;
  worker: HandoffWorker | null;
  taskType: HandoffTaskType;
  threadId: string | null;
  activeProjectId: string | null;
  activeProject: ProjectSummary | null;
  onError: (message: string | null) => void;
  recommenderEnabled?: boolean;
  onToggleRecommender?: (next: boolean) => void;
  routerDecision?: RouterDecision | null;
  routerDecisionLoading?: boolean;
  routerDecisionEta?: RecommendationEta | null;
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  recommendationEta?: RecommendationEta | null;
  manualModelSummary?: string;
  recommenderEngineSummary?: string;
  fallbackEngineSummary?: string;
  onDecisionAction?: (
    action: "approved" | "corrected_to_coding_task" | "corrected_to_normal_chat" | "canceled",
    comment: string,
  ) => void;
  onRecommend?: (message: string) => void;
  onManualRoutingDecision?: (message: string) => RoutingDecisionPayload | null;
  onUseRecommendation?: (draftText?: string) => void;
  onKeepCurrent?: (draftText?: string) => void;
  pendingRecommendedSend?: PendingRecommendedSend | null;
  onPendingRecommendedSendConsumed?: (id: number) => void;
  pendingRoutingDecision?: RoutingDecisionPayload | null;
  onRoutingDecisionRequestBodyPrepared?: (auditId: string | null) => void;
  onEnsureCodingThread?: () => Promise<string | null>;
  onCodingRunComplete?: (threadId: string | null) => void;
  harnessRegistry?: ReadonlyArray<HarnessRegistryView> | null;
  codingHarnessRecommendation?: CodingHarnessRecommendation | null;
  codingHarnessRecommendationLoading?: boolean;
  codingHarnessRecommendationEta?: RecommendationEta | null;
  codingHarnessRecommendationError?: string | null;
  decisionApproved?: "coding_task" | null;
  onSendToCodingHarness?: (input: {
    harnessId: CodingHarnessId;
    modelId: string;
    reasoningLevel: string;
  }) => void;
  onAnswerInChatInstead?: () => void;
}> = ({
  isCodingTask,
  worker,
  taskType,
  threadId,
  activeProjectId,
  activeProject,
  onError,
  recommenderEnabled = false,
  onToggleRecommender,
  routerDecision = null,
  routerDecisionLoading = false,
  routerDecisionEta = null,
  recommendation = null,
  recommendationLoading = false,
  recommendationEta = null,
  manualModelSummary,
  recommenderEngineSummary,
  fallbackEngineSummary,
  onDecisionAction,
  onRecommend,
  onManualRoutingDecision,
  onUseRecommendation,
  onKeepCurrent,
  pendingRecommendedSend = null,
  onPendingRecommendedSendConsumed,
  pendingRoutingDecision = null,
  onRoutingDecisionRequestBodyPrepared,
  onEnsureCodingThread,
  onCodingRunComplete,
  harnessRegistry = null,
  codingHarnessRecommendation = null,
  codingHarnessRecommendationLoading = false,
  codingHarnessRecommendationEta = null,
  codingHarnessRecommendationError = null,
  decisionApproved = null,
  onSendToCodingHarness,
  onAnswerInChatInstead,
}) => {
  const aui = useAui();
  const pendingRoutingDecisionRef = useRef<RoutingDecisionPayload | null>(null);
  const lastAppendedRoutingAuditIdRef = useRef<string | null>(null);

  // Queue a routing decision so the next run picks it up and inserts it as
  // its own assistant message bubble BEFORE the streamed model output. This
  // is the single client-side insertion point for routing decisions; the
  // server persists the same payload as its own DB row.
  //
  // Called by:
  //   - Manual normal-chat sends via `onManualRoutingDecision` (the parent
  //     builds the payload on demand; we capture it here on click).
  //   - The recommend-accept useEffect below, which captures the parent's
  //     `pendingRoutingDecision` BEFORE `composer.send()` runs (the
  //     transport's `prepareSendMessagesRequest` clears that prop shortly
  //     after, so reading it directly inside `thread.runStart` would race).
  const queueRoutingDecision = useCallback((routingDecision: RoutingDecisionPayload | null) => {
    if (!routingDecision) return;
    if (lastAppendedRoutingAuditIdRef.current === routingDecision.auditId) return;
    pendingRoutingDecisionRef.current = routingDecision;
  }, []);
  const queueManualRoutingDecision = useCallback(
    (text: string) => {
      if (text.trim().length === 0) return;
      const routingDecision = onManualRoutingDecision?.(text) ?? null;
      queueRoutingDecision(routingDecision);
    },
    [onManualRoutingDecision, queueRoutingDecision],
  );
  const appendQueuedRoutingDecision = useCallback(() => {
    const routingDecision = pendingRoutingDecisionRef.current;
    if (!routingDecision || lastAppendedRoutingAuditIdRef.current === routingDecision.auditId) return;
    pendingRoutingDecisionRef.current = null;
    lastAppendedRoutingAuditIdRef.current = routingDecision.auditId;
    // Append as its own assistant message (separate bubble) with
    // `startRun: false` so we don't trigger another run. The message
    // carries the canonical metadata tag so the assistant-ui runtime,
    // `filterModelContextMessages`, and reload rehydration can identify
    // it without re-parsing the data part.
    aui.thread().append({
      role: "assistant",
      content: [
        routingDecisionTextPart(routingDecision) as never,
        routingDecisionPart(routingDecision) as never,
      ],
      metadata: {
        custom: {
          kind: "routing_decision",
          messageType: "routing_decision",
          includeInModelContext: false,
          auditId: routingDecision.auditId,
          routingDecision,
        },
      },
      startRun: false,
    });
  }, [aui]);
  // Append the queued routing decision the moment the run starts but
  // BEFORE the streaming assistant message is appended to the runtime's
  // message list. Inside `thread.runStart` the user's message is the
  // last entry in `chatHelpers.messages`, so the append places R
  // between user and the streaming A in the linear message tree. This
  // is what makes the live-view bubble order match the DB / reload
  // order: user → R → A.
  useAuiEvent("thread.runStart", appendQueuedRoutingDecision);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [codexRun, setCodexRun] = useState<null | {
    id: string;
    status: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    gitStatusShort?: string;
    gitDiffStat?: string;
  }>(null);
  type CodexRunResponse = {
    run?: typeof codexRun;
    userText?: string;
    assistantText?: string;
    metadata?: {
      executor?: string;
      model?: string;
      reasoning?: string;
      durationMs?: number | null;
      projectName?: string;
      projectPath?: string;
    };
    message?: string;
    error?: string;
  };
  const composerText = useAuiState((s) => s.composer.text);
  const [decisionComment, setDecisionComment] = useState("");
  useEffect(() => {
    setDecisionComment("");
  }, [routerDecision?.runId]);
  // Toggle-ON flow: after Accept/Decline the parent stores the draft
  // above ChatPane, updates the selected model, then passes the pending
  // send back down. Keeping this pending action above the runtime is
  // important: accepting a recommendation can swap between the AI SDK
  // and Codex panes, which otherwise unmounts this component and loses
  // the scheduled send.
  const lastConsumedPendingSendId = useRef<number | null>(null);

  useEffect(() => {
    if (!pendingRecommendedSend) return;
    if (lastConsumedPendingSendId.current === pendingRecommendedSend.id) return;
    lastConsumedPendingSendId.current = pendingRecommendedSend.id;

    // CAPTURE the routing decision into a local ref BEFORE
    // `composer.send()` runs. The transport's `prepareSendMessagesRequest`
    // callback fires synchronously inside `sendMessage` and clears
    // `pendingRoutingDecision` via `onRoutingDecisionRequestBodyPrepared`,
    // so reading the prop directly inside `thread.runStart` would race.
    // The runStart handler consumes `pendingRoutingDecisionRef` instead.
    queueRoutingDecision(pendingRoutingDecision ?? null);

    try {
      const composer = aui.composer();
      composer.setText(pendingRecommendedSend.text);
      composer.send();
    } catch (err) {
      // Surfacing send errors here would interrupt the user's flow;
      // the runtime already surfaces them via the assistant message
      // status. Log and bail.
      // eslint-disable-next-line no-console
      console.error("[composer] post-recommend send failed:", err);
    } finally {
      onPendingRecommendedSendConsumed?.(pendingRecommendedSend.id);
    }
  }, [pendingRecommendedSend, aui, onPendingRecommendedSendConsumed, pendingRoutingDecision, queueRoutingDecision]);

  const handleAcceptRecommendation = () => {
    onUseRecommendation?.(recommenderEnabled ? composerText : undefined);
  };

  const handleDeclineAndSendRecommendation = () => {
    onKeepCurrent?.(recommenderEnabled ? composerText : undefined);
  };

  const handleDeclineRecommendation = () => {
    onKeepCurrent?.();
  };

  const handleRecommendBeforeSend = () => {
    const text = composerText.trim();
    if (!text || !onRecommend) return;
    onRecommend(text);
  };

  const appendCodexUserMessage = (
    data: CodexRunResponse,
    fallbackUserText: string,
    metadata: {
      custom: {
        harness: Record<string, unknown>;
        codex: Record<string, unknown>;
      };
    },
  ) => {
    const userText = data.userText?.trim() || fallbackUserText;
    aui.thread().append({
      role: "user",
      content: [{ type: "text", text: userText }],
      metadata,
      startRun: false,
    });
  };

  const appendCodexAssistantMessage = (
    data: CodexRunResponse,
    fallbackUserText: string,
    metadata: {
      custom: {
        harness: Record<string, unknown>;
        codex: Record<string, unknown>;
      };
    },
  ) => {
    const userText = data.userText?.trim() || fallbackUserText;
    const assistantText = data.assistantText?.trim();
    if (!assistantText) return;
    aui.thread().append({
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      metadata,
      startRun: false,
    });
  };

  const buildCodexMetadata = (data: CodexRunResponse) => {
    const userText = data.userText?.trim() || "";
    // The new dispatcher surfaces a generic `metadata` block on the
    // response (carries harness / model / reasoning / provider /
    // billing paths). Fall back to the legacy `data.metadata` block
    // for backwards compatibility with older senders.
    const newMeta = (
      data as unknown as {
        metadata?: {
          harness?: string;
          harnessLabel?: string;
          providerPath?: string;
          billingPath?: string;
          model?: string;
          reasoning?: string;
          durationMs?: number | null;
          projectName?: string;
          projectPath?: string;
          status?: string;
          exitStatus?: number | null;
          changedFiles?: string[];
        };
      }
    ).metadata;
    const harnessLabel = newMeta?.harnessLabel ?? data.metadata?.executor ?? "Codex CLI";
    const providerPath = newMeta?.providerPath ?? "";
    const billingPath = newMeta?.billingPath ?? "";
    const model = newMeta?.model ?? data.metadata?.model ?? "CLI default";
    const reasoning = newMeta?.reasoning ?? data.metadata?.reasoning ?? "CLI default";
    const durationMs = newMeta?.durationMs ?? data.metadata?.durationMs ?? null;
    const projectName =
      newMeta?.projectName ?? data.metadata?.projectName ?? activeProject?.name ?? null;
    const projectPathMeta =
      newMeta?.projectPath ?? data.metadata?.projectPath ?? projectPath ?? null;
    const status = newMeta?.status ?? data.run?.status ?? null;
    const changedFiles = newMeta?.changedFiles ?? null;
    const harnessId = newMeta?.harness ?? null;
    const metadata = {
      custom: {
        // Generic block — read by CodexMetadataLine via the
        // `custom.harness` field.
        harness: {
          harnessId,
          harnessLabel,
          providerPath,
          billingPath,
          model,
          reasoning,
          durationMs,
          projectName,
          projectPath: projectPathMeta,
          status,
          exitStatus: newMeta?.exitStatus ?? null,
          changedFiles,
        },
        // Legacy block — kept so older persisted messages and
        // older clients that read `custom.codex` continue to work.
        codex: {
          executor: harnessLabel,
          model,
          reasoning,
          durationMs,
          projectName,
          projectPath: projectPathMeta,
          status,
        },
      },
    };
    return metadata;
  };

  /**
   * Legacy helper that mirrors the original append order (user → assistant)
   * for callers that do NOT need to interleave a routing-decision bubble.
   * Prefer `appendCodexUserMessage` + (optional routing decision) +
   * `appendCodexAssistantMessage` when the bubble order matters.
   */
  const appendCodexMessages = (data: CodexRunResponse, fallbackUserText: string) => {
    const metadata = buildCodexMetadata(data);
    appendCodexUserMessage(data, fallbackUserText, metadata);
    appendCodexAssistantMessage(data, fallbackUserText, metadata);
  };

  const createDraft = async () => {
    if (!worker) {
      onError("This coding task thread is missing a harness.");
      return;
    }
    if (!activeProjectId) {
      onError("Select a workspace project before sending a coding task.");
      return;
    }
    const instruction = composerText.trim();
    if (!instruction) return;
    setCreatingDraft(true);
    setCodexRun(null);
    onError(null);
    try {
      if (worker === "codex" || worker === "minimax") {
        const runThreadId = threadId ?? (await onEnsureCodingThread?.()) ?? null;
        const harnessId = worker === "minimax" ? "minimax_cli" : "codex_cli";
        const res = await fetch("/api/coding-runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: activeProjectId,
            threadId: runThreadId,
            prompt: instruction,
            harnessId,
          }),
        });
        const data = (await res.json().catch(() => null)) as CodexRunResponse | null;
        if (data?.run) setCodexRun(data.run);
        if (data) appendCodexMessages(data, instruction);
        onCodingRunComplete?.(runThreadId);
        aui.composer().setText("");
        if (!res.ok) {
          const message =
            data?.message ?? data?.run?.stderr ?? data?.error ?? `status ${res.status}`;
          const label = worker === "minimax" ? "MiniMax CLI" : "Codex CLI";
          onError(`${label} run failed loudly: ${message}`);
          return;
        }
        onError(null);
        return;
      }

      const res = await fetch("/api/handoffs/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          threadId,
          worker,
          taskType,
          instruction,
        }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      aui.composer().setText("");
      onError(`Handoff draft created for ${worker}. Execution is not enabled yet.`);
    } catch (err) {
      const label = worker === "minimax" ? "MiniMax CLI" : worker === "codex" ? "Codex CLI" : null;
      onError(
        err instanceof Error
          ? label
            ? `${label} run failed: ${err.message}`
            : `Failed to create handoff draft: ${err.message}`
          : label
            ? `${label} run failed.`
            : "Failed to create handoff draft.",
      );
    } finally {
      setCreatingDraft(false);
    }
  };

  // Dispatch a harness run from the generic approval card. Mirrors
  // the legacy `createDraft` path but takes the harness/model/
  // reasoning-level tuple from the parent's recommendation rather
  // than the thread's stored `harness` value. This is the entry
  // point that the post-decision harness approval card calls.
  const sendToCodingHarness = async (input: {
    harnessId: CodingHarnessId;
    modelId: string;
    reasoningLevel: string;
  }) => {
    if (!activeProjectId) {
      onError("Open a project folder before sending coding tasks to a coding harness.");
      return;
    }
    const instruction = composerText.trim();
    if (!instruction) return;
    setCreatingDraft(true);
    setCodexRun(null);
    onError(null);
    try {
      const runThreadId = threadId ?? (await onEnsureCodingThread?.()) ?? null;
      const routingDecision: RoutingDecisionPayload | null = codingHarnessRecommendation
        ? {
            kind: "routing_decision",
            messageType: "routing_decision",
            includeInModelContext: false,
            auditId: routingDecisionAuditId({
              threadId: runThreadId,
              prompt: instruction,
              route: "coding_task",
              harness: input.harnessId,
              executionModel: input.modelId,
            }),
            route: "coding_task",
            selectionSource: "recommender_output",
            harness: input.harnessId === "minimax_cli" ? "MiniMax CLI" : "Codex CLI",
            routerEngine: routerDecision?.recommender_model_id ?? null,
            recommenderEngine: routerDecision?.recommender_model_id ?? null,
            recommenderReasoningLevel: null,
            executionModel: input.modelId,
            executionReasoningLevel: input.reasoningLevel,
            fallback: {
              configured: Boolean(routerDecision?.error_details?.fallback_recommender_model_id),
              attempted: routerDecision?.error_details?.fallback_attempted ?? false,
              used: Boolean(codingHarnessRecommendation.fallback),
              engine: routerDecision?.error_details?.fallback_recommender_model_id ?? null,
              reason: codingHarnessRecommendation.fallbackReason ?? null,
            },
            whyRoute: routerDecision?.reason ?? "User accepted coding route.",
            whyHarness: codingHarnessRecommendation.reason,
            whyModel: codingHarnessRecommendation.reason,
            alternatives: codingHarnessRecommendation.alternatives,
          }
        : null;
      const res = await fetch("/api/coding-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          threadId: runThreadId,
          prompt: instruction,
          harnessId: input.harnessId,
          modelId: input.modelId,
          reasoningLevel: input.reasoningLevel,
          routingDecision,
        }),
      });
      const data = (await res.json().catch(() => null)) as CodexRunResponse | null;
      if (data?.run) setCodexRun(data.run);
      // IMPORTANT: append user → routing-decision → assistant output, in
      // that order, so the visible chat matches the DB order. The
      // routing decision is its own assistant message bubble; appending
      // it BEFORE the user message would put it ahead of the turn.
      if (data && data.assistantText?.trim()) {
        const metadata = buildCodexMetadata(data);
        appendCodexUserMessage(data, instruction, metadata);
        if (routingDecision) {
          aui.thread().append({
            role: "assistant",
            content: [
              routingDecisionTextPart(routingDecision) as never,
              routingDecisionPart(routingDecision) as never,
            ],
            metadata: {
              custom: {
                kind: "routing_decision",
                messageType: "routing_decision",
                includeInModelContext: false,
                auditId: routingDecision.auditId,
                routingDecision,
              },
            },
            startRun: false,
          });
        }
        appendCodexAssistantMessage(data, instruction, metadata);
      }
      onCodingRunComplete?.(runThreadId);
      aui.composer().setText("");
      if (!res.ok) {
        const message = data?.message ?? data?.run?.stderr ?? data?.error ?? `status ${res.status}`;
        const label = input.harnessId === "minimax_cli" ? "MiniMax CLI" : "Codex CLI";
        onError(`${label} run failed loudly: ${message}`);
        return;
      }
      onError(null);
    } catch (err) {
      const label = input.harnessId === "minimax_cli" ? "MiniMax CLI" : "Codex CLI";
      onError(
        err instanceof Error ? `${label} run failed: ${err.message}` : `${label} run failed.`,
      );
    } finally {
      setCreatingDraft(false);
    }
  };

  const projectPath = activeProject?.repoPath ?? activeProject?.localPath ?? null;

  // Whether the generic coding-harness approval card should render.
  // The card surfaces in three shapes:
  //
  //   1. The user just got a fresh router decision whose verdict
  //      is `coding_task` (they haven't acted on it yet). Show
  //      the card so the approval / correction buttons drive
  //      the harness recommendation fetch.
  //   2. The user approved / corrected to `coding_task` and we
  //      are awaiting the harness recommendation
  //      (`decisionApproved === "coding_task"`). Show the card
  //      immediately so the user sees "This looks like a coding
  //      task. Picking harness…" instead of an empty composer.
  //   3. The thread is in coding_task mode AND a harness was
  //      already selected via the card
  //      (`(worker === "codex" || worker === "minimax")` AND
  //      `codingHarnessRecommendation` is non-null). Show the
  //      card with the chosen harness and the run state.
  //
  // The key fix: previously `showCodingHarnessCard` was false
  // in the intermediate state (decisionApproved but no worker
  // yet), which left the composer with only the legacy
  // handoff-draft button — clicking it fired "This coding task
  // thread is missing a harness." We now surface the card in
  // every shape so the user can always pick Codex CLI / MiniMax
  // CLI / Answer in chat instead.
  const showCodingHarnessCard =
    routerDecision?.decision === "coding_task" ||
    decisionApproved === "coding_task" ||
    (isCodingTask && (worker === "codex" || worker === "minimax") && codingHarnessRecommendation);

  return (
    <div className="aui-composer-action-wrapper relative flex flex-col gap-2">
      {showCodingHarnessCard ? (
        <div
          className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs"
          data-testid="coding-harness-approval-card"
        >
          {!codingHarnessRecommendation && codingHarnessRecommendationLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <CompactEstimateTimer
                startedAt={codingHarnessRecommendationEta?.started_at ?? new Date().toISOString()}
                expectedLatencyMs={codingHarnessRecommendationEta?.expected_latency_ms ?? 3000}
                upperLatencyMs={codingHarnessRecommendationEta?.upper_latency_ms ?? 7500}
                estimateQuality={codingHarnessRecommendationEta?.estimate_quality ?? "rough"}
                mode="recommendation"
              />
              <span>· picking harness…</span>
            </div>
          ) : null}
          {/* Loud-failure state for the harness recommendation
              fetch. Surfaces when
              `/api/coding-harness/recommend` failed and the parent
              set `codingHarnessRecommendationError` to a sanitized
              reason. We never leave the user stuck in the
              intermediate state with no actionable UI: the failure
              card is shown INSTEAD of the silent intermediate
              composer + handoff-draft button that previously fired
              "This coding task thread is missing a harness." */}
          {codingHarnessRecommendationError &&
          !codingHarnessRecommendation &&
          !codingHarnessRecommendationLoading ? (
            <div
              className="space-y-2"
              data-testid="coding-harness-recommendation-error"
            >
              <div className="font-medium text-destructive">
                Coding harness recommendation failed.
              </div>
              <div className="text-muted-foreground">
                Reason: {codingHarnessRecommendationError}
              </div>
              <div className="text-muted-foreground">
                The harness registry probe could not pick between Codex CLI and MiniMax CLI.
                Pick a harness manually:
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full px-3"
                  data-testid="coding-harness-fallback-codex"
                  onClick={() => {
                    const codex = harnessRegistry?.find((h) => h.id === "codex_cli");
                    if (!codex) return;
                    void sendToCodingHarness({
                      harnessId: "codex_cli",
                      modelId: codex.defaultModelId,
                      reasoningLevel: codex.defaultReasoningLevel,
                    });
                  }}
                >
                  Try Codex CLI
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full px-3"
                  data-testid="coding-harness-fallback-minimax"
                  onClick={() => {
                    const minimax = harnessRegistry?.find((h) => h.id === "minimax_cli");
                    if (!minimax) return;
                    void sendToCodingHarness({
                      harnessId: "minimax_cli",
                      modelId: minimax.defaultModelId,
                      reasoningLevel: minimax.defaultReasoningLevel,
                    });
                  }}
                >
                  Try MiniMax CLI
                </Button>
                {onAnswerInChatInstead ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-full px-3"
                    data-testid="coding-harness-fallback-answer-in-chat"
                    onClick={onAnswerInChatInstead}
                  >
                    Answer in chat instead
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {codingHarnessRecommendation ? (
            <CodingHarnessApprovalCard
              recommendation={codingHarnessRecommendation}
              registry={harnessRegistry}
              projectPath={projectPath}
              hasProject={Boolean(activeProjectId)}
              onSend={(input) => {
                void sendToCodingHarness(input);
              }}
              onAnswerInChatInstead={onAnswerInChatInstead}
              runState={
                codexRun
                  ? {
                      status: codexRun.status,
                      exitCode: codexRun.exitCode,
                      stdout: codexRun.stdout,
                      stderr: codexRun.stderr,
                      gitStatusShort: codexRun.gitStatusShort ?? "",
                      gitDiffStat: codexRun.gitDiffStat ?? "",
                    }
                  : null
              }
            />
          ) : null}
        </div>
      ) : null}
      {isCodingTask && worker === "codex" && !codingHarnessRecommendation ? (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
          <div className="font-medium text-foreground">Recommended executor: Codex CLI</div>
          <div className="mt-0.5 text-muted-foreground">Reason: coding task needs repo access</div>
          <div className="mt-0.5 break-all text-muted-foreground">
            Working directory: {projectPath ?? "No project selected"}
          </div>
          <div className="mt-2 text-muted-foreground">
            Click approve/run to execute Codex CLI in the selected project folder. No fallback model
            or API provider will be used.
          </div>
          {codexRun ? (
            <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-background/70 p-3">
              <div className="font-medium text-foreground">
                Status: {codexRun.status} · Exit code: {codexRun.exitCode ?? "none"}
              </div>
              {codexRun.stdout ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                  {codexRun.stdout}
                </pre>
              ) : null}
              {codexRun.stderr ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-2 text-[11px] text-destructive">
                  {codexRun.stderr}
                </pre>
              ) : null}
              {codexRun.gitStatusShort ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                  Changed files:\n{codexRun.gitStatusShort}
                </pre>
              ) : null}
              {codexRun.gitDiffStat ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                  Diff summary:\n{codexRun.gitDiffStat}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {isCodingTask && worker === "minimax" && !codingHarnessRecommendation ? (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
          <div className="font-medium text-foreground">Recommended executor: MiniMax CLI</div>
          <div className="mt-0.5 text-muted-foreground">
            Reason: MiniMax token plan; Codex CLI is unavailable.
          </div>
          <div className="mt-0.5 break-all text-muted-foreground">
            Working directory: {projectPath ?? "No project selected"}
          </div>
          <div className="mt-2 text-muted-foreground">
            Click approve/run to execute MiniMax CLI in the selected project folder. No fallback
            model or API provider will be used.
          </div>
          {codexRun ? (
            <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-background/70 p-3">
              <div className="font-medium text-foreground">
                Status: {codexRun.status} · Exit code: {codexRun.exitCode ?? "none"}
              </div>
              {codexRun.stdout ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                  {codexRun.stdout}
                </pre>
              ) : null}
              {codexRun.stderr ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-2 text-[11px] text-destructive">
                  {codexRun.stderr}
                </pre>
              ) : null}
              {codexRun.gitStatusShort ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                  Changed files:\n{codexRun.gitStatusShort}
                </pre>
              ) : null}
              {codexRun.gitDiffStat ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                  Diff summary:\n{codexRun.gitDiffStat}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {!isCodingTask && (routerDecision || routerDecisionLoading) ? (
        <div
          className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs"
          data-testid="router-decision-card"
        >
          {routerDecision ? (
            <>
              <div className="font-medium text-foreground">
                {routerDecision.decision
                  ? `Router decision: ${routerDecision.decision === "coding_task" ? "Coding task" : "Normal chat"}`
                  : "Router decision failed."}
              </div>
              <div className="mt-0.5 text-muted-foreground">Reason: {routerDecision.reason}</div>
              {/* Structured per-rung failure breakdown. Rendered
                  only when the decision failed (decision === null)
                  so the user can see EXACTLY which recommender
                  failed and whether fallback was attempted. The
                  data is sanitized server-side and never contains
                  secrets — the user said "do not hide failures". */}
              {!routerDecision.decision && routerDecision.error_details ? (
                <div
                  className="mt-2 space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2"
                  data-testid="router-decision-error-details"
                >
                  {routerDecision.error_details.primary_recommender_model_id ? (
                    <div className="text-destructive">
                      <span className="font-medium">Primary failed:</span>{" "}
                      <span className="font-mono">
                        {routerDecision.error_details.primary_recommender_model_id}
                      </span>{" "}
                      ({routerDecision.error_details.primary_provider_path})
                      {routerDecision.error_details.primary_error_type
                        ? ` · ${routerDecision.error_details.primary_error_type}`
                        : null}
                      {routerDecision.error_details.primary_error_message_safe
                        ? `: ${routerDecision.error_details.primary_error_message_safe}`
                        : null}
                    </div>
                  ) : null}
                  {routerDecision.error_details.fallback_recommender_model_id ? (
                    <div
                      className={
                        routerDecision.error_details.fallback_attempted
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      <span className="font-medium">
                        {routerDecision.error_details.fallback_attempted
                          ? "Fallback attempted:"
                          : "Fallback was not attempted:"}
                      </span>{" "}
                      <span className="font-mono">
                        {routerDecision.error_details.fallback_recommender_model_id}
                      </span>{" "}
                      ({routerDecision.error_details.fallback_provider_path ?? "unknown"})
                      {routerDecision.error_details.fallback_attempted &&
                      routerDecision.error_details.fallback_error_type
                        ? ` · ${routerDecision.error_details.fallback_error_type}`
                        : null}
                      {routerDecision.error_details.fallback_error_message_safe
                        ? `: ${routerDecision.error_details.fallback_error_message_safe}`
                        : null}
                    </div>
                  ) : (
                    <div className="text-muted-foreground">
                      <span className="font-medium">Fallback:</span> not configured. Set
                      Settings → Router → Recommender fallback to add one.
                    </div>
                  )}
                </div>
              ) : null}
              {routerDecision.ambiguity ? (
                <div className="mt-0.5 text-muted-foreground">
                  Ambiguity: {routerDecision.ambiguity}
                </div>
              ) : null}
              {routerDecision.signals?.length ? (
                <div className="mt-0.5 text-muted-foreground">
                  Signals: {routerDecision.signals.join(", ")}
                </div>
              ) : null}
              <div className="mt-1 text-muted-foreground">
                Decision time: {routerDecision.estimate_quality} · est{" "}
                {formatTimer(routerDecision.expected_latency_ms)}
              </div>
              <input
                value={decisionComment}
                onChange={(event) => setDecisionComment(event.target.value)}
                className="mt-2 h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs outline-none focus:border-foreground"
                placeholder="Comment for future routing…"
                data-testid="router-decision-comment"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {routerDecision.decision ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-full px-3"
                    data-testid="router-decision-approve"
                    onClick={() => onDecisionAction?.("approved", decisionComment)}
                  >
                    Approve
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant={routerDecision.decision ? "outline" : "default"}
                  size="sm"
                  className="h-7 rounded-full px-3"
                  data-testid="router-decision-correct"
                  onClick={() =>
                    onDecisionAction?.(
                      routerDecision.decision === "coding_task"
                        ? "corrected_to_normal_chat"
                        : "corrected_to_coding_task",
                      decisionComment,
                    )
                  }
                >
                  {routerDecision.decision === "coding_task"
                    ? "Wrong, normal chat"
                    : routerDecision.decision === "normal_chat"
                      ? "Wrong, coding task"
                      : "Coding task"}
                </Button>
                {!routerDecision.decision ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-full px-3"
                    data-testid="router-decision-manual-normal"
                    onClick={() => onDecisionAction?.("corrected_to_normal_chat", decisionComment)}
                  >
                    Normal chat
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full px-3"
                  data-testid="router-decision-cancel"
                  onClick={() => onDecisionAction?.("canceled", decisionComment)}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <RecommendationWaitingLine eta={routerDecisionEta} />
          )}
        </div>
      ) : null}
      {!isCodingTask &&
      !routerDecision &&
      !routerDecisionLoading &&
      (recommendation || recommendationLoading) ? (
        <div
          className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs"
          data-testid="recommender-banner"
        >
          {recommendation ? (
            <>
              {recommendation.loudFailure ? (
                <div>
                  <div className="font-medium text-foreground">Recommendation blocked</div>
                  <div className="mt-0.5 text-muted-foreground">
                    The recommender engine could not run: {recommenderEngineSummary ?? "unknown"}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Current manual model remains:{" "}
                    {manualModelSummary ?? recommendation.recommendedModelId}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Configured fallback engine: {fallbackEngineSummary ?? "No fallback configured"}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    Reason: {recommendation.reasoning}
                  </div>
                </div>
              ) : (
                <>
                  <div className="font-medium text-foreground">
                    Recommended: {recommendation.recommendedModelId}
                    {recommendation.recommendedReasoningLevel
                      ? ` · ${recommendation.recommendedReasoningLevel}`
                      : ""}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Reason: {recommendation.reasoning}
                  </div>
                  {recommendation.recommendationTelemetry ? (
                    <div className="mt-1 text-muted-foreground">
                      Recommendation:{" "}
                      {formatSeconds(recommendation.recommendationTelemetry.actual_latency_ms)} ·
                      time{" "}
                      {compactPct(recommendation.recommendationTelemetry.latency_deviation_pct) ??
                        "—"}
                    </div>
                  ) : null}
                </>
              )}
              {recommendation.loudFailure &&
              recommendation.proposedSubscriptionFallbacks?.length ? (
                <div className="mt-1 text-muted-foreground">
                  Suggested subscription alternatives:{" "}
                  {recommendation.proposedSubscriptionFallbacks
                    .map((p) => p.displayLabel)
                    .join(", ")}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {!recommendation.loudFailure ||
                recommendation.proposedSubscriptionFallbacks?.length ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-full px-3"
                    data-testid="recommender-accept"
                    onClick={handleAcceptRecommendation}
                  >
                    {recommendation.loudFailure
                      ? `Switch to ${recommendation.proposedSubscriptionFallbacks?.[0]?.displayLabel ?? "suggested subscription"}`
                      : recommenderEnabled
                        ? "Accept & send"
                        : "Use recommendation"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full px-3"
                  data-testid="recommender-decline"
                  onClick={handleDeclineAndSendRecommendation}
                >
                  {recommendation.loudFailure
                    ? "Keep current"
                    : recommenderEnabled
                      ? "Decline & send"
                      : "Keep current"}
                </Button>
                {!recommendation.loudFailure && recommenderEnabled ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-full px-3"
                    data-testid="recommender-decline-only"
                    onClick={handleDeclineRecommendation}
                  >
                    Decline
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <RecommendationWaitingLine eta={recommendationEta} />
          )}
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <ComposerAddAttachment />
          <span aria-hidden="true" className="bg-border/60 h-4 w-px" />
          <KbdHint combo="c" className="aui-composer-focus-shortcut" />
          {!isCodingTask && onToggleRecommender ? (
            <RecommenderToggle on={recommenderEnabled} onToggle={onToggleRecommender} />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <AuiIf condition={(s) => s.thread.capabilities.dictation}>
            <AuiIf condition={(s) => s.composer.dictation == null}>
              <ComposerPrimitive.Dictate asChild>
                <TooltipIconButton
                  tooltip="Voice input"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-dictate size-7 rounded-full"
                  aria-label="Start voice input"
                >
                  <MicIcon className="aui-composer-dictate-icon size-4" />
                </TooltipIconButton>
              </ComposerPrimitive.Dictate>
            </AuiIf>
            <AuiIf condition={(s) => s.composer.dictation != null}>
              <ComposerPrimitive.StopDictation asChild>
                <TooltipIconButton
                  tooltip="Stop dictation"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                  aria-label="Stop voice input"
                >
                  <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
                </TooltipIconButton>
              </ComposerPrimitive.StopDictation>
            </AuiIf>
          </AuiIf>
          {isCodingTask ? (
            // In the intermediate state (`decisionApproved ===
            // "coding_task"` but no harness selected yet) we
            // intentionally hide BOTH the "Send to Codex" button
            // and the legacy handoff-draft button. The harness
            // approval card above is the only action surface; any
            // send-button here would either fire the legacy
            // createDraft() path with `worker === null` (raising
            // "This coding task thread is missing a harness.") or
            // race with the harness recommendation fetch. Once
            // the user picks a harness via the card, the parent
            // sets `harnessOverride` and `worker` becomes non-null,
            // so the "Send to Codex" / MiniMax button renders
            // normally.
            decisionApproved === "coding_task" && !worker ? null : worker === "codex" ? (
              <Button
                type="button"
                size="sm"
                className="h-8 rounded-full px-3 text-xs font-medium"
                aria-label="Send to Codex"
                disabled={creatingDraft}
                onClick={createDraft}
              >
                {creatingDraft ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Send to Codex
              </Button>
            ) : (
              <TooltipIconButton
                tooltip="Create handoff draft"
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-send size-7 rounded-full"
                aria-label="Create handoff draft"
                disabled={creatingDraft}
                onClick={createDraft}
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
              </TooltipIconButton>
            )
          ) : (
            <AuiIf condition={(s) => !s.thread.isRunning}>
              {recommenderEnabled && onRecommend ? (
                <TooltipIconButton
                  tooltip="Get model recommendation"
                  side="bottom"
                  type="button"
                  variant="default"
                  size="icon"
                  className="aui-composer-send size-7 rounded-full"
                  aria-label="Get model recommendation"
                  disabled={recommendationLoading || routerDecisionLoading || !!routerDecision}
                  onClick={handleRecommendBeforeSend}
                >
                  <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
                </TooltipIconButton>
              ) : (
                <ComposerPrimitive.Send asChild>
                  <TooltipIconButton
                    tooltip="Send message"
                    side="bottom"
                    type="button"
                    variant="default"
                    size="icon"
                    className="aui-composer-send size-7 rounded-full"
                    aria-label="Send message"
                    onClickCapture={() => queueManualRoutingDecision(composerText)}
                  >
                    <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
                  </TooltipIconButton>
                </ComposerPrimitive.Send>
              )}
            </AuiIf>
          )}
          <AuiIf condition={(s) => s.thread.isRunning}>
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-cancel size-7 rounded-full"
                aria-label="Stop generating"
              >
                <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
              </Button>
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
      </div>
    </div>
  );
};

const RecommendationWaitingLine: FC<{ eta: RecommendationEta | null }> = ({ eta }) => {
  const fallbackStartedAtRef = useRef(new Date().toISOString());
  const timer = eta ?? {
    expected_latency_ms: 3_000,
    upper_latency_ms: 7_500,
    estimate_quality: "rough" as const,
    started_at: fallbackStartedAtRef.current,
  };
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <CompactEstimateTimer
        startedAt={timer.started_at}
        expectedLatencyMs={timer.expected_latency_ms}
        upperLatencyMs={timer.upper_latency_ms}
        estimateQuality={timer.estimate_quality}
        mode="recommendation"
      />
    </div>
  );
};

type CompactEstimateTimerProps = {
  startedAt: string;
  expectedLatencyMs: number;
  upperLatencyMs: number;
  estimateQuality: "likely" | "uncertain" | "rough";
  mode: "recommendation" | "execution";
};

const CompactEstimateTimer: FC<CompactEstimateTimerProps> = ({
  startedAt,
  expectedLatencyMs,
  upperLatencyMs,
  estimateQuality,
}) => {
  const originalEstimateRef = useRef({ startedAt, expectedLatencyMs });
  if (originalEstimateRef.current.startedAt !== startedAt) {
    originalEstimateRef.current = { startedAt, expectedLatencyMs };
  }

  const [now, setNow] = useState(() => Date.now());
  // Track whether the run is active so the interval stops immediately on completion.
  // Using a ref avoids stale closure issues: the interval callback always reads the
  // current isRunning value without needing to re-create the interval on every render.
  const isRunningRef = useRef(true);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  isRunningRef.current = isRunning;

  // Stop the timer when the run completes so the countdown freezes immediately
  // instead of continuing to tick after the assistant message is done. Also stops
  // stale timers left running after a thread switch.
  useAuiEvent("thread.runEnd", () => {
    isRunningRef.current = false;
    setNow(Date.now());
  });

  useEffect(() => {
    // Guard: stop creating intervals after the run has ended. This prevents
    // a new interval from being created when the runEnd-triggered re-render
    // causes this effect to re-run (the cleanup clears the old interval first,
    // then this body would create a new one — the guard prevents that).
    if (!isRunningRef.current) return;
    const id = window.setInterval(() => {
      if (isRunningRef.current) setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const originalEstimateMs = originalEstimateRef.current.expectedLatencyMs;
  const elapsedMs = Math.max(0, now - new Date(startedAt).getTime());
  const remainingMs = Math.max(0, expectedLatencyMs - elapsedMs);
  const elapsedEstimateText = `elapsed ${formatTimer(elapsedMs)} / est ${formatTimer(originalEstimateMs)}`;
  if (elapsedMs < expectedLatencyMs) {
    return (
      <span>
        Expected in {formatTimer(remainingMs)} · {elapsedEstimateText} · {estimateQuality}
      </span>
    );
  }
  if (elapsedMs < upperLatencyMs) {
    return <span>Expected now · {elapsedEstimateText} · late</span>;
  }
  return <span>Taking longer · {elapsedEstimateText} · unusual</span>;
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <div className="mb-1 font-medium">Send blocked</div>
        <ErrorPrimitive.Message className="aui-message-error-message whitespace-pre-wrap" />
        <div className="mt-2 text-xs text-destructive/80 dark:text-red-200/80">
          Control Room will not auto-switch models or use API-billed fallback. Re-enable the model
          in Settings or choose another model explicitly.
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/**
 * Generic coding-harness approval card.
 *
 * Rendered after the first decision gate is approved / corrected to
 * `coding_task` and the parent has fetched the harness
 * recommendation from `/api/coding-harness/recommend`. The card
 * shows:
 *
 *   - "This looks like a coding task." (always)
 *   - Recommended harness + display name + provider path
 *   - Recommended model id
 *   - Reasoning / thinking label ("provider default" when the
 *     harness does not accept a reasoning knob on the CLI surface,
 *     e.g. MiniMax CLI today)
 *   - Project folder path (or a clear "no project selected" notice)
 *   - Reason from the recommender
 *
 * Action buttons:
 *
 *   - "Send to <recommended harness>"  — primary CTA, dispatches
 *     `onSend({ harnessId, modelId, reasoningLevel })`.
 *   - "Use <other harness> instead"    — only rendered when the
 *     other harness is in the registry AND its `status` is
 *     `available`. Disabled (with a tooltip) otherwise.
 *   - "Answer in chat instead"          — drops the user back into
 *     the normal chat flow without consuming the coding-task
 *     thread state.
 *   - "Cancel"                         — no-op for now; the parent
 *     can decide whether to keep the composer open.
 *
 * HARD RULES:
 *
 *   - "Open a project folder before sending coding tasks to a
 *     coding harness." surfaces when `hasProject === false`; both
 *     Send buttons are disabled.
 *   - No silent harness fallback: the dispatcher only runs when
 *     the user clicks Send.
 *   - No normal-chat / API-billed fallback: when no harness is
 *     available the card shows a loud failure with the per-harness
 *     `unavailableReason`.
 */
const CodingHarnessApprovalCard: FC<{
  recommendation: CodingHarnessRecommendation;
  registry: ReadonlyArray<HarnessRegistryView> | null;
  projectPath: string | null;
  hasProject: boolean;
  onSend: (input: { harnessId: CodingHarnessId; modelId: string; reasoningLevel: string }) => void;
  onAnswerInChatInstead?: () => void;
  runState: null | {
    status: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    gitStatusShort: string;
    gitDiffStat: string;
  };
}> = ({
  recommendation,
  registry,
  projectPath,
  hasProject,
  onSend,
  onAnswerInChatInstead,
  runState,
}) => {
  const codexEntry = registry?.find((h) => h.id === "codex_cli") ?? null;
  const minimaxEntry = registry?.find((h) => h.id === "minimax_cli") ?? null;
  const recommendedEntry =
    recommendation.recommendedHarness === "codex_cli" ? codexEntry : minimaxEntry;
  const recommendedDisplayName = recommendedEntry?.displayName ?? "Coding harness";
  const recommendedProviderPath = recommendedEntry?.providerPath ?? "";
  const otherEntry = recommendation.recommendedHarness === "codex_cli" ? minimaxEntry : codexEntry;
  // `provider_default` is the canonical "this harness does not accept
  // a reasoning knob" label used by MiniMax CLI. Render it literally.
  const reasoningLabel =
    recommendation.recommendedReasoningLevel === "provider_default"
      ? "provider default"
      : recommendation.recommendedReasoningLevel;

  const recommendedDisabled = !hasProject || recommendedEntry?.status !== "available";
  const otherDisabled = !hasProject || otherEntry?.status !== "available";

  return (
    <div className="space-y-2">
      <div className="font-medium text-foreground">This looks like a coding task.</div>
      <div className="text-muted-foreground">
        Recommended harness:{" "}
        <span className="font-medium text-foreground">{recommendedDisplayName}</span>
      </div>
      <div className="text-muted-foreground">Model: {recommendation.recommendedModelId}</div>
      <div className="text-muted-foreground">Reasoning: {reasoningLabel}</div>
      <div className="break-all text-muted-foreground">
        Project folder: {projectPath ?? "No project selected"}
      </div>
      <div className="text-muted-foreground">Reason: {recommendation.reason}</div>
      {recommendedEntry?.providerPath ? (
        <div className="text-muted-foreground">Access: {recommendedEntry.providerPath}</div>
      ) : null}
      {recommendation.fallback ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-100/40 px-2 py-1 text-amber-900"
          role="status"
        >
          Recommendation fell back to a deterministic pick:{" "}
          {recommendation.fallbackReason ?? "unknown"}. No silent fallback to a different harness.
        </div>
      ) : null}
      {!hasProject ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-100/40 px-2 py-1 text-amber-900"
          role="status"
          data-testid="coding-harness-needs-project"
        >
          Open a project folder before sending coding tasks to a coding harness.
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          className="h-7 rounded-full px-3"
          data-testid="coding-harness-send"
          disabled={recommendedDisabled}
          onClick={() =>
            onSend({
              harnessId: recommendation.recommendedHarness,
              modelId: recommendation.recommendedModelId,
              reasoningLevel: recommendation.recommendedReasoningLevel,
            })
          }
        >
          Send to {recommendedDisplayName}
        </Button>
        {otherEntry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-full px-3"
            data-testid="coding-harness-use-other"
            disabled={otherDisabled}
            title={
              otherDisabled
                ? (otherEntry.unavailableReason ?? "Not available")
                : `Switch to ${otherEntry.displayName}`
            }
            onClick={() => {
              const alt = recommendation.alternatives.find((a) => a.harness === otherEntry.id);
              onSend({
                harnessId: otherEntry.id,
                modelId: alt?.modelId ?? otherEntry.defaultModelId,
                reasoningLevel: alt?.reasoningLevel ?? otherEntry.defaultReasoningLevel,
              });
            }}
          >
            Use {otherEntry.displayName} instead
          </Button>
        ) : null}
        {onAnswerInChatInstead ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-3"
            data-testid="coding-harness-answer-in-chat"
            onClick={onAnswerInChatInstead}
          >
            Answer in chat instead
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-3"
          data-testid="coding-harness-cancel"
          // Cancel = dismiss the harness card and return to a
          // clean composer. We reuse the parent's
          // `onAnswerInChatInstead` handler because it already
          // clears the intermediate state machine (routerDecision,
          // decisionApproved, harnessRecommendation, harnessOverride,
          // threadModeOverride). The user can re-issue a fresh
          // Send after cancelling without stale state bleeding
          // into the next round.
          onClick={() => onAnswerInChatInstead?.()}
        >
          Cancel
        </Button>
      </div>
      {runState ? (
        <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-background/70 p-3">
          <div className="font-medium text-foreground">
            Status: {runState.status} · Exit code: {runState.exitCode ?? "none"}
          </div>
          {runState.stdout ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
              {runState.stdout}
            </pre>
          ) : null}
          {runState.stderr ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-2 text-[11px] text-destructive">
              {runState.stderr}
            </pre>
          ) : null}
          {runState.gitStatusShort ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
              Changed files (git status --short):\n{runState.gitStatusShort}
            </pre>
          ) : null}
          {runState.gitDiffStat ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
              Diff summary (git diff --stat):\n{runState.gitDiffStat}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

type ExecutionEstimateData = {
  runId: string | null;
  model_id?: string;
  model_name?: string;
  reasoning_level?: string | null;
  provider_path?: string;
  selected_model_id?: string;
  recommended_model_id?: string | null;
  estimated_cost_usd?: number | null;
  expected_execution_latency_ms: number;
  upper_execution_latency_ms: number;
  expected_input_tokens: number;
  expected_output_tokens: number;
  expected_total_tokens: number;
  estimate_quality: "likely" | "uncertain" | "rough";
  started_at: string;
};

type ExecutionOutcomeData = {
  runId: string | null;
  actual_execution_latency_ms: number;
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_total_tokens: number;
  latency_deviation_ms: number;
  latency_deviation_pct: number | null;
  token_deviation_count: number;
  token_deviation_pct: number | null;
  latency_result: string;
  token_result: string;
};

function isDataPart(part: unknown, name: string) {
  if (typeof part !== "object" || part === null) return false;
  const p = part as { type?: string; name?: string };
  return p.type === `data-${name}` || (p.type === "data" && p.name === name);
}

function executionTelemetryFromParts(parts: readonly unknown[]) {
  const estimatePart = parts.find((p) => isDataPart(p, "router-execution-estimate")) as
    | { data?: ExecutionEstimateData }
    | undefined;
  const outcomePart = parts.find((p) => isDataPart(p, "router-execution-outcome")) as
    | { data?: ExecutionOutcomeData }
    | undefined;
  return { estimate: estimatePart?.data, outcome: outcomePart?.data };
}

function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function compactPct(n: number | null): string | null {
  if (n == null) return null;
  return `${n >= 0 ? "+" : ""}${Math.round(n)}%`;
}

const ExecutionTelemetryLine: FC<{ parts: readonly unknown[]; statusType?: string }> = ({
  parts,
  statusType,
}) => {
  const { estimate, outcome } = executionTelemetryFromParts(parts);
  const [expanded, setExpanded] = useState(false);
  if (!estimate) return null;
  const modelName = estimate.model_name ?? estimate.model_id ?? "Model";
  const reasoning = estimate.reasoning_level ? ` · reasoning ${estimate.reasoning_level}` : "";
  const timeText = outcome
    ? formatSeconds(outcome.actual_execution_latency_ms)
    : `~${formatEta(estimate.expected_execution_latency_ms)}`;
  const tokenText = outcome
    ? `${compactTokens(outcome.actual_total_tokens)} tokens`
    : `~${compactTokens(estimate.expected_total_tokens)} tokens`;
  if (!outcome) {
    const running = statusType === "running";
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground/75">
        {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {running ? (
          <CompactEstimateTimer
            startedAt={estimate.started_at}
            expectedLatencyMs={estimate.expected_execution_latency_ms}
            upperLatencyMs={estimate.upper_execution_latency_ms}
            estimateQuality={estimate.estimate_quality}
            mode="execution"
          />
        ) : (
          <span>
            {modelName}
            {reasoning} · completed · estimated {formatEta(estimate.expected_execution_latency_ms)}
          </span>
        )}
      </div>
    );
  }
  const deviationText = [
    compactPct(outcome.latency_deviation_pct),
    compactPct(outcome.token_deviation_pct),
  ]
    .map((value, index) => (value ? `${index === 0 ? "time" : "tokens"} ${value}` : null))
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mt-2 text-xs text-muted-foreground/75">
      <button
        type="button"
        className="text-left hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {modelName}
        {reasoning} · {timeText} · {tokenText}
        {deviationText ? ` · ${deviationText}` : ""}
      </button>
      {expanded ? (
        <dl className="mt-1 grid gap-x-3 gap-y-0.5 rounded-lg border border-border/40 bg-muted/20 p-2 text-[11px] sm:grid-cols-[max-content_1fr]">
          <dt>Model</dt>
          <dd>{modelName}</dd>
          <dt>Reasoning</dt>
          <dd>{estimate.reasoning_level ?? "—"}</dd>
          <dt>Provider path</dt>
          <dd>{estimate.provider_path ?? "—"}</dd>
          <dt>Selected / recommended</dt>
          <dd>
            {estimate.selected_model_id ?? "—"}
            {estimate.recommended_model_id ? ` / ${estimate.recommended_model_id}` : " / —"}
          </dd>
          <dt>Generation time</dt>
          <dd>
            est {formatSeconds(estimate.expected_execution_latency_ms)} · actual{" "}
            {outcome ? formatSeconds(outcome.actual_execution_latency_ms) : "—"}
            {outcome
              ? ` · ${formatDeviation(outcome.latency_deviation_ms, outcome.latency_deviation_pct)}`
              : ""}
          </dd>
          <dt>Input tokens</dt>
          <dd>
            est {estimate.expected_input_tokens.toLocaleString()} · actual{" "}
            {outcome?.actual_input_tokens.toLocaleString() ?? "—"}
          </dd>
          <dt>Output tokens</dt>
          <dd>
            est {estimate.expected_output_tokens.toLocaleString()} · actual{" "}
            {outcome?.actual_output_tokens.toLocaleString() ?? "—"}
          </dd>
          <dt>Total tokens</dt>
          <dd>
            est {estimate.expected_total_tokens.toLocaleString()} · actual{" "}
            {outcome?.actual_total_tokens.toLocaleString() ?? "—"}
            {outcome
              ? ` · ${outcome.token_deviation_count >= 0 ? "+" : ""}${outcome.token_deviation_count.toLocaleString()} / ${compactPct(outcome.token_deviation_pct) ?? "—"}`
              : ""}
          </dd>
          <dt>Cost</dt>
          <dd>
            est{" "}
            {estimate.estimated_cost_usd == null
              ? "—"
              : `$${estimate.estimated_cost_usd.toFixed(6)}`}{" "}
            · actual —
          </dd>
          {process.env.NODE_ENV !== "production" ? (
            <>
              <dt>Run ids</dt>
              <dd>recommendation — · execution {estimate.runId ?? outcome?.runId ?? "—"}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
};

/**
 * Compact metadata pill rendered under each assistant message that
 * came from a coding harness. Reads either the generic
 * `custom.harness` block (preferred) or the legacy `custom.codex`
 * block (for older persisted messages). The display is source-aware
 * so Codex CLI / MiniMax CLI can be told apart.
 */
const CodexMetadataLine: FC<{
  metadata: {
    executor?: string;
    model?: string;
    reasoning?: string;
    durationMs?: number | null;
    projectName?: string | null;
    projectPath?: string | null;
    status?: string | null;
  };
  harnessLabel?: string | null;
}> = ({ metadata, harnessLabel }) => {
  const duration =
    typeof metadata.durationMs === "number"
      ? `${(metadata.durationMs / 1000).toFixed(1)}s`
      : "duration unknown";
  const project = metadata.projectName || metadata.projectPath || "project unknown";
  const label = harnessLabel ?? metadata.executor ?? "Codex CLI";
  return (
    <div className="mt-2 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-[11px] font-medium text-primary">
      <span>{label}</span>
      <span aria-hidden="true">·</span>
      <span>model {metadata.model ?? "CLI default"}</span>
      <span aria-hidden="true">·</span>
      <span>reasoning {metadata.reasoning ?? "CLI default"}</span>
      <span aria-hidden="true">·</span>
      <span>{duration}</span>
      <span aria-hidden="true">·</span>
      <span className="max-w-64 truncate" title={metadata.projectPath ?? project}>
        {project}
      </span>
      {metadata.status ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{metadata.status}</span>
        </>
      ) : null}
    </div>
  );
};

const RoutingDecisionCard: FC<{ decision: RoutingDecisionPayload }> = ({ decision }) => {
  const alternatives = decision.alternatives ?? [];
  return (
    <div
      className="my-1 rounded-2xl border border-sky-500/25 bg-sky-500/5 p-3 text-sm"
      data-testid="routing-decision-bubble"
    >
      <div className="font-semibold text-foreground">Routing decision</div>
      <div className="mt-1 text-xs font-medium text-muted-foreground">
        Saved for visibility only. Not sent to the execution model.
      </div>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Route</dt>
        <dd>{decision.route === "coding_task" ? "coding" : "normal chat"}</dd>
        <dt className="text-muted-foreground">Selection source</dt>
        <dd>{decision.selectionSource ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Harness</dt>
        <dd>{decision.harness ?? "none"}</dd>
        <dt className="text-muted-foreground">Router/recommender engine</dt>
        <dd>{decision.recommenderEngine ?? decision.routerEngine ?? "not used"}</dd>
        <dt className="text-muted-foreground">Recommender reasoning</dt>
        <dd>{decision.recommenderReasoningLevel ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Execution model</dt>
        <dd>{decision.executionModel ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Execution reasoning</dt>
        <dd>{decision.executionReasoningLevel ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Fallback recommender</dt>
        <dd>
          {decision.fallback == null
            ? "not used"
            : decision.fallback.used
              ? "used"
              : decision.fallback.attempted
                ? "attempted"
                : decision.fallback.configured
                  ? "configured"
                  : "not configured"}
          {decision.fallback?.engine ? ` · ${decision.fallback.engine}` : ""}
        </dd>
      </dl>
      {decision.whyRoute ? (
        <div className="mt-3 text-xs"><div className="font-medium">Why this route/harness</div><p className="mt-1 text-muted-foreground">{decision.whyRoute}</p></div>
      ) : null}
      {decision.whyHarness ? (
        <div className="mt-3 text-xs"><div className="font-medium">Why this harness</div><p className="mt-1 text-muted-foreground">{decision.whyHarness}</p></div>
      ) : null}
      {decision.whyModel ? (
        <div className="mt-3 text-xs"><div className="font-medium">Why this model</div><p className="mt-1 text-muted-foreground">{decision.whyModel}</p></div>
      ) : null}
      {alternatives.length ? (
        <div className="mt-3 text-xs"><div className="font-medium">Alternatives returned</div><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 text-[11px] text-muted-foreground">{alternatives.map((a) => JSON.stringify(a)).join("\n")}</pre></div>
      ) : null}
    </div>
  );
};

const AssistantMessage: FC<{
  threadId: string | null;
  notesDisabled: boolean;
  routerAbOn: boolean;
}> = ({ threadId, notesDisabled, routerAbOn }) => {
  const messageId = useAuiState((s) => s.message.id);
  const parts = useAuiState((s) => s.message.parts);
  const messageStatusType = useAuiState((s) => s.message.status?.type);
  const routingDecision = useAuiState((s) => routingDecisionFromMessage(s.message));
  const codexMetadata = useAuiState((s) => {
    const custom = (s.message.metadata as { custom?: unknown } | undefined)?.custom;
    if (!custom || typeof custom !== "object") return null;
    // Prefer the generic `custom.harness` block (set by the
    // dispatcher for new runs) and fall back to the legacy
    // `custom.codex` block for older persisted messages.
    const harness = (custom as { harness?: unknown }).harness;
    if (harness && typeof harness === "object") {
      const h = harness as {
        harnessLabel?: string;
        model?: string;
        reasoning?: string;
        durationMs?: number | null;
        projectName?: string | null;
        projectPath?: string | null;
        status?: string | null;
        executor?: string;
      };
      return {
        metadata: {
          executor: h.executor ?? h.harnessLabel ?? "Codex CLI",
          model: h.model,
          reasoning: h.reasoning,
          durationMs: h.durationMs,
          projectName: h.projectName,
          projectPath: h.projectPath,
          status: h.status,
        },
        harnessLabel: h.harnessLabel ?? h.executor ?? null,
      };
    }
    const codex = (custom as { codex?: unknown }).codex;
    return codex && typeof codex === "object"
      ? {
          metadata: codex as {
            executor?: string;
            model?: string;
            reasoning?: string;
            durationMs?: number | null;
            projectName?: string | null;
            projectPath?: string | null;
            status?: string | null;
          },
          harnessLabel: (codex as { executor?: string }).executor ?? null,
        }
      : null;
  });
  const [notesOpen, setNotesOpen] = useState(false);
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-foreground px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        {routingDecision ? (
          <RoutingDecisionCard decision={routingDecision} />
        ) : (
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type === "text") return <MarkdownText />;
              if (part.type === "tool-call") return part.toolUI ?? <ToolFallback {...part} />;
              return null;
            }}
          </MessagePrimitive.Parts>
        )}
        <AuiIf
          condition={(s) => s.message.status?.type === "running" && s.message.parts.length === 0}
        >
          <span
            data-slot="aui_assistant-message-indicator"
            className="animate-pulse font-sans"
            aria-label="Assistant is working"
          >
            {"●"}
          </span>
        </AuiIf>
        {codexMetadata ? (
          <CodexMetadataLine
            metadata={codexMetadata.metadata}
            harnessLabel={codexMetadata.harnessLabel}
          />
        ) : null}
        <ExecutionTelemetryLine parts={parts} statusType={messageStatusType} />
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <FeedbackButtons messageId={messageId} />
        <ThreadNoteToggle open={notesOpen} onOpenChange={setNotesOpen} />
        <BranchPicker />
        <ActionBarDivider />
        <AssistantActionBar />
      </div>
      {notesOpen && <ThreadNoteEditor threadId={threadId} disabled={notesDisabled} />}
      {routerAbOn && (
        <PanelErrorBoundary>
          <RouterAbPanel initialPayload={payloadFromMessageParts(parts)} />
        </PanelErrorBoundary>
      )}
    </MessagePrimitive.Root>
  );
};

const ThreadNoteToggle: FC<{ open: boolean; onOpenChange: (open: boolean) => void }> = ({
  open,
  onOpenChange,
}) => {
  return (
    <TooltipIconButton
      tooltip={open ? "Hide thread notes" : "Show thread notes"}
      side="bottom"
      type="button"
      variant="ghost"
      size="icon"
      aria-label={open ? "Hide thread notes" : "Show thread notes"}
      aria-expanded={open}
      data-state={open ? "active" : "inactive"}
      onClick={() => onOpenChange(!open)}
      className={cn(
        "aui-thread-note-toggle size-7 rounded-full text-muted-foreground/60",
        "hover:bg-muted/40 hover:text-muted-foreground",
        "focus-visible:bg-muted/40 focus-visible:text-muted-foreground",
        open && "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <MessageCircleIcon className="size-3.5" />
    </TooltipIconButton>
  );
};

const ThreadNoteEditor: FC<{ threadId: string | null; disabled: boolean }> = ({
  threadId,
  disabled,
}) => {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    setBody("");
    setStatus("idle");
    if (!threadId || threadId.startsWith("local-")) return;
    (async () => {
      try {
        const res = await fetch(`/api/threads/${threadId}/note`, { cache: "no-store" });
        if (!res.ok) return;
        const data: NoteResponse = await res.json();
        if (!cancelled) setBody(data.note?.body ?? "");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const save = async () => {
    if (!threadId || threadId.startsWith("local-") || disabled) return;
    setStatus("saving");
    try {
      const res = await fetch(`/api/threads/${threadId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: NoteResponse = await res.json();
      setBody(data.note?.body ?? "");
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const unavailable = disabled || !threadId || threadId.startsWith("local-");

  return (
    <div className="aui-thread-note-editor mt-9 rounded-xl border border-border/60 bg-muted/10 px-3 py-2 shadow-sm">
      <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Thread notes
      </label>
      <div className="mt-1 flex gap-2">
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setStatus("idle");
          }}
          disabled={unavailable}
          placeholder="Private notes for later review. Not sent to the model."
          rows={2}
          className="min-h-16 flex-1 resize-y rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-muted-foreground/40 focus:outline-none disabled:opacity-60"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void save()}
          disabled={unavailable || status === "saving"}
          className="shrink-0 text-xs"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground/60">
        {status === "saved"
          ? "Saved. Notes are metadata and are not sent to chat."
          : status === "error"
            ? "Could not save note."
            : "Notes are independent from ratings and excluded from model context."}
      </div>
    </div>
  );
};

const FeedbackButtons: FC<{ messageId: string }> = ({ messageId }) => {
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/messages/${messageId}/feedback`, { cache: "no-store" });
        if (!res.ok) return;
        const data: { rating?: "up" | "down" | null } = await res.json();
        if (!cancelled) setVote(data.rating ?? null);
      } catch {
        // Feedback should never interrupt reading/chatting.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const submitVote = async (rating: "up" | "down") => {
    if (saving) return;
    const previous = vote;
    setSaving(true);
    setVote(previous === rating ? null : rating);
    try {
      const res = await fetch(`/api/messages/${messageId}/feedback`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: { rating: "up" | "down" | null } = await res.json();
      setVote(data.rating);
    } catch {
      setVote(previous);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="group" aria-label="Message feedback" className="flex items-center gap-0.5">
      <TooltipIconButton
        tooltip="Good response"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Thumbs up"
        aria-pressed={vote === "up"}
        data-state={vote === "up" ? "active" : "inactive"}
        disabled={saving}
        onClick={() => void submitVote("up")}
        className={cn(
          "aui-feedback-button size-7 rounded-full text-muted-foreground/60",
          "hover:bg-muted/40 hover:text-muted-foreground",
          "focus-visible:bg-muted/40 focus-visible:text-muted-foreground",
          "transition-colors",
          vote === "up" &&
            "bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/15 hover:text-emerald-500 focus-visible:bg-emerald-500/15 focus-visible:text-emerald-500",
        )}
      >
        <ThumbsUpIcon
          className={cn("size-3.5 transition-transform", vote === "up" && "fill-current scale-110")}
        />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Bad response"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Thumbs down"
        aria-pressed={vote === "down"}
        data-state={vote === "down" ? "active" : "inactive"}
        disabled={saving}
        onClick={() => void submitVote("down")}
        className={cn(
          "aui-feedback-button size-7 rounded-full text-muted-foreground/60",
          "hover:bg-muted/40 hover:text-muted-foreground",
          "focus-visible:bg-muted/40 focus-visible:text-muted-foreground",
          "transition-colors",
          vote === "down" &&
            "bg-rose-500/10 text-rose-500 hover:bg-rose-500/15 hover:text-rose-500 focus-visible:bg-rose-500/15 focus-visible:text-rose-500",
        )}
      >
        <ThumbsDownIcon
          className={cn(
            "size-3.5 transition-transform",
            vote === "down" && "fill-current scale-110",
          )}
        />
      </TooltipIconButton>
    </div>
  );
};

// Small vertical divider to separate feedback from copy/regenerate,
// matching the mockup's MessageActions grouping.
const ActionBarDivider: FC = () => (
  <div aria-hidden="true" className="bg-border/60 mx-1.5 h-4 w-px" />
);

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent">
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const preventEditMutationWhenRunning = useCallback(
    (event: { preventDefault(): void; stopPropagation(): void }) => {
      if (!isRunning) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [isRunning],
  );
  const preventEditKeyWhenRunning = useCallback(
    (event: {
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      preventDefault(): void;
      stopPropagation(): void;
    }) => {
      if (!isRunning) return;
      const key = event.key.toLowerCase();
      const mutatingShortcut = (event.ctrlKey || event.metaKey) && ["x", "v", "z", "y"].includes(key);
      if (
        key === "backspace" ||
        key === "delete" ||
        key === "enter" ||
        mutatingShortcut
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [isRunning],
  );

  return (
    <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-background border-border/60 dark:border-muted-foreground/15 dark:bg-muted/30 ms-auto flex w-full max-w-[85%] flex-col rounded-3xl border shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
          aria-disabled={isRunning}
          disabled={isRunning}
          readOnly={isRunning}
          onBeforeInputCapture={preventEditMutationWhenRunning}
          onBeforeInput={preventEditMutationWhenRunning}
          onInputCapture={preventEditMutationWhenRunning}
          onChange={preventEditMutationWhenRunning}
          onPasteCapture={preventEditMutationWhenRunning}
          onPaste={preventEditMutationWhenRunning}
          onCutCapture={preventEditMutationWhenRunning}
          onCut={preventEditMutationWhenRunning}
          onDropCapture={preventEditMutationWhenRunning}
          onDrop={preventEditMutationWhenRunning}
          onKeyDownCapture={preventEditKeyWhenRunning}
          onKeyDown={preventEditKeyWhenRunning}
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 rounded-full px-3.5" disabled={isRunning}>
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5" disabled={isRunning}>
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
