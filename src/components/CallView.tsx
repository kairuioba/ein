// Call mode — the bot on the line.
//
// The loop is deliberately HALF-DUPLEX: the microphone is live only when
// the bot is not speaking. The dictation helper is Apple's SFSpeechRecognizer
// running on raw AVAudioEngine input with no acoustic echo cancellation, so
// a mic left open through playback transcribes the bot's own voice back into
// the conversation and the two of them talk forever. Interrupting is a tap
// or Escape instead, which is honest and cannot feed back. (Full-duplex
// barge-in needs AEC on the capture path — a follow-up, not a footnote.)
//
// Turn-taking uses a small silence endpointer in the native helper. Apple's
// buffer-backed recognizer does not finalize on silence by itself: the helper
// has to end the audio stream, which then produces the final transcript.
//
// The other half of making a call bearable is narration. An agent turn is
// 5-60 seconds of tool calls; silence that long reads as a dropped call. So
// every activity chip the harness narrates (`tool.spoken`) is read aloud as
// it happens, which is why waiting feels like listening to someone work
// rather than listening to nothing.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { callStartedAt, currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { callActions, callPoints, captionLines } from "@/lib/group-call-notes";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import {
  CallBotTile,
  CallDock,
  CallShell,
  CallStage,
  CallYouTile,
  CaptionsPanel,
  callMascotScale,
  useSecondClock,
  type LiveCaption,
  type YouStatus,
} from "./group/CallChrome";
import { estimateSpeechMs, useCallContext } from "./group/useCallContext";
import { t } from "@/lib/i18n";
import { spokenNo, spokenYes } from "@/lib/spoken-answer";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the bot, not as consent — an approval must never be granted by a
 * sentence that merely contained the word "sure". */

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

