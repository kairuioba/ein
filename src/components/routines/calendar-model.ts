// Shared types and helpers for the calendar page and its parts (week grid,
// month grid, detail panel, editors). Moved out of RoutineCalendarPage.tsx.
import type { CalendarCall } from "@/lib/calendar-calls";
import { intlLocale, t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import {
  addDays,
  atLocalTime,
  startOfDay,
  toLocalTimeInput,
  type RoutineCalendarItem,
} from "@/lib/routine-calendar";
import type { Routine, RoutineRunStatus, RoutineSchedule } from "@/lib/routines";

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const BOT_DRAG_TYPE = "application/x-ein-bot";
export const EVENT_DRAG_TYPE = "application/x-ein-calendar-event";

export type EventKind = "routine" | "call";
export type RecurrenceChoice = "none" | "daily" | "weekdays" | "weekly" | "custom";
export type CalendarView = 1 | 3 | 7 | "month";

export type CallOccurrence = {
  id: string;
  at: number;
  durationMinutes: number;
  call: CalendarCall;
};

export type CalendarEventItem =
  | ({ kind: "routine" } & RoutineCalendarItem)
  | ({ kind: "call" } & CallOccurrence);

export type EventSeed = {
  kind: EventKind;
  at: number;
  durationMinutes: number;
  botIds: string[];
  name?: string;
  description?: string;
  anchor?: { x: number; y: number };
  routine?: Routine;
  call?: CalendarCall;
};

/** What the detail panel shows: a routine (with the clicked occurrence), a
 * call occurrence, or a run whose routine no longer exists. */
export type CalendarSelection =
  | { kind: "routine"; routineId: string; at: number; runId?: string }
  | { kind: "call"; callId: string; at: number }
  | { kind: "run"; runId: string; at: number };

export function selectionFor(item: CalendarEventItem): CalendarSelection {
  if (item.kind === "call") return { kind: "call", callId: item.call.id, at: item.at };
  if (item.routine) return { kind: "routine", routineId: item.routine.id, at: item.at, runId: item.run?.id };
  return { kind: "run", runId: item.run!.id, at: item.at };
}

export function isSelected(item: CalendarEventItem, selection: CalendarSelection | null): boolean {
  if (!selection) return false;
  if (item.kind === "call") return selection.kind === "call" && selection.callId === item.call.id && selection.at === item.at;
  if (selection.kind === "routine") return item.routine?.id === selection.routineId && selection.at === item.at;
  return selection.kind === "run" && item.run?.id === selection.runId;
}

export function nextHour(): number {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function niceTime(at: number): string {
  return new Date(at).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });
}

export function niceDate(at: number): string {
  return new Date(at).toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric" });
}

/** Localized weekday name for a getDay() index (0 = Sunday). */
export function weekdayName(day: number, width: "short" | "narrow" = "short"): string {
  // 1 January 2023 was a Sunday.
  return new Intl.DateTimeFormat(intlLocale(), { weekday: width }).format(new Date(2023, 0, 1 + day));
}

export function scheduleLabel(schedule: RoutineSchedule | CalendarCall["schedule"]): string {
  if (schedule.type === "once") return t("{date}, {time}", { date: niceDate(schedule.at), time: niceTime(schedule.at) });
  const days = schedule.weekdays;
  const label = days.length === 7
    ? t("Every day")
    : days.join(",") === "1,2,3,4,5"
      ? t("Every weekday")
      : days.length === 1
        ? t("Weekly on {day}", { day: weekdayName(days[0]!) })
        : new Intl.ListFormat(intlLocale(), { style: "narrow", type: "conjunction" }).format(days.map((day) => weekdayName(day)));
  return t("{schedule} at {time}", { schedule: label, time: niceTime(atLocalTime(Date.now(), schedule.time)) });
}

export function recurrenceFor(schedule: RoutineSchedule | CalendarCall["schedule"], at: number): RecurrenceChoice {
  if (schedule.type === "once") return "none";
  if (schedule.weekdays.length === 7) return "daily";
  if (schedule.weekdays.join(",") === "1,2,3,4,5") return "weekdays";
  if (schedule.weekdays.length === 1 && schedule.weekdays[0] === new Date(at).getDay()) return "weekly";
  return "custom";
}

export function makeSchedule(choice: RecurrenceChoice, at: number, weekdays: number[]): RoutineSchedule {
  if (choice === "none") return { type: "once", at };
  const selected = choice === "daily"
    ? ALL_DAYS
    : choice === "weekdays"
      ? WEEKDAYS
      : choice === "weekly"
        ? [new Date(at).getDay()]
        : weekdays;
  return { type: "daily", time: toLocalTimeInput(at), weekdays: [...selected].sort() };
}

export function projectCalls(calls: CalendarCall[], from: number, to: number): CallOccurrence[] {
  const items: CallOccurrence[] = [];
  for (const call of calls) {
    if (call.schedule.type === "once") {
      if (call.schedule.at >= from && call.schedule.at < to) {
        items.push({ id: `call-${call.id}-${call.schedule.at}`, at: call.schedule.at, durationMinutes: call.durationMinutes, call });
      }
      continue;
    }
    for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
      if (!call.schedule.weekdays.includes(new Date(day).getDay())) continue;
      const at = atLocalTime(day, call.schedule.time);
      if (at >= from && at < to && at >= call.createdAt) {
        items.push({ id: `call-${call.id}-${at}`, at, durationMinutes: call.durationMinutes, call });
      }
    }
  }
  return items.sort((left, right) => left.at - right.at);
}

/** The next time a schedule fires after `now` (null for a past one-off). */
export function nextOccurrence(schedule: RoutineSchedule | CalendarCall["schedule"], now = Date.now()): number | null {
  if (schedule.type === "once") return schedule.at > now ? schedule.at : null;
  for (let offset = 0; offset < 8; offset += 1) {
    const day = addDays(startOfDay(now), offset);
    if (!schedule.weekdays.includes(new Date(day).getDay())) continue;
    const at = atLocalTime(day, schedule.time);
    if (at > now) return at;
  }
  return null;
}

export function statusState(status: RoutineRunStatus): MausState {
  if (status === "running") return "working";
  if (status === "waiting") return "curious";
  if (status === "completed") return "proud";
  if (status === "failed" || status === "missed") return "sad";
  if (status === "cancelled") return "sleeping";
  return "drowsy";
}
