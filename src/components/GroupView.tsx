// A room: several bots + you in one shared thread, read as a meeting (U9).
// The header says who is in it and where the meeting stands; the bulletin is
// pinned as the agenda; each member speaks in a cluster under its engine tile
// and coloured name; cited sources become numbered chips; a question to you
// is a card you answer in place, and its decision shows the action items it
// dispatched. Approvals and account requests stay out of the transcript —
// they open in a private sheet. The minutes panel on the right is built from
// the room itself. Plain messages go to the room's default responder;
// @mentions override that routing.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquareReply,
  MoreHorizontal,
  NotebookText,
  Pin,
  PinOff,
  Search,
  ShieldCheck,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  api,
  useStore,
  useStreaming,
  formatTime,
  openNotificationTarget,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";

import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { effectiveDefaultResponder, groupResponseHint } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { GroupTaskPicker } from "./TaskPicker";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachedFileChips, AttachedImageGallery } from "./AttachmentPreview";
import { GroupCallButton, GroupCallOverlay } from "./GroupCallView";
import { OptionCard } from "./OptionCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { Dialog, Diamond } from "./ui";
import { AgendaBar } from "./group/AgendaBar";
import { MinutesPanel } from "./group/MinutesPanel";
import { DecisionCard, MemberAvatar, SourceChip, StatusPill, SystemLine, nameInk } from "./group/parts";
import { useMeeting, type Meeting } from "./group/useMeeting";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { intlLocale, msg, t, tn, tRich } from "@/lib/i18n";
import { useFocusMessage } from "@/lib/focus-message";
import { shortPath } from "@/lib/short-path";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { basisNumbers, type NumberedSource } from "@/lib/group-sources";
import { decisionForMessage, isQuestionCard, type MeetingState } from "@/lib/group-meeting";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { useReplyDraft } from "@/lib/drafts";

/** A new sender cluster also starts when the same member speaks again after a pause. */
const CLUSTER_GAP_MS = 5 * 60_000;
const COLUMN = "mx-auto w-full max-w-[708px]";

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("Today");
  if (diffDays === 1) return t("Yesterday");
  return d.toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric" });
}

/** One finished tool step in a room. Same pill the 1:1 chat uses, minus the
 * status glyph — a room reads as a conversation, not a build log. */
function RoomToolChip({ message }: { message: Message }) {
  const tool = message.tool;
  if (!tool) return null;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[12.5px]",
          tool.ok === false ? "text-danger" : "text-ink-secondary",
        )}
      >
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
      </div>
    </div>
  );
}

