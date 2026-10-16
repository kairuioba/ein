// Pure helpers for the calendar page (U14): the pinned 例行 lane, the month
// grid, run and session history, agenda lines and the short date labels the
// detail panel uses. Everything here is derived from routines, runs, calls and
// room messages the app already holds — no extra server state.
import { intlLocale, msg, t, tn } from "@/lib/i18n";
import { addDays, startOfDay, startOfWeek } from "@/lib/routine-calendar";
import type { Routine, RoutineRun, RoutineRunStatus } from "@/lib/routines";

const DAY_MS = 86_400_000;

/** A routine that repeats on weekdays lives in the pinned lane, not the grid. */
export function isRecurringRoutine(routine: Pick<Routine, "schedule"> | null | undefined): boolean {
  return routine?.schedule.type === "daily";
}

export interface LaneSegment {
  /** inclusive indexes into the visible days */
  from: number;
  to: number;
}

/** The contiguous stretches of the visible days a weekly schedule runs on.
 * Days that ended before the routine existed are left out, so a routine
 * created on Thursday does not claim Monday. */
export function laneSegments(
  weekdays: readonly number[],
  rangeStart: number,
  days: number,
  createdAt = 0,
): LaneSegment[] {
  const segments: LaneSegment[] = [];
  let open: LaneSegment | null = null;
  for (let index = 0; index < days; index += 1) {
    const day = addDays(rangeStart, index);
    const on = weekdays.includes(new Date(day).getDay()) && addDays(day, 1) > createdAt;
    if (!on) {
      open = null;
      continue;
    }
    if (open && open.to === index - 1) open.to = index;
    else {
      open = { from: index, to: index };
      segments.push(open);
    }
  }
  return segments;
}

/** 每天 · 周一到周五 · 周末 · 周一、周三 */
export function cadenceLabel(weekdays: readonly number[]): string {
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  if (days.length === 7) return t("Every day");
  if (days.join(",") === "1,2,3,4,5") return t("Mon to Fri");
  if (days.join(",") === "0,6") return t("Weekends");
  // Monday first, Sunday last, as the calendar draws them
  const ordered = [...days.filter((day) => day !== 0), ...days.filter((day) => day === 0)];
  const format = new Intl.DateTimeFormat(intlLocale(), { weekday: "short" });
  return new Intl.ListFormat(intlLocale(), { style: "narrow", type: "conjunction" }).format(
    ordered.map((day) => format.format(new Date(2023, 0, 1 + day))),
  );
}

/** "09:00" in the 24-hour style the calendar uses everywhere. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** 今天 / 明天 / 昨天 / 周二 (within the week around now) / 10月3日 */
export function dayWord(at: number, now = Date.now()): string {
  const delta = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (delta === 0) return t("Today");
  if (delta === 1) return t("Tomorrow");
  if (delta === -1) return t("Yesterday");
  if (delta > -7 && delta < 7) return new Date(at).toLocaleDateString(intlLocale(), { weekday: "short" });
  return new Date(at).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

/** "今天 09:00", "周二 09:00", "10月3日 09:00" */
export function dayTimeLabel(at: number, now = Date.now()): string {
  return `${dayWord(at, now)} ${clockTime(at)}`;
}

/** "16:26" today, else 昨天 / 周一 / 10月3日 — for compact "updated" columns. */
export function shortWhen(at: number, now = Date.now()): string {
  return startOfDay(at) === startOfDay(now) ? clockTime(at) : dayWord(at, now);
}

/** "14 分钟", "1 小时 5 分钟" */
export function durationLabel(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return t("{minutes} min", { minutes: whole });
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? t("{hours} hr {minutes} min", { hours, minutes: rest }) : t("{hours} hr", { hours });
}

/** The week label in the header: "10月12日 – 18日", or across months "9月28日 – 10月4日". */
export function weekRangeLabel(from: number, days: number, now = Date.now()): string {
  const start = new Date(from);
  const end = new Date(addDays(from, days - 1));
  const locale = intlLocale();
  const withYear = start.getFullYear() !== new Date(now).getFullYear() || end.getFullYear() !== start.getFullYear();
  if (days === 1) {
    return start.toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short", ...(withYear ? { year: "numeric" } : {}) });
  }
  if (start.getMonth() === end.getMonth() && !withYear) {
    return t("{start} – {endDay}", {
      start: start.toLocaleDateString(locale, { month: "long", day: "numeric" }),
      endDay: end.getDate(),
    });
  }
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) };
  return `${start.toLocaleDateString(locale, options)} – ${end.toLocaleDateString(locale, options)}`;
}

export function monthLabel(at: number): string {
  return new Date(at).toLocaleDateString(intlLocale(), { year: "numeric", month: "long" });
}

