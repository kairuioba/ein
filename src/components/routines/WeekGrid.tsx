// The calendar's time grid (U14): day headers ("周一 12", today as a cobalt
// pill), the pinned 例行 lane for recurring routines, light event cards with a
// left colour bar, and the red now-line. Drag on empty time to create, drag a
// card to move it, pull its bottom edge to resize, drop a bot to schedule it.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, Loader2, Phone, Repeat2 } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { Diamond } from "@/components/ui";
import {
  cadenceLabel,
  clockTime,
  ranTodayLabel,
  routineDaySummary,
  laneSegments,
  RUN_STATUS_LABEL,
} from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { addDays, atLocalTime, packCalendarCollisions, slotAt, startOfDay } from "@/lib/routine-calendar";
import type { Routine, RoutineRun } from "@/lib/routines";
import type { Bot } from "@/state/store";
import {
  BOT_DRAG_TYPE,
  EVENT_DRAG_TYPE,
  isSelected,
  niceDate,
  selectionFor,
  type CalendarEventItem,
  type CalendarSelection,
  type EventKind,
  type EventSeed,
} from "./calendar-model";

export const HOUR_HEIGHT = 60;
const GUTTER = 56;
const LANE_ROW = 25;
const LANE_VISIBLE = 4;

const minutesOfDay = (at: number) => new Date(at).getHours() * 60 + new Date(at).getMinutes();

/** Re-render once a minute so the now-line keeps up. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Tightly overlapped participant tiles, as on the design's call cards. */
function MiniStack({ bots, max = 5, more = true }: { bots: Bot[]; max?: number; more?: boolean }) {
  const shown = bots.slice(0, max);
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((bot, index) => (
        <span key={bot.id} className="rounded-[4px] ring-[1.5px] ring-stage" style={{ marginLeft: index === 0 ? 0 : -6 }}>
          <BotAvatar bot={bot} size={13} />
        </span>
      ))}
      {more && bots.length > shown.length && <span className="ml-0.5 text-[10px] font-semibold text-ink-secondary">+{bots.length - shown.length}</span>}
    </span>
  );
}

type CardVariant = "call" | "routine" | "done" | "running" | "waiting" | "failed" | "cancelled" | "selected";

function cardVariant(item: CalendarEventItem, selected: boolean): CardVariant {
  if (selected) return "selected";
  if (item.kind === "call") return "call";
  const status = item.run?.status;
  if (!status) return "routine";
  if (status === "completed") return "done";
  if (status === "running" || status === "queued") return "running";
  if (status === "waiting") return "waiting";
  if (status === "failed" || status === "missed") return "failed";
  return "cancelled";
}

const VARIANT_CLASS: Record<CardVariant, string> = {
  call: "bg-control/70 text-ink shadow-[inset_3px_0_0_var(--color-ink)]",
  routine: "text-ink",
  done: "bg-stage text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]",
  running: "bg-select/10 text-ink shadow-[inset_3px_0_0_var(--color-select)]",
  waiting: "bg-warning/10 text-ink shadow-[inset_3px_0_0_var(--color-warning)]",
  failed: "bg-danger/10 text-danger shadow-[inset_3px_0_0_var(--color-danger)]",
  cancelled: "bg-control/50 text-ink-secondary line-through decoration-ink-secondary/40",
  selected:
    "bg-select/10 text-accent-text shadow-[inset_3px_0_0_var(--color-select),inset_0_0_0_1.5px_var(--color-select),0_0_0_3px_color-mix(in_srgb,var(--color-select)_16%,transparent)]",
};

