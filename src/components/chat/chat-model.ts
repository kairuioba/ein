// Pure helpers behind the 1:1 chat (design U8): how a transcript row is
// classified, where time separators fall, which messages have thread
// replies, what the bottom error strip shows, the dispatch runs a chat
// owns, the typing line and the routine panel's labels. No React here, so
// every rule is unit-tested in chat-model.test.ts.
import { intlLocale, t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import type { DispatchRun, RunStatus } from "../../../shared/dispatch-types";
import type { Routine, RoutineRun, RoutineSchedule } from "@/lib/routines";

// ── row kinds ────────────────────────────────────────────────────────────

/** An activity row the harness writes ABOUT the work (an org or dispatch
 * event such as "created Squad B"), not a tool call. The server marks those
 * with `tool.system`; they render as a centred system line. */
export function isSystemLine(message: Message): boolean {
  if (message.kind !== "activity" || !message.tool) return false;
  return (message.tool as { system?: unknown }).system === true;
}

/** A failed turn ("error: …"): an error block with Retry, not a chip. */
export function isTurnError(message: Message): boolean {
  return message.kind === "activity" && Boolean(message.tool?.name.startsWith("error:"));
}

/** Any other failure the harness reported (a delegation that failed, a
 * dispatched step that will retry, an answer that could not be delivered). */
export function isFailureLine(message: Message): boolean {
  return (
    message.kind === "activity" &&
    message.tool?.ok === false &&
    !message.comm &&
    !message.tool.name.startsWith("error:")
  );
}

/** The text a failure row carries, without the harness's "error:" prefix. */
export function failureText(message: Message): string {
  const name = message.tool?.name ?? "";
  return (name.startsWith("error:") ? name.slice(6) : name).trim();
}

/** The problem the strip above the composer shows: the newest failure since
 * anyone last said something. A reply (or the person's next message) means
 * the conversation has moved past it, so it drops back into the history. */
export function currentFailure(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.kind === "text") return undefined;
    if (message.kind === "activity" && message.tool?.ok === false && !message.comm) return message;
  }
  return undefined;
}

// ── time separators ──────────────────────────────────────────────────────

/** A pause this long between two rows gets its own centred time. */
export const TIME_GAP_MS = 10 * 60_000;

const startOfDay = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** 24-hour clock, "16:10", in the app's language. */
export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "Today" · "Yesterday" · "The day before yesterday" · a weekday inside
 * the last week · a date. */