/** The 42 days (six Monday-first weeks) a month view shows around `at`. */
export function monthGridDays(at: number): number[] {
  const first = new Date(at);
  first.setDate(1);
  first.setHours(0, 0, 0, 0);
  const start = startOfWeek(first.getTime());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function startOfMonth(at: number): number {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addMonths(at: number, months: number): number {
  const date = new Date(startOfMonth(at));
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

// ── routine runs ──────────────────────────────────────────────────────────────
/** Statuses that mean the run actually started. */
const RAN: ReadonlySet<RoutineRunStatus> = new Set(["running", "waiting", "completed", "failed"]);

export interface RoutineDaySummary {
  /** runs of this routine that started today */
  ranToday: number;
  /** the newest run waiting on the person (any day — it is still waiting) */
  waiting?: RoutineRun;
  /** the newest run going right now */
  running?: RoutineRun;
  /** today's newest failed or missed run nobody has looked at yet */
  failed?: RoutineRun;
  /** newest run of any status */
  last?: RoutineRun;
}

export function routineDaySummary(routineId: string, runs: readonly RoutineRun[], now = Date.now()): RoutineDaySummary {
  const mine = runs.filter((run) => run.routineId === routineId).sort((a, b) => b.scheduledFor - a.scheduledFor);
  const today = startOfDay(now);
  const isToday = (run: RoutineRun) => run.scheduledFor >= today && run.scheduledFor < today + DAY_MS;
  return {
    ranToday: mine.filter((run) => isToday(run) && RAN.has(run.status)).length,
    waiting: mine.find((run) => run.status === "waiting"),
    running: mine.find((run) => run.status === "running"),
    failed: mine.find((run) => isToday(run) && (run.status === "failed" || run.status === "missed") && !run.seenAt),
    last: mine[0],
  };
}

/** Minutes a finished run took, or null while it has no start/end. */
export function runMinutes(run: Pick<RoutineRun, "startedAt" | "finishedAt">): number | null {
  if (run.startedAt == null || run.finishedAt == null) return null;
  return Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000));
}

export type RunTone = "green" | "blue" | "amber" | "red" | "grey";
export function runTone(status: RoutineRunStatus): RunTone {
  if (status === "completed") return "green";
  if (status === "running") return "blue";
  if (status === "waiting") return "amber";
  if (status === "failed" || status === "missed") return "red";
  return "grey";
}

// ── call sessions, from the room's messages ───────────────────────────────────
type SessionMessage = {
  id: string;
  role: "bot" | "user";
  at: number;
  sendId?: string;
  from?: { botId: string };
  text?: string;
  kind?: string;
};

export interface CallSession {
  /** the message that opened the session (its sendId names the call) */
  messageId: string;
  at: number;
  /** from the opening message to the last reply, 0 before anyone replied */
  minutes: number;
  /** distinct invited bots that spoke in the session */
  attended: number;
  invited: number;
  /** the last bot line in the session, for the "minutes" preview */
  lastLine?: string;
}

/** Each scheduled delivery posts one message whose sendId is
 * `calendar_<callId>_<scheduledFor>` (server/index.ts deliverCalendarCall);
 * a session runs until the next delivery. Newest first. */
export function callSessions(callId: string, botIds: readonly string[], messages: readonly SessionMessage[]): CallSession[] {
  const prefix = `calendar_${callId}_`;
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const openers = sorted.filter((message) => message.sendId?.startsWith(prefix));
  const invited = new Set(botIds);
  return openers
    .map((opener, index) => {
      const until = openers[index + 1]?.at ?? Number.POSITIVE_INFINITY;
      const replies = sorted.filter((message) => message.at > opener.at && message.at < until && message.role === "bot");
      const speakers = new Set(replies.flatMap((message) => (message.from && invited.has(message.from.botId) ? [message.from.botId] : [])));
      const lastText = [...replies].reverse().find((message) => (message.kind ?? "text") === "text" && message.text?.trim());
      const lastAt = replies.length ? replies[replies.length - 1]!.at : opener.at;
      return {
        messageId: opener.id,
        at: opener.at,
        minutes: replies.length ? Math.max(1, Math.round((lastAt - opener.at) / 60_000)) : 0,
        attended: speakers.size,
        invited: invited.size,
        lastLine: lastText?.text?.trim(),
      };
    })
    .reverse();
}

// ── agenda ────────────────────────────────────────────────────────────────────
const BULLET = /^\s*(?:[-*•·]|\d{1,2}\s*[.、)）:：]|[（(]\d{1,2}[)）]|[一二三四五六七八九十]{1,2}[、.．])\s*/;

/** Agenda lines from an event's description: one per line (bullets and
 * numbers stripped), or the sentences of a one-line description split on
 * semicolons. */
export function agendaItems(text: string, max = 8): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines.slice(0, max);
  const parts = (lines[0] ?? "").split(/[；;]\s*/).map((part) => part.trim()).filter(Boolean);
  return (parts.length > 1 ? parts : lines).slice(0, max);
}

// ── misc labels ───────────────────────────────────────────────────────────────
export const RUN_STATUS_LABEL: Record<RoutineRunStatus, string> = {
  queued: msg("queued"),
  running: msg("running"),
  waiting: msg("needs you"),
  completed: msg("completed"),
  failed: msg("failed"),
  cancelled: msg("cancelled"),
  missed: msg("missed"),
};

export function ranTodayLabel(count: number): string {
  return count > 0 ? tn(count, "ran {count} time today", "ran {count} times today") : t("not run yet today");
}
