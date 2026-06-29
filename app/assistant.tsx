"use client";

import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { routerAbDataSchemas } from "@/lib/assistant-ui/router-ab-data-schemas";
import { lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import { Sidebar } from "@/components/assistant-ui/sidebar";
import { Thread } from "@/components/assistant-ui/thread";
import {
  RecommenderToggle,
  RouterAbToggle,
  ReasoningControls,
  RecommenderControl,
} from "@/components/assistant-ui/router-ab-controls";
import type { RecommenderModelOption } from "@/components/assistant-ui/recommender-model-selector";
import type { ReasoningCapability } from "@/lib/providers/capability";
import type { ThinkingMode } from "@/lib/providers/runtime";
import { ThemeToggle } from "@/components/theme-toggle";
import { KbdHint } from "@/components/kbd-hint";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/components/layout/use-media-query";
import { ChevronDown, Menu } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";

import {
  SHORTCUT_TARGETS,
  type ShortcutTarget,
  eventMatchesCombo,
  isTypingTarget,
} from "@/lib/shortcuts";
import { messageRowsToUIMessages } from "@/lib/assistant-ui/thread-messages";

/**
 * Click or focus the element that owns a given shortcut target.
 *
 * - For New chat / User settings / Select model: the element is a button,
 *   so we call .click() which fires its onClick handler.
 * - For Search chats: the element is the <input>, so we focus it.
 * - For Help: the element is a button, .click() opens the dialog.
 * - For Focus composer: the element is the composer <textarea>, so we
 *   focus it.
 */
function triggerTarget(target: ShortcutTarget) {
  if (typeof document === "undefined") return;
  const el = document.querySelector<HTMLElement>(`[data-shortcut-target="${target}"]`);
  if (!el) return;
  if (target === SHORTCUT_TARGETS.searchChats || target === SHORTCUT_TARGETS.focusComposer) {
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  } else {
    el.click();
  }
}

/**
 * Provider-native reasoning-effort value (OpenAI / Codex
 * `reasoning_effort`, MiniMax mapped mode, or any future
 * provider-native value). The chat composer stores the user's
 * pick as this string and sends it verbatim to `/api/chat`.
 * The runtime adapter validates the value against the selected
 * model's `reasoningCapability.options` before forwarding it
 * to the provider.
 */
type ReasoningLevel = string;
type ModelTier = "cheap" | "expensive";
type SelectionSource =
  | "user_explicit"
  | "user_accepted"
  | "project_default"
  | "registry_default"
  | "system_fallback";

type ModelOption = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  enabled: boolean;
  reason?: string;
  accessPath?: "openai_api" | "minimax_api" | "codex_chatgpt";
  billingLabel?: "OpenAI API billing" | "MiniMax subscription" | "Codex subscription";
  capabilityKind?: "model_provider" | "agent_backend";
  description?: string;
  /**
   * Canonical reasoning / thinking capability for this model. When
   * the registry has no metadata for the id (e.g. opted-in
   * unconfigured model), this is `{ kind: "unknown", control: "unknown" }`
   * — the UI shows the "unknown" notice rather than a fake dropdown.
   */
  reasoningCapability: ReasoningCapability;
  /**
   * Derived legacy field — concrete effort-level list, derived from
   * `reasoningCapability`. Empty for thinking-budget, none, and
   * unknown capabilities.
   */
  reasoningLevels: ReadonlyArray<ReasoningLevel>;
  tier: ModelTier;
};

function selectedAccessExplanation(model: ModelOption | undefined): string {
  if (!model) return "";
  if (model.accessPath === "minimax_api") {
    return "Access: MiniMax subscription";
  }
  if (model.accessPath === "codex_chatgpt") {
    return "Access: Codex subscription";
  }
  return "Access: OpenAI API billing";
}

type ModelsResponse = {
  models: ModelOption[];
  defaultModelId: string | null;
  defaultReasoningLevel: ReasoningLevel;
};

type ModelRecommendation = {
  recommendedModelId: string;
  recommendedProvider: string;
  /**
   * Provider-native reasoning-effort value the recommender picked
   * for the answer model (`null` when the model does not support
   * reasoning controls).
   */
  recommendedReasoningLevel: string | null;
  reasoning: string;
  alternatives?: Array<{
    modelId: string;
    provider: string;
    recommendedReasoningLevel: string | null;
    reason: string;
  }>;
  proposedSubscriptionFallbacks?: Array<{
    toModelId: string;
    toProviderId: string;
    displayLabel: string;
    reason: string;
  }>;
  loudFailure?: boolean;
  diagnostics: {
    recommenderProvider?: string;
    recommenderModelId: string;
    fallback: boolean;
    fallbackReason: string | null;
    attemptedCandidateModel?: string | null;
  };
};

type RouterSettingsLiteResponse = {
  normalChatRouterProvider: string;
  normalChatRouterModelId: string | null;
  normalChatRecommenderModelId: string | null;
  normalChatRecommenderReasoningLevel: string;
  recommenderModelOptions: ReadonlyArray<RecommenderModelOption>;
  defaults: {
    normalChatRouterProvider: string;
    normalChatRouterModelId: string | null;
    normalChatRecommenderModelId: string | null;
    normalChatRecommenderReasoningLevel: string;
  };
};

type ThreadHarness = "pi" | "codex" | "opencode";
type ThreadMode = "chat" | "coding_task";

type ThreadListItem = {
  id: string;
  title: string;
  projectId?: string | null;
  threadMode?: ThreadMode;
  harness?: ThreadHarness | null;
  modelId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectListItem = {
  id: string;
  name: string;
  localPath: string;
  gitRemoteUrl: string | null;
  gitBranch: string | null;
};

type MessageRow = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  parts: unknown;
  modelId: string | null;
  createdAt: string;
  rating?: "up" | "down" | null;
};

