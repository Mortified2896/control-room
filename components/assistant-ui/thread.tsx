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
  MessageCircleIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useEffect, useState, type FC, type ReactNode } from "react";

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

type NoteResponse = {
  note: { threadId: string; body: string; createdAt: string; updatedAt: string } | null;
  configured?: boolean;
};

export const Thread: FC<{
  threadId: string | null;
  notesDisabled?: boolean;
  workflowContent?: ReactNode;
  showWelcome?: boolean;
  routerAbOn?: boolean;
}> = ({
  threadId,
  notesDisabled = false,
  workflowContent,
  showWelcome = true,
  routerAbOn = false,
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
            <Composer />
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

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="bg-background border-border/60 data-[dragging=true]:border-ring data-[dragging=true]:bg-accent/50 focus-within:border-border dark:border-muted-foreground/15 dark:bg-muted/30 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-3xl border p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed dark:shadow-none"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Message Control Room…  (press C to focus)"
            data-shortcut-target={SHORTCUT_TARGETS.focusComposer}
            className="aui-composer-input placeholder:text-muted-foreground/70 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none sm:text-[15px]"
            rows={1}
            autoFocus
            aria-label="Message input (press C to focus)"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-2">
        <ComposerAddAttachment />
        <span aria-hidden="true" className="bg-border/60 h-4 w-px" />
        <KbdHint combo="c" className="aui-composer-focus-shortcut" />
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
        <AuiIf condition={(s) => !s.thread.isRunning}>
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
        </AuiIf>
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
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
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
