// Conference call mode — one microphone, several room members (U17).
//
// Capture stays half-duplex for the same reason as one-to-one calls: the
// native recognizer has no acoustic echo cancellation. Bot replies are
// explicitly queued so a fast second member never cuts off the first.
//
// The screen is a full-window overlay: each member stands in a tile (its
// engine's full-body mascot), the host wears the crown chip, whoever is
// talking gets the ring and the waveform, the next reply in the queue is
// marked "下一位". Live captions and the minutes they produce sit on the right.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { callStartedAt, currentCall, deferCallCleanup, endCall, useOnCall } from "@/lib/call";
import { routeSpokenGroupMessage } from "@/lib/group-call";
import { callActions, callPoints, captionLines } from "@/lib/group-call-notes";
import { meetingChair, parseAgenda } from "@/lib/group-meeting";
import { effectiveDefaultResponder } from "@/lib/group-routing";
import { track } from "@/lib/analytics";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { formatTime, useStore, type Bot, type Group, type Message } from "@/state/store";
import { CallTargetButton } from "./CallView";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
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
  type TileStatus,
  type YouStatus,
} from "./group/CallChrome";
import { callOccurrence, estimateSpeechMs, useCallContext } from "./group/useCallContext";
import { t } from "@/lib/i18n";
import { spokenNo, spokenYes } from "@/lib/spoken-answer";

const CALL_ENDPOINT_MS = 850;

/** "09:15" — the calendar's own clock form. */
function clockText(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
/** With the speaker off a reply is read as a caption; pause briefly so turns stay legible. */
const CAPTION_ONLY_PAUSE_MS = 600;

type Phase = "listening" | "sending" | "working" | "speaking";

export function GroupCallButton({ group, members }: { group: Group; members: Bot[] }) {
  if (group.dm) return null;
  return (
    <CallTargetButton
      targetId={group.id}
      targetName={group.name}
      voices={members.map((member) => member.voice)}
      setupBotId={members.find((member) => !member.voice)?.id ?? members[0]?.id}
      requireExplicitVoices
      onStart={() => track("group_call_started", { memberCount: members.length })}
    />
  );
}

export function GroupCallOverlay({ group, members }: { group: Group; members: Bot[] }) {
  const active = useOnCall() === group.id;
  if (!active) return null;
  return <GroupCall group={group} members={members} />;
}

function questionIn(messages: Message[]): Message | undefined {
  return messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );
}

