import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { ArrowUp, Check, Clock, Gauge, Hand, Paperclip, ShieldCheck, Sparkles, Square, Users } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  draftRevision,
  forgetFailedComposerSend,
  markDraftEdited,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  restoredSendId,
  useComposerDraft,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { BotAvatar } from "./Avatar";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  appendPastedText,
  composeMessage,
  imageAttachmentFromFile,
  intakeFiles,
  isImageFile,
  isLongPaste,
  pasteAttachment,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { groupComposerHint, roomRespondersForComposer } from "@/lib/group-routing";
import { pendingApprovals } from "./PendingApproval";
import { PendingApprovalStrip } from "./chat/ApprovalStrip";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ReplyQuote } from "./ReplyQuote";
import { ErrorStrip, MenuDivider, MenuItem, MenuLabel, PopoverPanel, RING, useDismiss } from "./chat/primitives";
import { IconAt, IconMic, IconPlus, IconSlash } from "./chat/icons";
import { EffortSegments } from "./EffortPicker";
import { assessTask, difficultyLabel, effortFor, effortLabel, type Effort } from "../../shared/model-recommender";
import { dispatchSettings } from "../../shared/dispatch-types";
import { filterSkills, skillInstruction, slashQueryAt, useSkillChoices, type SkillChoice } from "./chat/skills";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

interface QueuedGroupSend {
  text: string;
  replyToId?: string;
  draft: ComposerDraftSnapshot;
}

/** Whether an element is on screen inside the viewport (null while unknown). */
function useOnScreen(selector: string | null): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!selector || typeof IntersectionObserver === "undefined") {
      setVisible(false);
      return;
    }
    let observer: IntersectionObserver | null = null;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attach = () => {
      const wrapper = document.querySelector<HTMLElement>(selector);
      const target = (wrapper?.lastElementChild as HTMLElement | null) ?? wrapper;
      if (!target) {
        setVisible(false);
        // the card may mount a moment after the composer (window, task switch)
        if (tries++ < 10) timer = setTimeout(attach, 300);
        return;
      }
      observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), {
        // the composer dock covers the bottom of the transcript
        rootMargin: "0px 0px -120px 0px",
        threshold: 0.35,
      });
      observer.observe(target);
    };
    attach();
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
    };
  }, [selector]);
  return visible;
}

/** Renders the editable message composer (design U8/U9: a pill with +, the
 * input, @ and /, and the round mic/send button) and what sits above it. */
