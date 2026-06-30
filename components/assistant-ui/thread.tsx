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
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

type NoteResponse = {
  note: { threadId: string; body: string; createdAt: string; updatedAt: string } | null;
  configured?: boolean;
};

type ThreadMode = "chat" | "coding_task";
type HandoffWorker = "pi" | "codex" | "opencode";
type HandoffTaskType = "implement" | "debug" | "inspect" | "refactor" | "test" | "review";
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
  recommendationTelemetry?: (RecommendationEta & {
    completed_at: string | null;
    actual_latency_ms: number | null;
    latency_deviation_ms: number | null;
    latency_deviation_pct: number | null;
    latency_result: string | null;
  });
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
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  recommendationEta?: RecommendationEta | null;
  manualModelSummary?: string;
  recommenderEngineSummary?: string;
  fallbackEngineSummary?: string;
  onRecommend?: (message: string) => void;
  onUseRecommendation?: (draftText?: string) => void;
  onKeepCurrent?: (draftText?: string) => void;
  pendingRecommendedSend?: PendingRecommendedSend | null;
  onPendingRecommendedSendConsumed?: (id: number) => void;
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
  recommendation = null,
  recommendationLoading = false,
  recommendationEta = null,
  manualModelSummary,
  recommenderEngineSummary,
  fallbackEngineSummary,
  onRecommend,
  onUseRecommendation,
  onKeepCurrent,
  pendingRecommendedSend = null,
  onPendingRecommendedSendConsumed,
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
              recommendation={recommendation}
              recommendationLoading={recommendationLoading}
              recommendationEta={recommendationEta}
              manualModelSummary={manualModelSummary}
              recommenderEngineSummary={recommenderEngineSummary}
              fallbackEngineSummary={fallbackEngineSummary}
              onRecommend={onRecommend}
              onUseRecommendation={onUseRecommendation}
              onKeepCurrent={onKeepCurrent}
              pendingRecommendedSend={pendingRecommendedSend}
              onPendingRecommendedSendConsumed={onPendingRecommendedSendConsumed}
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
  return ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;
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
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  recommendationEta?: RecommendationEta | null;
  manualModelSummary?: string;
  recommenderEngineSummary?: string;
  fallbackEngineSummary?: string;
  onRecommend?: (message: string) => void;
  onUseRecommendation?: (draftText?: string) => void;
  onKeepCurrent?: (draftText?: string) => void;
  pendingRecommendedSend?: PendingRecommendedSend | null;
  onPendingRecommendedSendConsumed?: (id: number) => void;
}> = ({
  threadId,
  activeProjectId,
  activeProject,
  threadMode,
  harness,
  recommenderEnabled = false,
  onToggleRecommender,
  recommendation = null,
  recommendationLoading = false,
  recommendationEta = null,
  manualModelSummary,
  recommenderEngineSummary,
  fallbackEngineSummary,
  onRecommend,
  onUseRecommendation,
  onKeepCurrent,
  pendingRecommendedSend = null,
  onPendingRecommendedSendConsumed,
}) => {
  const [error, setError] = useState<string | null>(null);
  const composerText = useAuiState((s) => s.composer.text);
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
        if (recommenderEnabled && composerText.trim().length > 0 && onRecommend) {
          event.preventDefault();
          onRecommend(composerText);
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
                {worker === "opencode" ? "OpenCode" : worker === "codex" ? "Codex" : "Pi"}
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
            recommendation={recommendation}
            recommendationLoading={recommendationLoading}
            recommendationEta={recommendationEta}
            manualModelSummary={manualModelSummary}
            recommenderEngineSummary={recommenderEngineSummary}
            fallbackEngineSummary={fallbackEngineSummary}
            onRecommend={onRecommend}
            onUseRecommendation={onUseRecommendation}
            onKeepCurrent={onKeepCurrent}
            pendingRecommendedSend={pendingRecommendedSend}
            onPendingRecommendedSendConsumed={onPendingRecommendedSendConsumed}
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
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  recommendationEta?: RecommendationEta | null;
  manualModelSummary?: string;
  recommenderEngineSummary?: string;
  fallbackEngineSummary?: string;
  onRecommend?: (message: string) => void;
  onUseRecommendation?: (draftText?: string) => void;
  onKeepCurrent?: (draftText?: string) => void;
  pendingRecommendedSend?: PendingRecommendedSend | null;
  onPendingRecommendedSendConsumed?: (id: number) => void;
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
  recommendation = null,
  recommendationLoading = false,
  recommendationEta = null,
  manualModelSummary,
  recommenderEngineSummary,
  fallbackEngineSummary,
  onRecommend,
  onUseRecommendation,
  onKeepCurrent,
  pendingRecommendedSend = null,
  onPendingRecommendedSendConsumed,
}) => {
  const aui = useAui();
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
  const composerText = useAuiState((s) => s.composer.text);
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
  }, [pendingRecommendedSend, aui, onPendingRecommendedSendConsumed]);

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
      if (worker === "codex") {
        const res = await fetch("/api/coding-runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: activeProjectId, threadId, prompt: instruction }),
        });
        const data = (await res.json().catch(() => null)) as
          | { run?: typeof codexRun; message?: string; error?: string }
          | null;
        if (!res.ok) {
          const message = data?.message ?? data?.run?.stderr ?? data?.error ?? `status ${res.status}`;
          if (data?.run) setCodexRun(data.run);
          throw new Error(message);
        }
        if (data?.run) setCodexRun(data.run);
        aui.composer().setText("");
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
      onError(
        err instanceof Error
          ? worker === "codex"
            ? `Codex CLI run failed: ${err.message}`
            : `Failed to create handoff draft: ${err.message}`
          : worker === "codex"
            ? "Codex CLI run failed."
            : "Failed to create handoff draft.",
      );
    } finally {
      setCreatingDraft(false);
    }
  };

  const projectPath = activeProject?.repoPath ?? activeProject?.localPath ?? null;

  return (
    <div className="aui-composer-action-wrapper relative flex flex-col gap-2">
      {isCodingTask && worker === "codex" ? (
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
      {!isCodingTask && (recommendation || recommendationLoading) ? (
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
                      Recommendation: {formatSeconds(recommendation.recommendationTelemetry.actual_latency_ms)} · time {compactPct(recommendation.recommendationTelemetry.latency_deviation_pct) ?? "—"}
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
            <TooltipIconButton
              tooltip={worker === "codex" ? "Approve and run Codex CLI" : "Create handoff draft"}
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label={worker === "codex" ? "Approve and run Codex CLI" : "Create handoff draft"}
              disabled={creatingDraft}
              onClick={createDraft}
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
            </TooltipIconButton>
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
                  disabled={recommendationLoading}
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
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
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
  const estimatePart = parts.find((p) => isDataPart(p, "router-execution-estimate")) as { data?: ExecutionEstimateData } | undefined;
  const outcomePart = parts.find((p) => isDataPart(p, "router-execution-outcome")) as { data?: ExecutionOutcomeData } | undefined;
  return { estimate: estimatePart?.data, outcome: outcomePart?.data };
}

function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function compactPct(n: number | null): string | null {
  if (n == null) return null;
  return `${n >= 0 ? "+" : ""}${Math.round(n)}%`;
}

const ExecutionTelemetryLine: FC<{ parts: readonly unknown[] }> = ({ parts }) => {
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
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground/75">
        <Loader2 className="size-3.5 animate-spin" />
        <CompactEstimateTimer
          startedAt={estimate.started_at}
          expectedLatencyMs={estimate.expected_execution_latency_ms}
          upperLatencyMs={estimate.upper_execution_latency_ms}
          estimateQuality={estimate.estimate_quality}
          mode="execution"
        />
      </div>
    );
  }
  const deviationText = [compactPct(outcome.latency_deviation_pct), compactPct(outcome.token_deviation_pct)]
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
        {modelName}{reasoning} · {timeText} · {tokenText}{deviationText ? ` · ${deviationText}` : ""}
      </button>
      {expanded ? (
        <dl className="mt-1 grid gap-x-3 gap-y-0.5 rounded-lg border border-border/40 bg-muted/20 p-2 text-[11px] sm:grid-cols-[max-content_1fr]">
          <dt>Model</dt><dd>{modelName}</dd>
          <dt>Reasoning</dt><dd>{estimate.reasoning_level ?? "—"}</dd>
          <dt>Provider path</dt><dd>{estimate.provider_path ?? "—"}</dd>
          <dt>Selected / recommended</dt><dd>{estimate.selected_model_id ?? "—"}{estimate.recommended_model_id ? ` / ${estimate.recommended_model_id}` : " / —"}</dd>
          <dt>Generation time</dt><dd>est {formatSeconds(estimate.expected_execution_latency_ms)} · actual {outcome ? formatSeconds(outcome.actual_execution_latency_ms) : "—"}{outcome ? ` · ${formatDeviation(outcome.latency_deviation_ms, outcome.latency_deviation_pct)}` : ""}</dd>
          <dt>Input tokens</dt><dd>est {estimate.expected_input_tokens.toLocaleString()} · actual {outcome?.actual_input_tokens.toLocaleString() ?? "—"}</dd>
          <dt>Output tokens</dt><dd>est {estimate.expected_output_tokens.toLocaleString()} · actual {outcome?.actual_output_tokens.toLocaleString() ?? "—"}</dd>
          <dt>Total tokens</dt><dd>est {estimate.expected_total_tokens.toLocaleString()} · actual {outcome?.actual_total_tokens.toLocaleString() ?? "—"}{outcome ? ` · ${outcome.token_deviation_count >= 0 ? "+" : ""}${outcome.token_deviation_count.toLocaleString()} / ${compactPct(outcome.token_deviation_pct) ?? "—"}` : ""}</dd>
          <dt>Cost</dt><dd>est {estimate.estimated_cost_usd == null ? "—" : `$${estimate.estimated_cost_usd.toFixed(6)}`} · actual —</dd>
          {process.env.NODE_ENV !== "production" ? <><dt>Run ids</dt><dd>recommendation — · execution {estimate.runId ?? outcome?.runId ?? "—"}</dd></> : null}
        </dl>
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
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") return <MarkdownText />;
            if (part.type === "tool-call") return part.toolUI ?? <ToolFallback {...part} />;
            return null;
          }}
        </MessagePrimitive.Parts>
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
        <ExecutionTelemetryLine parts={parts} />
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
  return (
    <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-background border-border/60 dark:border-muted-foreground/15 dark:bg-muted/30 ms-auto flex w-full max-w-[85%] flex-col rounded-3xl border shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 rounded-full px-3.5">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
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
