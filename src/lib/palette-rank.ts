// Ranking, matching and labels for the ⌘K palette. Pure, so the rules that
// decide what shows up (and in which order) are testable without React.
import { intlLocale, t } from "@/lib/i18n";
import { addDays, startOfDay } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";

/** Ranking for the command palette's name lists (bots, rooms).
 *
 * A prefix match is almost always what a few typed letters mean, so those
 * rows outrank plain substring matches. Within each tier the input order is
 * preserved — the caller's list already encodes a meaningful order (pinned
 * first, recency, …) and re-sorting it here would fight that. */
export function rankByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
  return rankByFields(items, query, (item) => item.name, () => []);
}

/** rankByName plus a third tier: rows whose other fields (title, description,
 * prompt …) contain the query. Input order is kept within each tier. */
export function rankByFields<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string,
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
): T[] {
  const q = query.trim().toLowerCase();
  // empty query = switcher mode: everything, untouched
  if (!q) return [...items];
  const prefix: T[] = [];
  const substring: T[] = [];
  const elsewhere: T[] = [];
  for (const item of items) {
    const label = name(item).toLowerCase();
    if (label.startsWith(q)) prefix.push(item);
    else if (label.includes(q)) substring.push(item);
    else if (fields(item).some((field) => field?.toLowerCase().includes(q))) elsewhere.push(item);
  }
  return [...prefix, ...substring, ...elsewhere];
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** Split text around every case-insensitive occurrence of the query, for
 * <mark>-ing them. Texts whose lower case changes length fall back to an
 * exact-case search so offsets stay right. */
export function highlightParts(text: string, query: string): TextPart[] {
  const q = query.trim();
  if (!q || !text) return [{ text, match: false }];
  const foldable = text.toLowerCase().length === text.length && q.toLowerCase().length === q.length;
  const haystack = foldable ? text.toLowerCase() : text;
  const needle = foldable ? q.toLowerCase() : q;
  const parts: TextPart[] = [];
  let cursor = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/** One line of `text` around its first match, so a hit deep inside a long
 * prompt still shows in a one-line row. */
export function excerptAround(text: string, query: string, radius = 22): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const q = query.trim().toLowerCase();
  const index = q ? flat.toLowerCase().indexOf(q) : -1;
  const width = radius * 2 + q.length;
  if (flat.length <= width) return flat;
  if (index < 0) return `${flat.slice(0, width)}…`;
  const start = Math.max(0, Math.min(index - radius, flat.length - width));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export type PaletteCategory = "all" | "bots" | "groups" | "messages" | "files" | "routines";
export const PALETTE_CATEGORIES: readonly PaletteCategory[] = ["all", "bots", "groups", "messages", "files", "routines"];

/** Rows per category on the "all" tab; the category's own tab lists everything. */
export const ALL_TAB_LIMITS: Readonly<Record<Exclude<PaletteCategory, "all">, number>> = {
  bots: 5,
  groups: 4,
  messages: 3,
  files: 4,
  routines: 3,
};

/** Tab / Shift+Tab: the next category, wrapping around. */
export function cycleCategory(current: PaletteCategory, direction: 1 | -1): PaletteCategory {
  const index = PALETTE_CATEGORIES.indexOf(current);
  const next = (index + direction + PALETTE_CATEGORIES.length) % PALETTE_CATEGORIES.length;
  return PALETTE_CATEGORIES[next]!;
}

/** "Weekdays 09:00", "Every day 18:00", "Mon, Wed 10:00", or the one date. */
export function routineScheduleLabel(schedule: RoutineSchedule): string {
  const locale = intlLocale();
  if (schedule.type === "once") {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(schedule.at);
  }
  const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  const time = schedule.time;
  if (days.length === 7) return t("Every day {time}", { time });
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return t("Weekdays {time}", { time });
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return t("Weekends {time}", { time });
  // 2024-09-01 was a Sunday: day n of that week names weekday n
  const names = days.map((day) => new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 8, 1 + day)));
  const list = new Intl.ListFormat(locale, { style: "narrow", type: "conjunction" }).format(names);
  return t("{days} {time}", { days: list, time });
}

/** "Next today 18:00", "Next tomorrow 09:00", or "Next Oct 20 09:00". */
export function nextRunLabel(at: number | null | undefined, now = Date.now()): string {
  if (!at || !Number.isFinite(at)) return "";
  const locale = intlLocale();
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  const day = startOfDay(at);
  const today = startOfDay(now);
  if (day === today) return t("Next today {time}", { time });
  if (day === addDays(today, 1)) return t("Next tomorrow {time}", { time });
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
  return t("Next {date} {time}", { date, time });
}
