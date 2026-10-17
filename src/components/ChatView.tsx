// The 1:1 chat (design U8, Grok-Bot conventions): soft grey bot bubbles and
// black user bubbles in one centred column, centred time separators and
// system lines, result / approval / draft cards with status pills, thread
// links under answered messages, the typing line, the error strip above the
// pill composer, and the routine panel on the right.
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ListTree,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Lock,
  Webhook,
  X,
} from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import {
  api,
  useStore,
  formatTime,
  messageVersions,
  openNotificationTarget,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
  type Task,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { BotAvatar } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { initialTail, nextTail, showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { stepLabel } from "@/lib/computer-steps";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachedFileChips, AttachedImageGallery } from "./AttachmentPreview";
import { RenameTitle } from "./RenameTitle";
import { SpeakButton } from "./SpeakButton";
import { CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { intlLocale, msg, t } from "@/lib/i18n";
import { useFocusMessage } from "@/lib/focus-message";
import { groupActivityRuns, type TranscriptItem } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useBottomFollow } from "@/hooks/use-bottom-follow";
import { COMPOSER_DOCK_HEIGHT, TRANSCRIPT_END_PAD } from "@/lib/composer-dock";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { timelineEvents } from "@/lib/taskTimeline";
import { useReplyDraft } from "@/lib/drafts";
import { chiefBot } from "@/lib/org";
import { useApi, useOrg } from "@/state/org-api";
import type { DispatchRun } from "../../shared/dispatch-types";
import type { OrgDecision } from "../../shared/org-types";
import { pendingApprovals } from "./PendingApproval";
import { ChatHeader } from "./chat/ChatHeader";
import { RoutinePanel } from "./chat/RoutinePanel";
import { DecisionCard, DispatchRunCard } from "./chat/ResultCards";
import { CardButton, ErrorStrip, SOFT, SystemLine, ThreadLink, TimeSeparator } from "./chat/primitives";
import { IconBolt, IconClock, IconUsers } from "./chat/icons";
import {
  clockLabel,
  currentFailure,
  failureText,
  isExpiryLine,
  isFailureLine,
  isSystemLine,
  isTurnError,
  nextReplyTarget,
  replyIndex,
  runningRunCount,
  runsForThread,
  runsKey,
  separatorBetween,
  slotByTime,
  typingLabel,
} from "./chat/chat-model";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** The transcript column: centred, the same width as the composer. */
const COLUMN = "mx-auto w-full max-w-[720px] px-5";

/** Bot bubble and user bubble, as the design draws them. */
const BOT_BUBBLE = cn("w-fit min-w-0 max-w-[560px] rounded-2xl rounded-tl-md px-[13px] py-[9px] text-[13.5px] leading-[1.6] text-ink", SOFT);
const USER_BUBBLE = "w-fit min-w-0 max-w-[440px] rounded-2xl rounded-tr-md bg-bubble-user px-[13px] py-[9px] text-[13.5px] leading-[1.6] whitespace-pre-wrap text-bubble-user-ink";

/** How often the header's "N running" and the run cards refresh. */
const DISPATCH_POLL_MS = 4_000;

/** Screen-reader names for the timeline dots; the state values stay ids. */
const TIMELINE_STATE_LABEL = {
  running: msg("running"),
  complete: msg("complete"),
  failed: msg("failed"),
  observed: msg("observed"),
} as const;

function TaskTimeline({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const events = useMemo(() => timelineEvents(messages), [messages]);
  if (events.length === 0) return null;
  const recent = events.slice(-8);
  return (
    <div className={cn(COLUMN, "pt-1")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
      >
        <span className="flex items-center gap-1.5"><ListTree size={14} /> {t("Execution timeline")}{busy ? ` · ${t("running")}` : ""}</span>
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="ml-2 border-l border-hairline/40 pb-2 pl-3">
          {recent.map((event) => (
            <li key={event.id} className="relative flex items-center gap-2 py-1 text-[12px] text-ink-secondary">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -left-[17px] size-2 rounded-full",
                  event.state === "failed"
                    ? "bg-danger"
                    : event.state === "complete"
                      ? "bg-success"
                      : event.state === "running"
                        ? "animate-status-pulse bg-accent"
                        : "bg-ink-secondary",
                )}
              />
              <span className="sr-only">{t(TIMELINE_STATE_LABEL[event.state])}: </span>
              <span className="truncate">{event.label}</span>
              <time className="ml-auto shrink-0 text-[11px] text-ink-secondary/70">{formatTime(event.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const HOVER_ACTION =
  "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100";

/** Hover/focus-revealed copy control shared by user + bot bubbles. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={t("Copy message")}
      title={t("Copy message")}
      className={cn(HOVER_ACTION, className)}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-fit min-w-0 max-w-[560px] rounded-[14px] bg-danger/[0.06] px-3.5 py-2.5 text-[13px] text-danger inset-ring inset-ring-danger/25">
        <div className="flex items-start gap-2">
          <IconBolt size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <CardButton variant="white" onClick={onRetry} className="mt-2 h-7 text-danger">
              <RefreshCw size={12} /> {t("Retry")}
            </CardButton>
          )
        )}
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <div className={cn(BOT_BUBBLE, "whitespace-pre-wrap")}>{this.props.fallbackText}</div>;
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full min-w-0 max-w-[560px] rounded-2xl bg-raised px-4 py-3 text-ink inset-ring-[1.5px] inset-ring-select">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <CardButton variant="grey" onClick={onCancel}>
          {t("Cancel")}
        </CardButton>
        <CardButton onClick={submit} disabled={!draft.trim()}>
          {t("Send")}
        </CardButton>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: () => void;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const webhookView = user ? webhookMessageView(text) : null;
  const attachments = user && !webhookView ? splitTranscriptAttachments(text) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing && !webhookView) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };
  const pinned = bot.pinnedMessageId === message.id;
  const pinButton = (
    <button
      onClick={() =>
        dispatch({
          type: "updateBot",
          botId: bot.id,
          patch: { pinnedMessageId: pinned ? "" : message.id },
        })
      }
      aria-label={pinned ? t("Unpin message") : t("Pin message")}
      className={HOVER_ACTION}
      title={pinned ? t("Unpin this message") : t("Pin this message to the top of the thread")}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
  const replyButton = (
    <button type="button" onClick={onReply} aria-label={t("Reply to message")} className={HOVER_ACTION} title={t("Reply")}>
      <MessageSquareReply size={14} />
    </button>
  );

  return (
    <div className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      <div className={cn("flex w-full items-end gap-1", user ? "justify-end" : "justify-start")}>
        {/* editing rewinds the thread, so it waits for the turn to end —
            same rule as the version switcher below */}
        {user && message.kind === "text" && !webhookView && !bot.busy && (
          <button onClick={onStartEdit} aria-label={t("Edit message")} className={HOVER_ACTION} title={t("Edit message")}>
            <Pencil size={14} />
          </button>
        )}
        {user && <CopyButton text={visibleText} />}
        {user && replyButton}
        {user && pinButton}
        {user && (
          <span className="mr-1 mb-1 shrink-0 text-[11px] tabular-nums text-ink-secondary/70" title={new Date(message.at).toLocaleString(intlLocale())}>
            {clockLabel(message.at)}
          </span>
        )}
        <div
          className={cn(
            user && webhookView
              ? "w-fit min-w-0 max-w-[520px] overflow-hidden rounded-2xl bg-raised text-[13.5px] leading-[1.6] text-ink inset-ring inset-ring-select/30"
              : user
                ? USER_BUBBLE
                : BOT_BUBBLE,
          )}
          title={new Date(message.at).toLocaleString(intlLocale())}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={bot.name}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-select/15 bg-select/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent-text">
                <Webhook size={13} />
                <span>{t("Webhook task")}</span>
              </div>
              <div className="px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">{t("View event payload")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-inset p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachments && attachments.images.length > 0 && (
                <AttachedImageGallery paths={attachments.images} />
              )}
              {attachments && attachments.files.length > 0 && (
                <AttachedFileChips files={attachments.files} className={!visibleText ? "mb-0" : undefined} />
              )}
              {visibleText && (
                <div
                  className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                >
                  {visibleText}
                </div>
              )}
              {message.steered && (
                <div className="mt-1 text-[11px] opacity-70" title={t("Sent while the bot was working — it saw this before its next step, inside the same turn.")}>
                  {t("sent mid-turn")}
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] opacity-75 hover:opacity-100">
                  {t("Show full message")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] opacity-75 hover:opacity-100">
                  {t("Show less")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={text}>
              <ChatMarkdown text={text} />
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <>
            <div className="flex items-center self-end">
              <CopyButton text={text} />
              {message.kind === "text" && (
                <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} />
              )}
              {isLastBotText && !bot.busy && onRegenerate && (
                <button onClick={onRegenerate} aria-label={t("Regenerate response")} title={t("Regenerate response")} className={HOVER_ACTION}>
                  <RefreshCw size={14} />
                </button>
              )}
            </div>
            {replyButton}
            {pinButton}
            <span className="mb-1 ml-1 self-end text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100">
              {clockLabel(message.at)}
            </span>
          </>
        )}
      </div>
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("Previous version")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("Next version")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. Bot⇄bot chips
 * are links to the channel where the exchange lives, drawn as system lines. */
function ActivityChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  const comm = message.comm;
  if (comm) {
    const peer = state.bots.find((bot) => bot.id === comm.withBotId);
    return (
      <SystemLine
        icon={peer ? <BotAvatar bot={peer} size={16} /> : <IconUsers size={13} />}
        onClick={() => dispatch({ type: "select", id: comm.groupId })}
        title={t("Open the conversation with {name}", { name: comm.withName })}
      >
        {tool.name}
        <ChevronRight size={12} className="ml-0.5 inline-block align-[-2px]" />
      </SystemLine>
    );
  }
  const failed = tool.ok === false;
  // The raw name is often a whole shell command. Show the app's short action
  // label and keep the command in the tooltip: a failed step then reads
  // "Run a command · Failed" instead of a wall of red command text.
  const label = stepLabel(tool);
  return (
    <div className="flex justify-start">
      <div
        title={tool.name}
        className="flex items-center gap-2 rounded-full bg-control/50 px-3 py-1.5 text-[12.5px] text-ink-secondary"
      >
        {tool.ok === undefined ? (
          <WorkingDots size={3.5} />
        ) : failed ? (
          <X size={13} className="text-danger" />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate">{label}</span>
        {failed && <span className="shrink-0 text-danger">· {t("Failed")}</span>}
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt={t("Bot's screen")}
        className="w-fit min-w-0 max-w-[560px] rounded-2xl ring-1 ring-hairline/40"
      />
    </div>
  );
}

/** Cards in the transcript that are not messages, placed by time. */
type TimedCard =
  | { kind: "run"; id: string; at: number; run: DispatchRun }
  | { kind: "decision"; id: string; at: number; decision: OrgDecision };

const itemFirstAt = (item: TranscriptItem) => (item.kind === "run" ? item.messages[0]!.at : item.message.at);
const itemLastAt = (item: TranscriptItem) => (item.kind === "run" ? item.messages.at(-1)!.at : item.message.at);

/** The settled transcript, memoized as one unit: ChatView re-renders for
 * every store change around it (a bot patch, a poll, the composer), but all
 * of these props keep their identity (bot/messages only change on real
 * message events), so the whole list — every markdown tree, every code
 * block — bails out of React work. This is the t3code structural-sharing
 * idea at component granularity. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  transcript,
  editingId,
  lastBotTextId,
  arrivingId,
  canRetryLast,
  engine,
  hasEarlier,
  cards,
  replies,
  stripId,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
  onShowReplies,
  onOpenRoutine,
}: {
  bot: Bot;
  messages: Message[];
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  /** the reply that just took the typing line's place: it pops in where it
   * will stay, so the transcript changes height once, not three times */
  arrivingId?: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  /** earlier rows are folded away above the window */
  hasEarlier: boolean;
  cards: readonly TimedCard[];
  /** message id → ids of the messages replying to it */
  replies: ReadonlyMap<string, string[]>;
  /** the failure the strip above the composer is showing (kept out of here) */
  stripId: string | null;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
  onShowReplies: (messageId: string) => void;
  onOpenRoutine: (routineId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  // Fold finished tool chips into runs, so a stretch of them cannot bury
  // what the bot actually said. Hidden unless Settings → Tool calls is on.
  const items = useMemo(() => groupActivityRuns(messages), [messages]);
  const placed = useMemo(() => {
    const byRow = new Map<number, TimedCard[]>();
    for (const { after, card } of slotByTime(items.map(itemLastAt), cards, { hasEarlier })) {
      byRow.set(after, [...(byRow.get(after) ?? []), card]);
    }
    return byRow;
  }, [items, cards, hasEarlier]);
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
  const findBot = (id?: string) => (id ? state.bots.find((candidate) => candidate.id === id) : undefined);

  // the time the last rendered row happened, for the separators
  let lastAt: number | undefined;
  const separatorFor = (at: number) => {
    const separator = separatorBetween(lastAt, at);
    lastAt = at;
    return separator ? <TimeSeparator label={separator.label} /> : null;
  };
  const renderCards = (index: number) =>
    (placed.get(index) ?? []).map((card) => (
      <div key={card.id} className="contents">
        {separatorFor(card.at)}
        <div className="flex justify-start">
          {card.kind === "run" ? <DispatchRunCard run={card.run} bots={state.bots} /> : <DecisionCard decision={card.decision} />}
        </div>
      </div>
    ));

  return (
    <>
      {messages.length === 0 && !bot.busy && cards.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <BotAvatar bot={bot} size={64} />
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />
          <div className="max-w-[360px] text-[13.5px] text-ink-secondary">
            {bot.description || t("Send a message to start the conversation.")}
          </div>
        </div>
      )}
      {renderCards(-1)}
      {items.map((item, i) => {
        if (item.kind === "run") {
          if (!showToolCalls) return <div key={item.id} className="contents">{renderCards(i)}</div>;
          return (
            <div key={item.id} className="contents">
              {separatorFor(itemFirstAt(item))}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityChip message={step} />
                  </div>
                ))}
              </ActivityRun>
              {renderCards(i)}
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          switch (m.kind) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "options":
              // a live permission ask gets the approval card; questions keep
              // the options card. The first-run quiz drops out once they talk.
              if (m.card?.requestId && m.card.tool) {
                return <ApprovalCard bot={findBot(m.from?.botId) ?? bot} message={m} threadId={bot.threadId} />;
              }
              if (shouldHideOnboardingCard(m, transcript)) return null;
              return <OptionCard botId={bot.id} message={m} />;
            case "routine.run": {
              const executionThreadId = m.routineRun?.executionThreadId;
              const canOpen = hasRoutineExecutionTask(bot.tasks, executionThreadId);
              return (
                <RoutineRunCard
                  message={m}
                  onOpen={canOpen
                    ? () => openNotificationTarget(
                        dispatch,
                        { botId: bot.id, threadId: executionThreadId },
                        state,
                      )
                    : undefined}
                  onOpenRoutine={state.routines.some((routine) => routine.id === m.routineRun?.routineId) ? onOpenRoutine : undefined}
                />
              );
            }
            case "activity": {
              // the failure on show in the strip above the composer stays
              // out of the history until it is dismissed or answered
              if (m.id === stripId) return null;
              // a failed turn is an error, not a tool run — render it as one.
              if (isTurnError(m) && m.tool) {
                return (
                  <ErrorRow
                    message={failureText(m)}
                    onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                    setupInstance={m.tool.setup ? engine : undefined}
                  />
                );
              }
              // org and dispatch events, and failures the harness reported,
              // are centred system lines; bot⇄bot chips link to the channel
              if (isSystemLine(m)) {
                return <SystemLine icon={<IconUsers size={13} />}>{m.tool?.name}</SystemLine>;
              }
              // an approval that expired while nobody was there: said once,
              // quietly — the card above already reads 已作废
              if (isExpiryLine(m)) {
                return <SystemLine icon={<IconClock size={13} />}>{m.tool?.name}</SystemLine>;
              }
              if (isFailureLine(m)) {
                return (
                  <SystemLine tone="danger" icon={<IconBolt size={13} />}>
                    {failureText(m)}
                  </SystemLine>
                );
              }
              // plain tool runs stay out unless Settings → Tool calls is on
              if (!showToolCalls && !m.comm) return null;
              return <ActivityChip message={m} />;
            }
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
                  onReply={() => onReply(m)}
                />
              );
          }
        })();
        if (!row) return <div key={m.id} className="contents">{renderCards(i)}</div>;
        const threadCount = replies.get(m.id)?.length ?? 0;
        return (
          <div key={m.id} className="contents">
            <div className="contents" data-mid={m.id}>
              {separatorFor(m.at)}
              <div
                className={cn(
                  "flex min-w-0 flex-col",
                  m.role === "user" ? "items-end" : "items-start",
                  m.id === arrivingId && "turn-answer",
                )}
              >
                {row}
                {threadCount > 0 && <ThreadLink count={threadCount} onClick={() => onShowReplies(m.id)} />}
              </div>
            </div>
            {renderCards(i)}
          </div>
        );
      })}
    </>
  );
});