type ThreadsResponse = {
  threads: ThreadListItem[];
  configured: boolean;
};

type MessagesResponse = {
  thread: ThreadListItem | null;
  messages: MessageRow[];
  configured: boolean;
};

type ProjectsResponse = {
  projects: ProjectListItem[];
  configured: boolean;
};

// Stub sidebar entries shown before the persisted thread list loads. The
// "local-" prefix keeps them on the offline-only code path (see isLocalThreadId
// below and the same-prefix guards in components/assistant-ui/thread.tsx) so
// they can never reach the persisted-chat API.
const INITIAL_THREADS: ThreadListItem[] = [
  { id: "local-1", title: "Control Room setup" },
  { id: "local-2", title: "Learn Chinese workflow" },
  { id: "local-3", title: "Hermes server task" },
  { id: "local-4", title: "Finance article draft" },
];

// Thread ids that exist only in this browser session and must never hit the
// persisted-chat API. Used for the offline stub entries above and for the
// in-memory "New chat" entries generated by handleNewThread, all of which are
// prefixed with "local-".
function isLocalThreadId(id: string | null | undefined): boolean {
  return !id || id.startsWith("local-");
}

function uiMessagesToThreadMessageLikes(messages: readonly UIMessage[]): ThreadMessageLike[] {
  return messages
    .filter(
      (message) =>
        message.role === "user" || message.role === "assistant" || message.role === "system",
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.parts
        .filter(
          (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => ({ type: "text" as const, text: part.text })),
    }));
}

function extractTextFromLocalMessages(messages: readonly unknown[]): string {
  const last = [...messages].reverse().find((m) => (m as { role?: unknown }).role === "user");
  const content = (last as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: unknown; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("\n")
    .trim();
}

const CodexChatPane: FC<{
  modelId: string | null;
  threadId: string | null;
  initialMessages: UIMessage[];
  notesDisabled: boolean;
  routerAbOn: boolean;
  activeProjectId: string | null;
  threadMode?: ThreadMode;
  harness?: ThreadHarness | null;
  onFinish: () => void;
}> = ({
  modelId,
  threadId,
  initialMessages,
  notesDisabled,
  routerAbOn,
  activeProjectId,
  threadMode,
  harness,
  onFinish,
}) => {
  const codexModel = modelId?.startsWith("codex:")
    ? modelId.slice("codex:".length)
    : "gpt-5.4-mini";
  const runtime = useLocalRuntime(
    {
      async run({ messages, abortSignal }) {
        const message = extractTextFromLocalMessages(messages);
        const response = await fetch("/api/agent-backends/codex/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, model: codexModel }),
          signal: abortSignal,
        });
        const data = (await response.json()) as {
          ok: boolean;
          responseText: string | null;
          error: string | null;
        };
        onFinish();
        return {
          content: [
            {
              type: "text",
              text: data.ok
                ? (data.responseText ?? "")
                : `Codex backend error: ${data.error ?? "Unknown error"}`,
            },
          ],
        };
      },
    },
    { initialMessages: uiMessagesToThreadMessageLikes(initialMessages) },
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        threadId={threadId}
        activeProjectId={activeProjectId}
        threadMode={threadMode}
        harness={harness}
        notesDisabled={notesDisabled}
        routerAbOn={routerAbOn}
      />
    </AssistantRuntimeProvider>
  );
};

const ChatPane: FC<{
  modelId: string | null;
  threadId: string | null;
  initialMessages: UIMessage[];
  notesDisabled: boolean;
  routerAbOn: boolean;
  reasoningLevel: string;
  thinkingMode: ThinkingMode;
  selectionSource: SelectionSource;
  models: ModelOption[];
  activeProjectId: string | null;
  threadMode?: ThreadMode;
  harness?: ThreadHarness | null;
  onFinish: () => void;
  recommenderEnabled?: boolean;
  onToggleRecommender?: (next: boolean) => void;
  recommendation?: ModelRecommendation | null;
  recommendationLoading?: boolean;
  onRecommend?: (message: string) => void;
  onUseRecommendation?: () => void;
  onKeepCurrent?: () => void;
}> = ({
  modelId,
  threadId,
  initialMessages,
  notesDisabled,
  routerAbOn,
  reasoningLevel,
  thinkingMode,
  selectionSource,
  models,
  activeProjectId,
  threadMode,
  harness,
  onFinish,
  recommenderEnabled = false,
  onToggleRecommender,
  recommendation = null,
  recommendationLoading = false,
  onRecommend,
  onUseRecommendation,
  onKeepCurrent,
}) => {
  const selectedModel = models.find((m) => m.modelId === modelId) ?? null;
  if (selectedModel?.providerId === "codex") {
    return (
      <CodexChatPane
        modelId={modelId}
        threadId={threadId}
        initialMessages={initialMessages}
        notesDisabled={notesDisabled}
        routerAbOn={false}
        activeProjectId={activeProjectId}
        threadMode={threadMode}
        harness={harness}
        onFinish={onFinish}
      />
    );
  }
  const effectiveRouterAbOn = routerAbOn && selectedModel?.providerId === "openai";
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        // Static body bits only. We use `prepareSendMessagesRequest` to inject
        // the *current* reasoning level + thinkingMode + routerAb toggle at
        // send time so changes between sends are reflected in the next
        // request. The chat route picks the right wire payload based on the
        // model's `reasoningCapability` (effort_levels → reasoningEffort,
        // thinking_budget → minimax.reasoning.enabled, etc.).
        body: { modelId, threadId },
        prepareSendMessagesRequest: ({ body, messages }) => ({
          body: {
            ...body,
            messages,
            modelId,
            threadId,
            // Send the provider-native value verbatim — the chat
            // route's capability validator rejects stale values
            // before forwarding to the runtime adapter.
            reasoningOption: reasoningLevel,
            thinkingMode,
            selectionSource,
            routerAb: effectiveRouterAbOn,
          },
        }),
      }),
    [modelId, threadId, reasoningLevel, thinkingMode, selectionSource, effectiveRouterAbOn],
  );

  const runtime = useChatRuntime({
    id: threadId ?? undefined,
    messages: initialMessages,
    onFinish,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport,
    // Type-validate the Router A/B data parts emitted by /api/chat and
    // keep them attached to the assistant message state so the panel can
    // pick them up via `useAuiState((s) => s.message.parts)`.
    dataPartSchemas: routerAbDataSchemas,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        threadId={threadId}
        activeProjectId={activeProjectId}
        threadMode={threadMode}
        harness={harness}
        notesDisabled={notesDisabled}
        routerAbOn={effectiveRouterAbOn}
        recommenderEnabled={recommenderEnabled}
        onToggleRecommender={onToggleRecommender}
        recommendation={recommendation}
        recommendationLoading={recommendationLoading}
        onRecommend={onRecommend}
        onUseRecommendation={onUseRecommendation}
        onKeepCurrent={onKeepCurrent}
      />
    </AssistantRuntimeProvider>
  );
};