export function CallButton({ bot }: { bot: Bot }) {
  return (
    <CallTargetButton
      targetId={bot.id}
      targetName={bot.name}
      voices={[bot.voice]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      onStart={() => track("call_started", { driver: bot.modelSelection?.instanceId })}
    />
  );
}

export function CallTargetButton({
  targetId,
  targetName,
  voices,
  setupBotId,
  requireExplicitVoices,
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  /** Agent profile to open when voice setup is missing (rooms choose a member). */
  setupBotId?: string;
  /** Rooms cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  onStart: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const active = useOnCall() === targetId;
  const supported = capabilities.dictation.available && Boolean(window.ogb?.speechStart);
  const configured = Boolean(state.config?.tts?.configured);
  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice));
  const voiceReady =
    configured && (requireExplicitVoices ? everyTargetHasVoice : Boolean(state.config?.tts?.ready || everyTargetHasVoice));
  const unavailable = !active && (!capabilitiesReady || !supported || !voiceReady);
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const label = active
    ? t("Hang up on {name}", { name: targetName })
    : !capabilitiesReady
      ? t("Checking call availability")
      : !supported
        ? t("Calls currently need the macOS desktop app")
        : !configured
          ? t("Set up a voice in an agent profile to make calls")
          : !voiceReady
            ? t("Pick a voice in an agent profile to make calls")
            : t("Call {name}", { name: targetName });

  const reason = !capabilitiesReady
    ? t("Checking whether this device can make calls.")
    : !capabilities.dictation.available
      ? t("Calls require Ein for macOS because speech recognition runs on-device.")
      : !window.ogb?.speechStart
        ? t("The speech service is unavailable in this app build. Restart or update Ein.")
        : !configured
          ? t("Add an ElevenLabs API key — or switch to the built-in Mac voices — so the bot can speak during calls.")
          : !voiceReady
            ? voices.length > 1
              ? t("Give every channel member a voice before starting a channel call.")
              : t("Choose a voice before starting a call.")
            : "";

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [helpOpen]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => {
          if (active) return endCall(targetId);
          if (unavailable) {
            setHelpOpen((open) => !open);
            return;
          }
          onStart();
          startCall(targetId);
        }}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        aria-label={label}
        title={label}
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-[9px] transition-colors",
          active
            ? "bg-danger text-white hover:brightness-110"
            : unavailable
              ? "text-ink-secondary/50 hover:bg-raised-hover hover:text-ink-secondary"
              : "text-ink-secondary hover:bg-raised-hover hover:text-ink",
        )}
      >
        {active ? <PhoneOff size={17} /> : <Phone size={17} />}
        {unavailable && (
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-warning ring-2 ring-stage" aria-hidden="true" />
        )}
      </button>

      {unavailable && helpOpen && (
        <div
          id={helpId}
          role="group"
          aria-label={t("Call unavailable")}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[280px] rounded-xl bg-raised p-3 text-left shadow-[0_0_0_1px_var(--color-hairline),0_18px_40px_-16px_rgb(16_24_40/0.35)]"
        >
          <div className="text-[13px] font-medium text-ink">{t("Call unavailable")}</div>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {voiceSetupRequired && (
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                if (setupBotId && setupBotId !== targetId) dispatch({ type: "select", id: setupBotId });
                dispatch({ type: "toggleSettings", open: true });
              }}
              className="mt-2.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-ink hover:brightness-110"
            >
              {t("Open agent settings")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return <Call bot={bot} />;
}

function Call({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const speech = useSpeech();
  const context = useCallContext();
  const now = useSecondClock();
  const [startedAt] = useState(() => callStartedAt() ?? Date.now());
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // what the screen shows, and your controls (see GroupCallView)
  const [live, setLive] = useState<LiveCaption | null>(null);
  const [spokenMs, setSpokenMs] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const mutedRef = useRef(false);
  const audibleRef = useRef(true);
  const hearingSince = useRef<number>(Date.now());
  const pushToTalk = usePushToTalk(bot.id, phase === "listening", () => {
    setNote(t("Push to talk couldn't start. Check Microphone and Speech Recognition access."));
  });

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );

  // Everything already on screen when the call starts has been read or
  // ignored — a call must not open by reciting the backlog.
  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  // the approval we last asked about aloud, so a card that stays open
  // while the user thinks is not re-read every render
  const askedApproval = useRef<{
    requestId: string;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; messageId: string } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);

  /** Change the rendered phase and the synchronous phase used by native
   * callbacks together. React state alone is too late: the helper can exit
   * in the same tick as a final transcript or an intentional mute. */
  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.ogb?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    setNote(null);
    setLive(null);
    hearingSince.current = Date.now();
    // muted: it is your turn, but the microphone stays closed until you unmute
    if (mutedRef.current) return;
    void window.ogb?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote(t("The microphone couldn't start. Check Microphone and Speech Recognition access."));
      }
    });
  }, [bot.id, move]);

  /** Speak, with the microphone closed for the duration (see the header
   * comment — an open mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string, lineId?: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      const begin = Date.now();
      setLive({ lineId, speakerId: bot.id, name: bot.name, text: lineId ? undefined : text, startedAt: begin });
      hush();
      // speaker off (or this bot silenced): the reply is read as a caption
      if (audibleRef.current) await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
      else await new Promise((resolve) => setTimeout(resolve, 600));
      if (alive.current) setSpokenMs((total) => total + (Date.now() - begin));
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, bot.name, bot.voice, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string, lineId?: string) => {
      const stillMine = await say(text, lineId);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  // Navigating away from this bot hangs up. Without ownership checking, the
  // overlay disappeared but `currentCall()` remained set and auto-speak was
  // permanently disabled for a call nobody could see.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      // StrictMode immediately remounts effects once in development. A
      // microtask distinguishes that probe from real navigation: the probe
      // has set alive=true again before this runs; a genuine unmount has not.
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

  // ── the microphone ───────────────────────────────────────────────────
  useEffect(() => {
    const bridge = window.ogb;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote(t("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access."));
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      // final result — Apple's recognizer decided the turn ended
      const said = line.text.trim();
      if (!said) return listen();

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        if (spokenYes(said) || spokenNo(said)) {
          const allow = spokenYes(said);
          if (allow && open.skill) {
            setHeard("");
            void sayThenListen(t("Open this chat to review the complete skill before enabling it. You can say no now to deny it."));
            return;
          }
          // Keep this request claimed until the server's durable card patch
          // arrives. Clearing it here lets a render in that network gap read
          // and submit the same approval again.
          open.submitted = true;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a call.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? t("routine decision") : t("approval");
              void sayThenListen(
                detail
                  ? t("I couldn't save that {decision}: {detail} Please try again.", { decision, detail })
                  : t("I couldn't save that {decision}. Please try again.", { decision }),
              );
            },
          });
          return;
        }
        // not a decision — leave the card up and say so rather than
        // guessing consent from an ambiguous sentence
        void sayThenListen(t("Sorry — is that a yes or a no?"));
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        dispatch({ type: "answerCard", botId: bot.id, messageId: openQuestion.messageId, answer: said });
        move("working");
        return;
      }

      move("sending");
      dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote(t("Calls need macOS dictation, which isn't available here yet."));
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? t("The dictation helper couldn't be built. Install Apple's Command Line Tools and try again.")
            : t("Dictation needs Microphone + Speech Recognition access in System Settings."),
        );
        return;
      }
      // the helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next
      if (phaseRef.current === "listening") listen();
    });
    if (bot.busy && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.ogb?.speechStop();
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, hush, listen, move, sayThenListen]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    // The request may be resolved from the normal approval UI or by another
    // client while this call is open. Do not keep treating future speech as
    // an answer to a card that no longer exists.
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    if (!approval && !question && bot.busy && phaseRef.current === "listening") {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    // Nothing may reopen capture or narrate new work while the server is
    // durably settling this exact decision.
    if (askedApproval.current?.submitted) return;
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      void sayThenListen(isSkillApproval(approval)
        ? t("{name} wants to enable a learned skill. Open this chat to review the complete skill before enabling it. You can say no to deny it.", { name: bot.name })
        : spokenApprovalPrompt(approval, bot.name));
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? " " + t("The options are {options}.", { options: question.card.options.join(", ") })
        : "";
      void sayThenListen(
        t("{name} asks: {detail}", { name: bot.name, detail: `${detail}${/[.!?]$/.test(detail) ? "" : "."}` }) + choices,
      );
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    // only the newest of each kind matters: a burst of tool chips should
    // not queue thirty seconds of narration behind the actual answer
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      void sayThenListen(reply.text, reply.id);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") {
          move("working");
          setLive(null);
        }
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    if (bot.busy) {
      // An open approval deliberately keeps the mic live for yes/no. Every
      // other busy phase is half-duplex and must close capture.
      if (phaseRef.current !== "speaking" && !askedApproval.current && !askedQuestion.current) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      // A failed/cancelled turn may have no reply to trigger the normal
      // speak-then-listen path. Recover the call instead of staying stuck.
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  // Escape hangs up; space interrupts whatever is being said
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, listen]);

  // ── your controls ─────────────────────────────────────────────────────
  const interrupt = () => {
    sayGeneration.current += 1;
    speaker.stop();
    listen();
  };
  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      setHeard("");
      if (phaseRef.current === "listening") hush();
    } else if (phaseRef.current === "listening") {
      listen();
    }
  };
  const setAudible = (speakerNext: boolean, voiceNext: boolean) => {
    setSpeakerOn(speakerNext);
    setVoiceMuted(voiceNext);
    audibleRef.current = speakerNext && !voiceNext;
    if (!audibleRef.current && speaker.isSpeaking()) speaker.stop();
  };

  // ── what the screen shows ─────────────────────────────────────────────
  const lines = useMemo(() => captionLines(messages, startedAt, { botId: bot.id, name: bot.name }), [messages, startedAt, bot.id, bot.name]);
  const actions = useMemo(() => callActions(lines), [lines]);
  const points = useMemo(() => callPoints(lines), [lines]);
  const spoke = Math.max(
    spokenMs,
    lines.filter((line) => line.speaker.kind === "bot").reduce((sum, line) => sum + estimateSpeechMs(line.text), 0),
  );
  const youStatus: YouStatus = muted ? "muted" : phase === "listening" ? (heard || pushToTalk ? "talking" : "open") : "listening";
  const leftHint = muted
    ? { title: t("You're muted"), detail: t("Click the mic to talk · Space interrupts") }
    : phase === "listening"
      ? pushToTalk
        ? { title: t("Listening to you"), detail: t("Release Control + Option to send…") }
        : { title: t("Your turn"), detail: t("Just talk, or hold Control + Option") }
      : phase === "speaking"
        ? { title: t("You're listening"), detail: t("Space interrupts · Esc hangs up") }
        : { title: phase === "sending" ? t("One moment") : t("{name} is working", { name: bot.name }) };
  const liveCaption: LiveCaption | null =
    phase === "speaking" && live
      ? { ...live, caption: speech.caption }
      : phase === "listening" && heard
        ? { you: true, name: t("You"), text: heard, startedAt: hearingSince.current }
        : null;
  const notice =
    note || speech.error ? (
      <div className="flex max-w-[560px] items-center gap-2 rounded-xl bg-raised px-3 py-2 text-[12.5px] text-warning shadow-[0_8px_24px_-14px_rgb(16_24_40/0.4)]">
        <span className="min-w-0 flex-1">{note ?? speech.error}</span>
        {note && (
          <button onClick={listen} className="shrink-0 rounded-full px-2.5 py-1 font-semibold hover:bg-warning/10">
            {t("Try microphone again")}
          </button>
        )}
      </div>
    ) : null;

  return (
    <CallShell
      label={t("Call with {name}", { name: bot.name })}
      title={bot.name}
      startedAt={startedAt}
      now={now}
      linkLabel={bot.title || undefined}
      people={[bot]}
      count={2}
      panelOpen={panelOpen}
      onTogglePanel={() => setPanelOpen((open) => !open)}
      stage={
        <CallStage
          count={2}
          tiles={
            <>
              <CallBotTile
                scale={callMascotScale(2)}
                onToggleVoice={() => setAudible(speakerOn, !voiceMuted)}
                tile={{
                  bot,
                  status: phase === "speaking" ? "speaking" : phase === "working" || phase === "sending" ? "working" : spoke > 0 ? "spoke" : "listening",
                  ms: phase === "speaking" ? now - (live?.startedAt ?? now) : spoke,
                  color: context.colors.get(bot.id),
                  engine: context.engineOf(bot),
                  voiceMuted,
                }}
              />
              <CallYouTile status={youStatus} onToggleMute={toggleMute} scale={callMascotScale(2)} name={state.config?.profile?.name?.trim() || t("Owner")} />
            </>
          }
          dock={
            <CallDock
              muted={muted}
              onToggleMute={toggleMute}
              speakerOn={speakerOn}
              onToggleSpeaker={() => setAudible(!speakerOn, voiceMuted)}
              canRaiseHand={phase === "speaking"}
              onRaiseHand={interrupt}
              onHangUp={() => endCall(bot.id)}
            />
          }
          leftHint={leftHint}
          notice={notice}
        />
      }
      panel={
        <CaptionsPanel
          lines={lines}
          live={liveCaption}
          startedAt={startedAt}
          bots={state.bots}
          points={points}
          actions={actions}
          keeper={bot.name}
          updatedAt={lines.length ? Math.max(...lines.map((line) => line.at)) : null}
          pending={phase === "working" ? t("{name} is preparing a reply", { name: bot.name }) : undefined}
          footer={t("Everything said stays in your chat with {name}", { name: bot.name })}
          onCollapse={() => setPanelOpen(false)}
        />
      }
    />
  );
}