function EventCard({
  item,
  bots,
  color,
  selected,
  now,
  layout,
  onOpen,
  onResize,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  color: string;
  selected: boolean;
  now: number;
  layout: { column: number; columns: number };
  onOpen: () => void;
  onResize: (minutes: number) => void;
}) {
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const ownerIds = isCall ? item.call.botIds : [routine?.botId ?? run?.botId ?? ""];
  const owners = ownerIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = owners[0];
  const name = isCall ? item.call.name : routine?.name ?? run?.routineName ?? t("Routine");
  const [previewDuration, setPreviewDuration] = useState(item.durationMinutes);
  useEffect(() => setPreviewDuration(item.durationMinutes), [item.durationMinutes]);
  const canMove = isCall || Boolean(routine && !run);
  const recurring = (isCall ? item.call.schedule : routine?.schedule)?.type === "daily";
  const variant = cardVariant(item, selected);
  const ended = item.at + previewDuration * 60_000 < now;
  const past = ended && (variant === "call" || variant === "routine" || variant === "done");
  const height = Math.max(18, (previewDuration / 60) * HOUR_HEIGHT - 2);
  const twoRows = height >= 40;
  const status = run?.status;

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startDuration = previewDuration;
    let next = startDuration;
    const move = (pointer: PointerEvent) => {
      next = Math.max(15, Math.min(240, Math.round((startDuration + ((pointer.clientY - startY) / HOUR_HEIGHT) * 60) / 15) * 15));
      setPreviewDuration(next);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (next === item.durationMinutes) return;
      if (recurring && !window.confirm(t("Resize this entire recurring series?"))) {
        setPreviewDuration(item.durationMinutes);
        return;
      }
      onResize(next);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  const style: CSSProperties = {
    left: `calc(${(layout.column / layout.columns) * 100}% + 3px)`,
    width: `calc(${100 / layout.columns}% - 6px)`,
    top: (minutesOfDay(item.at) / 60) * HOUR_HEIGHT + 1,
    height,
    // a routine card wears its bot's department colour
    ...(variant === "routine" ? { background: `color-mix(in srgb, ${color} 10%, var(--color-stage))`, boxShadow: `inset 3px 0 0 ${color}` } : {}),
  };

  const lead = isCall ? (
    <Phone size={11} className={cn("shrink-0", variant === "selected" ? "text-accent-text" : "text-ink-secondary")} />
  ) : primary ? (
    <BotAvatar bot={primary} size={14} />
  ) : null;
  const trail =
    status === "completed" ? <Check size={12} className="ml-auto shrink-0 text-success" aria-label={t("completed")} /> :
    status === "running" ? <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-accent-text" /> :
    status === "waiting" ? <Diamond size={9} className="ml-auto" label={t("needs you")} /> : null;
  const stack = isCall && owners.length > 0 ? <MiniStack bots={owners} /> : null;
  // narrow columns get three faces, wide ones five
  const fittedStack = isCall && owners.length > 0 ? (
    <>
      <span className="ml-auto hidden shrink-0 @min-[76px]:flex @min-[118px]:hidden"><MiniStack bots={owners} max={3} more={false} /></span>
      <span className="ml-auto hidden shrink-0 @min-[118px]:flex"><MiniStack bots={owners} /></span>
    </>
  ) : null;
  const meta = isCall
    ? stack
    : status
      ? <span className="truncate">{t(RUN_STATUS_LABEL[status])}{primary ? ` · ${primary.name}` : ""}</span>
      : <span className="truncate">{clockTime(item.at)}{primary ? ` · ${primary.name}` : ""}</span>;

  return (
    <button
      data-event-card
      type="button"
      draggable={canMove}
      aria-label={`${name} · ${niceDate(item.at)} ${clockTime(item.at)}`}
      aria-pressed={selected}
      onDragStart={(event) => {
        if (!canMove) return event.preventDefault();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(EVENT_DRAG_TYPE, JSON.stringify({ kind: item.kind, id: isCall ? item.call.id : routine!.id, at: item.at }));
      }}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      className={cn(
        "group @container absolute z-10 flex overflow-hidden rounded-[7px] text-left text-[11.5px] leading-tight transition-[filter,opacity] hover:z-20 hover:brightness-[0.98] focus:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-select",
        twoRows ? "flex-col items-start justify-start gap-0.5 py-1 pl-2 pr-1.5" : "items-center gap-1.5 pl-2 pr-1.5",
        VARIANT_CLASS[variant],
        past && "opacity-55",
      )}
      style={style}
    >
      {twoRows ? (
        <>
          <span className="flex w-full min-w-0 items-center gap-1">
            {lead}
            <b className="truncate font-semibold">{name}</b>
            {trail}
          </span>
          <span className={cn("flex min-w-0 max-w-full items-center gap-1 text-[10.5px]", variant === "failed" ? "text-danger/85" : "text-ink-secondary")}>{meta}</span>
        </>
      ) : (
        <>
          {lead}
          <b className="min-w-[2.6em] truncate font-semibold">{name}</b>
          {fittedStack && height >= 24 ? fittedStack : trail}
        </>
      )}
      {canMove && <div onPointerDown={beginResize} className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100" aria-label={t("Resize event")}><div className="mx-auto mt-0.5 h-0.5 w-5 rounded-full bg-ink-secondary/50" /></div>}
    </button>
  );
}

function LaneBar({
  routine,
  bot,
  color,
  runs,
  rangeStart,
  days,
  row,
  now,
  selected,
  onOpen,
}: {
  routine: Routine;
  bot?: Bot;
  color: string;
  runs: RoutineRun[];
  rangeStart: number;
  days: number;
  row: number;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  if (routine.schedule.type !== "daily") return null;
  const segments = laneSegments(routine.schedule.weekdays, rangeStart, days, routine.createdAt);
  if (!segments.length) return null;
  const summary = routineDaySummary(routine.id, runs, now);
  const todayIndex = Math.round((startOfDay(now) - rangeStart) / 86_400_000);
  const time = clockTime(atLocalTime(now, routine.schedule.time));
  const next = routine.nextRunAt && routine.nextRunAt > now ? clockTime(routine.nextRunAt) : null;
  const ran = ranTodayLabel(summary.ranToday);
  const meta = [bot?.name, cadenceLabel(routine.schedule.weekdays), next ? t("{ran}, next {time}", { ran, time: next }) : ran]
    .filter(Boolean)
    .join(" · ");
  const waitingToday = summary.waiting && todayIndex >= 0 && todayIndex < days ? summary.waiting : undefined;
  const failedToday = !waitingToday && summary.failed && todayIndex >= 0 && todayIndex < days ? summary.failed : undefined;
  return (
    <>
      {segments.map((segment, index) => (
        <button
          key={`${routine.id}-${segment.from}`}
          type="button"
          onClick={onOpen}
          aria-pressed={selected}
          aria-label={t("{name}, routine", { name: routine.name })}
          className={cn(
            "relative mx-[3px] flex h-[22px] min-w-0 items-center gap-1.5 self-center rounded-[7px] pl-[3px] pr-2 text-left whitespace-nowrap transition-[filter] hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-select",
            selected && "ring-2 ring-select",
          )}
          style={{
            gridColumn: `${segment.from + 2} / ${segment.to + 3}`,
            gridRow: row + 1,
            background: `color-mix(in srgb, ${color} 9%, var(--color-stage))`,
            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 26%, var(--color-stage))`,
          }}
        >
          {bot ? <BotAvatar bot={bot} size={15} /> : <Repeat2 size={12} className="text-ink-secondary" />}
          {index === 0 || segment.to - segment.from >= 1 ? (
            <>
              <b className="shrink-0 text-[12px] font-semibold text-ink">{routine.name} · {time}</b>
              <span className="min-w-0 truncate text-[11.5px] text-ink-secondary">{meta}</span>
            </>
          ) : (
            <b className="min-w-0 truncate text-[11.5px] font-semibold text-ink">{routine.name}</b>
          )}
          {segment.to - segment.from >= 2 && <Repeat2 size={12} className="ml-auto shrink-0 text-ink-secondary/70" />}
        </button>
      ))}
      {waitingToday && (
        <span
          className="pointer-events-none z-[1] ml-1.5 inline-flex h-4 items-center gap-1 self-center justify-self-start rounded-[5px] bg-[color-mix(in_srgb,var(--color-warning)_14%,var(--color-stage))] px-1.5 text-[11px] font-bold whitespace-nowrap text-warning shadow-[0_0_0_2px_var(--color-stage)]"
          style={{ gridColumn: `${todayIndex + 2} / span 2`, gridRow: row + 1 }}
        >
          <Diamond size={8} />
          {t("Today's run waits for you")}
        </span>
      )}
      {failedToday && (
        <span
          className="pointer-events-none z-[1] ml-1.5 inline-flex h-4 items-center self-center justify-self-start rounded-[5px] bg-[color-mix(in_srgb,var(--color-danger)_12%,var(--color-stage))] px-1.5 text-[11px] font-bold whitespace-nowrap text-danger shadow-[0_0_0_2px_var(--color-stage)]"
          style={{ gridColumn: `${todayIndex + 2} / span 2`, gridRow: row + 1 }}
        >
          {t("Today's run failed")}
        </span>
      )}
    </>
  );
}

export function WeekGrid({
  rangeStart,
  days,
  items,
  laneRoutines,
  runs,
  bots,
  colorFor,
  selection,
  now,
  onOpen,
  onOpenRoutine,
  onCreate,
  onMove,
  onResize,
}: {
  rangeStart: number;
  days: number;
  items: CalendarEventItem[];
  laneRoutines: Routine[];
  runs: RoutineRun[];
  bots: Bot[];
  colorFor: (botId: string | undefined) => string;
  selection: CalendarSelection | null;
  now: number;
  onOpen: (selection: CalendarSelection) => void;
  onOpenRoutine: (routine: Routine) => void;
  onCreate: (seed: EventSeed) => void;
  onMove: (item: { kind: EventKind; id: string; at: number }, nextAt: number) => void;
  onResize: (item: CalendarEventItem, duration: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectionBox, setSelectionBox] = useState<{ day: number; start: number; end: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ day: number; at: number } | null>(null);
  const [laneExpanded, setLaneExpanded] = useState(false);
  const today = startOfDay(now);
  const starts = Array.from({ length: days }, (_, index) => addDays(rangeStart, index));
  const showsToday = starts.includes(today);
  const minDayWidth = days === 7 ? 92 : days === 3 ? 180 : 320;
  const gridTemplateColumns = `${GUTTER}px repeat(${days}, minmax(${minDayWidth}px, 1fr))`;
  const minWidth = GUTTER + days * minDayWidth;
  const shownLane = laneExpanded ? laneRoutines : laneRoutines.slice(0, LANE_VISIBLE);
  const hiddenLane = laneRoutines.length - shownLane.length;
  const nowTop = (minutesOfDay(now) / 60) * HOUR_HEIGHT;

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const hour = new Date().getHours();
    const top = showsToday && hour >= 18 ? hour - 9 : showsToday && hour < 8 ? Math.max(0, hour - 1) : 8;
    viewport.scrollTo({ top: top * HOUR_HEIGHT });
    // only when the visible range changes, not on every tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, rangeStart]);

  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-event-card]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    let end = start + 30 * 60_000;
    setSelectionBox({ day, start, end });
    const move = (pointer: PointerEvent) => {
      const current = slotAt(day, pointer.clientY, rect.top, HOUR_HEIGHT);
      end = Math.max(start + 15 * 60_000, current + 15 * 60_000);
      setSelectionBox({ day, start, end });
    };
    const up = (pointer: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setSelectionBox(null);
      onCreate({ kind: "routine", at: start, durationMinutes: Math.max(15, Math.round((end - start) / 60_000)), botIds: [], anchor: { x: pointer.clientX, y: pointer.clientY } });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  const drop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    event.preventDefault();
    setDragPreview(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    if (botId) return onCreate({ kind: "routine", at, durationMinutes: 30, botIds: [botId], anchor: { x: event.clientX, y: event.clientY } });
    const raw = event.dataTransfer.getData(EVENT_DRAG_TYPE);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: EventKind; id: string; at: number };
      onMove(item, at);
    } catch {
      // Ignore drags from another application.
    }
  };

  const previewDrop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    if (!event.dataTransfer.types.includes(BOT_DRAG_TYPE) && !event.dataTransfer.types.includes(EVENT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(EVENT_DRAG_TYPE) ? "move" : "copy";
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    setDragPreview((current) => current?.day === day && current.at === at ? current : { day, at });
  };

  const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  return (
    <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
      <div style={{ minWidth }}>
        <div className="sticky top-0 z-30 bg-stage">
          {/* day headers */}
          <div className="grid h-[34px]" style={{ gridTemplateColumns }}>
            <div />
            {starts.map((start) => {
              const date = new Date(start);
              const isToday = start === today;
              const weekend = date.getDay() === 0 || date.getDay() === 6;
              return (
                <div
                  key={start}
                  role="columnheader"
                  aria-current={isToday ? "date" : undefined}
                  className={cn("flex items-center justify-center gap-1.5 text-[12px] whitespace-nowrap", isToday && "bg-select/[0.045]")}
                >
                  <span className={cn(isToday ? "font-semibold text-accent-text" : weekend ? "text-ink-secondary/60" : "text-ink-secondary")}>
                    {date.toLocaleDateString(intlLocale(), { weekday: "short" })}
                  </span>
                  <b
                    className={cn(
                      "font-semibold tabular-nums",
                      isToday
                        ? "inline-grid h-6 min-w-6 place-items-center rounded-full bg-select px-1 text-[13px] text-white"
                        : weekend
                          ? "text-[14px] text-ink-secondary/60"
                          : "text-[14px] text-ink",
                    )}
                  >
                    {date.getDate()}
                  </b>
                </div>
              );
            })}
          </div>
          {/* the pinned 例行 lane */}
          <div
            className="relative grid border-y border-hairline/45 py-[3px]"
            style={{ gridTemplateColumns, gridAutoRows: `${LANE_ROW}px`, minHeight: LANE_ROW + 6 }}
            aria-label={t("Recurring routines")}
          >
            <div className="flex flex-col items-end justify-center gap-0.5 pr-2 text-[11px] font-semibold text-ink-secondary" style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(1, shownLane.length)}` }}>
              <span>{t("Routines lane")}</span>
              {hiddenLane > 0 && (
                <button type="button" onClick={() => setLaneExpanded(true)} className="rounded px-1 text-[10.5px] font-semibold text-accent-text hover:bg-select/10">+{hiddenLane}</button>
              )}
              {laneExpanded && laneRoutines.length > LANE_VISIBLE && (
                <button type="button" onClick={() => setLaneExpanded(false)} className="rounded px-1 text-[10.5px] font-medium text-ink-secondary hover:bg-raised-hover">{t("Less")}</button>
              )}
            </div>
            {starts.map((start, index) => (
              <div
                key={start}
                aria-hidden
                className={cn("pointer-events-none", start === today && "bg-select/[0.045]")}
                style={{ gridColumn: index + 2, gridRow: `1 / span ${Math.max(1, shownLane.length)}` }}
              />
            ))}
            {shownLane.length === 0 ? (
              <div className="flex items-center pl-2 text-[11.5px] text-ink-secondary/70" style={{ gridColumn: `2 / ${days + 2}`, gridRow: 1 }}>
                {t("Routines that repeat every day or week stay pinned here.")}
              </div>
            ) : (
              shownLane.map((routine, row) => (
                <LaneBar
                  key={routine.id}
                  routine={routine}
                  bot={bots.find((bot) => bot.id === routine.botId)}
                  color={colorFor(routine.botId)}
                  runs={runs}
                  rangeStart={rangeStart}
                  days={days}
                  row={row}
                  now={now}
                  selected={selection?.kind === "routine" && selection.routineId === routine.id}
                  onOpen={() => onOpenRoutine(routine)}
                />
              ))
            )}
          </div>
        </div>

        <div
          role="grid"
          aria-label={t("Routine and call calendar")}
          onDragEnd={() => setDragPreview(null)}
          className="relative grid"
          style={{ height: HOUR_HEIGHT * 24, gridTemplateColumns }}
        >
          <div className="relative">
            {Array.from({ length: 24 }, (_, hour) => hour === 0 ? null : (
              <div key={hour} className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-ink-secondary/70" style={{ top: hour * HOUR_HEIGHT }}>{hourLabel(hour)}</div>
            ))}
            {showsToday && (
              <span className="absolute left-1.5 z-30 grid h-[18px] w-[44px] -translate-y-1/2 place-items-center rounded-[6px] bg-danger text-[11px] font-bold tabular-nums text-white" style={{ top: nowTop }}>
                {clockTime(now)}
              </span>
            )}
          </div>
          {starts.map((start) => {
            const dayItems = items.filter((item) => startOfDay(item.at) === start);
            const collisionLayouts = packCalendarCollisions(dayItems);
            const selected = selectionBox?.day === start ? selectionBox : null;
            const preview = dragPreview?.day === start ? dragPreview : null;
            const weekend = new Date(start).getDay() === 0 || new Date(start).getDay() === 6;
            return (
              <div
                key={start}
                role="gridcell"
                aria-label={t("{date} calendar", { date: niceDate(start) })}
                onPointerDown={(event) => beginSelection(event, start)}
                onDragOver={(event) => previewDrop(event, start)}
                onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragPreview(null); }}
                onDrop={(event) => drop(event, start)}
                className={cn("relative border-l border-hairline/25", start === today ? "bg-select/[0.045]" : weekend && "bg-inset/50")}
              >
                {Array.from({ length: 24 }, (_, hour) => hour === 0 ? null : <div key={hour} className="pointer-events-none absolute inset-x-0 border-t border-hairline/25" style={{ top: hour * HOUR_HEIGHT }} />)}
                {start === today && (
                  <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop - 1 }}>
                    <span className="-ml-1 size-2 rounded-full bg-danger" />
                    <span className="h-0.5 flex-1 bg-danger" />
                  </div>
                )}
                {selected && <div className="pointer-events-none absolute inset-x-1 z-10 rounded-[7px] bg-select/15 shadow-[inset_0_0_0_1.5px_var(--color-select)]" style={{ top: (minutesOfDay(selected.start) / 60) * HOUR_HEIGHT, height: Math.max(16, ((selected.end - selected.start) / 3_600_000) * HOUR_HEIGHT) }} />}
                {preview && <div className="pointer-events-none absolute inset-x-1 z-20 rounded-[7px] bg-select/15 shadow-[inset_0_0_0_1.5px_var(--color-select)]" style={{ top: (minutesOfDay(preview.at) / 60) * HOUR_HEIGHT, height: HOUR_HEIGHT / 2 }}><div className="px-2 py-1 text-[10.5px] font-semibold text-accent-text">{clockTime(preview.at)}</div></div>}
                {dayItems.map((item) => (
                  <EventCard
                    key={item.id}
                    item={item}
                    bots={bots}
                    color={colorFor(item.kind === "call" ? item.call.botIds[0] : item.routine?.botId ?? item.run?.botId)}
                    selected={isSelected(item, selection)}
                    now={now}
                    layout={collisionLayouts.get(item.id) ?? { column: 0, columns: 1 }}
                    onOpen={() => onOpen(selectionFor(item))}
                    onResize={(minutes) => onResize(item, minutes)}
                  />
                ))}
              </div>
            );
          })}
          {showsToday && (
            <i
              aria-hidden
              className="pointer-events-none absolute right-0 z-[5] border-t border-dashed border-danger/45"
              style={{ left: GUTTER, top: nowTop }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