const ModelSelector: FC<{
  models: ModelOption[];
  selectedModelId: string | null;
  onModelChange: (modelId: string) => void;
  loading: boolean;
}> = ({ models, selectedModelId, onModelChange, loading }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery("(max-width: 639px)");

  useEffect(() => {
    if (isPhone) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPhone]);

  const selected = models.find((m) => m.modelId === selectedModelId);
  const triggerLabel = selected
    ? selected.modelLabel
    : loading
      ? "Loading models…"
      : "Select model";
  const selectedExplanation = selectedAccessExplanation(selected);

  const modelOptions = (() => {
    // Assign ⌘1..⌘9 to the first 9 *enabled* models in display order.
    // This way the "press ⌘3 to switch to the third enabled model"
    // behavior is consistent with what the user sees in the list.
    const enabledIndexById = new Map<string, number>();
    let enabledCounter = 0;
    for (const m of models) {
      if (!m.enabled) continue;
      enabledCounter += 1;
      if (enabledCounter <= 9) {
        enabledIndexById.set(m.modelId, enabledCounter);
      }
    }
    return models.map((m) => {
      const isSelected = m.modelId === selectedModelId;
      const disabled = !m.enabled;
      const shortcutIndex = enabledIndexById.get(m.modelId);
      return (
        <button
          key={`${m.providerId}:${m.modelId}`}
          type="button"
          disabled={disabled}
          title={disabled ? (m.reason ?? "Not available") : undefined}
          onClick={() => {
            if (disabled) return;
            onModelChange(m.modelId);
            setOpen(false);
          }}
          className={
            "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors sm:min-h-0 sm:py-1.5 " +
            (disabled
              ? "cursor-not-allowed text-muted-foreground/60"
              : isSelected
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground")
          }
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{m.modelLabel}</div>
            <div className="flex flex-wrap items-center gap-1 truncate text-[10px] text-muted-foreground">
              <span>{m.billingLabel ?? m.providerLabel}</span>
              {m.accessPath === "minimax_api" ? <span>· MiniMax key</span> : null}
              {m.accessPath === "openai_api" ? <span>· OpenAI key</span> : null}
              {disabled && m.reason ? <span>— {m.reason}</span> : null}
            </div>
          </div>
          {shortcutIndex !== undefined && (
            <KbdHint
              combo={`${shortcutIndex}`}
              className="aui-model-dropdown-shortcut bg-background/40"
            />
          )}
        </button>
      );
    });
  })();

  return (
    <div
      ref={ref}
      className="relative flex items-center border-b border-border/60 bg-background px-3 py-2 sm:px-4"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        data-shortcut-target={SHORTCUT_TARGETS.selectModel}
        aria-label={`Select model (currently ${triggerLabel}; press M)`}
        className="aui-model-selector-trigger relative inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 py-1 pl-2.5 pr-8 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground sm:min-h-0 sm:pr-10"
        disabled={loading}
      >
        <span className="size-1.5 rounded-full bg-emerald-500/80" aria-hidden />
        <span className="truncate">{triggerLabel}</span>
        {selected?.billingLabel ? (
          <span className="hidden shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            {selected.billingLabel}
          </span>
        ) : null}
        <ChevronDown className="size-3 shrink-0 opacity-70" />
        <KbdHint
          combo="m"
          className="aui-model-selector-shortcut pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 bg-background/60"
        />
      </button>

      {selectedExplanation ? (
        <div className="ml-2 hidden min-w-0 truncate text-[11px] text-muted-foreground md:block">
          {selectedExplanation}
        </div>
      ) : null}

      {open && !isPhone && (
        <div className="absolute left-4 top-full z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {models.length === 0 && !loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No models available</div>
          )}
          {modelOptions}
        </div>
      )}

      <DialogPrimitive.Root open={open && isPhone} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-hidden rounded-t-2xl border border-border bg-popover shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom">
            <div className="safe-bottom flex max-h-[70dvh] flex-col">
              <div className="border-b border-border/60 px-4 py-3">
                <DialogPrimitive.Title className="text-sm font-semibold text-popover-foreground">
                  Select model
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
                  Choose the model/backend for this chat. Access path and billing are shown for each
                  option.
                </DialogPrimitive.Description>
              </div>
              <div className="overflow-y-auto py-1">
                {models.length === 0 && !loading && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">No models available</div>
                )}
                {modelOptions}
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
};

