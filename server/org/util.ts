// Small helpers shared by the company-layer modules (server/org/*): clipping
// text to one short line, local day/week boundaries, and the structural
// shapes of the harness records the org layer reads. The shapes are a subset
// of server/store.ts's records, so the real store satisfies them and tests
// can hand in plain objects.
import { existsSync, readFileSync } from "node:fs";

/** Clip to `max` characters (code points, so an emoji is never cut in half). */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : chars.join("");
}

/** The first non-empty line, clipped — event titles are one short line. */
export function firstLine(text: string | undefined | null, max = 60): string {
  const line = (text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? clip(line, max) : "";
}

/** Local midnight of the day `now` falls in. */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local Monday 00:00 of the week `now` falls in. */
export function startOfWeek(now: number): number {
  const date = new Date(startOfDay(now));
  const sinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - sinceMonday);
  return date.getTime();
}

/** "16:52" in local time. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Parsed JSON of a file, or undefined when it is missing or unreadable. */
export function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Trimmed section label; "" is the unsectioned list. */
export const sectionOf = (section?: string | null): string => section?.trim() || "";

export const round2 = (value: number): number => Math.round(value * 100) / 100;

// ── what the org layer reads from the harness ────────────────────────────────

export interface OrgCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  allowKey?: string;
  /** the rule that sent this card to the owner (already in the app's language) */
  rule?: string;
  /** the decision (决议 #n) answering this card produced */
  decisionId?: number;
  routineRequest?: unknown;
  skillRequest?: unknown;
}

export interface OrgMessage {
  id: string;
  role: "bot" | "user";
  kind: string;
  at: number;
  text?: string;
  card?: OrgCard;
  from?: { botId: string; name?: string };
}

export interface OrgTask {
  threadId: string;
  title?: string;
  createdAt?: number;
}

export interface OrgBot {
  id: string;
  name: string;
  threadId: string;
  tasks?: OrgTask[];
  section?: string;
  chiefOfStaff?: boolean;
  hidden?: boolean;
  busy?: boolean;
  activity?: string;
  createdAt?: number;
}

export interface OrgGroup {
  id: string;
  name: string;
  threadId: string;
  tasks?: OrgTask[];
  memberIds: string[];
  dm?: boolean;
  section?: string;
  busyBotId?: string | null;
}

/** Every conversation a bot owns: its active thread and every task's. */
export function botThreads(bot: Pick<OrgBot, "threadId" | "tasks">): string[] {
  return [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])];
}

/** Every conversation of a room: its active thread and every task's. */
export function groupThreads(group: Pick<OrgGroup, "threadId" | "tasks">): string[] {
  return [...new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])];
}
