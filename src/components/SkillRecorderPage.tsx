// 教授技能 (U15): one live workspace. You do the task once while a bot
// watches: the left shows the recorded screen with a floating 暂停 / 结束
// dock and the 存成技能 card filling itself in; the right shows what the bot
// understood — steps with thumbnails, what will change next time, and the
// notes it took. Recording runs through the macOS bridge (screen + action
// helper) and AssemblyAI narration, exactly as before.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Circle,
  Clipboard,
  Cloud,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Globe,
  Keyboard,
  Lock,
  Mic,
  MonitorUp,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  ScrollText,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";

import { Mascot } from "@/components/mascot/Mascot";
import { Button } from "@/components/ui";
import {
  mergeAssemblyAITurn,
  startAssemblyAITranscription,
  type AssemblyAITranscript,
  type AssemblyAITranscriptionSession,
} from "@/lib/assemblyai-transcription";
import { cn } from "@/lib/cn";
import { mascotForBot, type MascotPose } from "@/lib/engine-mascots";
import { t, tRich } from "@/lib/i18n";
import { chiefBot } from "@/lib/org";
import {
  appendNativeEvent,
  eventLabel,
  formatRecordingTime,
  type RecordedSkillEvent,
} from "@/lib/skill-recorder";
import {
  originHost,
  pageTitle,
  skillApps,
  skillParams,
  slashCommand,
  suggestSkillName,
  transcriptWithNotes,
  type SkillNote,
} from "@/lib/skill-teach";
import { requestScreenPreview, stopScreenPreview } from "@/lib/screen-preview";
import { TRANSCRIPTION_STATUS_EVENT } from "@/lib/transcription-status";
import { useOrg } from "@/state/org-api";
import { useStore, type Bot } from "@/state/store";

type Phase = "idle" | "starting" | "recording" | "review" | "saving" | "saved";

const iconFor = (type: RecordedSkillEvent["type"]) => {
  if (type === "click") return MousePointer2;
  if (type === "scroll") return ScrollText;
  if (type === "typing" || type === "shortcut") return Keyboard;
  if (type === "clipboard") return Clipboard;
  if (type === "download") return Download;
  return MonitorUp;
};

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(t("Couldn't read the microphone recording")));
    reader.readAsDataURL(blob);
  });
}

const CARD = "rounded-2xl bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent),0_1px_2px_rgb(16_24_40/0.05)]";

