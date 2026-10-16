// Today on one line: the company's events on an axis whose busy hours are
// drawn wider (compressDay), a "now" marker, and a replay that walks a
// playhead from the morning to now. Used under the people view and as the
// 时间 lens of the work tree.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Clock, Play, Square } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { clip, clock, compressDay, concernsOwner, placeLabels } from "@/lib/workbench";
import type { OrgEvent, OrgEventKind } from "../../../shared/org-types";

import { DecisionMark, useElementSize } from "./parts";

export interface TimelineMark {
  id: string;
  at: number;
  title: string;
  kind: OrgEventKind | "scheduled";
  severity?: OrgEvent["severity"];
}

const KIND_COLOR: Partial<Record<TimelineMark["kind"], string>> = {
  "run.started": "#9AA0AC",
  "run.done": "#16A34A",
  "run.failed": "#E5484D",
  "subtask.failed": "#E5484D",
  "subtask.retry": "#E5484D",
  "people.added": "#8B5CF6",
  decision: "var(--color-ink)",
  "approval.requested": "#D97706",
  "approval.resolved": "#16A34A",
  "approval.auto": "#9AA0AC",
  "approval.expired": "#9AA0AC",
  "library.published": "#14B8A6",
  escalation: "#D97706",
  report: "#3B5BFF",
  meeting: "#EC4899",
  scheduled: "#B8BEC9",
};

export function markColor(mark: Pick<TimelineMark, "kind" | "severity">): string {
  if (mark.severity === "error") return "#E5484D";
  if (mark.severity === "warn" && mark.kind !== "decision") return "#D97706";
  return KIND_COLOR[mark.kind] ?? "#9AA0AC";
}

/** Rough label width in px at 11.5px: CJK glyphs are wide, Latin narrow. */
const textWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 11.5 : 6.4), 0);

