// The call screen (U17), shared by room calls and 1:1 calls: a full-window
// overlay with the call's title and running time on top, a grid of speaker
// tiles (each bot's full-body mascot on a tint of its engine colour, you as
// a plain "你" tile), the control dock, and a right panel with live captions
// and the minutes built from them. Presentation only — GroupCallView and
// CallView own the speech loop and pass the state in.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  Clock,
  Copy,
  FileText,
  Hand,
  Headphones,
  LoaderCircle,
  Mic,
  MicOff,
  MonitorUp,
  PanelRightClose,
  PanelRightOpen,
  PhoneOff,
  Volume2,
  VolumeX,
} from "lucide-react";


import { Mascot } from "@/components/mascot/Mascot";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MASCOT_BRAND, mascotForBot, type MascotPose } from "@/lib/engine-mascots";
import { callGridShape, formatClock, formatOffset, splitSpoken, type CallAction, type CaptionLine } from "@/lib/group-call-notes";
import { useStore, type Bot } from "@/state/store";
import { MemberAvatar, nameInk, useChiefId } from "./parts";

// ── clock ───────────────────────────────────────────────────────────────────
/** Re-renders once a second while mounted and returns Date.now(). */
export function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ── shell ───────────────────────────────────────────────────────────────────
function WindowDots() {
  return (
    <span className="flex items-center gap-2" aria-hidden>
      <span className="size-3 rounded-full bg-[#ff5f57]" />
      <span className="size-3 rounded-full bg-[#febc2e]" />
      <span className="size-3 rounded-full bg-[#28c840]" />
    </span>
  );
}

const softRing = "color-mix(in oklab, var(--color-hairline) 45%, transparent)";