export function Composer({
  bot,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked = false,
  notice,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  /** New rooms keep the composer inert until their setup is saved or skipped. */
  locked?: boolean;
  /** Strips the conversation puts above the pill (errors, retries). */
  notice?: ReactNode;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  // an engine with a live session takes a message INTO the running turn;
  // for those the composer never locks — the server steers instead of 409
  const canSteer =
    !group && Boolean(bot) && state.instances.find((i) => i.instanceId === bot!.modelSelection.instanceId)?.capabilities?.queueing === true;
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : (state.bots.find((member) => member.id === approval?.message.from?.botId) ?? bot);
  // the card in the transcript is where an approval is answered; the strip
  // here only stands in while that card is out of view
  const approvalCardVisible = useOnScreen(approval ? `[data-mid="${CSS.escape(approval.message.id)}"]` : null);
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? t("A bot"))
    : (bot?.name ?? t("The bot"));
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const failedSends = useFailedComposerSends(draftId);
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      // Shared recovery reaches a newly mounted view after navigation and
      // falls back to a separate retry item when a newer draft already exists.
      if (recoverFailedComposerSend(sent) === "restored" && sent.reply) {
        onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => editAttachments((prev) => [...prev, ...next]),
    [editAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => editAttachments((prev) => prev.filter((a) => a.id !== id)),
    [editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @ or /
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  const closePlus = useCallback(() => setPlusOpen(false), []);
  useDismiss(plusOpen, closePlus, plusRef);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // image paste is offered only when every bot that will actually answer
  // can open one. sendGroup routes to mentions, else the room default —
  // `members.some` would let a mixed room send <attached-image> to Grok.
  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string) => {
    if (!group) return botSupportsImages(bot);
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const engineSupportsImages = imageTargetsSupport(text);

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);

  // ── / skill picker (a skill the bot — or the room's members — can use) ──
  const slash = mention ? null : slashQueryAt(text, caret);
  const slashActive = Boolean(slash && slash.start !== dismissedAt);
  const skillBots = useMemo(
    () => (group ? (members ?? []).filter((member) => !member.hidden) : bot ? [bot] : []).map((member) => ({ id: member.id, name: member.name })),
    [group, members, bot],
  );
  const { skills, loading: skillsLoading } = useSkillChoices(skillBots, slashActive);
  const skillCandidates = useMemo(
    () => (slashActive && slash ? filterSkills(skills, slash.query).slice(0, 6) : []),
    [slashActive, slash, skills],
  );
  const pickerOpen = candidates.length > 0 || skillCandidates.length > 0;
  const pickerLength = candidates.length > 0 ? candidates.length : skillCandidates.length;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query, slash?.start, slash?.query]);

  // one line at rest, then grow with the draft — hard cap at six lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const cap = line * 6;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [text]);

  const placeCaret = (next: number) => {
    setCaret(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next, next);
    });
  };

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    placeCaret(mention.start + peer.name.length + 2);
  };

  const pickSkill = (skill: SkillChoice) => {
    if (!slash) return;
    const instruction = skillInstruction(skill.name);
    const next = `${text.slice(0, slash.start)}${instruction}${text.slice(caret)}`;
    editText(next);
    setDismissedAt(slash.start);
    placeCaret(slash.start + instruction.length);
  };

  /** The @ and / buttons: type the trigger at the caret, opening its picker. */
  const insertTrigger = (trigger: "@" | "/") => {
    const input = inputRef.current;
    const at = input ? input.selectionStart ?? text.length : text.length;
    const before = text.slice(0, at);
    const glue = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${glue}${trigger}${text.slice(at)}`;
    editText(next);
    setDismissedAt(null);
    placeCaret(at + glue.length + 1);
  };

  // Rooms hold one message client-side while a member speaks; it auto-sends
  // the moment the room settles. 1:1 mid-turn sends still POST (the harness
  // queue), but stay off the transcript until drain — the chip here is the
  // pending row so they cannot become the active leaf mid-turn.
  const [queued, setQueued] = useState<QueuedGroupSend | null>(null);
  const queuedRef = useRef(queued);
  const clearQueued = useCallback(() => {
    queuedRef.current = null;
    setQueued(null);
  }, []);
  useEffect(
    () => () => {
      const unsent = queuedRef.current;
      if (unsent) restoreDraft(unsent.draft);
    },
    [draftId, restoreDraft],
  );
  // 1:1 queued sends render as ghost rows in the transcript tail (each with
  // its own cancel); the composer chip remains only for rooms, whose queue
  // is local to this component.
  const pendingChip = group ? queued?.text : undefined;
  // a chip on its own is a message: the send control has to appear for it
  const fileInput = useRef<HTMLInputElement>(null);
  const [autoWarn, setAutoWarn] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  // Auto mode belongs to one bot; a room has several, each with its own.
  const autoBot = group ? undefined : bot;
  // How hard this bot thinks: its own level, or — with none set and
  // automatic effort on — the level this message's difficulty calls for,
  // shown while you type (server/index.ts autoEffort sends the same).
  const effortLevels = ((autoBot && state.instances.find((instance) => instance.instanceId === autoBot.modelSelection.instanceId)?.capabilities?.effortLevels) ??
    []) as readonly Effort[];
  const effortPrefs = dispatchSettings(state.config?.dispatch);
  const typedTask = autoBot && !autoBot.modelSelection.effort && effortPrefs.autoEffort && effortLevels.length && text.trim() ? assessTask(text) : null;
  const autoLevel = typedTask ? effortFor(typedTask.difficulty, effortLevels, effortPrefs.policy) : undefined;
  const setEffort = (level: Effort | undefined) => {
    if (!autoBot) return;
    dispatch({ type: "setModel", botId: autoBot.id, selection: { ...autoBot.modelSelection, effort: level } });
  };
  const pickFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const { attachments: added, notice: intakeNotice } = await intakeFiles(Array.from(picked), {
      allowImages: engineSupportsImages,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    if (added.length) addAttachments(added);
    // Keep file-specific failures beside the attachments. A successful
    // overlapping intake must not erase an earlier failure before it is read.
    if (intakeNotice) setAttachmentNotice(intakeNotice);
  };
  const setAuto = (auto: boolean) => {
    if (!autoBot) return;
    // Turning it on for a bot that drives THIS computer is the one case that
    // has to be acknowledged first. The flag the dialog sends is stripped by
    // the reducer rather than stored, so — exactly like the settings panel —
    // the warning is shown on every switch-on, not just the first.
    if (auto && !autoBot.autoApprove && autoBot.computer === "local") {
      setAutoWarn(true);
      return;
    }
    dispatch({ type: "updateBot", botId: autoBot.id, patch: { autoApprove: auto } });
  };

  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const retryFailedSend = (failed: FailedComposerSend) => {
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText)) {
      dispatch({ type: "error", message: t("The selected responder does not support image attachments.") });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
  };
  const send = () => {
    // A busy channel already has one locally held send. Keep any newer text
    // as an editable draft until that send is dispatched; replacing the slot
    // here would silently lose the first message.
    if (locked || (group && queued)) return;
    if (attachments.some((attachment) => attachment.kind === "image") && !imageTargetsSupport(text)) {
      dispatch({ type: "error", message: t("The selected responder does not support image attachments.") });
      return;
    }
    const composed = composeMessage(text, attachments);
    if (!composed) return;
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? crypto.randomUUID(),
      text,
      requestText: composed,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
    };
    if (busy && group) {
      const pending = { text: composed, replyToId: replyTo?.id, draft: sentDraft };
      queuedRef.current = pending;
      setQueued(pending);
      setText("");
      setAttachments([]);
      onConsumeReply?.();
      return;
    }
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: composed,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { room: true });
    } else if (bot) {
      dispatch({
        type: "send",
        botId: bot.id,
        text: composed,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer });
    }
    setText("");
    setAttachments([]);
    onConsumeReply?.();
  };
  useEffect(() => {
    if (busy || !queued) return;
    if (group) {
      if (queued.text.includes("<attached-image ") && !imageTargetsSupport(queued.text)) {
        dispatch({ type: "error", message: t("The selected responder does not support image attachments.") });
        clearQueued();
        restoreDraft(queued.draft);
        return;
      }
      clearQueued();
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: queued.text,
        sendId: queued.draft.sendId,
        replyToId: queued.replyToId,
        threadId: queued.draft.threadId,
        onError: () => restoreDraft(queued.draft),
      });
      track("message_sent", { room: true, queued: true });
    }
  }, [busy, queued, group, members, state.instances, dispatch, clearQueued, restoreDraft]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        editText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError(t("Dictation is only available on macOS for now."));
      } else if (code === 1) {
        setSpeechError(
          t("Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security."),
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording, editText]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError(t("Dictation isn't available in this build."));
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  const stopTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id });
  };
  const showApprovalCard = () => {
    if (approval) dispatch({ type: "focusMessage", threadId, messageId: approval.message.id });
  };

  const name = group ? group.name : (bot?.name ?? "");
  const placeholder = locked
    ? t("Finish room setup to start chatting")
    : approval
      ? t("Answer the approval above to continue")
      : recording
        ? t("Listening…")
        : busy && canSteer
          ? t("{name} is working — Enter sends this into the running turn", { name: busyName })
          : busy
            ? group
              ? t("{name} is working — Enter queues your message", { name: busyName })
              : t("{name} is working — sends when this turn finishes", { name: busyName })
            : group
              ? t("Message {name} · @ a bot · @everyone", { name })
              : t("Message {name} · @ to mention a bot · / to use a skill", { name });

  // anything above the pill gets the stage colour behind it, so the
  // transcript never shows through a strip
  const stripsShown = Boolean(
    notice ||
      speechError ||
      failedSends.length ||
      pendingChip ||
      (approval && !approvalCardVisible) ||
      replyTo ||
      attachments.length ||
      attachmentNotice,
  );

  // the round button: send what is typed, else stop a running turn, else
  // dictate (where dictation is missing, pressing it says why)
  const primary: "send" | "queue" | "stop" | "mic" = hasContent
    ? busy && !canSteer
      ? "queue"
      : "send"
    : busy
      ? "stop"
      : "mic";

  return (
    <div className="pointer-events-none relative mx-auto w-full max-w-[720px] px-5 pb-3">
      {/* No fill on this wrapper: bubbles scroll under the pill. The stage
          colour starts at the pill's midline and runs to the bottom edge;
          strips above the pill sit on the stage colour too. */}
      <div className="pointer-events-auto relative w-full">
        <div className="relative flex flex-col">
        {stripsShown && (
          <>
            <div aria-hidden className="pointer-events-none absolute -top-3 -right-5 -left-5 h-3 bg-gradient-to-b from-transparent to-stage" />
            <div aria-hidden className="pointer-events-none absolute -right-5 -left-5 top-0 bottom-0 bg-stage" />
          </>
        )}
        {notice && <div className="relative">{notice}</div>}
        {speechError && (
          <div className="relative mb-2">
            <ErrorStrip tone="warning" onDismiss={() => setSpeechError(null)}>
              {speechError}
            </ErrorStrip>
          </div>
        )}
        {failedSends.map((failed) => (
          <div key={failed.id} className="relative mb-2">
            <ErrorStrip
              onDismiss={() => forgetFailedComposerSend(draftId, failed.id)}
              action={
                <button
                  type="button"
                  onClick={() => retryFailedSend(failed)}
                  className="h-6 shrink-0 rounded-md px-2 text-[12px] font-semibold hover:bg-danger/10"
                >
                  {t("Retry")}
                </button>
              }
            >
              <span className="block truncate">{t("Not sent: “{text}”", { text: failed.text.trim() || t("attachment") })}</span>
            </ErrorStrip>
          </div>
        ))}
        {pendingChip && (
          <div className="relative mb-2">
            <ErrorStrip tone="quiet" onDismiss={clearQueued}>
              <span className="flex min-w-0 items-center gap-2">
                <Clock size={13} className="shrink-0" />
                <span className="min-w-0 truncate">
                  {t("Queued — sends when {name} finishes: “{text}”", { name: busyName, text: pendingChip })}
                </span>
              </span>
            </ErrorStrip>
          </div>
        )}
        {pickerOpen && (
          <div
            role="listbox"
            aria-label={candidates.length ? t("Tag a bot") : t("Use a skill")}
            className={cn("absolute bottom-full left-2 z-20 mb-2 w-80 overflow-hidden rounded-xl bg-raised p-1 shadow-xl", RING)}
          >
            {candidates.length > 0
              ? candidates.map((peer, i) => (
                  <button
                    key={peer.id}
                    role="option"
                    aria-selected={i === highlight}
                    onClick={() => pickMention(peer)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", i === highlight ? "bg-raised-hover" : "")}
                  >
                    {peer.bot ? (
                      <BotAvatar bot={peer.bot} size={22} />
                    ) : (
                      <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-control text-ink-secondary">
                        <Users size={13} aria-hidden="true" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{peer.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{peer.bot ? t("Agent") : t("Channel")}</span>
                  </button>
                ))
              : skillCandidates.map((skill, i) => (
                  <button
                    key={`${skill.botId}:${skill.name}`}
                    role="option"
                    aria-selected={i === highlight}
                    onClick={() => pickSkill(skill)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left", i === highlight ? "bg-raised-hover" : "")}
                  >
                    <Sparkles size={14} className="mt-0.5 shrink-0 text-ink-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] font-semibold text-ink">/{skill.name}</span>
                      {skill.description && <span className="block truncate text-[11.5px] text-ink-secondary">{skill.description}</span>}
                    </span>
                    {group && <span className="shrink-0 text-[11px] text-ink-secondary">{skill.botName}</span>}
                  </button>
                ))}
          </div>
        )}
        {slashActive && !pickerOpen && slash?.query === "" && (
          <div className={cn("absolute bottom-full left-2 z-20 mb-2 w-80 rounded-xl bg-raised px-3 py-2.5 text-[12.5px] text-ink-secondary shadow-xl", RING)}>
            {skillsLoading ? t("Loading skills…") : t("No skills yet — import one in the bot's settings.")}
          </div>
        )}
        {/* The card in the transcript is where an approval is answered; this
            strip stands in only while that card is out of view. */}
        {approval && !approvalCardVisible && (
          <div className="relative">
            <PendingApprovalStrip
              pending={approval}
              count={approvals.length}
              threadId={threadId}
              bot={approvalBot}
              onShow={showApprovalCard}
              onCancelTurn={stopTurn}
            />
          </div>
        )}
        {replyTo && (
          <div className="relative mb-2 px-1">
            <ReplyQuote
              message={replyTo}
              fallbackName={bot?.name}
              onClear={onClearReply}
            />
          </div>
        )}
        <div className="relative">
          <ComposerAttachments
            items={attachments}
            onAdd={addAttachments}
            onRemove={removeAttachment}
            onDisplayInChatBox={displayPasteInChatBox}
            allowImages={engineSupportsImages}
            notice={attachmentNotice}
            onNotice={setAttachmentNotice}
          />
        </div>
        </div>
        <div className="relative">
          {/* Stage colour from the pill's midline down, across the whole
              chat column: bubbles may tuck into the top half of the pill's
              radius, never below its centre. Under a strip the whole pill
              sits on the stage, so nothing peeks out at its corners. */}
          <div
            aria-hidden
            className={cn("absolute -bottom-3 left-1/2 w-[200vw] -translate-x-1/2 bg-stage", stripsShown ? "top-0" : "top-1/2")}
          />
          <div
            className={cn(
              "relative z-[1] flex min-h-[50px] items-end gap-2 rounded-[25px] bg-raised py-[8px] pr-2 pl-2.5",
              "inset-ring inset-ring-hairline/55 shadow-[0_6px_18px_-10px_#10182840]",
            )}
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void pickFiles(e.target.files);
                // same file twice in a row still fires onChange
                e.target.value = "";
              }}
            />
            {!locked && (
              <div ref={plusRef} className="relative flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPlusOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={plusOpen}
                  aria-label={t("Attach and options")}
                  title={t("Attach and options")}
                  className={cn(
                    "grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:text-ink",
                    plusOpen ? "bg-raised-hover" : "bg-control/70 hover:bg-raised-hover",
                  )}
                >
                  <IconPlus size={18} />
                </button>
                {/* Auto mode shows itself — the one setting worth seeing at a glance */}
                {autoBot?.autoApprove && (
                  <button
                    type="button"
                    onClick={() => setPlusOpen(true)}
                    title={t("Keep going automatically; destructive and sensitive actions still ask")}
                    className="flex h-6 items-center gap-1 rounded-full bg-select/10 px-2 text-[11.5px] font-semibold text-accent-text"
                  >
                    <ShieldCheck size={12} />
                    {t("Auto")}
                  </button>
                )}
                {/* the effort this message will get, recommended from its difficulty */}
                {autoLevel && typedTask && (
                  <button
                    type="button"
                    onClick={() => setPlusOpen(true)}
                    title={t("Thinks as hard as this message calls for: {difficulty} → {level}. Click to fix a level.", {
                      difficulty: difficultyLabel(typedTask.difficulty),
                      level: effortLabel(autoLevel),
                    })}
                    className="flex h-6 items-center gap-1 rounded-full bg-control/70 px-2 text-[11.5px] font-semibold text-ink-secondary hover:text-ink"
                  >
                    <Gauge size={12} />
                    {effortLabel(autoLevel)}
                  </button>
                )}
                {plusOpen && (
                  <PopoverPanel label={t("Attach and options")} className="bottom-full left-0 mb-2 w-[300px]">
                    <MenuItem
                      icon={<Paperclip size={14} />}
                      onClick={() => {
                        setPlusOpen(false);
                        fileInput.current?.click();
                      }}
                    >
                      {t("Attach a file")}
                    </MenuItem>
                    <MenuItem
                      icon={<IconSlash size={14} />}
                      onClick={() => {
                        setPlusOpen(false);
                        insertTrigger("/");
                      }}
                    >
                      {t("Use a skill")}
                    </MenuItem>
                    {autoBot && (
                      <>
                        <MenuDivider />
                        <MenuLabel>{t("How should {name} actions be approved?", { name: autoBot.name })}</MenuLabel>
                        <MenuItem
                          icon={<Hand size={14} />}
                          role="menuitemradio"
                          aria-checked={!autoBot.autoApprove}
                          hint={!autoBot.autoApprove ? <Check size={13} /> : undefined}
                          onClick={() => {
                            setPlusOpen(false);
                            setAuto(false);
                          }}
                        >
                          {t("Ask for approval")}
                        </MenuItem>
                        <MenuItem
                          icon={<ShieldCheck size={14} />}
                          role="menuitemradio"
                          aria-checked={Boolean(autoBot.autoApprove)}
                          hint={autoBot.autoApprove ? <Check size={13} /> : undefined}
                          onClick={() => {
                            setPlusOpen(false);
                            setAuto(true);
                          }}
                        >
                          {t("Auto mode")}
                        </MenuItem>
                      </>
                    )}
                    {autoBot && effortLevels.length > 0 && (
                      <>
                        <MenuDivider />
                        <MenuLabel>{t("How hard {name} thinks", { name: autoBot.name })}</MenuLabel>
                        <EffortSegments
                          className="mx-1.5 mb-1"
                          label={t("How hard {name} thinks", { name: autoBot.name })}
                          levels={effortLevels}
                          value={autoBot.modelSelection.effort}
                          unsetLabel={effortPrefs.autoEffort ? t("Auto") : t("Default")}
                          unsetTitle={effortPrefs.autoEffort ? t("Auto, by each task's difficulty") : t("Engine default")}
                          onChange={(level) => {
                            setPlusOpen(false);
                            setEffort(level);
                          }}
                        />
                        {autoLevel && typedTask && (
                          <p className="px-2.5 pb-1.5 text-[11.5px] leading-[1.5] text-ink-secondary">
                            {t("This message: {difficulty} → {level}", { difficulty: difficultyLabel(typedTask.difficulty), level: effortLabel(autoLevel) })}
                          </p>
                        )}
                      </>
                    )}
                  </PopoverPanel>
                )}
              </div>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              onChange={(e) => {
                editText(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                setDismissedAt(null);
              }}
              onPaste={(e) => {
                // an image from the clipboard becomes an uploaded attachment —
                // but only for engines that can open one; a grok bot politely
                // refuses instead of receiving a path it cannot read
                const imageFiles = Array.from(e.clipboardData.files).filter(isImageFile);
                if (imageFiles.length && engineSupportsImages) {
                  e.preventDefault();
                  void (async () => {
                    for (const file of imageFiles) {
                      try {
                        const attachment = await imageAttachmentFromFile(file);
                        if (attachment) editAttachments((prev) => [...prev, attachment]);
                      } catch (err) {
                        dispatch({
                          type: "error",
                          message: err instanceof Error ? err.message : t("image upload failed"),
                        });
                      }
                    }
                  })();
                  return;
                }
                // a wall of text becomes a chip instead of burying the input
                const pasted = e.clipboardData.getData("text/plain");
                if (!isLongPaste(pasted)) return;
                e.preventDefault();
                // Preserve native paste replacement semantics: if text was
                // selected, the attachment replaces that selection.
                const start = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                if (start !== end) {
                  editText(`${text.slice(0, start)}${text.slice(end)}`);
                  setCaret(start);
                }
                editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
              }}
              onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (pickerOpen) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    setHighlight((h) => (h + delta + pickerLength) % pickerLength);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    if (candidates.length) pickMention(candidates[highlight] ?? candidates[0]!);
                    else pickSkill(skillCandidates[highlight] ?? skillCandidates[0]!);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDismissedAt(mention?.start ?? slash?.start ?? null);
                    return;
                  }
                }
                if (e.key === "Escape" && slashActive) {
                  e.preventDefault();
                  setDismissedAt(slash?.start ?? null);
                  return;
                }
                // an empty composer + ArrowUp = edit your last message (like a chat app)
                if (e.key === "ArrowUp" && !hasContent && onEditLast) {
                  e.preventDefault();
                  onEditLast();
                  return;
                }
                // Shift+Enter inserts a newline; plain Enter sends
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape" && recording) setRecording(false);
              }}
              disabled={Boolean(approval) || locked}
              placeholder={placeholder}
              aria-label={t("Message {name}", { name })}
              // rooms: who answers when nobody is mentioned
              title={group ? t("Message {name} — {hint}", { name, hint: groupComposerHint(group, members ?? []) }) : undefined}
              className="max-h-[9rem] min-h-[34px] min-w-0 flex-1 resize-none self-center overflow-y-auto bg-transparent px-1 py-[7px] text-[13.5px] leading-5 text-ink placeholder:truncate placeholder:text-ink-secondary/70 focus:outline-none disabled:cursor-not-allowed"
            />
            {!locked && (
              <div className="flex shrink-0 items-center gap-1 self-center">
                <button
                  type="button"
                  onClick={() => insertTrigger("@")}
                  disabled={Boolean(approval)}
                  aria-label={t("Mention a bot")}
                  title={t("Mention a bot")}
                  className="grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-40"
                >
                  <IconAt size={17} />
                </button>
                <button
                  type="button"
                  onClick={() => insertTrigger("/")}
                  disabled={Boolean(approval)}
                  aria-label={t("Use a skill")}
                  title={t("Use a skill")}
                  className="grid size-8 place-items-center rounded-full text-[15px] font-bold text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-40"
                >
                  /
                </button>
                {busy && hasContent && (
                  <button
                    type="button"
                    onClick={stopTurn}
                    aria-label={t("Stop this turn")}
                    title={t("Stop")}
                    className="grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised-hover hover:text-ink"
                  >
                    <Square size={13} className="fill-current" />
                  </button>
                )}
                {primary === "stop" ? (
                  <button
                    type="button"
                    onClick={stopTurn}
                    aria-label={t("Stop this turn")}
                    title={t("Stop")}
                    className="grid size-[34px] place-items-center rounded-full bg-primary text-primary-ink hover:brightness-110"
                  >
                    <Square size={12} className="fill-current" />
                  </button>
                ) : primary === "mic" ? (
                  <button
                    type="button"
                    onClick={toggleMic}
                    aria-label={recording ? t("Stop dictation") : t("Start dictation")}
                    title={recording ? t("Stop dictation (Esc)") : t("Dictate")}
                    className={cn(
                      "grid size-[34px] place-items-center rounded-full",
                      recording ? "animate-pulse bg-danger text-white" : "bg-primary text-primary-ink hover:brightness-110",
                    )}
                  >
                    <IconMic size={16} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={send}
                    disabled={Boolean(group && queued)}
                    aria-label={
                      group && queued
                        ? t("Waiting for queued message")
                        : busy && canSteer
                          ? t("Send into the running turn")
                          : busy
                            ? t("Queue message")
                            : t("Send message")
                    }
                    title={
                      group && queued
                        ? t("Your earlier message will send when the current turn finishes")
                        : busy && canSteer
                          ? t("Send into the running turn")
                          : busy
                            ? t("Sends when the current turn finishes")
                            : t("Send")
                    }
                    className={cn(
                      "grid size-[34px] place-items-center rounded-full transition",
                      group && queued
                        ? "cursor-not-allowed bg-control text-ink-secondary"
                        : primary === "queue"
                          ? "bg-control text-ink hover:bg-raised-hover"
                          : "bg-primary text-primary-ink hover:brightness-110 disabled:opacity-25",
                    )}
                  >
                    {primary === "queue" ? <Clock size={15} /> : <ArrowUp size={17} strokeWidth={2.4} />}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="pointer-events-auto">
        <LocalComputerAutoWarning
          open={autoWarn}
          onCancel={() => setAutoWarn(false)}
          onConfirm={() => {
            if (autoBot) {
              dispatch({
                type: "updateBot",
                botId: autoBot.id,
                patch: { autoApprove: true, acknowledgeLocalAuto: true },
              });
            }
            setAutoWarn(false);
          }}
        />
      </div>
    </div>
  );
}