export function dayLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return t("Today");
  if (days === 1) return t("Yesterday");
  if (days === 2) return t("The day before yesterday");
  const date = new Date(at);
  if (days > 1 && days < 7) return date.toLocaleDateString(intlLocale(), { weekday: "short" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(intlLocale(), sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export type Separator = { kind: "day" | "time"; label: string } | null;

/** What separates a row from the one before it: the day when the date
 * changes (or at the very top), the clock after a long pause, else nothing. */
export function separatorBetween(previousAt: number | undefined, at: number, now = Date.now()): Separator {
  if (previousAt === undefined || startOfDay(previousAt) !== startOfDay(at)) {
    return { kind: "day", label: `${dayLabel(at, now)} ${clockLabel(at)}` };
  }
  if (at - previousAt >= TIME_GAP_MS) return { kind: "time", label: clockLabel(at) };
  return null;
}

// ── thread replies ───────────────────────────────────────────────────────

/** Markdown down to its words, for one-line quotes ("Replying to …"). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?[^\s*])\*(?!\*)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .trim();
}

/** Message id → the ids of the messages that reply to it, oldest first. */
export function replyIndex(messages: readonly Message[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const message of messages) {
    if (!message.replyToId || message.replyToId === message.id) continue;
    const list = index.get(message.replyToId);
    if (list) list.push(message.id);
    else index.set(message.replyToId, [message.id]);
  }
  return index;
}

/** Which reply a click on "N replies in thread" lands on: the first, then
 * each following one, wrapping around. */
export function nextReplyTarget(replies: readonly string[], lastFocused: string | null): string | undefined {
  if (!replies.length) return undefined;
  const at = lastFocused ? replies.indexOf(lastFocused) : -1;
  return replies[(at + 1) % replies.length];
}

// ── timed cards merged into the transcript ───────────────────────────────

/** Place cards that are not messages (dispatch runs, decisions) between the
 * transcript rows by time. Returns, per card, the index of the row it
 * follows (-1 = before the first row). Cards older than the first row are
 * dropped when earlier history is folded away, so they reappear with it. */
export function slotByTime<T extends { at: number }>(
  rowTimes: readonly number[],
  cards: readonly T[],
  options: { hasEarlier: boolean },
): Array<{ after: number; card: T }> {
  const sorted = [...cards].sort((a, b) => a.at - b.at);
  const placed: Array<{ after: number; card: T }> = [];
  for (const card of sorted) {
    let after = -1;
    for (let index = 0; index < rowTimes.length; index += 1) {
      if (rowTimes[index]! <= card.at) after = index;
      else break;
    }
    if (after === -1 && options.hasEarlier) continue;
    placed.push({ after, card });
  }
  return placed;
}

// ── dispatch runs ────────────────────────────────────────────────────────

export function isActiveRun(status: RunStatus): boolean {
  return status === "running" || status === "synthesizing";
}

/** "N running" in the header: this bot's dispatch runs still working. */
export function runningRunCount(runs: readonly DispatchRun[], botId: string): number {
  return runs.filter((run) => run.chiefBotId === botId && isActiveRun(run.status)).length;
}

/** The runs started from this conversation, oldest first. */
export function runsForThread(runs: readonly DispatchRun[], threadId: string): DispatchRun[] {
  return runs.filter((run) => run.sourceThreadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
}

export function runProgress(run: DispatchRun): { done: number; total: number; failed: number; running: number } {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const subtask of run.subtasks) {
    if (subtask.status === "done") done += 1;
    else if (subtask.status === "failed") failed += 1;
    else if (subtask.status === "running") running += 1;
  }
  return { done, total: run.subtasks.length, failed, running };
}

/** A stable fingerprint, so polling the same state does not re-render the
 * whole transcript. */
export function runsKey(runs: readonly DispatchRun[]): string {
  return runs
    .map((run) => `${run.id}:${run.status}:${run.updatedAt}:${run.subtasks.map((subtask) => subtask.status[0]).join("")}`)
    .join("|");
}

// ── the typing line ──────────────────────────────────────────────────────

/** "Chief is thinking" · "Chief is running a command" · "Chief is running
 * “Daily brief”" — the routine wins, because that is what the bot is on. */
export function typingLabel(name: string, state: { routine?: string | null; activity?: string | null }): string {
  if (state.routine) return t("{name} is running “{routine}”", { name, routine: state.routine });
  if (state.activity) return t("{name} · {activity}", { name, activity: state.activity });
  return t("{name} is thinking", { name });
}

// ── routines (the right-hand 定时任务 panel) ────────────────────────────

/** A routine and the others that are the same job at another time: same bot,
 * name and instructions. "+ Add another" creates one more of these, so the
 * panel edits them as one task with several times. */
export function routineSiblings(routines: readonly Routine[], routine: Routine): Routine[] {
  return routines
    .filter(
      (candidate) =>
        candidate.botId === routine.botId &&
        candidate.name.trim() === routine.name.trim() &&
        candidate.prompt.trim() === routine.prompt.trim(),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WORKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

function weekdayName(day: number): string {
  // 1 January 2023 was a Sunday
  return new Date(2023, 0, 1 + day).toLocaleDateString(intlLocale(), { weekday: "short" });
}

const sameDays = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && [...a].sort().every((day, index) => day === [...b].sort()[index]);

/** Which days a schedule runs on, as the short word the panel shows. */
export function scheduleDays(schedule: RoutineSchedule): string {
  if (schedule.type === "once") {
    return new Date(schedule.at).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
  }
  const days = schedule.weekdays;
  if (!days.length || sameDays(days, ALL_DAYS)) return t("Every day");
  if (sameDays(days, WORKDAYS)) return t("Weekdays");
  if (sameDays(days, WEEKEND)) return t("Weekends");
  return [...days].sort().map(weekdayName).join(t(", "));
}

/** The left side of a schedule row: "Daily 18:00" or "Once 18:00". */
export function scheduleTime(schedule: RoutineSchedule): string {
  if (schedule.type === "once") return t("Once {time}", { time: clockLabel(schedule.at) });
  return t("Daily {time}", { time: schedule.time });
}

export type DayChoice = "daily" | "weekdays" | "weekends" | "custom" | "once";

export function dayChoice(schedule: RoutineSchedule): DayChoice {
  if (schedule.type === "once") return "once";
  if (!schedule.weekdays.length || sameDays(schedule.weekdays, ALL_DAYS)) return "daily";
  if (sameDays(schedule.weekdays, WORKDAYS)) return "weekdays";
  if (sameDays(schedule.weekdays, WEEKEND)) return "weekends";
  return "custom";
}

/** Rebuild a schedule from the panel's controls. "custom" keeps the days it
 * already had; "once" lands on the next time that clock reading comes up. */
export function withDayChoice(schedule: RoutineSchedule, choice: DayChoice, now = Date.now()): RoutineSchedule {
  const time = schedule.type === "daily" ? schedule.time : clockLabel(schedule.at);
  if (choice === "once") return { type: "once", at: nextOccurrence(time, now) };
  const weekdays =
    choice === "daily"
      ? ALL_DAYS
      : choice === "weekdays"
        ? WORKDAYS
        : choice === "weekends"
          ? WEEKEND
          : schedule.type === "daily" && schedule.weekdays.length
            ? schedule.weekdays
            : ALL_DAYS;
  return { type: "daily", time, weekdays: [...weekdays] };
}

/** Same days, another clock time ("HH:MM"). */
export function withTime(schedule: RoutineSchedule, time: string, now = Date.now()): RoutineSchedule {
  if (!/^\d{2}:\d{2}$/.test(time)) return schedule;
  if (schedule.type === "once") return { type: "once", at: nextOccurrence(time, now) };
  return { ...schedule, time };
}

/** What a person typed into a time field → "HH:MM" (24-hour), or null:
 * "9:30", "0930", "18", "18：00" all read. */
export function normalizeTime(input: string): string | null {
  const match = /^\s*(\d{1,2})\s*[:：.]?\s*(\d{2})?\s*$/.exec(input);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The next moment a "HH:MM" clock reading comes around (today or tomorrow). */
export function nextOccurrence(time: string, now = Date.now()): number {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date(now);
  date.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** The default time for "+ Add another": an hour after the last one. */
export function anotherTime(schedule: RoutineSchedule): RoutineSchedule {
  const time = schedule.type === "daily" ? schedule.time : clockLabel(schedule.at);
  const [hours, minutes] = time.split(":").map(Number);
  const next = `${String(((hours ?? 0) + 1) % 24).padStart(2, "0")}:${String(minutes ?? 0).padStart(2, "0")}`;
  return schedule.type === "daily" ? { ...schedule, time: next } : { type: "daily", time: next, weekdays: [...ALL_DAYS] };
}

/** "Yesterday 18:00" · "Today 09:00" · "Tue 18:00" · "Oct 10 18:00". */
export function runTimeLabel(at: number, now = Date.now()): string {
  return `${dayLabel(at, now)} ${clockLabel(at)}`;
}

/** One line about a run for the history list. */
export function runSummary(run: RoutineRun): string {
  const source =
    run.status === "failed" || run.status === "missed"
      ? (run.error ?? run.output)
      : run.status === "waiting"
        ? (run.attention ?? run.output)
        : (run.output ?? run.error);
  const line = (source ?? "")
    .split("\n")
    .map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}