/** Pin toggle for one room message — one pin per room, patchGroup path. */
function PinToggle({ group, message }: { group: Group; message: Message }) {
  const { dispatch } = useStore();
  const pinned = group.pinnedMessageId === message.id;
  return (
    <button
      onClick={() =>
        dispatch({
          type: "patchGroup",
          groupId: group.id,
          patch: { pinnedMessageId: pinned ? "" : message.id },
        })
      }
      aria-label={pinned ? t("Unpin message") : t("Pin message")}
      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      title={pinned ? t("Unpin this message") : t("Pin this message to the top of the channel")}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
}

function ReplyButton({ onReply }: { onReply: () => void }) {
  return (
    <button
      type="button"
      onClick={onReply}
      aria-label={t("Reply to message")}
      title={t("Reply")}
      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <MessageSquareReply size={14} />
    </button>
  );
}

/** A short single-paragraph message can carry its chips on the same line. */
const PLAIN_LINE = /^[^\n*_`#>|[\]~]*$/;

/** Approvals, secrets and connector sign-ins never sit in the room's
 * transcript (anyone reading along would see them). While one is pending a
 * centred line says who is waiting: an approval is answered in the box above
 * the composer (it owns the composer until then); a credential or an app
 * sign-in opens in a private sheet. */
function PrivateRequestLine({ group, message, bot }: { group: Group; message: Message; bot?: Bot }) {
  const [open, setOpen] = useState(false);
  const name = bot?.name ?? message.from?.name ?? t("A member");
  const approval = message.kind === "options";
  const pending = approval
    ? Boolean(message.card && !message.card.answered && !message.card.dismissed)
    : message.kind === "secret"
      ? Boolean(message.secret && !message.secret.provided && !message.secret.dismissed && !message.secret.resumed)
      : Boolean(message.connector && !message.connector.dismissed && !message.connector.resumed && message.connector.status !== "connected");
  useEffect(() => {
    if (!pending) setOpen(false);
  }, [pending]);
  if (!pending) return null;
  const what = approval
    ? t("{name} is waiting for your approval", { name })
    : message.kind === "secret"
      ? t("{name} needs a credential from you", { name })
      : t("{name} needs you to connect an app", { name });
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-[12.5px] text-ink-secondary">
      <Diamond size={10} />
      <span>{what}</span>
      <span className="opacity-50">·</span>
      {approval ? (
        <span>{t("answer it above the message box")}</span>
      ) : (
        <>
          <span>{t("kept out of the room")}</span>
          <button type="button" onClick={() => setOpen(true)} className="font-semibold text-accent-text hover:underline">
            {t("Review")}
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label={what} width={560}>
            <div className="flex items-center gap-2 border-b border-hairline/25 px-4 py-3">
              {bot ? <MemberAvatar bot={bot} size={22} /> : null}
              <div className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{what}</div>
              <button type="button" onClick={() => setOpen(false)} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-4">
              {message.kind === "secret" && message.from?.botId ? (
                <SecretRequestCard botId={message.from.botId} threadId={group.threadId} message={message} />
              ) : message.kind === "connector" && message.from?.botId ? (
                <ConnectorCard botId={message.from.botId} threadId={group.threadId} message={message} />
              ) : null}
            </div>
          </Dialog>
        </>
      )}
    </div>
  );
}

/** Is this message a private request that must not render in the room? */
function isPrivateRequest(message: Message): boolean {
  return (
    (message.kind === "options" && Boolean(message.card?.requestId && message.card.tool)) ||
    (message.kind === "secret" && Boolean(message.secret && message.from?.botId)) ||
    (message.kind === "connector" && Boolean(message.connector && message.from?.botId))
  );
}

/** A member's cluster: tile and coloured name once, then its messages. */
function BotCluster({
  bot,
  from,
  at,
  color,
  first,
  children,
}: {
  bot?: Bot;
  from?: Message["from"];
  at: number;
  color?: string;
  first: boolean;
  children: ReactNode;
}) {
  const name = bot?.name ?? from?.name ?? t("Bot");
  return (
    <div className={cn("flex gap-2", !first && "-mt-1.5")}>
      <div className="w-6 shrink-0 pt-0.5">{first && bot ? <MemberAvatar bot={bot} size={24} /> : null}</div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        {first && (
          <div className="ml-0.5 flex items-baseline gap-1.5 leading-none">
            <b className={cn("text-[12.5px] font-bold", !color && "text-ink")} style={color ? { color: nameInk(color) } : undefined}>
              {name}
            </b>
            <span className="text-[11px] text-ink-secondary/60 tabular-nums">{formatTime(at)}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
  meeting,
  onReply,
  onJump,
  onOpenSource,
}: {
  group: Group;
  members: Bot[];
  /** The windowed suffix of group.messages — the boundary lives in GroupView. */
  messages: Message[];
  /** Full room transcript, used to resolve quoted messages outside the mounted window. */
  transcript: Message[];
  emergingId?: string | null;
  meeting: Meeting;
  onReply: (message: Message) => void;
  onJump: (messageId: string) => void;
  onOpenSource: (source: NumberedSource) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  // a member who left the room still owns what it said
  const botOf = (id?: string) => (id ? (members.find((b) => b.id === id) ?? state.bots.find((b) => b.id === id)) : undefined);
  // Several bots working at once turn a room into a wall of chips; fold the
  // finished ones the same way a 1:1 chat does.
  const items = useMemo(() => groupActivityRuns(messages), [messages]);
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  const jumpToSource = (n: number) => {
    const source = meeting.sources.list.find((entry) => entry.n === n);
    if (source) onJump(source.messageId);
  };
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        const dayLine = newDay ? (
          <div className="py-1 text-center text-[11.5px] font-medium text-ink-secondary/60">
            {dayLabel(first.at)} {formatTime(first.at)}
          </div>
        ) : null;
        const newCluster =
          !prev ||
          prev.role !== first.role ||
          prev.from?.botId !== first.from?.botId ||
          newDay ||
          first.at - prev.at > CLUSTER_GAP_MS ||
          (previous?.kind === "message" && isPrivateRequest(previous.message));
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          return (
            <div key={item.id} className="contents">
              {dayLine}
              <BotCluster bot={botOf(first.from?.botId)} from={first.from} at={first.at} color={meeting.colors.get(first.from?.botId ?? "")} first={Boolean(first.from) && newCluster}>
                <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                  {item.messages.map((step) => (
                    <div key={step.id} className="contents" data-mid={step.id}>
                      <RoomToolChip message={step} />
                    </div>
                  ))}
                </ActivityRun>
              </BotCluster>
            </div>
          );
        }
        const m = item.message;
        if (m.id === emergingId) return null;
        const user = m.role === "user";
        const sender = botOf(m.from?.botId);

        if (isPrivateRequest(m)) {
          return (
            <div key={m.id} className="contents" data-mid={m.id}>
              {dayLine}
              <PrivateRequestLine group={group} message={m} bot={sender} />
            </div>
          );
        }

        const attachments = user && m.text ? splitTranscriptAttachments(m.text) : null;
        const routineOwner = m.kind === "routine.run" ? botOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const quote = m.replyToId ? transcript.find((candidate) => candidate.id === m.replyToId) : undefined;
        const quoteBlock = quote ? (
          <div className="mb-2">
            <ReplyQuote
              message={quote}
              fallbackName={t("Bot")}
              compact
              onJump={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: quote.id })}
            />
          </div>
        ) : null;

        let row: ReactNode = null;
        if (isQuestionCard(m)) {
          // a member asks you to decide; once answered, its decision follows
          const decision = decisionForMessage(meeting.decisions, m);
          row = (
            <div className="flex w-full flex-col items-start gap-2">
              <div className="w-full max-w-[560px]">
                <OptionCard botId={m.from?.botId ?? ""} message={m} />
              </div>
              {decision && (
                <DecisionCard
                  decision={decision}
                  basis={basisNumbers(decision.basis, meeting.sources.list)}
                  chiefId={meeting.chiefId}
                  onJump={jumpToSource}
                />
              )}
            </div>
          );
        } else if (m.kind === "routine.run") {
          row = (
            <RoutineRunCard
              message={m}
              onOpen={routineTarget ? () => openNotificationTarget(dispatch, routineTarget, state) : undefined}
            />
          );
        } else if (m.kind === "activity" && m.tool) {
          row = m.tool.ok === false || m.tool.name.startsWith("error:") || showToolCalls ? <RoomToolChip message={m} /> : null;
        } else if (m.kind === "text" && m.text && user) {
          row = (
            <div className="group flex w-full items-end justify-end gap-1.5">
              <ReplyButton onReply={() => onReply(m)} />
              <PinToggle group={group} message={m} />
              <span className="mb-1 shrink-0 text-[11px] text-ink-secondary/60 tabular-nums">{formatTime(m.at)}</span>
              <div
                className="w-fit max-w-[440px] rounded-2xl rounded-tr-md bg-bubble-user px-[13px] py-[9px] text-[13.5px] leading-[1.6] whitespace-pre-wrap text-bubble-user-ink"
                title={new Date(m.at).toLocaleString(intlLocale())}
              >
                {quoteBlock}
                {attachments && attachments.images.length > 0 && <AttachedImageGallery paths={attachments.images} />}
                {attachments && attachments.files.length > 0 && (
                  <AttachedFileChips files={attachments.files} className={!attachments.display ? "mb-0" : undefined} />
                )}
                {attachments?.display ?? m.text}
              </div>
            </div>
          );
        } else if (m.kind === "text" && m.text) {
          const chips = meeting.sources.byMessage.get(m.id) ?? [];
          const text = chips.length ? (meeting.sources.texts.get(m.id) ?? m.text) : m.text;
          const inline = chips.length > 0 && PLAIN_LINE.test(text);
          row = (
            <div className="group flex w-full items-end gap-1.5">
              <div
                className="w-fit max-w-[560px] min-w-0 rounded-2xl rounded-tl-md bg-control/60 px-[13px] py-[9px] text-[13.5px] leading-[1.6] text-ink"
                title={new Date(m.at).toLocaleString(intlLocale())}
              >
                {quoteBlock}
                {inline ? (
                  <span>
                    {text}
                    {chips.map((chip) => (
                      <span key={chip.n} className="ml-2 inline-flex">
                        <SourceChip source={chip} onOpen={onOpenSource} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <>
                    {text.trim() && <ChatMarkdown text={text} />}
                    {chips.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {chips.map((chip) => (
                          <SourceChip key={chip.n} source={chip} onOpen={onOpenSource} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              <ReplyButton onReply={() => onReply(m)} />
              <PinToggle group={group} message={m} />
            </div>
          );
        }
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {dayLine}
            {user ? (
              row
            ) : (
              <BotCluster bot={sender} from={m.from} at={m.at} color={meeting.colors.get(m.from?.botId ?? "")} first={newCluster}>
                {row}
              </BotCluster>
            )}
          </div>
        );
      })}
    </>
  );
});

function DefaultResponderSelect({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const responder = effectiveDefaultResponder(group, members);
  const value = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const title =
    responder.kind === "everyone"
      ? t("Plain messages go to every channel member; @mentions override this")
      : responder.kind === "mentions"
        ? t("Only explicitly @mentioned bots respond")
        : t("Plain messages go to {name}; @mentions override this", { name: lead?.name ?? t("the lead bot") });

  const change = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  return (
    <div className="relative min-w-0" title={title}>
      <select
        aria-label={t("Default responder")}
        value={value}
        onChange={(event) => change(event.target.value)}
        className="h-8 w-full appearance-none truncate rounded-lg bg-control/60 py-1 pr-7 pl-2.5 text-[12.5px] font-medium text-ink outline-none hover:bg-control focus:ring-2 focus:ring-select/30"
      >
        <optgroup label={t("Channel lead")}>
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              {t("Lead: {name}", { name: member.name })}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("Channel behavior")}>
          <option value="everyone">{t("Everyone responds")}</option>
          <option value="mentions">{t("Only when mentioned")}</option>
        </optgroup>
      </select>
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-secondary"
      />
    </div>
  );
}

/** The room's shared desk: where every member's shell and file tools run,
 * overriding each bot's own folder for room turns. The room pins its own
 * copy on its first turn (the server does the pinning — engines key their
 * sessions to the folder a thread starts in, so a folder must not move
 * under a room that already worked somewhere). The PATCH is made directly
 * rather than through patchGroup: the server validates the path and a
 * rejected folder must not stick in local state. */
function RoomWorkingFolder({ group, onClose }: { group: Group; onClose: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const pinned = group.pinnedCwd; // undefined = not yet, null = each bot's own, string = folder
  const locked = pinned !== undefined;
  const shownCwd = locked ? (pinned ?? undefined) : group.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(group.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-inset p-4" style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-hairline) 30%, transparent)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">{t("Working folder")}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("Where every bot in this channel runs its shell and file tools.")}</div>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-7 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>
      {locked ? (
        <div className="mt-3">
          <div className="truncate rounded-lg border border-hairline/40 bg-raised px-3 py-2 font-mono text-[12.5px] text-ink" title={shownCwd}>
            {shownCwd ? shortPath(shownCwd, home) : <span className="text-ink-secondary">{t("Each bot's own folder")}</span>}
          </div>
          <div className="mt-2 text-[12px] text-ink-secondary">
            {t("Fixed for this task after its first turn. Start a new task to work somewhere else.")}
          </div>
        </div>
      ) : canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-raised px-3 py-2 font-mono text-[12.5px] text-ink" title={group.cwd}>
            {group.cwd ? shortPath(group.cwd, home) : <span className="text-ink-secondary">{t("Each bot's own folder")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50" style={{ boxShadow: "inset 0 0 0 1px var(--color-hairline)" }}>
            <FolderOpen size={14} /> {t("Choose…")}
          </button>
          {group.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("Clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? group.cwd ?? "").trim() || null);
          }}
        >
          <input
            className="w-full rounded-lg border border-hairline/40 bg-raised px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            placeholder={t("Each bot's own folder — or an absolute path")}
            value={draft ?? group.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-ink hover:brightness-110 disabled:opacity-40">
            {t("Save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The folder this room's turns run in — the pinned folder once a turn ran,
 * else the room folder a first turn would pin. */
function roomFolder(group: Group): string | undefined {
  return group.pinnedCwd === undefined ? group.cwd : (group.pinnedCwd ?? undefined);
}

type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

type RoomResponderMode = "lead" | "everyone" | "mentions";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
}

function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  // Legacy empty rooms omit both keys and remain immediately usable.
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const leadPickerRef = useRef<HTMLDivElement>(null);
  const selectedLead = members.find((member) => member.id === leadId) ?? members[0];

  useEffect(() => {
    if (!leadPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!leadPickerRef.current?.contains(event.target as Node)) setLeadPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeadPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [leadPickerOpen]);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setLeadPickerOpen(false);
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  const choice = (on: boolean) =>
    cn(
      "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      on ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30" : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
    );
  const radio = (on: boolean) => (
    <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-accent bg-accent" : "border-ink-secondary/60")}>
      {on && <span className="size-1.5 rounded-full bg-white" />}
    </span>
  );

  return (
    <section
      data-testid="room-setup"
      aria-labelledby="room-setup-title"
      className="relative z-20 w-full overflow-visible rounded-3xl border border-hairline/50 bg-card shadow-xl shadow-black/10"
    >
      <div className="rounded-t-3xl border-b border-hairline/40 bg-panel/70 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-ink">1</span>
          <div>
            <h1 id="room-setup-title" className="text-xl font-semibold tracking-tight text-ink">{t("Set up {name}", { name: group.name })}</h1>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-relaxed text-ink-secondary">
              {t("Give this room a shared workspace, response style, and a little context before the first conversation starts.")}
            </p>
          </div>
        </div>
      </div>
      <form
        className="space-y-5 px-5 py-5 sm:px-7 sm:py-6"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("Working folder")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("Where room members run file and shell tools.")}</span>
          <div className="mt-2 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t("Each bot's own folder")}
              className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
            />
            {window.ogb?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hairline/50 bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} /> {t("Choose")}
              </button>
            )}
          </div>
        </label>

        <fieldset className="block">
          <legend className="text-[13px] font-semibold text-ink">{t("Default responder")}</legend>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("Choose who answers when nobody is mentioned.")}</p>
          <div role="radiogroup" aria-label={t("Default responder")} className="mt-2 grid gap-2 sm:grid-cols-3">
            <div ref={leadPickerRef} className="relative min-w-0">
              <button
                type="button"
                role="radio"
                aria-checked={behavior === "lead"}
                aria-haspopup="listbox"
                aria-expanded={behavior === "lead" && leadPickerOpen}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                disabled={saving}
                className={choice(behavior === "lead")}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    {radio(behavior === "lead")}
                    {t("Specific lead")}
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn("shrink-0 text-ink-secondary transition-transform", leadPickerOpen && "rotate-180")}
                  />
                </span>
                <span className="mt-2 ml-6 truncate text-[11.5px] text-ink-secondary">
                  {selectedLead?.name ?? t("Choose a teammate")}
                </span>
              </button>
              {behavior === "lead" && leadPickerOpen && (
                <div
                  role="listbox"
                  aria-label={t("Choose a lead")}
                  className="absolute top-full left-0 z-30 mt-2 w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/20"
                >
                  <div className="border-b border-hairline/40 px-3 py-2.5">
                    <div className="text-[12.5px] font-semibold text-ink">{t("Choose a lead")}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("Plain messages go to this teammate.")}</div>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1.5">
                    {members.map((member) => {
                      const selected = member.id === leadId;
                      return (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setLeadId(member.id);
                            setLeadPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                            selected ? "bg-accent/10" : "hover:bg-raised",
                          )}
                        >
                          <MemberAvatar bot={member} size={24} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{member.name}</span>
                            <span className="block truncate text-[11px] text-ink-secondary">{member.title}</span>
                          </span>
                          {selected && <Check size={15} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "everyone"}
              onClick={() => {
                setBehavior("everyone");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={choice(behavior === "everyone")}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                {radio(behavior === "everyone")}
                {t("Everyone responds")}
              </span>
              <span className="mt-2 ml-6 text-[11.5px] text-ink-secondary">{t("All room members")}</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "mentions"}
              onClick={() => {
                setBehavior("mentions");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={choice(behavior === "mentions")}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                {radio(behavior === "mentions")}
                {t("Only when mentioned")}
              </span>
              <span className="mt-2 ml-6 text-[11.5px] text-ink-secondary">{t("Only @mentioned members")}</span>
            </button>
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("Room instructions")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("A shared brief every member sees on each turn. You can edit it later.")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder={t("Goals, tone, ownership, constraints…")}
            className="mt-2 w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
          />
        </label>

        {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className="rounded-xl px-3 py-2 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            {t("Skip for now")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-ink hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t("Save & continue")}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Overlapping member tiles; a working member wears the blue pixels. */
function MemberStack({ members, busyId }: { members: Bot[]; busyId?: string | null }) {
  const shown = members.slice(0, 5);
  return (
    <span className="flex shrink-0 items-end" aria-hidden>
      {shown.map((member, index) => (
        <span
          key={member.id}
          title={busyId === member.id ? t("{name} — working…", { name: member.name }) : member.name}
          className="inline-flex rounded-[7px] bg-stage ring-[1.5px] ring-stage"
          style={{ marginLeft: index === 0 ? 0 : -6, zIndex: shown.length - index }}
        >
          <MemberAvatar bot={member} size={20} marker={busyId === member.id ? "working" : undefined} />
        </span>
      ))}
      {members.length > shown.length && <span className="ml-1 text-[11.5px] font-semibold text-ink-secondary">+{members.length - shown.length}</span>}
    </span>
  );
}

const STATE_WORD: Record<MeetingState, string> = {
  idle: msg("Not started"),
  live: msg("In progress"),
  waiting: msg("Waiting for your call"),
  ended: msg("Ended"),
};
const STATE_TONE: Record<MeetingState, "grey" | "blue" | "amber"> = {
  idle: "grey",
  live: "blue",
  waiting: "amber",
  ended: "grey",
};

/** "协调会 · 已结束" for a meeting; a plain room shows only live or waiting. */
function MeetingChip({ meeting, busy }: { meeting: Meeting; busy: boolean }) {
  if (!meeting.isMeeting && !(meeting.state === "waiting" || (meeting.state === "live" && busy))) return null;
  const word = t(STATE_WORD[meeting.state]);
  return (
    <StatusPill tone={STATE_TONE[meeting.state]} className="ml-1">
      {meeting.isMeeting ? `${t("Coordination meeting")} · ${word}` : word}
    </StatusPill>
  );
}

function HeaderButton({
  label,
  onClick,
  pressed,
  children,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[9px] transition-colors hover:bg-raised-hover",
        pressed ? "bg-control/70 text-ink" : "text-ink-secondary hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** The ⋯ menu: who answers by default and where the room works. */
function RoomMoreMenu({
  group,
  members,
  onFolder,
}: {
  group: Group;
  members: Bot[];
  onFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const folder = roomFolder(group);
  const folderName = folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder : null;
  return (
    <div ref={ref} className="relative">
      <HeaderButton label={t("More")} onClick={() => setOpen((value) => !value)} pressed={open}>
        <MoreHorizontal size={18} />
      </HeaderButton>
      {open && (
        <div className="animate-pop-in absolute top-full right-0 z-30 mt-1.5 w-[260px] rounded-xl bg-raised p-3" style={{ boxShadow: "0 0 0 1px color-mix(in oklab, var(--color-hairline) 40%, transparent), 0 18px 40px -16px rgb(16 24 40 / 0.35)" }}>
          <div className="mb-1.5 text-[11.5px] font-semibold text-ink-secondary">{t("Default responder")}</div>
          <DefaultResponderSelect group={group} members={members} />
          <div className="mt-3 mb-1.5 text-[11.5px] font-semibold text-ink-secondary">{t("Working folder")}</div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onFolder();
            }}
            className="flex h-8 w-full items-center gap-2 rounded-lg bg-control/60 px-2.5 text-left text-[12.5px] text-ink hover:bg-control"
            title={folder ? t("Working folder: {path}", { path: folder }) : t("Channel working folder")}
          >
            <Folder size={13} className="shrink-0 text-ink-secondary" />
            <span className="min-w-0 flex-1 truncate font-mono">{folderName ?? t("Each bot's own folder")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

const MINUTES_KEY = (groupId: string) => `omb.group.minutes:${groupId}`;

function readMinutesOpen(groupId: string): boolean | null {
  try {
    const value = localStorage.getItem(MINUTES_KEY(groupId));
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const stream = useStreaming();
  const streaming = stream.streaming[group.threadId];
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);
  const [folderOpen, setFolderOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
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

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const setupPending = roomNeedsSetup(group);
  const meeting = useMeeting(group, members, state.bots);

  // Minutes: open by default for a meeting that has started (on a wide
  // enough window); your own toggle is remembered per room.
  const [minutesOpen, setMinutesOpen] = useState<boolean>(() => {
    const stored = readMinutesOpen(group.id);
    if (stored !== null) return stored;
    return meeting.isMeeting && group.messages.length > 0 && typeof window !== "undefined" && window.innerWidth >= 1200;
  });
  const toggleMinutes = (next = !minutesOpen) => {
    setMinutesOpen(next);
    try {
      localStorage.setItem(MINUTES_KEY(group.id), next ? "1" : "0");
    } catch {
      /* the choice holds for this session */
    }
  };

  // Mascot stays while a member works; the finished reply pops in above it.
  const lastGroupMessage = group.messages.at(-1);
  const activityLabel = liveActivityLabel(lastGroupMessage);
  const waiting = Boolean(
    speaker && showWorkingDots(true, group.messages.at(-1), speaker.id),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; text: string; botId?: string } | null>(null);
  useEffect(() => {
    wasWaiting.current = false;
    setPopping(null);
  }, [group.id, group.threadId]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useEffect(() => {
    if (lastGroupMessage?.role !== "bot" || lastGroupMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    setPopping({
      id: lastGroupMessage.id,
      text: lastGroupMessage.text ?? "",
      botId: lastGroupMessage.from?.botId,
    });
    const timer = setTimeout(() => setPopping(null), 520);
    return () => clearTimeout(timer);
  }, [
    lastGroupMessage?.id,
    lastGroupMessage?.role,
    lastGroupMessage?.kind,
    lastGroupMessage?.text,
    lastGroupMessage?.from?.botId,
  ]);
  const presenceVisible = waiting || popping !== null;
  const presenceSpeaker = speaker ?? members.find((member) => member.id === popping?.botId) ?? members[0];

  // Windowed transcript, mirroring ChatView: only a tail of the room mounts;
  // the anchored boundary re-tails on a render-phase reset when the room (or
  // its thread) changes. Working dots below stay on the FULL list's tail.
  const transcriptKey = `${group.id}:${group.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(group.messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(group.messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [group.messages, transcriptWindow.start, transcriptWindow.end],
  );

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [group.id, setBottomFollow]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== group.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = group.messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(group.messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [group.messages, group.threadId, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(group.threadId, group.messages.length > 0);

  // an open folder editor belongs to the room it was opened in
  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);
  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted — see ChatView.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [group.id, group.messages.length, streaming, group.busyBotId, composerDock.pad]);

  // Rows also grow after they mount — a decision card or the minutes line
  // arrives with the polled company data, an image loads. While following
  // the bottom, keep it there.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const log = logRef.current;
    const scroller = scrollRef.current;
    if (!log || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followRef.current) return;
      scroller.scrollTo({ top: scroller.scrollHeight });
      previousScrollTop.current = scroller.scrollTop;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, [group.id, setupPending]);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
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
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(group.messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= group.messages.length ? null : nextEnd }));
  };

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };

  const jumpTo = useCallback(
    (messageId: string) => dispatch({ type: "focusMessage", threadId: group.threadId, messageId }),
    [dispatch, group.threadId],
  );
  const openLibrary = useCallback(() => dispatch({ type: "showPage", page: "library" }), [dispatch]);
  const openSource = useCallback(
    (source: NumberedSource) => {
      if (source.kind === "library") return openLibrary();
      if (source.kind === "web") {
        window.open(source.target, "_blank", "noopener,noreferrer");
        return;
      }
      // a file: hand over a copy the same way a file link in the chat does
      const path = source.target.replace(/^file:\/\//i, "");
      void window.ogb?.saveFile?.(decodeURI(path)).catch(() => {});
    },
    [openLibrary],
  );

  const exportHref = `/api/threads/${encodeURIComponent(group.threadId)}/export?format=markdown`;
  const showRoomLines = !group.dm && !setupPending && group.messages.length > 0;

  return (
    <div className="relative flex h-full min-w-0 flex-1">
      <main className="relative flex h-full min-w-0 flex-1 flex-col bg-stage">
        <GroupCallOverlay group={group} members={members} />
        {membersOpen && !group.dm && (
          <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
        )}
        {/* Header: who is in the room, where the meeting stands, room tools. */}
        <header className="@container/chathead flex h-14 shrink-0 items-center gap-2 border-b border-hairline/25 pr-3 pl-11 md:pl-5">
          <MemberStack members={members} busyId={group.busyBotId} />
          <h1 className="min-w-0 truncate text-[15px] font-bold text-ink">{group.name}</h1>
          {!group.dm && (
            <span className="shrink-0 text-[12.5px] whitespace-nowrap text-ink-secondary/80 @max-2xl/chathead:hidden">
              {tn(members.length, "{count} Bot + you", "{count} Bots + you")}
            </span>
          )}
          {!setupPending && <MeetingChip meeting={meeting} busy={Boolean(group.busyBotId)} />}
          {!setupPending && !group.dm && <GroupTaskPicker group={group} />}
          <span className="min-w-2 flex-1" />
          <div className="flex shrink-0 items-center gap-0.5">
            <GroupCallButton group={group} members={members} />
            {!group.dm && (
              <HeaderButton
                buttonRef={membersTriggerRef}
                label={tn(members.length, "Manage members — {count} bot in this channel", "Manage members — {count} bots in this channel")}
                onClick={() => setMembersOpen(true)}
              >
                <Users size={18} />
              </HeaderButton>
            )}
            <HeaderButton label={t("Find in conversation (⌘F)")} onClick={() => setFindOpen((open) => !open)} pressed={findOpen}>
              <Search size={17} />
            </HeaderButton>
            {!setupPending && (
              <HeaderButton label={t("Meeting minutes")} onClick={() => toggleMinutes()} pressed={minutesOpen}>
                <NotebookText size={17} />
              </HeaderButton>
            )}
            {group.messages.length > 0 && (
              <a
                href={exportHref}
                download
                aria-label={t("Export the conversation")}
                title={t("Export the conversation")}
                className="grid size-8 shrink-0 place-items-center rounded-[9px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
              >
                <Upload size={17} />
              </a>
            )}
            {!setupPending && !group.dm && <RoomMoreMenu group={group} members={members} onFolder={() => setFolderOpen(true)} />}
          </div>
        </header>

        {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}

        {/* The bulletin, pinned as the agenda; click to edit. */}
        {!setupPending && (
          <div className="w-full px-5 pt-2">
            <div className={COLUMN}>
              <AgendaBar
                bulletin={group.bulletin}
                agenda={meeting.agenda}
                state={meeting.state}
                timing={meeting.timing}
                onSave={(bulletin) => dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin } })}
              />
            </div>
          </div>
        )}

        {/* Working folder card — the ⋯ menu opens it */}
        {!setupPending && folderOpen && !group.dm && (
          <div className="w-full px-5 pt-2">
            <div className={COLUMN}>
              <RoomWorkingFolder group={group} onClose={() => setFolderOpen(false)} />
            </div>
          </div>
        )}

        {/* Pinned message banner — resolves against the room's full transcript */}
        {(() => {
          const pinned = group.messages.find((m) => m.id === group.pinnedMessageId && m.kind === "text");
          const text = pinned ? (pinned.text ?? "").replace(/\s+/g, " ").trim() : "";
          if (!pinned || !text) return null;
          const sender = pinned.role === "user" ? t("You") : (pinned.from?.name ?? t("A bot"));
          return (
            <div className="w-full px-5 pt-2">
              <div className={cn(COLUMN, "flex items-center gap-2 rounded-xl border border-accent/25 bg-accent/[0.07] px-3 py-1.5")}>
                <Pin size={12} className="shrink-0 text-accent" />
                <button
                  onClick={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: pinned.id })}
                  className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                  title={t("Jump to the pinned message")}
                >
                  <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
                  <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
                </button>
                <button
                  onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
                  aria-label={t("Unpin message")}
                  title={t("Unpin")}
                  className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          );
        })()}

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
            onWheel={(e) => {
              if (e.deltaY < 0) setBottomFollow(false);
              else if (atEnd()) setBottomFollow(true);
            }}
            onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
            onTouchMove={(e) => {
              const y = e.touches[0]?.clientY ?? 0;
              if (y > touchY.current + 4) setBottomFollow(false);
              else if (atEnd()) setBottomFollow(true);
            }}
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              const scrollTop = el.scrollTop;
              const resume = shouldResumeBottomFollow({
                following: followRef.current,
                previousScrollTop: previousScrollTop.current,
                scrollTop,
                distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
              });
              previousScrollTop.current = scrollTop;
              if (resume) setBottomFollow(true);
            }}
          >
            {setupPending ? (
              <div className={cn(COLUMN, "flex min-h-full items-center py-8")}>
                <RoomSetup group={group} members={members} />
              </div>
            ) : (
              <div
                ref={logRef}
                className={cn(COLUMN, "flex min-h-full flex-col justify-end gap-3 pt-4")}
                style={{ paddingBottom: composerDock.pad }}
                role="log"
                aria-live="polite"
                aria-label={t("Room {name}", { name: group.name })}
              >
                {group.messages.length === 0 && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
                    <div className="flex -space-x-2">
                      {members.slice(0, 3).map((b) => (
                        <span key={b.id} className="rounded-[13px] ring-2 ring-stage">
                          <MemberAvatar bot={b} size={44} />
                        </span>
                      ))}
                    </div>
                    <div className="text-[17px] font-semibold text-ink">{group.name}</div>
                    <div className="max-w-[380px] text-[14px] text-ink-secondary">
                      {groupResponseHint(group, members)}
                    </div>
                  </div>
                )}
                {hiddenCount > 0 && (
                  <div className="flex justify-center pt-2">
                    <button
                      onClick={showEarlier}
                      className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      {t("Show earlier messages ({count} more)", { count: hiddenCount })}
                    </button>
                  </div>
                )}
                <Transcript
                  group={group}
                  members={members}
                  messages={windowedMessages}
                  transcript={group.messages}
                  emergingId={popping?.id}
                  meeting={meeting}
                  onReply={selectReply}
                  onJump={jumpTo}
                  onOpenSource={openSource}
                />
                {laterCount > 0 && (
                  <div className="flex justify-center">
                    <button
                      onClick={showLater}
                      className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      {t("Show later messages ({count} more)", { count: laterCount })}
                    </button>
                  </div>
                )}
                {(speaker || presenceVisible) && (
                  <TurnPresence
                    avatar={presenceSpeaker ? <MemberAvatar bot={presenceSpeaker} size={24} marker="working" /> : null}
                    visible={presenceVisible}
                    label={activityLabel}
                    answering={popping !== null}
                  >
                    {popping ? (
                      <div className="ml-8 w-fit max-w-[560px] rounded-2xl rounded-tl-md bg-control/60 px-[13px] py-[9px] text-[13.5px] leading-[1.6] text-ink">
                        <ChatMarkdown text={meeting.sources.texts.get(popping.id) ?? popping.text} />
                      </div>
                    ) : null}
                  </TurnPresence>
                )}
                {showRoomLines && laterCount === 0 && (
                  <div className="flex flex-col gap-1.5 pt-1">
                    {meeting.isMeeting && meeting.state === "ended" && meeting.timing && (
                      <SystemLine icon={<Folder size={13} className="shrink-0 opacity-70" aria-hidden />}>
                        {meeting.minutesDoc
                          ? tRich(
                              "Meeting ended {time} · minutes filed to <b>Library</b>",
                              {
                                b: (children) => (
                                  <button type="button" onClick={openLibrary} className="font-semibold text-ink hover:underline">
                                    {children}
                                  </button>
                                ),
                              },
                              { time: formatTime(meeting.timing.end) },
                            )
                          : t("Meeting ended {time}", { time: formatTime(meeting.timing.end) })}
                      </SystemLine>
                    )}
                    <SystemLine icon={<ShieldCheck size={13} className="shrink-0 opacity-70" aria-hidden />}>
                      {t("Approvals and account requests never appear in group chats")}
                    </SystemLine>
                  </div>
                )}
              </div>
            )}
          </div>

          {!follow && (
            <button
              onClick={() => {
                setBottomFollow(true);
                setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length), end: null });
                requestAnimationFrame(() => {
                  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                });
              }}
              aria-label={t("Jump to latest messages")}
              className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
              style={{ bottom: composerDock.height }}
            >
              <ArrowDown size={13} /> {t("Jump to latest")}
            </button>
          )}

          <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
            <Composer
              key={group.threadId}
              group={group}
              members={members}
              locked={setupPending}
              replyTo={replyTo}
              onClearReply={clearReply}
              onConsumeReply={consumeReply}
              onRestoreReply={restoreReply}
            />
          </div>
        </div>
      </main>
      {minutesOpen && !setupPending && (
        <MinutesPanel
          group={group}
          members={members}
          meeting={meeting}
          onClose={() => toggleMinutes(false)}
          onJump={jumpTo}
          onOpenLibrary={openLibrary}
        />
      )}
    </div>
  );
}