/** The one pinned message, above the transcript: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const sender =
    pinned.role === "user" ? t("You") : (pinned.from?.name ?? bot.name);
  const text = (pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className={cn(COLUMN, "pt-2")}>
      <div className="flex items-center gap-2 rounded-[10px] bg-select/[0.07] px-3 py-1.5 inset-ring inset-ring-select/20">
        <Pin size={12} className="shrink-0 text-accent-text" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={t("Jump to the pinned message")}
        >
          <span className="shrink-0 text-[11.5px] font-semibold text-accent-text">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        <button
          onClick={onUnpin}
          aria-label={t("Unpin message")}
          title={t("Unpin")}
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised-hover hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const activeTask = bot.tasks?.find((task) => task.threadId === bot.threadId);
  // No useStreaming() here: the 1:1 view never shows streamed text (the reply
  // pops in when it settles), and subscribing re-rendered this whole view —
  // header, composer, cards — on every token frame of every reply.
  const provisioning = state.provisioning[bot.id];
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // ── the company layer: the 主 Bot, its dispatch runs and decisions ──
  const org = useOrg();
  const isMainBot = chiefBot(state.bots, org.data)?.id === bot.id;
  const coordinates = isMainBot || Boolean(bot.chiefOfStaff);
  const dispatchState = useApi<{ runs?: DispatchRun[] }>(coordinates ? "/api/dispatch/state" : null, { runs: [] }, DISPATCH_POLL_MS);
  const decisionsApi = useApi<{ decisions?: OrgDecision[] }>(isMainBot && org.loaded && !org.error ? "/api/org/decisions" : null, { decisions: [] }, 10_000);
  const allRuns = dispatchState.data.runs ?? [];
  const runningRuns = runningRunCount(allRuns, bot.id);
  const threadRuns = runsForThread(allRuns, bot.threadId);
  const threadRunsKey = runsKey(threadRuns);
  const groupDecisions = (decisionsApi.data.decisions ?? []).filter((decision) => decision.source.kind === "group");
  const decisionsKey = groupDecisions.map((decision) => `${decision.id}:${decision.actionItems.length}`).join("|");
  // stable while nothing changed, so a poll does not re-render the transcript
  const cards = useMemo<TimedCard[]>(
    () => [
      ...threadRuns.map((run) => ({ kind: "run" as const, id: `run:${run.id}`, at: run.createdAt, run })),
      ...groupDecisions.map((decision) => ({ kind: "decision" as const, id: `decision:${decision.id}`, at: decision.at, decision })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadRunsKey, decisionsKey],
  );

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  const replies = useMemo(() => replyIndex(messages), [messages]);

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is anchored per bot+task; a
  // render-phase reset re-tails it on switch so the old thread's boundary
  // never flashes into the new one. Everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
    },
    [bot.id, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );

  // The typing line while the turn works. Streaming stays invisible — when
  // the reply is finished, the whole bubble pops in where the line was.
  const lastMessage = messages.at(-1);
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined && !isSystemLine(lastMessage);
  const activityLabel = liveActivityLabel(lastMessage);
  const waiting = Boolean(
    bot.busy &&
      bot.activity !== "waiting-on-you" &&
      showWorkingDots(bot.busy, lastMessage),
  );
  // Which reply is popping in, decided in the render that brings it (not in
  // an effect a frame later): the bubble mounts once, in its final row, and
  // the typing line steps aside in the same commit.
  const [tail, setTail] = useState(() => ({ key: transcriptKey, ...initialTail(lastMessage, waiting) }));
  let currentTail = tail;
  if (tail.key !== transcriptKey) {
    currentTail = { key: transcriptKey, ...initialTail(lastMessage, waiting) };
    setTail(currentTail);
  } else {
    const next = nextTail(tail, waiting, lastMessage);
    if (next !== tail) {
      currentTail = { key: transcriptKey, ...next };
      setTail(currentTail);
    }
  }
  const arrivingId = currentTail.arrivingId;
  useEffect(() => {
    if (!arrivingId) return;
    // the pop is 0.48s; afterwards a remount (window, branch) must not replay it
    const timer = setTimeout(() => setTail((current) => (current.arrivingId === arrivingId ? { ...current, arrivingId: null } : current)), 520);
    return () => clearTimeout(timer);
  }, [arrivingId]);
  const replyLanded = lastMessage?.role === "bot" && lastMessage.kind === "text";
  // Wall-clock anchor for the working row's elapsed readout — set when the
  // turn starts, cleared when it settles, reset on bot switch.
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(bot.busy ? Date.now() : null);
  }, [bot.busy, bot.id]);
  // a routine this bot is running right now names what it is busy with
  const runningRoutine = state.routineRuns.find((run) => run.botId === bot.id && run.status === "running");
  const typing = typingLabel(bot.name, {
    routine: runningRoutine?.routineName,
    activity: toolInFlight ? activityLabel : null,
  });

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // ── the strip above the composer: the newest failure, dismissible ──
  const failure = currentFailure(messages);
  const [dismissedFailures, setDismissedFailures] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setDismissedFailures(new Set()), [bot.threadId]);
  const stripFailure = failure && !dismissedFailures.has(failure.id) && !failure.tool?.setup ? failure : undefined;
  const canRetryLast = !bot.busy && Boolean(lastUserMessage);

  // ── thread replies: each click lands on the next reply ──
  const lastReplyFocus = useRef<string | null>(null);
  const showReplies = useCallback(
    (messageId: string) => {
      const target = nextReplyTarget(replies.get(messageId) ?? [], lastReplyFocus.current);
      if (!target) return;
      lastReplyFocus.current = target;
      dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: target });
    },
    [replies, bot.threadId, dispatch],
  );

  // ── the routine panel on the right ──
  const [routinePanel, setRoutinePanel] = useState<{ routineId: string | null } | null>(null);
  const botRoutines = useMemo(() => state.routines.filter((routine) => routine.botId === bot.id), [state.routines, bot.id]);
  const openRoutinePanel = useCallback(
    (routineId: string | null) => {
      // one panel at a time on the right
      if (state.settingsOpen) dispatch({ type: "toggleSettings", open: false });
      if (state.computerOpen) dispatch({ type: "toggleComputer", open: false });
      if (state.inspectorOpen) dispatch({ type: "toggleInspector", open: false });
      setRoutinePanel({ routineId });
    },
    [dispatch, state.settingsOpen, state.computerOpen, state.inspectorOpen],
  );
  useEffect(() => {
    if (state.settingsOpen || state.computerOpen || state.inspectorOpen) setRoutinePanel(null);
  }, [state.settingsOpen, state.computerOpen, state.inspectorOpen]);
  useEffect(() => setRoutinePanel(null), [bot.id]);
  const openRoutines = useCallback(() => {
    const names = new Set(botRoutines.map((routine) => `${routine.name.trim()}\n${routine.prompt.trim()}`));
    openRoutinePanel(names.size === 1 ? botRoutines[0]!.id : null);
  }, [botRoutines, openRoutinePanel]);

  // Scroll pinning: follow the bottom while the reader hasn't scrolled away.
  // An observer pins every change in height before it is painted (see
  // useBottomFollow); an upward wheel, touch, key or scrollbar grab detaches,
  // and scrolling back down to the end re-arms.
  const bottom = useBottomFollow({ scrollRef, contentRef: logRef, dockRef: composerDockRef, resetKey: transcriptKey });
  const follow = bottom.follow;

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    follow.detach();
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, messages, follow, state.focusMessage, transcriptKey]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    follow.detach();
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandHeight.current === null || !el) return;
    el.scrollTop += el.scrollHeight - preExpandHeight.current;
    preExpandHeight.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    follow.syncScrollTop();
  }, [transcriptWindow.start, follow]);

  const showLater = () => {
    follow.detach();
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };

  const jumpToLatest = () => {
    // a re-tailed window that changes height is pinned by the observer
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
    bottom.jumpToLatest();
  };

  const approvalsWaiting = pendingApprovals(messages).length > 0;
  const strips = (
    <>
      {state.error && (
        <div className="mb-2">
          <ErrorStrip onDismiss={() => dispatch({ type: "error", message: null })}>{state.error}</ErrorStrip>
        </div>
      )}
      {stripFailure && (
        <div className="mb-2">
          <ErrorStrip
            onDismiss={() => setDismissedFailures((current) => new Set([...current, stripFailure.id]))}
            action={
              isTurnError(stripFailure) && stripFailure.id === lastMessage?.id && canRetryLast ? (
                <button
                  type="button"
                  onClick={regenerate}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-semibold hover:bg-danger/10"
                >
                  <RefreshCw size={12} /> {t("Retry")}
                </button>
              ) : undefined
            }
          >
            {failureText(stripFailure)}
          </ErrorStrip>
        </div>
      )}
    </>
  );

  return (
    <>
      <main className="relative flex h-full min-w-0 flex-1 flex-col bg-stage">
        {/* Call mode covers the thread while the bot is on the line */}
        <CallOverlay bot={bot} />
        <ChatHeader
          bot={bot}
          messages={messages}
          isMainBot={isMainBot}
          runningRuns={runningRuns}
          waitingOnYou={approvalsWaiting || bot.activity === "waiting-on-you"}
          findOpen={findOpen}
          onFind={() => setFindOpen(true)}
          onOpenRoutines={openRoutines}
          routineCount={botRoutines.length}
        />

        {findOpen && (
          <div className="pt-2">
            <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />
          </div>
        )}

        {/* Pinned message banner */}
        <PinnedBanner
          bot={bot}
          pinnedId={bot.pinnedMessageId}
          messages={messages}
          onJump={(messageId) =>
            dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
          }
          onUnpin={() =>
            dispatch({ type: "updateBot", botId: bot.id, patch: { pinnedMessageId: "" } })
          }
        />

        {showToolCallsEnabled(state.config) && <TaskTimeline messages={messages} busy={bot.busy ?? false} />}

        {/* Messages + composer share one pane so bubbles scroll into the pill
            instead of dying on a rectangular clip above the dock. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
            {...bottom.scrollProps}
          >
            <div
              ref={logRef}
              className={cn(COLUMN, "flex min-h-full flex-col justify-end gap-3 pt-4")}
              style={{ paddingBottom: TRANSCRIPT_END_PAD }}
              role="log"
              aria-live="polite"
              aria-label={t("Conversation with {name}", { name: bot.name })}
            >
              {hiddenCount > 0 && (
                <div className="flex justify-center pt-1">
                  <button
                    onClick={showEarlier}
                    className={cn("rounded-full px-3 py-1 text-[12px] text-ink-secondary hover:text-ink", SOFT)}
                  >
                    {t("Show earlier messages ({count} more)", { count: hiddenCount })}
                  </button>
                </div>
              )}
              <MessagesList
                bot={bot}
                messages={windowedMessages}
                transcript={messages}
                editingId={editingId}
                lastBotTextId={lastBotTextId}
                arrivingId={arrivingId}
                canRetryLast={canRetryLast}
                engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
                hasEarlier={hiddenCount > 0}
                cards={cards}
                replies={replies}
                stripId={stripFailure?.id ?? null}
                onStartEdit={startEdit}
                onCancelEdit={cancelEdit}
                onSubmitEdit={submitEdit}
                onRegenerate={regenerate}
                onReply={selectReply}
                onShowReplies={showReplies}
                onOpenRoutine={openRoutinePanel}
              />
              {laterCount > 0 && (
                <div className="flex justify-center">
                  <button
                    onClick={showLater}
                    className={cn("rounded-full px-3 py-1 text-[12px] text-ink-secondary hover:text-ink", SOFT)}
                  >
                    {t("Show later messages ({count} more)", { count: laterCount })}
                  </button>
                </div>
              )}
              {provisioning && (
                <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                  <WorkingDots size={3.5} />
                  {t("Setting up this bot's computer…")}
                </div>
              )}
              <TurnPresence
                avatar={<BotAvatar bot={bot} size={18} state={toolInFlight ? "working" : "thinking"} />}
                visible={waiting}
                label={typing}
                replaced={replyLanded}
                since={busySince}
              />
              {/* Ghost tail: 1:1 sends made mid-turn wait in the server's steer
                  queue and stay off the transcript until drain (they must never
                  become the active leaf). These rows are that queue made visible,
                  in send order, each with its own cancel. */}
              {bot.busy &&
                (state.pendingQueued[bot.threadId] ?? []).map((entry) => (
                  <div key={entry.queueId} className="flex flex-col items-end">
                    <div className="w-fit min-w-0 max-w-[440px] rounded-2xl rounded-tr-md border border-dashed border-hairline/70 px-[13px] py-[9px] text-[13.5px] leading-[1.6] whitespace-pre-wrap text-ink-secondary">
                      {entry.text}
                    </div>
                    <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-ink-secondary/70">
                      <Clock size={11} aria-hidden="true" />
                      <span>{t("Queued — sends when this turn finishes")}</span>
                      <button
                        type="button"
                        onClick={() =>
                          dispatch({ type: "cancelQueued", botId: bot.id, queueId: entry.queueId })
                        }
                        aria-label={t("Cancel queued message")}
                        title={t("Cancel queued message")}
                        className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised-hover hover:text-ink"
                      >
                        <X size={11} strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* a soft fade under the header, as the design draws it */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-5 bg-gradient-to-b from-stage to-transparent" />

          {/* Reading scrollback — one tap back to the end, streaming or not */}
          {!bottom.following && (
            <button
              onClick={jumpToLatest}
              aria-label={t("Jump to latest messages")}
              className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
              style={{ bottom: COMPOSER_DOCK_HEIGHT }}
            >
              <ArrowDown size={13} /> {t("Jump to latest")}
            </button>
          )}

          {/* Keyed by task: each conversation keeps its own draft and a failed
              request can restore the old task without spilling into the newly
              selected one. ArrowUp-to-edit stays gated on busy because editing
              rewinds the thread, which a live turn forbids (the server 409s it). */}
          <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
            {activeTask?.closedAt ? (
              <ClosedTaskBar task={activeTask} />
            ) : (
            <Composer
              key={bot.threadId}
              bot={bot}
              replyTo={replyTo}
              onClearReply={clearReply}
              onConsumeReply={consumeReply}
              onRestoreReply={restoreReply}
              onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
              notice={state.error || stripFailure ? strips : undefined}
            />
            )}
          </div>
        </div>
      </main>
      {routinePanel && (
        <RoutinePanel
          bot={bot}
          routineId={routinePanel.routineId}
          onSelect={(routineId) => setRoutinePanel({ routineId })}
          onClose={() => setRoutinePanel(null)}
        />
      )}
    </>
  );
}

/** A finished task's window: read-only, with the one meaningful action —
 * start a new task that references this one's approved conclusions. */
function ClosedTaskBar({ task }: { task: Task }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fork = async () => {
    if (!task.folderId) {
      setError(t("This conversation is not linked to a task yet."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = (await api(`/api/tasks/${task.folderId}/fork`, {
        method: "POST",
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      })) as { botId: string; conversationId: string };
      dispatch({ type: "select", id: created.botId });
      dispatch({ type: "switchTask", botId: created.botId, threadId: created.conversationId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 pb-3">
      <div className="rounded-[16px] bg-raised px-4 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_60%,transparent)]">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <Lock size={14} className="text-ink-secondary" />
          {t("This task is finished — it no longer takes messages")}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {t("Finished on {date}. The conversation stays readable; start a new task that carries over its approved conclusions (not the chat log).", {
            date: task.closedAt ? new Date(task.closedAt).toLocaleDateString() : "",
          })}
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void fork()}
            className="inline-flex h-9 items-center rounded-[10px] bg-select px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? t("Opening…") : t("Based on this, start a new task")}
          </button>
        </div>
        {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