function GroupCall({ group, members }: { group: Group; members: Bot[] }) {
  const { state, dispatch } = useStore();
  const speech = useSpeech();
  const context = useCallContext();
  const now = useSecondClock();
  const [startedAt] = useState(() => callStartedAt() ?? Date.now());
  const initialPhase: Phase = group.busyBotId ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [speakingMemberId, setSpeakingMemberId] = useState<string | null>(null);
  // what the screen shows about the turn-taking
  const [live, setLive] = useState<LiveCaption | null>(null);
  const [upNext, setUpNext] = useState<string[]>([]);
  const [spokenMs, setSpokenMs] = useState<Record<string, number>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  // your controls
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [voiceMuted, setVoiceMuted] = useState<Set<string>>(() => new Set());
  const mutedRef = useRef(false);
  const speakerOnRef = useRef(true);
  const voiceMutedRef = useRef<Set<string>>(new Set());
  const hearingSince = useRef<number>(Date.now());
  const pushToTalk = usePushToTalk(group.id, phase === "listening", () => {
    setNote(t("Push to talk couldn't start. Check Microphone and Speech Recognition access."));
  });

  const messages = group.messages;
  const approval = pendingApprovals(messages)[0];
  const question = questionIn(messages);
  const membersRef = useRef(members);
  const busyRef = useRef(Boolean(group.busyBotId));
  const defaultResponderRef = useRef(group.defaultResponder);
  membersRef.current = members;
  busyRef.current = Boolean(group.busyBotId);
  defaultResponderRef.current = group.defaultResponder;

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const message of messages) spokenIds.current.add(message.id);
  }

  const askedApproval = useRef<{
    requestId: string;
    member?: Bot;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; member?: Bot } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);
  const queueGeneration = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queuedJobs = useRef(new Set<number>());
  /** who each queued job belongs to, in order — the head is "下一位" */
  const queuedSpeakers = useRef<Array<{ jobId: number; memberId: string }>>([]);
  const nextJobId = useRef(0);
  const listenWhenDrained = useRef(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowBargeIn = useRef(false);

  const syncUpNext = useCallback(() => {
    if (alive.current) setUpNext(queuedSpeakers.current.map((entry) => entry.memberId).filter(Boolean));
  }, []);

  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.ogb?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== group.id) return;
    move("listening");
    setSpeakingMemberId(null);
    setLive(null);
    setHeard("");
    setNote(null);
    hearingSince.current = Date.now();
    // muted: it is your turn, but the microphone stays closed until you unmute
    if (mutedRef.current) return;
    void window.ogb?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === group.id) {
        setNote(t("The microphone couldn't start. Check Microphone and Speech Recognition access."));
      }
    });
  }, [group.id, move]);

  const scheduleListen = useCallback(
    (force = false, delay = 140) => {
      if (listenTimer.current) clearTimeout(listenTimer.current);
      listenTimer.current = setTimeout(() => {
        listenTimer.current = null;
        if (!alive.current || currentCall() !== group.id || queuedJobs.current.size) return;
        if (force || allowBargeIn.current || !busyRef.current) listen();
      }, delay);
    },
    [group.id, listen],
  );

  const say = useCallback(
    async (text: string, member?: Bot, lineId?: string) => {
      if (!alive.current || currentCall() !== group.id) return false;
      const mine = ++sayGeneration.current;
      move("speaking");
      setSpeakingMemberId(member?.id ?? null);
      const begin = Date.now();
      setLive({
        lineId,
        speakerId: member?.id,
        name: member?.name ?? t("Channel member"),
        text: lineId ? undefined : text,
        startedAt: begin,
      });
      hush();
      const audible = speakerOnRef.current && !(member && voiceMutedRef.current.has(member.id));
      if (audible) await speaker.speak(text, { botId: member?.id, voiceId: member?.voice });
      else await new Promise((resolve) => setTimeout(resolve, CAPTION_ONLY_PAUSE_MS));
      if (member && alive.current) {
        const spent = Date.now() - begin;
        setSpokenMs((current) => ({ ...current, [member.id]: (current[member.id] ?? 0) + spent }));
      }
      return alive.current && currentCall() === group.id && sayGeneration.current === mine;
    },
    [group.id, hush, move],
  );

  const enqueueSpeech = useCallback(
    (text: string, member?: Bot, answerAfter = false, lineId?: string) => {
      const generation = queueGeneration.current;
      const jobId = ++nextJobId.current;
      queuedJobs.current.add(jobId);
      queuedSpeakers.current.push({ jobId, memberId: member?.id ?? "" });
      syncUpNext();
      if (answerAfter) listenWhenDrained.current = true;
      const dropFromQueue = () => {
        queuedSpeakers.current = queuedSpeakers.current.filter((entry) => entry.jobId !== jobId);
        syncUpNext();
      };
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (generation !== queueGeneration.current) return;
          dropFromQueue();
          await say(text, member, lineId);
        })
        .finally(() => {
          if (generation !== queueGeneration.current) return;
          dropFromQueue();
          queuedJobs.current.delete(jobId);
          if (queuedJobs.current.size) return;
          setSpeakingMemberId(null);
          if (alive.current) setLive(null);
          const force = listenWhenDrained.current;
          listenWhenDrained.current = false;
          scheduleListen(force);
        });
    },
    [say, scheduleListen, syncUpNext],
  );

  const interruptSpeech = useCallback(() => {
    const wasBusy = busyRef.current;
    queueGeneration.current += 1;
    queue.current = Promise.resolve();
    queuedJobs.current.clear();
    queuedSpeakers.current = [];
    syncUpNext();
    listenWhenDrained.current = false;
    sayGeneration.current += 1;
    speaker.stop();
    setSpeakingMemberId(null);
    allowBargeIn.current = true;
    if (wasBusy) dispatch({ type: "interruptGroup", groupId: group.id });
    listen();
  }, [dispatch, group.id, listen, syncUpNext]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueGeneration.current += 1;
      sayGeneration.current += 1;
      if (listenTimer.current) clearTimeout(listenTimer.current);
      deferCallCleanup(group.id, () => alive.current);
    };
  }, [group.id]);

  useEffect(() => {
    const bridge = window.ogb;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== group.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote(t("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access."));
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      const said = line.text.trim();
      if (!said) return listen();

      const openApproval = askedApproval.current;
      if (openApproval) {
        if (openApproval.submitted) {
          move("working");
          hush();
          return;
        }
        if (spokenYes(said) || spokenNo(said)) {
          const allow = spokenYes(said);
          if (allow && openApproval.skill) {
            setHeard("");
            enqueueSpeech(
              t("Open the channel chat to review the complete skill before enabling it. You can say no now to deny it."),
              openApproval.member,
              true,
            );
            return;
          }
          // Hold this approval in-flight until its server patch arrives so a
          // slow response cannot reopen the microphone and submit it twice.
          openApproval.submitted = true;
          allowBargeIn.current = false;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: group.threadId,
            requestId: openApproval.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a group call.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== group.id ||
                pending?.requestId !== openApproval.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = openApproval.routine ? t("routine decision") : t("approval");
              enqueueSpeech(
                detail
                  ? t("I couldn't save that {decision}: {detail} Please try again.", { decision, detail })
                  : t("I couldn't save that {decision}. Please try again.", { decision }),
                openApproval.member,
                true,
              );
            },
          });
          return;
        }
        enqueueSpeech(t("Sorry — is that a yes or a no?"), openApproval.member, true);
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        allowBargeIn.current = false;
        dispatch({
          type: "decideRequest",
          threadId: group.threadId,
          requestId: openQuestion.requestId,
          behavior: "answer",
          message: said,
        });
        move("working");
        return;
      }

      const routed = routeSpokenGroupMessage(said, membersRef.current);
      if (defaultResponderRef.current.kind === "mentions" && !routed.addressed) {
        listen();
        const names = membersRef.current.map((member) => member.name).join(", ");
        setNote(names
          ? t("Say a member's name — {names} — or say everyone.", { names })
          : t("Say a member's name — or say everyone."));
        return;
      }

      allowBargeIn.current = false;
      move(busyRef.current ? "working" : "sending");
      dispatch({ type: "sendGroup", groupId: group.id, text: routed.text, threadId: group.threadId });
      scheduleListen(false, 600);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== group.id) return;
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
      if (phaseRef.current === "listening") listen();
    });
    if (group.busyBotId && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.ogb?.speechStop();
    };
    // Live busy/card changes are handled below without restarting native capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, enqueueSpeech, group.id, group.threadId, hush, listen, move, scheduleListen]);

  useEffect(() => {
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }

    if (resumeAfterRoutine && !approval && !question && !group.busyBotId) {
      scheduleListen(true);
      return;
    }
    // Keep the voice queue and microphone closed until this exact decision
    // is settled or its request reports an error.
    if (askedApproval.current?.submitted) return;

    if (approval && askedApproval.current?.requestId !== approval.requestId) {
      const member = members.find((candidate) => candidate.id === approval.message.from?.botId);
      askedApproval.current = {
        requestId: approval.requestId,
        member,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const name = member?.name ?? approval.message.from?.name ?? t("A channel member");
      enqueueSpeech(isSkillApproval(approval)
        ? t("{name} wants to enable a learned skill. Open the channel chat to review the complete skill before enabling it. You can say no to deny it.", { name })
        : spokenApprovalPrompt(approval, name), member, true);
    }

    if (question?.card?.requestId && askedQuestion.current?.requestId !== question.card.requestId) {
      const member = members.find((candidate) => candidate.id === question.from?.botId);
      askedQuestion.current = { requestId: question.card.requestId, member };
      spokenIds.current.add(question.id);
      const name = member?.name ?? question.from?.name ?? t("A channel member");
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? " " + t("The options are {options}.", { options: question.card.options.join(", ") })
        : "";
      enqueueSpeech(
        t("{name} asks: {detail}", { name, detail: detail + (/[.!?]$/.test(detail) ? "" : ".") }) + choices,
        member,
        true,
      );
    }

    const fresh = messages.filter((message) => !spokenIds.current.has(message.id));
    if (!fresh.length) return;
    for (const message of fresh) spokenIds.current.add(message.id);

    const replies = fresh.filter(
      (message) => message.role === "bot" && message.kind === "text" && message.text?.trim(),
    );
    for (const reply of replies) {
      const member = members.find((candidate) => candidate.id === reply.from?.botId);
      enqueueSpeech(reply.text!, member, false, reply.id);
    }
    if (!replies.length) {
      const chip = [...fresh].reverse().find((message) => message.kind === "activity" && message.tool?.spoken);
      if (chip?.tool?.spoken) {
        const member = members.find((candidate) => candidate.id === chip.from?.botId);
        enqueueSpeech(chip.tool.spoken, member);
      }
    }
  }, [approval, enqueueSpeech, group.busyBotId, members, messages, question, scheduleListen]);

  useEffect(() => {
    const busy = Boolean(group.busyBotId);
    busyRef.current = busy;
    if (busy) {
      if (
        (phaseRef.current === "listening" || phaseRef.current === "sending") &&
        !askedApproval.current &&
        !askedQuestion.current &&
        !allowBargeIn.current
      ) {
        move("working");
        hush();
      }
      return;
    }
    allowBargeIn.current = false;
    if (
      (phaseRef.current === "working" || phaseRef.current === "sending") &&
      !askedApproval.current &&
      !askedQuestion.current
    ) {
      scheduleListen();
    }
  }, [group.busyBotId, hush, move, scheduleListen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        endCall(group.id);
      } else if (event.code === "Space" && speaker.isSpeaking()) {
        event.preventDefault();
        interruptSpeech();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group.id, interruptSpeech]);

  // ── your controls ─────────────────────────────────────────────────────
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
  const toggleSpeaker = () => {
    const next = !speakerOnRef.current;
    speakerOnRef.current = next;
    setSpeakerOn(next);
    if (!next && speaker.isSpeaking()) speaker.stop();
  };
  const toggleVoice = (member: Bot) => {
    const next = new Set(voiceMutedRef.current);
    if (next.has(member.id)) next.delete(member.id);
    else {
      next.add(member.id);
      if (speakingMemberId === member.id && speaker.isSpeaking()) speaker.stop();
    }
    voiceMutedRef.current = next;
    setVoiceMuted(next);
  };

  // ── what the screen shows ─────────────────────────────────────────────
  const lines = useMemo(() => captionLines(messages, startedAt), [messages, startedAt]);
  const actions = useMemo(() => callActions(lines), [lines]);
  const agenda = useMemo(() => parseAgenda(group.bulletin), [group.bulletin]);
  const points = useMemo(
    () => callPoints(lines, agenda ? t("Goal: {goal}", { goal: agenda.topic ?? agenda.raw }) : undefined),
    [lines, agenda],
  );
  const responder = effectiveDefaultResponder(group, members);
  const host = meetingChair(members, agenda, responder.kind === "member" ? responder.botId : undefined, context.chiefId);
  const calendarCall = context.calls.find((call) => call.roomId === group.id);
  const occurrence = calendarCall ? callOccurrence(calendarCall, startedAt) : null;
  const title = calendarCall
    ? [
        calendarCall.name,
        // a daily call is titled by the time it was set for ("09:00")
        calendarCall.schedule.type === "daily" ? calendarCall.schedule.time : occurrence ? formatTime(occurrence) : null,
        host ? t("{name} hosting", { name: host.name }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : group.name;
  const linkLabel = calendarCall && calendarCall.name !== group.name ? group.name : agenda?.raw;

  const spokenFor = (member: Bot) => {
    const estimated = lines
      .filter((line) => line.speaker.kind === "bot" && line.speaker.botId === member.id)
      .reduce((sum, line) => sum + estimateSpeechMs(line.text), 0);
    return Math.max(spokenMs[member.id] ?? 0, estimated);
  };
  const speakingMember = phase === "speaking" ? members.find((member) => member.id === speakingMemberId) : undefined;
  const nextId = upNext.find((id) => id && id !== speakingMember?.id);
  const statusOf = (member: Bot): { status: TileStatus; ms?: number } => {
    if (speakingMember?.id === member.id) return { status: "speaking", ms: now - (live?.startedAt ?? now) };
    if (group.busyBotId === member.id) return { status: "working" };
    if (nextId === member.id) return { status: "next" };
    const spoke = spokenFor(member);
    return spoke > 0 ? { status: "spoke", ms: spoke } : { status: "listening" };
  };
  const youStatus: YouStatus = muted ? "muted" : phase === "listening" ? (heard || pushToTalk ? "talking" : "open") : "listening";
  const notSpoken = members.filter((member) => member.id !== host?.id && spokenFor(member) === 0 && speakingMember?.id !== member.id).length;
  const expectedEnd = occurrence && calendarCall ? occurrence + calendarCall.durationMinutes * 60_000 : null;
  const workingMember = members.find((member) => member.id === group.busyBotId);

  const leftHint = muted
    ? { title: t("You're muted"), detail: t("Click the mic to talk · Space interrupts") }
    : phase === "listening"
      ? pushToTalk
        ? { title: t("Listening to you"), detail: t("Release Control + Option to send…") }
        : { title: t("Your turn"), detail: t("Just talk, or hold Control + Option") }
      : phase === "speaking"
        ? { title: t("You're listening"), detail: t("Space interrupts · Esc hangs up") }
        : { title: workingMember ? t("{name} is working", { name: workingMember.name }) : t("Bringing the channel in"), detail: t("You’ll hear each response in turn.") };
  const rightHint =
    notSpoken > 0 || expectedEnd
      ? {
          title: notSpoken > 0 ? t("{count} still to speak", { count: notSpoken }) : t("Everyone has spoken"),
          // same "09:15" form as the calendar's "09:00" in the title
          detail: expectedEnd ? t("Expected to end {time}", { time: clockText(expectedEnd) }) : undefined,
        }
      : undefined;

  const liveCaption: LiveCaption | null =
    phase === "speaking" && live
      ? { ...live, caption: speech.caption }
      : phase === "listening" && heard
        ? { you: true, name: t("You"), text: heard, startedAt: hearingSince.current }
        : null;
  const floor = speakingMember ?? workingMember;
  const pending = floor
    ? speakingMember
      ? t("{name} is speaking · capturing action items", { name: floor.name })
      : t("{name} is preparing a reply", { name: floor.name })
    : undefined;

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

  const scale = callMascotScale(members.length + 1);
  return (
    <CallShell
      label={t("Call with {name}", { name: group.name })}
      title={title}
      startedAt={startedAt}
      now={now}
      linkLabel={linkLabel}
      people={members}
      count={members.length + 1}
      panelOpen={panelOpen}
      onTogglePanel={() => setPanelOpen((open) => !open)}
      stage={
        <CallStage
          count={members.length + 1}
          tiles={
            <>
              {members.map((member) => {
                const { status, ms } = statusOf(member);
                return (
                  <CallBotTile
                    key={member.id}
                    scale={scale}
                    onToggleVoice={() => toggleVoice(member)}
                    tile={{
                      bot: member,
                      status,
                      ms,
                      host: host?.id === member.id,
                      color: context.colors.get(member.id),
                      engine: context.engineOf(member),
                      voiceMuted: voiceMuted.has(member.id),
                    }}
                  />
                );
              })}
              <CallYouTile status={youStatus} onToggleMute={toggleMute} scale={scale} name={state.config?.profile?.name?.trim() || t("Owner")} />
            </>
          }
          dock={
            <CallDock
              muted={muted}
              onToggleMute={toggleMute}
              speakerOn={speakerOn}
              onToggleSpeaker={toggleSpeaker}
              canRaiseHand={phase === "speaking" || phase === "working" || upNext.length > 0}
              onRaiseHand={interruptSpeech}
              onHangUp={() => endCall(group.id)}
            />
          }
          leftHint={leftHint}
          rightHint={rightHint}
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
          keeper={host?.name ?? t("The chief")}
          updatedAt={lines.length ? Math.max(...lines.map((line) => line.at)) : null}
          pending={pending}
          footer={t("Everything said stays in the “{name}” group chat", { name: group.name })}
          onCollapse={() => setPanelOpen(false)}
        />
      }
    />
  );
}