/**
 * Row of secondary controls that live below the model picker:
 *   - the reasoning-level dropdown (Side A's reasoning effort),
 *   - the Router A/B on/off toggle.
 *
 * The reasoning-level dropdown is always visible — Side A always uses the
 * user's pick — and only lists levels supported by the currently-selected
 * model. The A/B toggle controls whether the recommender runs at all.
 */
const RouterControlsBar: FC<{
  models: ModelOption[];
  selectedModelId: string | null;
  reasoningLevel: string;
  onReasoningChange: (next: string) => void;
  thinkingMode: ThinkingMode;
  onThinkingModeChange: (next: ThinkingMode) => void;
  routerAbOn: boolean;
  onRouterAbChange: (next: boolean) => void;
  recommenderEnabled?: boolean;
  onToggleRecommender?: (next: boolean) => void;
  recommenderModelId?: string | null;
  recommenderModelOptions?: ReadonlyArray<RecommenderModelOption>;
  recommenderModelLoading?: boolean;
  recommenderModelSaving?: boolean;
  onRecommenderModelChange?: (modelId: string) => void;
  recommenderReasoningLevel?: string;
  onRecommenderReasoningChange?: (level: string) => void;
}> = ({
  models,
  selectedModelId,
  reasoningLevel,
  onReasoningChange,
  thinkingMode,
  onThinkingModeChange,
  routerAbOn,
  onRouterAbChange,
  recommenderEnabled = false,
  onToggleRecommender,
  recommenderModelId = null,
  recommenderModelOptions = [],
  recommenderModelLoading = false,
  recommenderModelSaving = false,
  onRecommenderModelChange,
  recommenderReasoningLevel = "low" as string,
  onRecommenderReasoningChange,
}) => {
  const selectedModel = useMemo(
    () => models.find((m) => m.modelId === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const capability: ReasoningCapability | null = selectedModel
    ? selectedModel.reasoningCapability
    : null;
  const supportedLevels: ReadonlyArray<string> = selectedModel
    ? selectedModel.reasoningLevels
    : ["low"];
  const supportsRouterAb = selectedModel?.providerId === "openai";
  // If the persisted reasoning level is no longer supported by the new
  // model, snap to the cheapest supported level so the dropdown stays sane.
  useEffect(() => {
    if (supportedLevels.includes(reasoningLevel)) return;
    if (supportedLevels.length === 0) return;
    onReasoningChange(supportedLevels[0]);
  }, [supportedLevels, reasoningLevel, onReasoningChange]);
  useEffect(() => {
    if (supportsRouterAb || !routerAbOn) return;
    onRouterAbChange(false);
  }, [supportsRouterAb, routerAbOn, onRouterAbChange]);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-background px-3 py-2 sm:px-4">
      <ReasoningControls
        capability={capability}
        reasoningLevel={reasoningLevel}
        onReasoningChange={onReasoningChange}
        thinkingMode={thinkingMode}
        onThinkingModeChange={onThinkingModeChange}
      />
      {supportsRouterAb ? (
        <RouterAbToggle on={routerAbOn} onToggle={onRouterAbChange} />
      ) : (
        <div className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
          Router A/B is OpenAI-only.
        </div>
      )}
      {onToggleRecommender ? (
        onRecommenderModelChange ? (
          <RecommenderControl
            enabled={recommenderEnabled}
            onToggle={onToggleRecommender}
            modelId={recommenderModelId}
            modelOptions={recommenderModelOptions}
            onModelChange={onRecommenderModelChange}
            modelLoading={recommenderModelLoading}
            modelSaving={recommenderModelSaving}
            reasoningLevel={recommenderReasoningLevel}
            onReasoningChange={onRecommenderReasoningChange}
          />
        ) : (
          <RecommenderToggle on={recommenderEnabled} onToggle={onToggleRecommender} />
        )
      ) : null}
      <div className="ml-auto flex items-center">
        <ThemeToggle />
      </div>
    </div>
  );
};

const MobileHeader: FC<{
  activeThreadTitle: string;
  onOpenSidebar: () => void;
}> = ({ activeThreadTitle, onOpenSidebar }) => {
  return (
    <header className="safe-top flex min-h-14 items-center gap-2 border-b border-border/60 bg-background px-3 md:hidden">
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        aria-label="Open sidebar"
        onClick={onOpenSidebar}
        className="-ml-1 rounded-full"
      >
        <Menu className="size-5" />
      </Button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">Control Room</div>
        <div className="truncate text-[11px] text-muted-foreground/70">{activeThreadTitle}</div>
      </div>
    </header>
  );
};

const SidebarPanel: FC<{
  threads: { id: string; title: string }[];
  projects: ProjectListItem[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onOpenProject: (localPath: string) => Promise<boolean>;
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteAllThreads: () => void;
  deleteAllDisabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({
  threads,
  projects,
  activeProjectId,
  onSelectProject,
  onOpenProject,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteAllThreads,
  deleteAllDisabled,
  open,
  onOpenChange,
}) => {
  return (
    <>
      <div className="hidden h-full shrink-0 md:block">
        <Sidebar
          threads={threads}
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={onSelectProject}
          onOpenProject={onOpenProject}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
          onNewThread={onNewThread}
          onDeleteAllThreads={onDeleteAllThreads}
          deleteAllDisabled={deleteAllDisabled}
        />
      </div>

      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 md:hidden data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="safe-top fixed inset-y-0 left-0 z-50 h-dvh w-72 max-w-[85vw] border-r border-border/60 bg-background outline-none md:hidden data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left">
            <DialogPrimitive.Title className="sr-only">Control Room sidebar</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Search chats, start a new chat, or switch threads.
            </DialogPrimitive.Description>
            <Sidebar
              threads={threads}
              projects={projects}
              activeProjectId={activeProjectId}
              onSelectProject={onSelectProject}
              onOpenProject={onOpenProject}
              activeThreadId={activeThreadId}
              onSelectThread={onSelectThread}
              onNewThread={onNewThread}
              onDeleteAllThreads={onDeleteAllThreads}
              deleteAllDisabled={deleteAllDisabled}
              onClose={() => onOpenChange(false)}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
};

const harnessLabel = (harness: ThreadHarness) =>
  harness === "opencode" ? "OpenCode" : harness === "codex" ? "Codex" : "Pi";

type HarnessRecommendation = {
  recommendedHarness: ThreadHarness;
  reasoning: string;
  alternatives?: Array<{ harness: ThreadHarness; reason: string }>;
};

const NewChatDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectListItem | null;
  onCreate: (input: {
    threadMode: ThreadMode;
    harness?: ThreadHarness | null;
    firstMessage?: string;
  }) => void;
}> = ({ open, onOpenChange, project, onCreate }) => {
  const [threadMode, setThreadMode] = useState<ThreadMode>("chat");
  const [instruction, setInstruction] = useState("");
  const [selectedHarness, setSelectedHarness] = useState<ThreadHarness | null>(null);
  const [recommendation, setRecommendation] = useState<HarnessRecommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setThreadMode("chat");
    setInstruction("");
    setSelectedHarness(null);
    setRecommendation(null);
    setError(null);
  }, [open]);

  const recommend = async () => {
    if (!project) return;
    const task = instruction.trim();
    if (!task) {
      setError("Paste the first coding task before requesting a recommendation.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/harness/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, instruction: task }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as HarnessRecommendation;
      setRecommendation(data);
      setSelectedHarness(data.recommendedHarness);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recommendation failed");
    } finally {
      setLoading(false);
    }
  };

  const create = () => {
    if (threadMode === "chat") {
      onCreate({ threadMode: "chat" });
      onOpenChange(false);
      return;
    }
    if (!project) return;
    if (!instruction.trim()) {
      setError("Coding task requires the first task prompt.");
      return;
    }
    if (!selectedHarness) {
      setError("Choose a harness before creating the coding task thread.");
      return;
    }
    onCreate({
      threadMode: "coding_task",
      harness: selectedHarness,
      firstMessage: instruction.trim(),
    });
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-4 shadow-xl">
          <DialogPrimitive.Title className="text-base font-semibold">
            New chat
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
            {project ? `Create a chat in ${project.name}.` : "Create a general chat."}
          </DialogPrimitive.Description>

          <div className="mt-4 flex gap-2 text-sm">
            <Button
              variant={threadMode === "chat" ? "default" : "outline"}
              onClick={() => setThreadMode("chat")}
            >
              Chat
            </Button>
            {project ? (
              <Button
                variant={threadMode === "coding_task" ? "default" : "outline"}
                onClick={() => setThreadMode("coding_task")}
              >
                Coding task
              </Button>
            ) : null}
          </div>

          {threadMode === "coding_task" && project ? (
            <div className="mt-4 space-y-3">
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                className="min-h-28 w-full rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-foreground"
                placeholder="What should this coding chat work on?"
              />
              <Button type="button" variant="outline" onClick={recommend} disabled={loading}>
                {loading ? "Recommending…" : "Recommend harness"}
              </Button>
              {recommendation ? (
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <div className="font-medium">
                    Recommended harness: {harnessLabel(recommendation.recommendedHarness)}
                  </div>
                  <p className="mt-1 text-muted-foreground">{recommendation.reasoning}</p>
                  {recommendation.alternatives?.length ? (
                    <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                      {recommendation.alternatives.map((alt) => (
                        <li key={alt.harness}>
                          {harnessLabel(alt.harness)}: {alt.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 text-sm">
                {(["pi", "codex", "opencode"] as const).map((harness) => (
                  <Button
                    key={harness}
                    type="button"
                    variant={selectedHarness === harness ? "default" : "outline"}
                    onClick={() => setSelectedHarness(harness)}
                  >
                    {harnessLabel(harness)}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {error ? <div className="mt-3 text-sm text-destructive">{error}</div> : null}
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button type="button" onClick={create}>
              Create thread
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

export const Assistant = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [threads, setThreads] = useState<ThreadListItem[]>(INITIAL_THREADS);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    INITIAL_THREADS[0]?.id ?? null,
  );
  const [threadMessages, setThreadMessages] = useState<UIMessage[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [deletingThreads, setDeletingThreads] = useState(false);
  const [dbConfigured, setDbConfigured] = useState(true);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedModelSelectionSource, setSelectedModelSelectionSource] =
    useState<SelectionSource>("registry_default");
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<string>("low");
  const [selectedThinkingMode, setSelectedThinkingMode] =
    useState<ThinkingMode>("provider_default");
  const [routerAbOn, setRouterAbOn] = useState(true);
  const [recommenderModelId, setRecommenderModelId] = useState<string | null>(null);
  const [recommenderModelOptions, setRecommenderModelOptions] = useState<
    ReadonlyArray<RecommenderModelOption>
  >([]);
  const [recommenderModelLoading, setRecommenderModelLoading] = useState(true);
  const [recommenderModelSaving, setRecommenderModelSaving] = useState(false);
  const [recommenderModelError, setRecommenderModelError] = useState<string | null>(null);
  const [recommenderReasoningLevel, setRecommenderReasoningLevel] = useState<string>("low");
  // Recommend-model toggle. When ON, every Send goes through a
  // recommendation round-trip first. When OFF, the chat composer
  // sends with the manually selected model immediately. Persisted
  // per-tab via sessionStorage so a refresh keeps the user's choice.
  const [recommenderEnabled, setRecommenderEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem("control_room.recommender_enabled") === "true";
    } catch {
      return false;
    }
  });
  const toggleRecommender = useCallback((next: boolean) => {
    setRecommenderEnabled(next);
    try {
      window.sessionStorage.setItem("control_room.recommender_enabled", String(next));
    } catch {
      // sessionStorage may be unavailable (private mode, etc.) — that's fine.
    }
    // Toggling off clears any in-flight recommendation banner so the
    // composer returns to a clean state.
    if (!next) setRecommendation(null);
  }, []);
  const [recommendation, setRecommendation] = useState<ModelRecommendation | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const newChatCounter = useRef(0);

  const refreshThreads = useCallback(async () => {
    try {
      const url = `/api/threads?projectId=${activeProjectId ?? "null"}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: ThreadsResponse = await res.json();
      setDbConfigured(data.configured);
      if (data.configured) {
        setThreads(data.threads);
        setActiveThreadId((prev) =>
          prev && data.threads.some((t) => t.id === prev) ? prev : (data.threads[0]?.id ?? null),
        );
      }
    } catch {
      setDbConfigured(false);
      setThreads((prev) => (prev.length ? prev : INITIAL_THREADS));
      setActiveThreadId((prev) => prev ?? INITIAL_THREADS[0]?.id ?? null);
    } finally {
      setThreadsLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!mounted) return;
    void refreshThreads();
  }, [mounted, refreshThreads]);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: ProjectsResponse = await res.json();
      if (data.configured) setProjects(data.projects);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    void refreshProjects();
  }, [mounted, refreshProjects]);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: ModelsResponse = await res.json();
        if (cancelled) return;
        setModels(data.models);
        setSelectedModelId((prev) => {
          if (prev && data.models.some((m) => m.modelId === prev && m.enabled)) return prev;
          setSelectedModelSelectionSource("registry_default");
          return data.defaultModelId;
        });
        setSelectedReasoningLevel((prev) =>
          prev && data.defaultReasoningLevel ? prev : data.defaultReasoningLevel,
        );
        setModelsError(null);
      } catch (err) {
        if (cancelled) return;
        setModelsError(err instanceof Error ? err.message : "Failed to load models");
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  // Fetch the lightweight router settings (current recommender model +
  // available options). This drives the inline `RecommenderControl` in
  // the chat composer. Failures are non-fatal: the picker just stays
  // empty until the user clicks Save in Settings.
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/router/settings", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: RouterSettingsLiteResponse = await res.json();
        if (cancelled) return;
        setRecommenderModelId(data.normalChatRecommenderModelId ?? null);
        setRecommenderModelOptions(data.recommenderModelOptions ?? []);
        if (data.normalChatRecommenderReasoningLevel) {
          setRecommenderReasoningLevel(data.normalChatRecommenderReasoningLevel);
        }
        setRecommenderModelError(null);
      } catch (err) {
        if (cancelled) return;
        setRecommenderModelError(
          err instanceof Error ? err.message : "Failed to load recommender settings",
        );
      } finally {
        if (!cancelled) setRecommenderModelLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  const handleRecommenderModelChange = useCallback(
    async (nextId: string) => {
      if (!nextId) return;
      const previousId = recommenderModelId;
      setRecommenderModelId(nextId);
      setRecommenderModelSaving(true);
      setRecommenderModelError(null);
      try {
        const res = await fetch("/api/router/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ normalChatRecommenderModelId: nextId }),
        });
        if (!res.ok) {
          const reason = await res
            .json()
            .catch(() => ({ reason: `status ${res.status}` }))
            .then((j: { reason?: string }) => j.reason ?? `status ${res.status}`);
          throw new Error(reason);
        }
      } catch (err) {
        // Roll back so the picker reflects what the server actually saved.
        setRecommenderModelId(previousId);
        setRecommenderModelError(
          err instanceof Error ? err.message : "Failed to save recommender model",
        );
      } finally {
        setRecommenderModelSaving(false);
      }
    },
    [recommenderModelId],
  );

  const handleRecommenderReasoningChange = useCallback(
    async (nextLevel: ReasoningLevel) => {
      if (nextLevel === recommenderReasoningLevel) return;
      const previousLevel = recommenderReasoningLevel;
      setRecommenderReasoningLevel(nextLevel);
      setRecommenderModelSaving(true);
      setRecommenderModelError(null);
      try {
        const res = await fetch("/api/router/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ normalChatRecommenderReasoningLevel: nextLevel }),
        });
        if (!res.ok) {
          const reason = await res
            .json()
            .catch(() => ({ reason: `status ${res.status}` }))
            .then((j: { reason?: string }) => j.reason ?? `status ${res.status}`);
          throw new Error(reason);
        }
      } catch (err) {
        setRecommenderReasoningLevel(previousLevel);
        setRecommenderModelError(
          err instanceof Error ? err.message : "Failed to save recommender reasoning level",
        );
      } finally {
        setRecommenderModelSaving(false);
      }
    },
    [recommenderReasoningLevel],
  );

  useEffect(() => {
    if (!mounted || isLocalThreadId(activeThreadId)) {
      setThreadMessages([]);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/threads/${activeThreadId}/messages`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: MessagesResponse = await res.json();
        if (cancelled) return;
        setDbConfigured(data.configured);
        setThreadMessages(messageRowsToUIMessages(data.messages));
        if (data.thread) {
          setThreads((prev) =>
            prev.map((t) => (t.id === data.thread?.id ? { ...t, ...data.thread } : t)),
          );
          // When the user switches to a chat, restore its stored
          // model so the picker + reasoning controls reflect the
          // model the chat was created with. The chat composer uses
          // this id to send new messages; without restoring it, the
          // picker would keep showing the previously-active model's
          // settings, which makes chat switching feel broken (the
          // user changes chats and the dropdown silently stays on
          // the old model). We only update if the stored modelId
          // is still in the available models list so the picker
          // never shows a model that the user has since disabled.
          const thread = data.thread;
          if (thread && thread.modelId) {
            setSelectedModelId((prev) => {
              if (prev === thread.modelId) return prev;
              // models is read via closure; the effect deps include
              // `models` so this re-runs whenever they change.
              if (models.some((m) => m.modelId === thread.modelId && m.enabled)) {
                setSelectedModelSelectionSource("project_default");
                return thread.modelId ?? null;
              }
              return prev;
            });
          }
        }
      } catch {
        if (!cancelled) setThreadMessages([]);
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, activeThreadId, models]);

  const handleCreateThread = useCallback(
    async (input?: {
      threadMode?: ThreadMode;
      harness?: ThreadHarness | null;
      firstMessage?: string;
    }) => {
      const threadMode = input?.threadMode ?? "chat";
      const harness = input?.harness ?? null;
      const firstMessage = input?.firstMessage?.trim() ?? "";
      if (dbConfigured) {
        try {
          const res = await fetch("/api/threads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "New chat",
              modelId: selectedModelId,
              projectId: activeProjectId,
              threadMode,
              harness,
              firstMessage,
            }),
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const data: { thread: ThreadListItem } = await res.json();
          setThreads((prev) => [data.thread, ...prev.filter((t) => t.id !== data.thread.id)]);
          setActiveThreadId(data.thread.id);
          setThreadMessages([]);
          return;
        } catch {
          setDbConfigured(false);
        }
      }

      newChatCounter.current += 1;
      const newThread: ThreadListItem = {
        id: `local-${Date.now()}-${newChatCounter.current}`,
        title: `New chat ${newChatCounter.current}`,
        projectId: activeProjectId,
        threadMode,
        harness,
      };
      setThreads((prev) => [newThread, ...prev]);
      setActiveThreadId(newThread.id);
      setThreadMessages([]);
    },
    [dbConfigured, selectedModelId, activeProjectId],
  );

  const handleNewThread = useCallback(() => {
    if (activeProjectId) setNewChatOpen(true);
    else void handleCreateThread({ threadMode: "chat" });
  }, [activeProjectId, handleCreateThread]);

  const handleDeleteAllThreads = useCallback(async () => {
    if (threads.length === 0 || deletingThreads) return;
    const scope = activeProjectId ? "this project" : "General chat";
    const confirmed = window.confirm(
      `Delete all ${threads.length} chat${threads.length === 1 ? "" : "s"} in ${scope}? This cannot be undone.`,
    );
    if (!confirmed) return;

    if (!dbConfigured) {
      setThreads([]);
      setActiveThreadId(null);
      setThreadMessages([]);
      return;
    }

    setDeletingThreads(true);
    try {
      const res = await fetch(`/api/threads?projectId=${activeProjectId ?? "null"}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setThreads([]);
      setActiveThreadId(null);
      setThreadMessages([]);
      void refreshThreads();
    } catch {
      await refreshThreads();
    } finally {
      setDeletingThreads(false);
    }
  }, [activeProjectId, dbConfigured, deletingThreads, refreshThreads, threads.length]);

  const handleSelectThread = useCallback((id: string) => {
    setActiveThreadId(id);
    setSidebarOpen(false);
  }, []);

  const handleSelectProject = useCallback((id: string | null) => {
    setActiveProjectId(id);
    setActiveThreadId(null);
    setThreadMessages([]);
  }, []);

  const handleOpenProject = useCallback(
    async (localPath: string) => {
      const res = await fetch("/api/projects/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath }),
      });
      if (!res.ok) return false;
      const data: { project: ProjectListItem } = await res.json();
      setProjects((prev) => [data.project, ...prev.filter((p) => p.id !== data.project.id)]);
      setActiveProjectId(data.project.id);
      setActiveThreadId(null);
      setThreadMessages([]);
      void refreshProjects();
      return true;
    },
    [refreshProjects],
  );

  const handleRecommendModel = useCallback(
    async (message: string) => {
      const selected = models.find((m) => m.modelId === selectedModelId) ?? null;
      const trimmed = message.trim();
      if (!trimmed) return;
      setRecommendationLoading(true);
      try {
        const res = await fetch("/api/model/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: isLocalThreadId(activeThreadId) ? null : activeThreadId,
            projectId: activeProjectId,
            message: trimmed,
            currentModelId: selectedModelId,
            currentProvider: selected?.providerId ?? null,
            currentReasoningLevel: selectedReasoningLevel,
            mode: "normal_chat",
          }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: ModelRecommendation = await res.json();
        setRecommendation(data);
      } catch {
        setRecommendation({
          recommendedModelId: selectedModelId ?? "gpt-5.4-mini",
          recommendedProvider: selected?.providerId ?? "openai",
          recommendedReasoningLevel: selectedReasoningLevel,
          reasoning:
            "The recommender request failed. Control Room will not auto-substitute a different model.",
          loudFailure: true,
          proposedSubscriptionFallbacks: [],
          diagnostics: {
            recommenderProvider: "unknown",
            recommenderModelId: "unknown",
            fallback: true,
            fallbackReason: "model_recommendation_failed",
            attemptedCandidateModel: null,
          },
        });
      } finally {
        setRecommendationLoading(false);
      }
    },
    [activeProjectId, activeThreadId, models, selectedModelId, selectedReasoningLevel],
  );

  const handleUseRecommendation = useCallback(() => {
    if (!recommendation) return;
    const proposed = recommendation.loudFailure
      ? (recommendation.proposedSubscriptionFallbacks?.[0] ?? null)
      : null;
    setSelectedModelId(proposed?.toModelId ?? recommendation.recommendedModelId);
    setSelectedModelSelectionSource("user_accepted");
    if (!proposed && recommendation.recommendedReasoningLevel) {
      setSelectedReasoningLevel(recommendation.recommendedReasoningLevel);
    }
    // TODO: persist accepted recommendation history in run/message metadata.
    setRecommendation(null);
  }, [recommendation]);

  const handleKeepCurrent = useCallback(() => setRecommendation(null), []);

  // Centralized keyboard-shortcut handler. See lib/shortcuts.ts for the
  // full registry. The typing guard (isTypingTarget) is enforced here for
  // every shortcut marked requiresIdle in SHORTCUT_ENTRIES, so we never
  // hijack a key the user is typing into an input / textarea /
  // contenteditable. We also bail on e.repeat and on modifier keys for
  // single-key shortcuts, so the user can still use browser shortcuts
  // like Cmd+N (Firefox new window) or Cmd+Shift+; without our handler
  // firing first.
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (eventMatchesCombo(e, "mod+/")) {
        e.preventDefault();
        const help = document.querySelector<HTMLElement>(
          `[data-shortcut-target="${SHORTCUT_TARGETS.help}"]`,
        );
        help?.click();
        return;
      }
      const idle = !isTypingTarget(e.target);
      if (isCoarsePointer) return;
      if (idle) {
        const noMods = !e.metaKey && !e.ctrlKey && !e.altKey;
        if (noMods) {
          const k = e.key.toLowerCase();
          if (k >= "1" && k <= "9") {
            const idx = Number(k) - 1;
            const enabled = models.filter((m) => m.enabled);
            const target = enabled[idx];
            if (target) {
              e.preventDefault();
              setSelectedModelId(target.modelId);
              return;
            }
          }
          let target: ShortcutTarget | null = null;
          if (k === "n") target = SHORTCUT_TARGETS.newChat;
          else if (k === "k") target = SHORTCUT_TARGETS.searchChats;
          else if (k === "m") target = SHORTCUT_TARGETS.selectModel;
          else if (k === "c") target = SHORTCUT_TARGETS.focusComposer;
          else if (k === ",") target = SHORTCUT_TARGETS.userSettings;
          if (target) {
            e.preventDefault();
            triggerTarget(target);
          }
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mounted, models, isCoarsePointer]);

  if (!mounted) return <div className="h-dvh" />;

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const activeThreadTitle = activeThread?.title ?? "New chat";
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

  return (
    <div className="flex h-dvh overflow-hidden">
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        project={activeProject}
        onCreate={(input) => void handleCreateThread(input)}
      />

      <SidebarPanel
        threads={threads}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={handleSelectProject}
        onOpenProject={handleOpenProject}
        activeThreadId={activeThreadId ?? ""}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onDeleteAllThreads={handleDeleteAllThreads}
        deleteAllDisabled={threadsLoading || deletingThreads}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
      />

      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <MobileHeader
          activeThreadTitle={activeThreadTitle}
          onOpenSidebar={() => setSidebarOpen(true)}
        />

        <ModelSelector
          models={models}
          selectedModelId={selectedModelId}
          onModelChange={(next) => {
            setSelectedModelId(next);
            setSelectedModelSelectionSource("user_explicit");
          }}
          loading={modelsLoading}
        />

        <RouterControlsBar
          models={models}
          selectedModelId={selectedModelId}
          reasoningLevel={selectedReasoningLevel}
          onReasoningChange={setSelectedReasoningLevel}
          thinkingMode={selectedThinkingMode}
          onThinkingModeChange={setSelectedThinkingMode}
          routerAbOn={routerAbOn}
          onRouterAbChange={setRouterAbOn}
          recommenderEnabled={recommenderEnabled}
          onToggleRecommender={toggleRecommender}
          recommenderModelId={recommenderModelId}
          recommenderModelOptions={recommenderModelOptions}
          recommenderModelLoading={recommenderModelLoading}
          recommenderModelSaving={recommenderModelSaving}
          onRecommenderModelChange={handleRecommenderModelChange}
          recommenderReasoningLevel={recommenderReasoningLevel}
          onRecommenderReasoningChange={handleRecommenderReasoningChange}
        />

        {!dbConfigured && (
          <div className="border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
            Working offline — chats and notes in this session may not persist.
          </div>
        )}

        {modelsError && (
          <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
            Failed to load models: {modelsError}
          </div>
        )}

        {recommenderModelError ? (
          <div
            className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive"
            data-testid="chat-recommender-model-error"
            role="alert"
          >
            Recommender model: {recommenderModelError}. You can still pick a model in Settings →
            Router → Normal-chat recommender model.
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          {messagesLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading thread…
            </div>
          ) : (
            <ChatPane
              key={activeThreadId ?? "empty"}
              modelId={selectedModelId}
              threadId={activeThreadId}
              initialMessages={threadMessages}
              notesDisabled={!dbConfigured || threadsLoading}
              routerAbOn={routerAbOn}
              reasoningLevel={selectedReasoningLevel}
              thinkingMode={selectedThinkingMode}
              selectionSource={selectedModelSelectionSource}
              models={models}
              activeProjectId={activeProjectId}
              threadMode={activeThread?.threadMode ?? "chat"}
              harness={activeThread?.harness ?? null}
              recommenderEnabled={recommenderEnabled}
              onToggleRecommender={toggleRecommender}
              recommendation={recommendation}
              recommendationLoading={recommendationLoading}
              onRecommend={handleRecommendModel}
              onUseRecommendation={handleUseRecommendation}
              onKeepCurrent={handleKeepCurrent}
              onFinish={() => void refreshThreads()}
            />
          )}
        </div>
      </div>
    </div>
  );
};