export function DayTimeline({
  marks,
  now,
  replayNonce = 0,
  className,
  style,
  compact = false,
}: {
  marks: readonly TimelineMark[];
  now: number;
  /** bump to start the replay from outside (the "since" card's link) */
  replayNonce?: number;
  className?: string;
  style?: CSSProperties;
  compact?: boolean;
}) {
  const [axisRef, { width }] = useElementSize<HTMLDivElement>();
  const [playAt, setPlayAt] = useState<number | null>(null);
  const frame = useRef(0);
  const sorted = useMemo(() => [...marks].sort((a, b) => a.at - b.at), [marks]);
  const scale = useMemo(() => compressDay(sorted.map((mark) => mark.at), now), [sorted, now]);
  const inner = Math.max(0, width - 48);
  const xOf = (time: number) => 24 + inner * scale.at(time);
  const nowX = xOf(now);

  const replay = () => {
    cancelAnimationFrame(frame.current);
    const started = performance.now();
    const duration = 4200;
    const step = (tick: number) => {
      const progress = Math.min(1, (tick - started) / duration);
      setPlayAt(scale.start + (now - scale.start) * progress);
      if (progress < 1) frame.current = requestAnimationFrame(step);
      else window.setTimeout(() => setPlayAt(null), 700);
    };
    frame.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const lastNonce = useRef(replayNonce);
  useEffect(() => {
    if (replayNonce !== lastNonce.current) {
      lastNonce.current = replayNonce;
      replay();
    }
    // replay() reads the latest scale through closure on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayNonce]);

  const labels = useMemo(
    () =>
      placeLabels(
        sorted.map((mark) => {
          const text = clip(mark.title, 11);
          return { mark, text, x: xOf(mark.at), width: textWidth(text) + 44 };
        }),
        10,
      ),
    // xOf depends on width + scale only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sorted, inner, scale],
  );
  const zoomStart = new Date(now);
  zoomStart.setHours(scale.zoomHour, 0, 0, 0);
  const bandLeft = xOf(zoomStart.getTime());
  const bandRight = xOf(zoomStart.getTime() + 3_600_000);
  const mine = sorted.filter((mark) => mark.kind !== "scheduled" && concernsOwner({ kind: mark.kind as OrgEventKind })).length;
  const happened = sorted.filter((mark) => mark.kind !== "scheduled").length;
  const head = playAt ?? now;

  return (
    <section
      className={cn("relative rounded-[14px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]", className)}
      style={style}
      aria-label={t("Today's timeline")}
    >
      <header className="flex h-[38px] items-center gap-1.5 px-4 text-[12px] whitespace-nowrap text-ink-secondary">
        <Clock size={13} className="text-ink-secondary" />
        <b className="text-[13px] text-ink">{t("Today")}</b>
        <span>{t("Timeline · {hour}:00 zoomed in", { hour: scale.zoomHour })}</span>
        <Button variant="ghost" size="sm" className="ml-1.5 h-6 gap-1 px-2" onClick={playAt === null ? replay : () => { cancelAnimationFrame(frame.current); setPlayAt(null); }}>
          {playAt === null ? <Play size={10} fill="currentColor" /> : <Square size={9} fill="currentColor" />}
          {playAt === null ? t("Replay") : t("Stop")}
        </Button>
        <span className="ml-auto">{t("{count} events · {mine} about you", { count: happened, mine })}</span>
      </header>
      <div ref={axisRef} className={cn("relative", compact ? "h-[64px]" : "h-[72px]")}>
        {width > 0 && (
          <>
            <div className="absolute top-[6px] h-[54px] rounded-lg bg-select/[0.045]" style={{ left: bandLeft, width: Math.max(0, bandRight - bandLeft) }} />
            <div className="absolute top-[32px] h-[2px] rounded-full bg-ink-secondary/55" style={{ left: 24, width: Math.max(0, nowX - 24) }} />
            <div
              className="absolute top-[32px] h-[2px]"
              style={{ left: nowX, width: Math.max(0, 24 + inner - nowX), background: "repeating-linear-gradient(90deg, color-mix(in srgb, var(--color-ink-secondary) 40%, transparent) 0 4px, transparent 4px 8px)" }}
            />
            {labels.map(({ mark, text, x, row, hidden }) => {
              const future = mark.at > now;
              const lit = mark.at <= head;
              const color = markColor(mark);
              return (
                <div key={mark.id} className={cn("transition-opacity duration-300", playAt !== null && !lit && "opacity-25")}>
                  <i
                    className="absolute top-[28px] z-[2] size-[10px] -translate-x-1/2 rounded-full"
                    style={{ left: x, background: future ? "var(--color-raised)" : color, boxShadow: future ? `0 0 0 2px var(--color-raised), inset 0 0 0 2px ${color}` : "0 0 0 2px var(--color-raised)" }}
                  />
                  {!hidden && (
                    <span
                      className={cn(
                        "absolute z-[2] inline-flex -translate-x-1/2 items-center gap-1 text-[11.5px] whitespace-nowrap",
                        row === 0 ? "top-[9px]" : "top-[42px]",
                        future ? "text-ink-secondary/70" : "text-ink",
                      )}
                      style={{ left: x }}
                    >
                      <b className="font-mono text-[10.5px] font-medium text-ink-secondary/80">{clock(mark.at)}</b>
                      {mark.kind === "decision" && <DecisionMark size={10} />}
                      {text}
                    </span>
                  )}
                </div>
              );
            })}
            <div className="absolute top-[2px] z-[3] h-[38px] w-[2px] -translate-x-1/2 bg-select" style={{ left: playAt === null ? nowX : xOf(head) }} />
            {playAt === null && (
              <span className="absolute -top-[30px] z-[3] h-5 -translate-x-1/2 rounded-full bg-select px-2 text-[11px] leading-5 font-bold whitespace-nowrap text-white" style={{ left: nowX }}>
                {t("Now {time}", { time: clock(now) })}
              </span>
            )}
          </>
        )}
        {width > 0 && sorted.length === 0 && (
          <div className="absolute inset-x-0 top-[44px] text-center text-[12px] text-ink-secondary">{t("Nothing has happened yet today. Events show up here as the team works.")}</div>
        )}
      </div>
    </section>
  );
}