export function CallShell({
  label,
  title,
  startedAt,
  now,
  linkLabel,
  people,
  count,
  panelOpen,
  onTogglePanel,
  stage,
  panel,
}: {
  label: string;
  title: string;
  startedAt: number;
  now: number;
  linkLabel?: string;
  people: Bot[];
  count: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
  stage: ReactNode;
  panel: ReactNode;
}) {
  const { capabilities } = useDesktopCapabilities();
  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // the call takes the whole window: move focus into it so screen readers and
  // the keyboard start here (Space interrupts, Esc hangs up)
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);
  // SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type.
  const drag = macInset ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined;
  const noDrag = macInset ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;
  return (
    <div ref={shellRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className="animate-workspace-in fixed inset-0 z-[45] flex flex-col bg-app text-ink outline-none">
      <div className={cn("flex h-[52px] shrink-0 items-center gap-2.5 pr-3", macInset ? "pl-[92px]" : browser ? "pl-[18px]" : "pl-4")} style={drag}>
        {browser && !macInset && (
          <span className="mr-8">
            <WindowDots />
          </span>
        )}
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-ink-secondary" style={{ boxShadow: `inset 0 0 0 1px ${softRing}` }}>
          <Headphones size={16} aria-hidden />
        </span>
        <b className="min-w-0 truncate text-[15.5px] font-bold">{title}</b>
        <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-[9px] text-[12px] font-semibold whitespace-nowrap text-success">
          <span className="size-[7px] rounded-full bg-success" style={{ boxShadow: "0 0 0 3px color-mix(in oklab, var(--color-success) 18%, transparent)" }} aria-hidden />
          {t("On call")}
          <span className="font-mono text-[12px] text-ink tabular-nums">{formatOffset(now - startedAt)}</span>
        </span>
        {linkLabel && (
          <span className="hidden h-[22px] min-w-0 items-center truncate rounded-full bg-control/60 px-2.5 text-[12px] font-semibold text-ink-secondary lg:inline-flex">
            {linkLabel}
          </span>
        )}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center" style={noDrag}>
          {people.slice(0, 6).map((bot, index) => (
            <span key={bot.id} className="inline-flex rounded-[6px] ring-[1.5px] ring-app" style={{ marginLeft: index === 0 ? 0 : -6 }}>
              <MemberAvatar bot={bot} size={20} />
            </span>
          ))}
          <span className="-ml-1 grid size-[22px] place-items-center rounded-full bg-select/10 text-[11px] font-bold text-accent-text ring-2 ring-app">{t("You")}</span>
        </span>
        <span className="mr-1 shrink-0 text-[12.5px] whitespace-nowrap text-ink-secondary/85">{t("{count} people", { count })}</span>
        <button
          type="button"
          onClick={onTogglePanel}
          aria-label={panelOpen ? t("Hide captions") : t("Show captions")}
          title={panelOpen ? t("Hide captions") : t("Show captions")}
          aria-pressed={panelOpen}
          className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
          style={noDrag}
        >
          {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <section className="relative min-w-0 flex-1 overflow-hidden rounded-[14px] bg-stage" style={{ boxShadow: `inset 0 0 0 1px ${softRing}, 0 1px 2px rgb(16 24 40 / 0.05)` }}>
          {stage}
        </section>
        {panelOpen && (
          <aside className="relative flex w-[412px] shrink-0 flex-col overflow-hidden rounded-[14px] bg-stage max-lg:w-[340px]" style={{ boxShadow: `inset 0 0 0 1px ${softRing}, 0 1px 2px rgb(16 24 40 / 0.05)` }}>
            {panel}
          </aside>
        )}
      </div>
    </div>
  );
}

// ── tiles ───────────────────────────────────────────────────────────────────
export type TileStatus = "speaking" | "working" | "next" | "spoke" | "listening";

export interface BotTileModel {
  bot: Bot;
  status: TileStatus;
  /** speaking: ms so far; spoke: total ms spoken in this call */
  ms?: number;
  host?: boolean;
  /** department colour for the name dot */
  color?: string;
  /** engine name for the chip ("Kimi") */
  engine?: string;
  /** you silenced this bot's voice for the call (captions keep coming) */
  voiceMuted?: boolean;
}

export type YouStatus = "muted" | "talking" | "open" | "listening";

const BARS = [5, 9, 14, 8, 16, 11, 6, 13, 16, 9, 12, 6, 4];

export function Waveform({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-4 items-center gap-0.5", className)} aria-hidden>
      {BARS.map((height, index) => (
        <i
          key={index}
          className="w-[3px] animate-pulse rounded-[2px] bg-select"
          style={{ height, animationDelay: `${(index % 5) * 120}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

function Crown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path d="M3.2 8.2l4.6 3.6L12 4.8l4.2 7 4.6-3.6-1.9 10.3H5.1z" fill="#E5A00D" />
    </svg>
  );
}

const lift = (alpha = 0.06) => `0 1px 2px rgb(16 24 40 / ${alpha})`;

function TileChip({ tone, children }: { tone: "white" | "blue" | "next" | "green" | "grey"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-[5px] rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap",
        tone === "blue" && "bg-select text-white",
        tone === "next" && "bg-raised text-accent-text",
        tone === "green" && "bg-raised text-success",
        tone === "grey" && "bg-raised text-ink-secondary",
        tone === "white" && "bg-raised text-ink-secondary",
      )}
      style={{
        boxShadow:
          tone === "blue"
            ? "none"
            : tone === "next"
              ? `inset 0 0 0 1px color-mix(in oklab, var(--color-select) 30%, transparent), ${lift()}`
              : lift(),
      }}
    >
      {children}
    </span>
  );
}

const dot = <span className="size-1.5 rounded-full bg-current" aria-hidden />;

function poseFor(status: TileStatus): MascotPose {
  if (status === "speaking") return "wave";
  if (status === "working") return "work";
  return "idle";
}

const tileShadow = "inset 0 0 0 1px rgb(16 24 40 / 0.06)";
const speakingShadow = "0 0 0 2px var(--color-select), 0 0 0 7px color-mix(in oklab, var(--color-select) 16%, transparent)";

function MicButton({
  state,
  label,
  title,
  pressed,
  onClick,
}: {
  state: "idle" | "talking" | "off";
  label: string;
  title: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      style={{ boxShadow: lift(0.08) }}
      className={cn(
        "absolute top-2.5 right-3 z-[2] grid size-[30px] place-items-center rounded-full",
        state === "talking" ? "bg-select text-white" : state === "off" ? "bg-primary text-primary-ink" : "bg-raised text-ink-secondary hover:text-ink",
      )}
    >
      {state === "talking" ? <AudioLines size={15} /> : state === "off" ? <MicOff size={15} /> : <Mic size={15} />}
    </button>
  );
}

function NamePlate({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-x-3 bottom-3 z-[2] flex h-[38px] items-center gap-1.5 rounded-[11px] bg-raised px-2.5 whitespace-nowrap" style={{ boxShadow: lift() }}>
      {children}
    </div>
  );
}

export function CallBotTile({ tile, scale, onToggleVoice }: { tile: BotTileModel; scale: number; onToggleVoice: () => void }) {
  const { state } = useStore();
  const kind = mascotForBot(tile.bot, state.instances);
  const chiefId = useChiefId();
  const brand = MASCOT_BRAND[kind];
  const speaking = tile.status === "speaking";
  return (
    <div
      className={cn("relative min-h-0 rounded-2xl", speaking ? "z-[1]" : "overflow-hidden")}
      style={{ background: `color-mix(in oklab, ${brand} 11%, var(--color-stage))`, boxShadow: speaking ? speakingShadow : tileShadow }}
      aria-label={tile.bot.name}
    >
      <div className="absolute top-3 left-3 z-[2] flex gap-1.5">
        {tile.host && (
          <TileChip tone="white">
            <Crown />
            {t("Host")}
          </TileChip>
        )}
        {tile.status === "speaking" ? (
          <TileChip tone="blue">
            {dot}
            {t("Speaking · {time}", { time: formatClock(tile.ms ?? 0) })}
          </TileChip>
        ) : tile.status === "working" ? (
          <TileChip tone="next">
            <LoaderCircle size={11} className="animate-spin" aria-hidden />
            {t("Preparing")}
          </TileChip>
        ) : tile.status === "next" ? (
          <TileChip tone="next">{t("Up next")}</TileChip>
        ) : tile.status === "spoke" ? (
          <TileChip tone="green">
            {dot}
            {t("Spoke · {time}", { time: formatClock(tile.ms ?? 0) })}
          </TileChip>
        ) : (
          !tile.host && (
            <TileChip tone="grey">
              {dot}
              {t("In the room")}
            </TileChip>
          )
        )}
      </div>
      <MicButton
        state={speaking ? "talking" : tile.voiceMuted ? "off" : "idle"}
        pressed={Boolean(tile.voiceMuted)}
        onClick={onToggleVoice}
        label={tile.voiceMuted ? t("Unmute {name}", { name: tile.bot.name }) : t("Mute {name}", { name: tile.bot.name })}
        title={tile.voiceMuted ? t("Unmute {name}", { name: tile.bot.name }) : t("Mute {name} — captions keep coming", { name: tile.bot.name })}
      />
      {speaking && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-[46%] left-1/2 aspect-square w-[78%] max-w-[260px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, transparent 52%, color-mix(in oklab, var(--color-select) 10%, transparent) 53%, transparent 66%, color-mix(in oklab, var(--color-select) 7%, transparent) 67%, transparent 80%)",
          }}
        />
      )}
      <div className={cn("absolute inset-x-0 top-11 bottom-[62px] z-[1] flex items-center justify-center", tile.voiceMuted && "opacity-90")}>
        <Mascot kind={kind} pose={poseFor(tile.status)} scale={scale} shadow title={tile.bot.name} />
      </div>
      <NamePlate>
        <span className="size-2 shrink-0 rounded-full" style={{ background: tile.color ?? "var(--color-ink)" }} aria-hidden />
        <b className="truncate text-[14px] font-bold" style={tile.color ? { color: nameInk(tile.color) } : undefined}>
          {tile.bot.name}
        </b>
        {chiefId === tile.bot.id && <Crown />}
        {tile.bot.title && <span className="min-w-0 truncate text-[12px] text-ink-secondary/85">{tile.bot.title}</span>}
        {tile.engine && (
          <span className="h-[18px] shrink-0 rounded-[5px] bg-control/60 px-[5px] text-[10.5px] leading-[18px] font-semibold text-ink-secondary">{tile.engine}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          {speaking ? <Waveform /> : tile.voiceMuted ? <span className="text-[12px] font-semibold text-ink-secondary">{t("Muted")}</span> : null}
        </span>
      </NamePlate>
    </div>
  );
}

export function CallYouTile({ status, onToggleMute, name, scale }: { status: YouStatus; onToggleMute: () => void; name: string; scale: number }) {
  const talking = status === "talking";
  const circle = Math.round(48 * scale);
  return (
    <div
      className={cn("relative min-h-0 rounded-2xl", talking ? "z-[1]" : "overflow-hidden")}
      style={{ background: "color-mix(in oklab, var(--color-select) 4%, var(--color-stage))", boxShadow: talking ? speakingShadow : tileShadow }}
      aria-label={t("You")}
    >
      <div className="absolute top-3 left-3 z-[2] flex gap-1.5">
        {status === "talking" ? (
          <TileChip tone="blue">
            {dot}
            {t("Speaking")}
          </TileChip>
        ) : status === "open" ? (
          <TileChip tone="green">
            {dot}
            {t("Mic on")}
          </TileChip>
        ) : status === "muted" ? (
          <TileChip tone="grey">
            <MicOff size={11} aria-hidden />
            {t("Muted")}
          </TileChip>
        ) : (
          <TileChip tone="grey">
            {dot}
            {t("In the room")}
          </TileChip>
        )}
      </div>
      <MicButton
        state={status === "muted" ? "off" : talking ? "talking" : "idle"}
        pressed={status === "muted"}
        onClick={onToggleMute}
        label={status === "muted" ? t("Unmute") : t("Mute")}
        title={status === "muted" ? t("Unmute") : t("Mute")}
      />
      <div className="absolute inset-x-0 top-11 bottom-[62px] z-[1] flex items-center justify-center">
        <span
          className="grid place-items-center rounded-full bg-select/10 font-bold text-accent-text"
          style={{ width: circle, height: circle, fontSize: Math.round(circle * 0.38), boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-select) 22%, transparent)" }}
        >
          {t("You")}
        </span>
      </div>
      <NamePlate>
        <span className="size-2 shrink-0 rounded-full bg-select" aria-hidden />
        <b className="truncate text-[14px] font-bold">{t("You")}</b>
        <span className="truncate text-[12px] text-ink-secondary/85">{name}</span>
        <span className="ml-auto flex shrink-0 items-center">{talking ? <Waveform /> : null}</span>
      </NamePlate>
    </div>
  );
}

/** The speaker grid with the dock and the two hints under it. */
export function CallStage({
  count,
  tiles,
  dock,
  leftHint,
  rightHint,
  notice,
}: {
  count: number;
  tiles: ReactNode;
  dock: ReactNode;
  leftHint: { title: string; detail?: string };
  rightHint?: { title: string; detail?: string };
  notice?: ReactNode;
}) {
  const shape = callGridShape(count);
  return (
    <>
      <div
        className={cn("absolute inset-x-[18px] top-[18px] bottom-[128px] grid gap-[14px]", shape.rows === 1 && "content-center")}
        style={{
          gridTemplateColumns: `repeat(${shape.cols}, minmax(0, 1fr))`,
          gridTemplateRows: shape.rows === 1 ? "minmax(0, min(100%, 460px))" : `repeat(${shape.rows}, minmax(0, 1fr))`,
        }}
      >
        {tiles}
      </div>
      {notice && <div className="absolute inset-x-0 bottom-[118px] z-[3] flex justify-center px-6">{notice}</div>}
      <div className="absolute bottom-[34px] left-[19px] flex max-w-[26%] flex-col gap-0.5 text-[12px] text-ink-secondary/85 max-xl:hidden">
        <b className="text-[12.5px] text-ink-secondary">{leftHint.title}</b>
        {leftHint.detail && <span>{leftHint.detail}</span>}
      </div>
      {rightHint && (
        <div className="absolute right-[19px] bottom-[34px] flex max-w-[30%] flex-col items-end gap-0.5 text-[12px] text-ink-secondary/85 max-xl:hidden">
          <b className="text-[12.5px] text-ink-secondary">{rightHint.title}</b>
          {rightHint.detail && <span>{rightHint.detail}</span>}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-9 flex justify-center">{dock}</div>
    </>
  );
}

/** The scale a grid of `count` tiles draws its mascots at. */
export function callMascotScale(count: number): number {
  return callGridShape(count).scale;
}

// ── dock ────────────────────────────────────────────────────────────────────
function DockButton({
  label,
  title,
  onClick,
  active,
  disabled,
  danger,
  children,
}: {
  label: string;
  title?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title ?? label}
      className="group/dock flex w-[62px] flex-col items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        className={cn(
          "grid h-12 place-items-center rounded-full transition-[filter,background-color]",
          danger ? "w-16 rounded-[24px] bg-danger text-white group-hover/dock:brightness-110" : "w-12",
          !danger && (active ? "bg-select/10 text-accent-text" : "bg-control/60 text-ink group-enabled/dock:group-hover/dock:bg-control"),
        )}
      >
        {children}
      </span>
      <span className={cn("text-[12px] whitespace-nowrap", danger ? "font-semibold text-danger" : "text-ink-secondary")}>{label}</span>
    </button>
  );
}

export function CallDock({
  muted,
  onToggleMute,
  speakerOn,
  onToggleSpeaker,
  canRaiseHand,
  onRaiseHand,
  onHangUp,
}: {
  muted: boolean;
  onToggleMute: () => void;
  speakerOn: boolean;
  onToggleSpeaker: () => void;
  canRaiseHand: boolean;
  onRaiseHand: () => void;
  onHangUp: () => void;
}) {
  return (
    <div
      className="flex items-start justify-center gap-[18px] rounded-[22px] bg-raised px-[18px] pt-3 pb-2.5"
      style={{ boxShadow: `inset 0 0 0 1px ${softRing}, 0 14px 30px -18px rgb(16 24 40 / 0.35)` }}
    >
      <DockButton label={muted ? t("Unmute") : t("Mute")} title={muted ? t("Unmute your microphone") : t("Mute your microphone")} onClick={onToggleMute} active={muted}>
        {muted ? <MicOff size={20} /> : <Mic size={20} />}
      </DockButton>
      <DockButton
        label={t("Speaker")}
        title={speakerOn ? t("Speaker on — turn off to read captions only") : t("Speaker off — captions only")}
        onClick={onToggleSpeaker}
        active={speakerOn}
      >
        {speakerOn ? <Volume2 size={20} /> : <VolumeX size={20} />}
      </DockButton>
      <DockButton label={t("Raise hand")} title={t("Stop whoever is talking and take the floor (Space)")} onClick={onRaiseHand} disabled={!canRaiseHand}>
        <Hand size={20} />
      </DockButton>
      <DockButton label={t("Share screen")} title={t("Screen sharing isn't available on calls yet")} disabled>
        <MonitorUp size={20} />
      </DockButton>
      <DockButton label={t("Hang up")} title={t("Hang up (Esc)")} onClick={onHangUp} danger>
        <PhoneOff size={22} />
      </DockButton>
    </div>
  );
}

// ── captions + minutes ──────────────────────────────────────────────────────
export interface LiveCaption {
  /** a caption line being read aloud right now, by id */
  lineId?: string;
  speakerId?: string;
  name: string;
  /** the utterance audible right now (from the speaker) */
  caption?: string;
  /** text not in the transcript (a question read aloud, or what you're saying) */
  text?: string;
  you?: boolean;
  startedAt: number;
}

function SpeakerAvatar({ line, bots }: { line: { speaker: CaptionLine["speaker"] }; bots: Bot[] }) {
  if (line.speaker.kind === "you") {
    return <span className="grid size-[18px] place-items-center rounded-full bg-select/10 text-[9.5px] font-bold text-accent-text">{t("You")}</span>;
  }
  const speakerId = line.speaker.botId;
  const bot = bots.find((candidate) => candidate.id === speakerId);
  return bot ? <MemberAvatar bot={bot} size={18} /> : <span className="size-[18px] rounded-md bg-control" />;
}

function PendingDots() {
  return (
    <span className="ml-0.5 inline-flex gap-[3px] align-middle text-accent-text" aria-hidden>
      {[0, 1, 2].map((index) => (
        <i key={index} className="size-1 animate-pulse rounded-full bg-current" style={{ animationDelay: `${index * 160}ms` }} />
      ))}
    </span>
  );
}

export function CaptionsPanel({
  lines,
  live,
  startedAt,
  bots,
  points,
  actions,
  keeper,
  updatedAt,
  pending,
  footer,
  onCollapse,
}: {
  lines: CaptionLine[];
  live: LiveCaption | null;
  startedAt: number;
  bots: Bot[];
  points: string[];
  actions: CallAction[];
  /** who keeps the minutes (the host) */
  keeper: string;
  updatedAt: number | null;
  /** "小文 正在说" while someone has the floor */
  pending?: string;
  footer: string;
  onCollapse: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const liveLine = live?.lineId ? lines.find((line) => line.id === live.lineId) : undefined;
  const extra = live && !liveLine && (live.text || live.caption) ? live : null;
  const lastKey = `${lines.at(-1)?.id ?? ""}:${extra?.text ?? ""}:${live?.caption ?? ""}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [lastKey]);

  const copy = () => {
    const text = [
      ...lines.map((line) => `[${formatOffset(line.offsetMs)}] ${line.speaker.kind === "you" ? t("You") : line.speaker.name}: ${line.text}`),
      "",
      `${t("Minutes")}:`,
      ...points.map((point) => `- ${point}`),
      ...actions.map((action) => `- [ ] ${action.title} — ${action.ownerName}${action.due ? ` (${action.due})` : ""}`),
    ].join("\n");
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const jumpToLine = (lineId: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-line="${CSS.escape(lineId)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.animate([{ backgroundColor: "color-mix(in oklab, var(--color-select) 14%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1200 });
  };

  return (
    <>
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline/25 pr-2.5 pl-4">
        <b className="truncate text-[15px] font-bold">{t("Live captions + minutes")}</b>
        <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-control/60 px-2 text-[11.5px] font-semibold text-ink-secondary">{t("Auto-generated")}</span>
        <span className="flex-1" />
        <button type="button" onClick={copy} aria-label={t("Copy captions and minutes")} title={t("Copy captions and minutes")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
          {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
        </button>
        <button type="button" onClick={onCollapse} aria-label={t("Hide captions")} title={t("Hide captions")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
          <PanelRightClose size={16} />
        </button>
      </div>

      <div ref={scrollRef} className="relative min-h-[120px] flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col justify-end gap-2.5 px-3 pt-3 pb-3.5">
          {lines.length === 0 && !extra && (
            <div className="px-2 py-6 text-center text-[12.5px] text-ink-secondary/80">{t("Captions appear here as people talk.")}</div>
          )}
          {lines.map((line) => {
            const now = liveLine?.id === line.id;
            const split = now ? splitSpoken(line.text, live?.caption) : null;
            return (
              <div
                key={line.id}
                data-line={line.id}
                className={cn("flex gap-2 rounded-xl px-1", now && "bg-select/[0.07] py-2.5 pr-2.5 pl-2")}
                style={now ? { boxShadow: "inset 3px 0 0 var(--color-select)" } : undefined}
              >
                <span className="mt-0.5 shrink-0">
                  <SpeakerAvatar line={line} bots={bots} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex h-5 items-center gap-1.5">
                    <b className="truncate text-[12.5px] font-bold">{line.speaker.kind === "you" ? t("You") : line.speaker.name}</b>
                    <span className="font-mono text-[11px] text-ink-secondary/60 tabular-nums">{formatOffset(line.offsetMs)}</span>
                    {now && (
                      <em className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11.5px] font-semibold text-accent-text not-italic">
                        <AudioLines size={12} aria-hidden />
                        {t("Speaking")}
                      </em>
                    )}
                  </div>
                  <div className="text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-ink">
                    {split ? (
                      <>
                        {split.spoken}
                        {split.pending && <span className="text-ink-secondary/55">{split.pending}</span>}
                        {split.pending && <PendingDots />}
                      </>
                    ) : (
                      line.text
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {extra && (
            <div className="flex gap-2 rounded-xl bg-select/[0.07] py-2.5 pr-2.5 pl-2" style={{ boxShadow: "inset 3px 0 0 var(--color-select)" }}>
              <span className="mt-0.5 shrink-0">
                {extra.you ? (
                  <SpeakerAvatar line={{ speaker: { kind: "you" } }} bots={bots} />
                ) : (
                  <SpeakerAvatar line={{ speaker: { kind: "bot", botId: extra.speakerId ?? "", name: extra.name } }} bots={bots} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center gap-1.5">
                  <b className="truncate text-[12.5px] font-bold">{extra.you ? t("You") : extra.name}</b>
                  <span className="font-mono text-[11px] text-ink-secondary/60 tabular-nums">{formatOffset(extra.startedAt - startedAt)}</span>
                  <em className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11.5px] font-semibold text-accent-text not-italic">
                    <AudioLines size={12} aria-hidden />
                    {t("Speaking")}
                  </em>
                </div>
                <div className="text-[13px] leading-[1.6] break-words text-ink">
                  {extra.text ?? extra.caption}
                  <PendingDots />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex max-h-[56%] shrink-0 flex-col overflow-y-auto border-t border-hairline/40 bg-inset px-4 pt-3 pb-3">
        <div className="flex h-7 items-center gap-2">
          <span className="grid size-6 place-items-center rounded-[7px] bg-raised text-ink-secondary" style={{ boxShadow: `inset 0 0 0 1px ${softRing}` }}>
            <FileText size={14} aria-hidden />
          </span>
          <b className="text-[14px] font-bold">{t("Minutes")}</b>
          <span className="truncate text-[11.5px] text-ink-secondary/85">
            {updatedAt !== null ? t("{name} · updated {time}", { name: keeper, time: formatOffset(updatedAt - startedAt) }) : t("{name} keeps them", { name: keeper })}
          </span>
        </div>
        {points.length > 0 ? (
          <div className="mt-1.5 mb-2.5 flex flex-col gap-0.5 text-[12.5px] leading-[1.55] text-ink-secondary">
            {points.map((point) => (
              <div key={point} className="flex items-baseline gap-[7px]">
                <i className="relative -top-[3px] size-1 shrink-0 rounded-full bg-ink-secondary/50" aria-hidden />
                <span className="min-w-0">{point}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1.5 mb-2.5 text-[12.5px] text-ink-secondary/80">{t("Key points show up once people commit to something.")}</div>
        )}
        <div className="mb-1.5 flex items-center gap-1.5">
          <b className="text-[12.5px] font-semibold text-ink-secondary">{t("Action items")}</b>
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink-secondary px-1 text-[11px] font-bold text-stage">{actions.length}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {actions.map((action) => {
            const owner = bots.find((bot) => bot.id === action.ownerId);
            return (
              <div key={action.id} className="flex gap-2.5 rounded-[11px] bg-raised px-2.5 py-[7px]" style={{ boxShadow: `inset 0 0 0 1px ${softRing}` }}>
                <span className="mt-0.5 size-4 shrink-0 rounded-[5px] bg-stage" style={{ boxShadow: "inset 0 0 0 1.5px color-mix(in oklab, var(--color-hairline) 80%, transparent)" }} aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <b className="truncate text-[13px] font-semibold">{action.title}</b>
                  <div className="flex items-center gap-[5px] text-[12px] whitespace-nowrap text-ink-secondary">
                    {owner ? <MemberAvatar bot={owner} size={16} /> : null}
                    <span className="truncate">{action.ownerName}</span>
                    {action.due && (
                      <span className="ml-1 inline-flex h-[18px] shrink-0 items-center gap-[3px] rounded-[5px] bg-control/60 px-1.5 text-[11px]">
                        <Clock size={11} aria-hidden />
                        {action.due}
                      </span>
                    )}
                    <button type="button" onClick={() => jumpToLine(action.lineId)} className="ml-auto shrink-0 font-mono text-[11px] text-ink-secondary/60 hover:text-accent-text">
                      {t("from {time}", { time: formatOffset(action.offsetMs) })}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {pending && (
            <div className="flex h-[30px] items-center gap-2 rounded-[10px] border border-dashed border-select/30 bg-select/[0.04] px-2.5 text-[12px] whitespace-nowrap text-accent-text">
              <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden />
              <span className="truncate">{pending}</span>
            </div>
          )}
        </div>
        <div className="mt-2.5 text-[11.5px] text-ink-secondary/70">{footer}</div>
      </div>
    </>
  );
}