function StepRow({ event, index, current, removable, onRemove }: { event: RecordedSkillEvent; index: number; current: boolean; removable: boolean; onRemove: () => void }) {
  const Icon = iconFor(event.type);
  const context = [
    event.name && event.type !== "click" ? event.name : undefined,
    pageTitle(event.windowTitle) ?? event.app,
    event.type === "download" ? originHost(event.whereFroms?.[0]) : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <div className={cn("group relative flex h-[58px] items-center gap-[11px] rounded-xl pl-2 pr-2.5", current ? "bg-select/[0.07] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-select)_30%,transparent)]" : "hover:bg-raised-hover")}>
      <span className="grid h-10 w-14 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-inset shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
        {event.screenshot ? <img src={event.screenshot} alt={t("Recorded screen at step {step}", { step: index + 1 })} className="h-full w-full object-cover object-top" /> : <Icon size={15} className="text-ink-secondary" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <b className={cn("flex items-center gap-1.5 truncate text-[13.5px] font-semibold", current && "text-accent-text")}>
          <em className="text-[11.5px] font-bold not-italic tabular-nums text-ink-secondary/70">{index + 1}</em>
          <span className="truncate">{eventLabel(event)}</span>
        </b>
        <span className={cn("truncate text-[11.5px]", current ? "text-accent-text" : "text-ink-secondary")}>
          {[formatRecordingTime(event.atMs), context].filter(Boolean).join(" · ")}
        </span>
      </span>
      {removable ? (
        <button type="button" aria-label={t("Remove step {step}", { step: index + 1 })} onClick={onRemove} className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-secondary opacity-60 hover:bg-danger/10 hover:text-danger group-hover:opacity-100">
          <X size={14} />
        </button>
      ) : current ? (
        <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-select/25 border-t-select" aria-hidden />
      ) : (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success text-white"><Check size={10} strokeWidth={3} /></span>
      )}
    </div>
  );
}

export function SkillRecorderPage() {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const bridge = window.ogb?.skillRecorder;
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const [events, setEvents] = useState<RecordedSkillEvent[]>([]);
  const eventsRef = useRef<RecordedSkillEvent[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const transcriptRef = useRef("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [transcriptionConfigured, setTranscriptionConfigured] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id: string; path: string; events: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const [notes, setNotes] = useState<SkillNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [learnerId, setLearnerId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const transcriptionSessionRef = useRef<AssemblyAITranscriptionSession | null>(null);
  const cloudTranscriptRef = useRef<AssemblyAITranscript>({ turns: new Map(), finalText: "", partialText: "" });
  const audioChunksRef = useRef<Blob[]>([]);
  const audioDataRef = useRef("");
  const startedRef = useRef(0);
  const stoppingRef = useRef(false);
  // 暂停: the native helper has no pause, so while paused its events are
  // dropped here, the microphone track is muted and the clock stands still
  const pausedRef = useRef(false);
  const pausedAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const saidTurnsRef = useRef(new Set<number>());

  // the bot that "learns": the one you were talking to, else the chief
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const learner: Bot | undefined =
    visibleBots.find((bot) => bot.id === learnerId) ??
    visibleBots.find((bot) => bot.id === state.selectedId) ??
    chiefBot(visibleBots, org) ??
    visibleBots[0];

  const updatePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const elapsedNow = () => (pausedRef.current ? pausedAtRef.current : Date.now()) - startedRef.current - pausedTotalRef.current;

  const takeScreenshot = useCallback((): string | undefined => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return undefined;
    const width = Math.min(1120, video.videoWidth);
    const height = Math.round(video.videoHeight * (width / video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/webp", 0.68);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    const offEvent = bridge.onEvent((native) => {
      if (phaseRef.current !== "recording" || pausedRef.current) return;
      const result = appendNativeEvent(eventsRef.current, native);
      if (result.addedId) {
        // A frame is worth keeping for visual/context-changing moments (clicks,
        // app switches, scrolls, downloads) but not for typing bursts or
        // clipboard ops — those add no visual evidence and a typing frame can
        // catch field contents. Secure-field typing never reaches here (the
        // native helper suppresses it), but skip typing frames regardless.
        const noFrame = native.type === "typing" || native.type === "clipboard";
        const screenshot = noFrame ? undefined : takeScreenshot();
        if (screenshot) {
          const index = result.events.findIndex((event) => event.id === result.addedId);
          if (index >= 0) result.events[index] = { ...result.events[index]!, screenshot };
        }
      }
      eventsRef.current = result.events;
      setEvents(result.events);
    });
    const offEnd = bridge.onEnd((info) => {
      if (phaseRef.current === "recording" && info.code !== 0) {
        setError(info.reason || t("The native recorder stopped unexpectedly."));
      }
    });
    return () => { offEvent(); offEnd(); };
  }, [bridge, takeScreenshot]);

  useEffect(() => {
    let alive = true;
    const onStatus = (event: CustomEvent<{ configured: boolean }>) => {
      setTranscriptionConfigured(event.detail.configured);
    };
    window.addEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    window.ogb?.transcription?.status()
      .then((status) => alive && setTranscriptionConfigured(status.configured))
      .catch(() => alive && setTranscriptionConfigured(false));
    return () => {
      alive = false;
      window.removeEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const tick = () => setElapsed(elapsedNow());
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [phase]);

  // the name fills itself in from where the demonstration happened, until you type one
  useEffect(() => {
    if (nameTouched) return;
    const suggestion = suggestSkillName(events);
    if (suggestion) setName(suggestion);
  }, [events, nameTouched]);

  const releaseStreams = useCallback(() => {
    stopScreenPreview(screenRef.current);
    screenRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
  }, []);

  useEffect(() => () => {
    void bridge?.stop();
    void transcriptionSessionRef.current?.stop();
    releaseStreams();
  }, [bridge, releaseStreams]);

  const resetPause = () => {
    pausedRef.current = false;
    pausedAtRef.current = 0;
    pausedTotalRef.current = 0;
    setPaused(false);
  };

  const start = async () => {
    setError("");
    if (!bridge || !window.ogb?.beginScreenPreviewIntent || !navigator.mediaDevices?.getDisplayMedia) {
      setError(t("Skill recording requires the Ein desktop app on macOS."));
      return;
    }
    if (!transcriptionConfigured || !window.ogb.transcription) {
      setError(t("Add your AssemblyAI key under Cloud transcription before recording."));
      return;
    }
    const nextPermission = await bridge.permissions();
    if (!nextPermission.supported) {
      setError(t("Skill recording is currently available in the macOS desktop app."));
      return;
    }
    updatePhase("starting");
    try {
      const selected = await requestScreenPreview({
        beginIntent: () => window.ogb!.beginScreenPreviewIntent(),
        getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
      });
      if (!selected.ok) throw new Error(selected.message);
      screenRef.current = selected.stream;
      const video = videoRef.current;
      if (!video) throw new Error(t("The recorder preview is unavailable"));
      video.srcObject = selected.stream;
      await video.play();

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micRef.current = mic;
      audioChunksRef.current = [];
      const preferredAudio = "audio/webm;codecs=opus";
      const recorder = new MediaRecorder(
        mic,
        MediaRecorder.isTypeSupported(preferredAudio) ? { mimeType: preferredAudio } : undefined,
      );
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.start(1_000);
      mediaRecorderRef.current = recorder;

      await bridge.start();
      eventsRef.current = [];
      setEvents([]);
      transcriptRef.current = "";
      setTranscript("");
      setPartialTranscript("");
      setNotes([]);
      saidTurnsRef.current = new Set();
      resetPause();
      cloudTranscriptRef.current = { turns: new Map(), finalText: "", partialText: "" };
      transcriptionSessionRef.current = await startAssemblyAITranscription({
        stream: mic,
        getToken: () => window.ogb!.transcription!.streamingToken(),
        onTurn: (turn) => {
          const next = mergeAssemblyAITurn(cloudTranscriptRef.current, turn);
          cloudTranscriptRef.current = next;
          transcriptRef.current = next.finalText;
          setTranscript(next.finalText);
          setPartialTranscript(next.partialText);
          // a finished sentence becomes one of the bot's notes, stamped with the clock
          if (turn.final && turn.text.trim() && !saidTurnsRef.current.has(turn.order)) {
            saidTurnsRef.current.add(turn.order);
            const atMs = elapsedNow();
            setNotes((current) => [...current, { id: `said-${turn.order}`, source: "said", text: turn.text.trim(), atMs }]);
          }
        },
        onError: (message) => setError(message),
      });
      audioDataRef.current = "";
      startedRef.current = Date.now();
      setElapsed(0);
      updatePhase("recording");
    } catch (caught) {
      await bridge.stop().catch(() => {});
      await transcriptionSessionRef.current?.stop().catch(() => {});
      transcriptionSessionRef.current = null;
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      releaseStreams();
      updatePhase("idle");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const togglePause = () => {
    if (phaseRef.current !== "recording") return;
    const pausing = !pausedRef.current;
    if (pausing) {
      pausedAtRef.current = Date.now();
      pausedRef.current = true;
    } else {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedRef.current = false;
    }
    micRef.current?.getAudioTracks().forEach((track) => { track.enabled = !pausing; });
    const recorder = mediaRecorderRef.current;
    if (pausing && recorder?.state === "recording") recorder.pause();
    if (!pausing && recorder?.state === "paused") recorder.resume();
    setPaused(pausing);
    setElapsed(elapsedNow());
  };

  const stop = async () => {
    if (stoppingRef.current || phaseRef.current !== "recording") return;
    stoppingRef.current = true;
    setElapsed(elapsedNow());
    try {
      await bridge?.stop();
      await transcriptionSessionRef.current?.stop().catch(() => {
        setError(t("Cloud transcription did not close cleanly; the original audio is still available."));
      });
      transcriptionSessionRef.current = null;
      const capturedTranscript = [
        cloudTranscriptRef.current.finalText,
        cloudTranscriptRef.current.partialText,
      ].filter(Boolean).join(" ");
      transcriptRef.current = capturedTranscript;
      setTranscript(capturedTranscript);
      setPartialTranscript("");
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
        recorder.stop();
        await stopped;
      }
      mediaRecorderRef.current = null;
      if (audioChunksRef.current.length) {
        const mime = recorder?.mimeType.split(";")[0] || "audio/webm";
        audioDataRef.current = await blobDataUrl(new Blob(audioChunksRef.current, { type: mime }));
      }
      releaseStreams();
      updatePhase("review");
    } catch (caught) {
      await transcriptionSessionRef.current?.stop().catch(() => {});
      transcriptionSessionRef.current = null;
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      releaseStreams();
      updatePhase("review");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      stoppingRef.current = false;
      pausedRef.current = false;
      setPaused(false);
    }
  };

  const discard = async () => {
    await bridge?.stop().catch(() => {});
    await transcriptionSessionRef.current?.stop().catch(() => {});
    transcriptionSessionRef.current = null;
    if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    releaseStreams();
    eventsRef.current = [];
    setEvents([]);
    setTranscript("");
    setPartialTranscript("");
    setName("");
    setNameTouched(false);
    setDescription("");
    setNotes([]);
    setNoteDraft("");
    setSaved(null);
    setError("");
    resetPause();
    updatePhase("idle");
  };

  const removeEvent = (id: string) => {
    const next = eventsRef.current.filter((event) => event.id !== id);
    eventsRef.current = next;
    setEvents(next);
  };

  const save = async () => {
    if (!bridge || !name.trim()) return;
    updatePhase("saving");
    setError("");
    try {
      const result = await bridge.save({
        name,
        description,
        durationMs: elapsed,
        transcript: transcriptWithNotes(transcriptRef.current, notes, formatRecordingTime),
        transcription: { provider: "assemblyai", model: "u3-rt-pro" },
        audio: audioDataRef.current || undefined,
        events: eventsRef.current,
      });
      setSaved(result);
      updatePhase("saved");
    } catch (caught) {
      updatePhase("review");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  // 存成技能 while still recording ends the recording first
  const finish = async () => {
    if (phaseRef.current === "recording") await stop();
    if (phaseRef.current === "review") await save();
  };

  const addNote = () => {
    const text = noteDraft.trim();
    if (!text) return;
    setNotes((current) => [...current, { id: `typed-${Date.now()}`, source: "typed", text, atMs: phaseRef.current === "recording" ? elapsedNow() : undefined }]);
    setNoteDraft("");
  };

  const recording = phase === "recording";
  const live = recording || phase === "starting";
  const reviewing = phase === "review" || phase === "saving";
  const apps = useMemo(() => skillApps(events), [events]);
  const params = useMemo(() => skillParams(events), [events]);
  const lastShot = [...events].reverse().find((event) => event.screenshot)?.screenshot;
  const latest = events.at(-1);
  const learnerName = learner?.name ?? t("The bot");
  const pose: MascotPose = phase === "saved" ? "cheer" : recording ? (paused ? "idle" : "think") : reviewing ? "point" : "wave";
  const say = phase === "saved"
    ? t("Got it. Next time just ask.")
    : recording
      ? paused
        ? t("Paused — I'll keep watching when you continue.")
        : latest
          ? t("Noted: {step}.", { step: eventLabel(latest) })
          : t("Go ahead, I'm watching.")
      : reviewing
        ? t("Done. Check the steps, then save.")
        : t("Do it once while I watch; I'll take notes.");
  const allNotes: SkillNote[] = [...notes, { id: "rule-private", source: "rule", text: t("Keystrokes and clipboard contents are never stored") }];
  const usage = slashCommand(name);
  const example = description.trim() || transcript.split(/[。.!?！？]/)[0]?.trim() || "";

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden bg-stage text-ink">
      {/* ── left: the recording ── */}
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 pb-5" aria-label={t("Recording")}>
        <header className="flex min-h-[68px] shrink-0 flex-wrap items-center gap-2.5 py-2">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-select/10 text-accent-text"><Wand2 size={18} /></span>
          <div className="min-w-0 flex-1 leading-tight">
            <h1 className="text-[22px] font-bold tracking-[-0.2px]">{t("Teach a skill")}</h1>
            <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{t("Do it once for {name}; it learns, saves it as a skill, and next time one sentence is enough", { name: learnerName })}</p>
          </div>
          <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-control/60 px-2.5 text-[12px] text-ink-secondary"><Lock size={12} />{t("Only what you choose to share · no passwords")}</span>
          {(recording || reviewing || phase === "saved") && (
            <span className={cn("inline-flex h-[30px] shrink-0 items-center gap-[7px] rounded-full pl-[11px] pr-[13px] text-[13px] font-bold tabular-nums", recording ? "bg-danger text-white shadow-[0_6px_16px_-8px_color-mix(in_srgb,var(--color-danger)_90%,transparent)]" : "bg-control/70 text-ink")}>
              {recording ? <i className={cn("size-2 rounded-full bg-white shadow-[0_0_0_3px_rgb(255_255_255/0.3)]", !paused && "animate-pulse")} /> : <Check size={13} />}
              {recording
                ? paused
                  ? t("Paused {time}", { time: formatRecordingTime(elapsed) })
                  : t("Recording {time}", { time: formatRecordingTime(elapsed) })
                : t("Recorded {time}", { time: formatRecordingTime(elapsed) })}
            </span>
          )}
        </header>

        {/* the live preview, framed; a red ring while recording */}
        <div
          className={cn(
            "relative flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-2xl bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]",
            recording && !paused && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent),0_0_0_4px_color-mix(in_srgb,var(--color-danger)_13%,transparent)]",
          )}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            className={cn("absolute inset-0 h-full w-full bg-inset object-contain", live ? "opacity-100" : "pointer-events-none opacity-0")}
          />
          {live && (
            <>
              {latest && (
                <span className="absolute left-4 top-4 inline-flex h-[22px] max-w-[70%] items-center rounded-[7px] bg-select px-2.5 text-[11.5px] font-bold text-white shadow-[0_6px_14px_-8px_color-mix(in_srgb,var(--color-select)_90%,transparent)]">
                  <span className="truncate">{t("{name} is watching: {step}", { name: learnerName, step: eventLabel(latest) })}</span>
                </span>
              )}
              {phase === "starting" && (
                <div className="absolute inset-0 grid place-items-center text-[13px] text-ink-secondary">{t("Getting ready…")}</div>
              )}
              {/* the floating dock */}
              {recording && (
                <div className="absolute bottom-5 left-1/2 flex h-11 -translate-x-1/2 items-center gap-1 rounded-full bg-[#14161C] pl-2 pr-1.5 text-white shadow-[0_18px_36px_-14px_rgb(16_24_40/0.6)]">
                  <span className="grid grid-cols-2 gap-[3px] px-1.5" aria-hidden>{Array.from({ length: 6 }, (_, index) => <i key={index} className="size-[3px] rounded-full bg-white/35" />)}</span>
                  <button type="button" onClick={togglePause} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-[13px] text-[13px] font-semibold hover:bg-white/15">
                    {paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
                    {paused ? t("Continue") : t("Pause")}
                  </button>
                  <span className="mx-0.5 h-[18px] w-px bg-white/15" />
                  <button type="button" onClick={() => void stop()} className="inline-flex h-8 items-center gap-1.5 rounded-full px-[13px] text-[13px] font-semibold hover:bg-white/10">
                    <span className="size-[11px] rounded-[3px] bg-danger" />
                    {t("Finish")}
                  </button>
                </div>
              )}
            </>
          )}

          {!live && phase !== "saved" && (reviewing ? (
            lastShot ? (
              <div className="relative flex flex-1 items-center justify-center bg-inset p-4">
                <img src={lastShot} alt={t("The last recorded screen")} className="max-h-full max-w-full rounded-[10px] object-contain shadow-[0_0_0_1px_rgb(16_24_40/0.08)]" />
                <span className="absolute left-4 top-4 inline-flex h-[22px] items-center gap-1.5 rounded-[7px] bg-[rgb(20_22_28/0.78)] px-2 text-[11px] font-semibold text-white"><Eye size={12} />{t("Last screen recorded")}</span>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-success/12 text-success"><Check size={22} /></span>
                <div className="text-[16px] font-semibold">{t("Recording complete")}</div>
                <div className="max-w-[46ch] text-[13px] text-ink-secondary">{events.length ? t("Remove anything private or irrelevant, then name the skill.") : t("No action steps remain. The narration can still become the skill.")}</div>
              </div>
            )
          ) : (
            /* idle: how teaching works, and the button */
            <div className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-5 p-8">
              <div>
                <h2 className="text-[24px] font-bold tracking-[-0.02em]">{t("Record yourself doing the task")}</h2>
                <p className="mt-2 text-[14px] leading-6 text-ink-secondary">
                  {t("Speak naturally while you work. Ein lines up your clicks, app changes, screenshots, and narration, then turns the reviewed demonstration into a reusable local skill.")}
                </p>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-3">
                {[
                  { Icon: MousePointer2, label: t("Actions"), copy: t("Clicks, scrolling, app changes") },
                  { Icon: MonitorUp, label: t("Visuals"), copy: t("A frame at each useful moment") },
                  { Icon: Mic, label: t("Narration"), copy: t("Live transcript plus original audio") },
                ].map(({ Icon, label, copy }) => (
                  <div key={label} className="rounded-xl bg-inset p-3.5">
                    <Icon size={17} className="text-ink-secondary" />
                    <div className="mt-2.5 text-[13px] font-semibold">{label}</div>
                    <div className="mt-0.5 text-[11.5px] leading-4 text-ink-secondary">{copy}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-2.5 rounded-xl bg-inset px-3.5 py-3">
                <EyeOff size={16} className="mt-0.5 shrink-0 text-success" />
                <p className="text-[12px] leading-5 text-ink-secondary">
                  {t("Raw keystrokes and clipboard contents are never stored. Screen frames can contain visible text and stay on this computer; microphone audio is streamed to AssemblyAI for transcription. You review everything before creating the skill.")}
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-xl p-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-select/10 text-accent-text"><Cloud size={17} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    {t("Cloud transcription")}
                    {transcriptionConfigured && <span className="text-[11px] font-semibold text-success">{t("Saved")}</span>}
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-4 text-ink-secondary">
                    {transcriptionConfigured ? t("AssemblyAI is ready for live narration.") : t("Add an AssemblyAI key in Settings before recording.")}
                  </p>
                </div>
                <Button variant="soft" size="sm" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}>
                  {transcriptionConfigured ? t("Manage") : t("Open Settings")}
                </Button>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Button size="lg" className="w-full" disabled={!transcriptionConfigured} onClick={() => void start()}>
                  <Circle size={13} fill="currentColor" className="text-danger" /> {t("Start recording")}
                </Button>
                <p className="text-center text-[11.5px] text-ink-secondary">{t("macOS will ask for screen, microphone, and action-recording access the first time.")}</p>
              </div>
            </div>
          ))}

          {phase === "saved" && (
            <div className="mx-auto flex max-w-xl flex-1 flex-col items-center justify-center p-9 text-center">
              <div className="grid size-14 place-items-center rounded-full bg-success/15 text-success"><Check size={27} /></div>
              <h2 className="mt-5 text-[24px] font-bold">{t("Skill ready")}</h2>
              <p className="mt-2 text-[13px] leading-5 text-ink-secondary">{tRich("Bots will load <skill>{name}</skill> automatically when a request matches it.", { skill: (children) => <span className="font-semibold text-ink">{children}</span> }, { name })}</p>
              {usage && <code className="mt-3 inline-flex h-[30px] items-center rounded-lg bg-control/60 px-2.5 font-mono text-[12.5px] font-semibold text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">{usage}</code>}
              <div className="mt-5 w-full rounded-xl bg-inset p-4 text-left">
                <div className="text-[11px] font-semibold text-ink-secondary">{t("Saved locally")}</div>
                <div className="mt-1 break-all font-mono text-[11.5px] text-ink">{saved?.path}</div>
              </div>
              <Button variant="soft" className="mt-6" onClick={() => void discard()}>{t("Teach another skill")}</Button>
            </div>
          )}
        </div>

        {error && <div role="alert" className="mt-3 rounded-xl bg-danger/10 px-4 py-3 text-[12.5px] text-danger">{error}</div>}

        {/* 存成技能, filled in as you go */}
        {phase !== "idle" && phase !== "starting" && phase !== "saved" && (
          <section className={cn(CARD, "mt-4 flex shrink-0 flex-col gap-3.5 px-[18px] pb-4 pt-3.5")} aria-label={t("Save as a skill")}>
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles size={16} className="shrink-0 text-accent-text" />
              <b className="shrink-0 text-[15px]">{t("Save as a skill")}</b>
              <span className="min-w-0 truncate text-[12px] text-ink-secondary">{t("{name} filled this in from the recording — edit and save", { name: learnerName })}</span>
              <span className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-secondary">{t("{count} steps · recorded {time}", { count: events.length, time: formatRecordingTime(elapsed) })}</span>
            </div>
            <div className="flex flex-wrap items-end gap-[18px]">
              <label className="flex w-[232px] min-w-0 flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink-secondary">{t("Name")}</span>
                <span className="flex h-9 items-center gap-2 rounded-[10px] bg-stage px-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_70%,transparent)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-select)]">
                  <input
                    value={name}
                    onChange={(event) => { setName(event.target.value); setNameTouched(true); }}
                    placeholder={t("e.g. File an expense report")}
                    maxLength={100}
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none placeholder:font-normal placeholder:text-ink-secondary/60"
                  />
                  <Pencil size={14} className="shrink-0 text-ink-secondary/60" />
                </span>
              </label>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink-secondary">{t("Apps it used")}</span>
                <div className="flex h-9 min-w-0 items-center gap-1.5 overflow-hidden">
                  {apps.length === 0 ? <span className="text-[12.5px] text-ink-secondary/70">{t("Appears as you switch apps")}</span> : apps.map((app) => (
                    <span key={`${app.kind}-${app.label}`} className="inline-flex h-[30px] min-w-0 shrink items-center gap-1.5 rounded-full bg-control/60 pl-[9px] pr-[11px] text-[12.5px] font-medium whitespace-nowrap">
                      {app.kind === "browser" ? <Globe size={13} className="shrink-0 text-ink-secondary" /> : app.kind === "download" ? <Download size={13} className="shrink-0 text-ink-secondary" /> : <FolderOpen size={13} className="shrink-0 text-ink-secondary" />}
                      <span className="truncate">{app.detail ? `${app.label} · ${app.detail}` : app.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-[18px]">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink-secondary">{t("Next time")}</span>
                <div className="flex h-9 min-w-0 items-center gap-2.5">
                  {usage ? <code className="inline-flex h-[30px] shrink-0 items-center rounded-lg bg-control/60 px-2.5 font-mono text-[12.5px] font-semibold shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">{usage}</code> : null}
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={300}
                    placeholder={example ? t("or just say “{example}”", { example }) : t("When should bots use it?")}
                    aria-label={t("When should bots use it?")}
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-secondary"
                  />
                </div>
              </div>
              <Button variant="soft" onClick={() => void discard()} disabled={phase === "saving"} className="h-9">
                <RotateCcw size={14} />{t("Record again")}
              </Button>
              <Button onClick={() => void finish()} disabled={!name.trim() || phase === "saving" || !bridge} className="h-9">
                {phase === "saving" ? t("Creating skill…") : t("Save as a skill")}
              </Button>
            </div>
          </section>
        )}
      </section>

      {/* ── right: what the bot understood ── */}
      <aside className="flex w-[356px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-hairline/40 px-[18px] py-4 shadow-[-16px_0_36px_-30px_rgb(16_24_40/0.35)]" aria-label={t("{name} is learning", { name: learnerName })}>
        {learner && (
          <div className="relative flex h-[138px] shrink-0 items-end gap-3.5 rounded-2xl bg-[linear-gradient(170deg,color-mix(in_srgb,var(--color-select)_7%,var(--color-stage))_0,var(--color-stage)_100%)] pb-3.5 pl-[18px] pr-3.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-select)_14%,transparent)]">
            <Mascot kind={mascotForBot(learner, state.instances)} pose={pose} scale={1.5} shadow className="-mb-1 shrink-0" title={learner.name} />
            <div className="flex min-w-0 flex-col gap-1 pb-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {phase === "idle" && visibleBots.length > 1 ? (
                  // before recording, the name is where you pick who learns
                  <label className="min-w-0">
                    <span className="sr-only">{t("Who learns")}</span>
                    <select
                      value={learner.id}
                      onChange={(event) => setLearnerId(event.target.value)}
                      className="max-w-full cursor-pointer truncate rounded-md bg-transparent pr-1 text-[17px] font-bold text-ink outline-none hover:bg-control/50"
                    >
                      {visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                    </select>
                  </label>
                ) : (
                  <b className="truncate text-[17px]">{recording ? t("{name} is learning", { name: learner.name }) : learner.name}</b>
                )}
                {recording && !paused && <span className="size-[15px] shrink-0 animate-spin rounded-full border-2 border-select/25 border-t-select" aria-hidden />}
              </div>
              <span className="truncate text-[12px] text-ink-secondary">{[learner.title, t("watches you once, takes notes")].filter(Boolean).join(" · ")}</span>
              <span className="mt-1 rounded-xl rounded-tl-[4px] bg-stage px-2.5 py-[7px] text-[12.5px] leading-normal text-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-select)_14%,transparent)]">{say}</span>
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
          {t("Steps it understood")}
          <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-control/70 px-1.5 text-[11px] font-bold">{events.length}</span>
          <span className="ml-auto font-medium text-ink-secondary/70">{reviewing ? t("✕ removes a step") : recording ? t("Fills in as you go") : ""}</span>
        </div>
        <div className="flex shrink-0 flex-col gap-0.5">
          {events.length === 0 ? (
            <div className="rounded-xl bg-inset px-3 py-4 text-center text-[12px] leading-relaxed text-ink-secondary">
              {recording ? t("Click, switch apps or scroll — each step shows up here.") : t("The steps appear here while you record.")}
            </div>
          ) : (
            events.map((event, index) => (
              <StepRow
                key={event.id}
                event={event}
                index={index}
                current={recording && !paused && index === events.length - 1}
                removable={reviewing}
                onRemove={() => removeEvent(event.id)}
              />
            ))
          )}
        </div>

        {params.length > 0 && (
          <>
            <div className="mt-1 flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
              {t("What changes next time")}
              <span className="ml-auto font-medium text-ink-secondary/70">{t("It asks you for these first")}</span>
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {params.map((param) => (
                <span key={`${param.kind}-${param.value}`} className="inline-flex h-[30px] max-w-full items-center gap-1.5 rounded-[9px] bg-stage pl-[5px] pr-[11px] text-[12.5px] font-semibold shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
                  <em className="rounded-md bg-control/60 px-1.5 text-[11px] font-semibold not-italic leading-5 text-ink-secondary">{t(param.kind)}</em>
                  <span className="truncate">{param.value}</span>
                </span>
              ))}
            </div>
          </>
        )}

        <div className="mt-1 flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
          {t("{name}'s notes", { name: learnerName })}
          <span className="ml-auto font-medium text-ink-secondary/70">{t("from what you say and type")}</span>
        </div>
        <div className="flex shrink-0 flex-col">
          {recording && partialTranscript && (
            <div className="flex min-h-8 items-center gap-2 py-1 text-[12.5px] text-ink-secondary"><Mic size={13} className="shrink-0" /><span className="min-w-0 flex-1 italic">{partialTranscript}</span></div>
          )}
          {allNotes.map((note, index) => (
            <div key={note.id} className={cn("flex min-h-8 items-center gap-2 py-1 text-[12.5px]", index > 0 && "border-t border-hairline/25")}>
              {note.source === "said" ? <Mic size={13} className="shrink-0 text-ink-secondary" /> : note.source === "typed" ? <Pencil size={13} className="shrink-0 text-ink-secondary" /> : <Lock size={13} className="shrink-0 text-ink-secondary" />}
              <span className="min-w-0 flex-1">{note.text}</span>
              <em className="shrink-0 text-[11.5px] not-italic text-ink-secondary/70">
                {note.source === "rule" ? t("Rule") : [note.source === "said" ? t("You said") : t("You wrote"), note.atMs === undefined ? null : formatRecordingTime(note.atMs)].filter(Boolean).join(" · ")}
              </em>
            </div>
          ))}
        </div>

        <form
          className="mt-auto flex h-[46px] shrink-0 items-center gap-2 rounded-full bg-stage pl-3.5 pr-[7px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_50%,transparent),0_6px_18px_-10px_rgb(16_24_40/0.25)]"
          onSubmit={(event) => { event.preventDefault(); addNote(); }}
        >
          <input
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder={t("Tell {name}: e.g. “step 3 only needs the first two paragraphs”", { name: learnerName })}
            aria-label={t("Add a note for {name}", { name: learnerName })}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-secondary/70"
          />
          <button
            type="submit"
            disabled={!noteDraft.trim()}
            aria-label={noteDraft.trim() ? t("Add note") : t("Narration is on while recording")}
            title={noteDraft.trim() ? t("Add note") : t("Narration is on while recording")}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-ink disabled:opacity-100"
          >
            {noteDraft.trim() ? <ArrowUp size={15} /> : <Mic size={15} className={cn(recording && !paused && "text-danger")} />}
          </button>
        </form>
      </aside>
      {!bridge && phase === "idle" && <span className="sr-only">{t("Skill recording requires the Ein desktop app on macOS.")}</span>}
    </main>
  );
}
