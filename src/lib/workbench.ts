// Workbench (工作台) model — pure functions the two views render:
//   看人  peopleStates() turns bots + dispatch runs + the inbox into a pose, a
//         status line and a speech bubble per bot; layoutFloor() packs the
//         department rooms into rows.
//   看事  layoutTree() places departments → people → outputs in columns and
//         keeps every node on the row it was given (a persistent slot map), so
//         adding people never moves the nodes already on screen.
//   both  compressDay() for the day timeline, projectOf()/parseDeadline() for
//         the header, buildWires() for dispatch routes, view math, undo.
import type { DispatchRoute, DispatchRun, DispatchSquad, DispatchSubtask } from "../../shared/dispatch-types";
import type { Brief, BriefDepartment, Health, InboxItem, OrgEvent } from "../../shared/org-types";
import { MASCOT_KINDS, poseForStatus, type MascotKind, type MascotPose, type MascotStatus } from "./engine-mascots";
import { formatDateTime, t } from "./i18n";
import type { TeamMapSnapshot } from "./team-map";

export interface WorkbenchBot {
  id: string;
  name: string;
  section?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  /** sent by the server on every bot; absent on very old records */
  createdAt?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface NodeBox extends Point {
  width: number;
  height: number;
}

// ── small formatting helpers ────────────────────────────────────────────────

const MIN = 60_000;

/** "16:52" in the app's language (24-hour clock). */
export function clock(at: number): string {
  return formatDateTime(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "刚刚" / "18 分前" / "3 小时前" / a date. */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / MIN));
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{count}m ago", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{count}h ago", { count: hours });
  return formatDateTime(at, { month: "numeric", day: "numeric" });
}

/** Cut a line to `max` characters with an ellipsis (CJK counts one each). */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

export const isActiveRun = (run: Pick<DispatchRun, "status">) =>
  run.status === "running" || run.status === "awaiting-approval" || run.status === "synthesizing";

const newestFirst = (runs: readonly DispatchRun[]) => [...runs].sort((a, b) => b.createdAt - a.createdAt);

// ── the header: current project and its deadline ────────────────────────────

/** The newest top-level run still in progress — the project the workbench is
 * about. A department lead's own plan (parentRunId) is part of its parent. */
export function activeRun(runs: readonly DispatchRun[]): DispatchRun | undefined {
  return newestFirst(runs).find((run) => isActiveRun(run) && !run.parentRunId);
}

/** A subtask a lead handed to its own team is a container: the child run's
 * subtasks are the real work, so counts skip it. */
export const isLeafSubtask = (subtask: Pick<DispatchSubtask, "childRunId">) => !subtask.childRunId;

/** Squads added to running jobs that are still together, by member. */
export function activeSquads(runs: readonly DispatchRun[]): Map<string, { squad: DispatchSquad; run: DispatchRun }> {
  const out = new Map<string, { squad: DispatchSquad; run: DispatchRun }>();
  for (const run of runs) {
    if (!isActiveRun(run)) continue;
    for (const squad of run.squads ?? []) {
      if (squad.endedAt) continue;
      for (const botId of squad.botIds) out.set(botId, { squad, run });
    }
  }
  return out;
}

/** The project title: the active run's goal (first line), else null. */
export function projectTitle(runs: readonly DispatchRun[]): string | null {
  const run = activeRun(runs);
  if (!run) return null;
  const line = run.goal.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return line ? clip(line.replace(/^DISPATCH_PLAN\s+/, ""), 28) : null;
}

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** A deadline written in the goal: "周五 19:30", "明天 18:00", "10月18日 9:00",
 * "today 17:30". Returns the next such moment after `now`, or null. */
export function parseDeadline(text: string, now: number): number | null {
  const at = (day: Date, hour: number, minute: number) => {
    const out = new Date(day);
    out.setHours(hour, minute, 0, 0);
    return out.getTime();
  };
  const base = new Date(now);
  let match = /(今天|明天|后天|today|tomorrow)\s*(\d{1,2})[:：](\d{2})/i.exec(text);
  if (match) {
    const shift = /明天|tomorrow/i.test(match[1]) ? 1 : match[1] === "后天" ? 2 : 0;
    const day = new Date(base);
    day.setDate(day.getDate() + shift);
    return at(day, Number(match[2]), Number(match[3]));
  }
  match = /(?:周|星期|礼拜)([日天一二三四五六])\s*(?:晚上|下午|上午|早上)?\s*(\d{1,2})[:：](\d{2})/.exec(text);
  if (match) {
    const target = WEEKDAY[match[1]] ?? 0;
    const day = new Date(base);
    let diff = (target - day.getDay() + 7) % 7;
    const sameDay = at(day, Number(match[2]), Number(match[3]));
    if (diff === 0 && sameDay <= now) diff = 7;
    day.setDate(day.getDate() + diff);
    return at(day, Number(match[2]), Number(match[3]));
  }
  match = /(\d{1,2})月(\d{1,2})[日号]\s*(?:(\d{1,2})[:：](\d{2}))?/.exec(text);
  if (match) {
    const day = new Date(base.getFullYear(), Number(match[1]) - 1, Number(match[2]));
    const when = at(day, match[3] ? Number(match[3]) : 18, match[4] ? Number(match[4]) : 0);
    return when > now ? when : null;
  }
  return null;
}

/** The deadline of a run: an explicit numeric field if the server sends one,
 * else one written in its goal. */
export function runDeadline(run: DispatchRun | undefined, now: number): number | null {
  if (!run) return null;
  const extra = run as DispatchRun & { deadline?: unknown; dueAt?: unknown };
  for (const value of [extra.deadline, extra.dueAt]) if (typeof value === "number" && Number.isFinite(value)) return value;
  return parseDeadline(run.goal, now);
}

// ── 看人: what each bot is doing, as a pose ─────────────────────────────────

export type PersonStatus =
  | "leading"
  | "overseeing"
  | "working"
  | "waiting"
  | "stuck"
  | "failed"
  | "disagree"
  | "delivered"
  | "done"
  | "blocked"
  | "queued"
  | "idle";

export type Tone = "blue" | "amber" | "red" | "green" | "grey";

export interface PersonState {
  botId: string;
  status: PersonStatus;
  pose: MascotPose;
  tone: Tone;
  /** the status line under the name */
  line: string;
  /** what floats over the head when the bot needs attention */
  bubble?: { tone: "amber" | "red" | "grey"; lines: string[] };
  /** idle and queued figures are drawn faded */
  dim: boolean;
  /** joined since the owner last looked, or created for a running job */
  isNew: boolean;
  /** when the current state began (stuck since, waiting since …) */
  since?: number;
  subtask?: DispatchSubtask;
  run?: DispatchRun;
  inbox?: InboxItem;
}

const MASCOT_STATUS: Record<PersonStatus, MascotStatus> = {
  leading: "leading",
  overseeing: "leading",
  working: "working",
  waiting: "waiting",
  stuck: "stuck",
  failed: "failed",
  disagree: "disagree",
  delivered: "done",
  done: "idle",
  blocked: "queued",
  queued: "queued",
  idle: "idle",
};

export function poseOf(status: PersonStatus): MascotPose {
  return poseForStatus(MASCOT_STATUS[status]);
}

export interface PeopleInput {
  bots: readonly WorkbenchBot[];
  runs: readonly DispatchRun[];
  inbox: readonly InboxItem[];
  risks?: Brief["risks"];
  chiefId?: string;
  /** department leads (chief of staff of a section) */
  leads?: ReadonlySet<string>;
  /** sections with work in flight — their idle leads are shown overseeing it */
  busySections?: ReadonlyMap<string, { done: number; total: number }>;
  /** the bot's current conversation title, for work started outside dispatch */
  taskTitle?: (botId: string) => string | undefined;
  maxAttempts: number;
  lastSeen: number;
  now: number;
}

/** A disagreement is reported as a risk; the contract has no kind for it yet,
 * so it is recognised by its words. */
const DISAGREEMENT = /分歧|矛盾|冲突|disagree|conflict/i;
export const JUST_DELIVERED_MS = 30 * MIN;
const RECENT_FAILURE_MS = 6 * 60 * MIN;

export function peopleStates(input: PeopleInput): Map<string, PersonState> {
  const { now } = input;
  const runs = newestFirst(input.runs);
  const out = new Map<string, PersonState>();
  const subtaskById = new Map<string, DispatchSubtask>();
  for (const run of runs) for (const subtask of run.subtasks) subtaskById.set(`${run.id}:${subtask.id}`, subtask);

  for (const bot of input.bots) {
    if (bot.hidden) continue;
    const mine = runs.flatMap((run) => run.subtasks.filter((subtask) => subtask.assigneeBotId === bot.id).map((subtask) => ({ run, subtask })));
    const createdForActiveRun = mine.some(({ run, subtask }) => subtask.createdBot && isActiveRun(run));
    const isNew = (input.lastSeen > 0 && (bot.createdAt ?? 0) > input.lastSeen) || createdForActiveRun;
    const base = { botId: bot.id, isNew };
    const set = (state: Omit<PersonState, "botId" | "isNew" | "pose"> & { pose?: MascotPose }) =>
      out.set(bot.id, { ...base, pose: state.pose ?? poseOf(state.status), ...state });

    const escalation = input.inbox.find((item) => item.kind === "escalation" && (item.chain?.[0]?.botId ?? item.botId) === bot.id);
    const asking = input.inbox.find((item) => item.kind !== "escalation" && item.botId === bot.id);
    const running = mine.find(({ subtask }) => subtask.status === "running");
    const retrying = mine.find(({ run, subtask }) => subtask.status === "pending" && subtask.error && subtask.attempts > 0 && isActiveRun(run));
    const failed = mine.find(
      ({ run, subtask }) => subtask.status === "failed" && run.status !== "canceled" && now - (subtask.finishedAt ?? run.updatedAt) < RECENT_FAILURE_MS,
    );
    const pending = mine.find(({ run, subtask }) => subtask.status === "pending" && isActiveRun(run));
    const done = mine
      .filter(({ subtask }) => subtask.status === "done" && subtask.finishedAt)
      .sort((a, b) => (b.subtask.finishedAt ?? 0) - (a.subtask.finishedAt ?? 0))[0];
    const disagreement = input.risks?.find((risk) => risk.botId === bot.id && DISAGREEMENT.test(`${risk.title} ${risk.detail}`));
    // the work a waiting or stuck bot was on, so its node still shows the report
    const current = running ?? retrying ?? pending ?? failed ?? done;

    if (escalation) {
      const since = escalation.chain?.[0]?.at ?? escalation.since;
      const minutes = Math.max(1, Math.round((now - since) / MIN));
      set({
        status: "stuck",
        tone: "amber",
        line: t("Stuck {count} min", { count: minutes }),
        bubble: { tone: "amber", lines: [clip(escalation.title, 8), t("Sent up to you")] },
        dim: false,
        since,
        inbox: escalation,
        subtask: current?.subtask,
        run: current?.run,
      });
      continue;
    }
    if (asking) {
      const verb = asking.kind === "approval" ? t("Needs your OK") : t("Needs your pick");
      set({
        status: "waiting",
        tone: "amber",
        line: verb,
        bubble: { tone: "amber", lines: [clip(asking.title, 10), verb] },
        dim: false,
        since: asking.since,
        inbox: asking,
        subtask: current?.subtask,
        run: current?.run,
      });
      continue;
    }
    if (bot.activity === "dead" || bot.activity === "no-signal") {
      set({ status: "failed", tone: "red", line: t("No signal"), dim: false });
      continue;
    }
    if (retrying) {
      const { subtask, run } = retrying;
      set({
        status: "failed",
        tone: "red",
        line: t("Failed · retrying"),
        bubble: { tone: "red", lines: [clip(subtask.error ?? subtask.title, 9), t("Retry {attempt}/{max}", { attempt: subtask.attempts, max: input.maxAttempts })] },
        dim: false,
        subtask,
        run,
      });
      continue;
    }
    if (failed && !running) {
      const { subtask, run } = failed;
      set({
        status: "failed",
        tone: "red",
        line: t("Failed"),
        bubble: { tone: "red", lines: [clip(subtask.title, 9), clip(subtask.error ?? t("Did not finish"), 9)] },
        dim: false,
        since: subtask.finishedAt,
        subtask,
        run,
      });
      continue;
    }
    if (disagreement && bot.id !== input.chiefId) {
      set({
        status: "disagree",
        tone: "red",
        line: clip(disagreement.title, 10),
        bubble: { tone: "red", lines: [clip(disagreement.title, 9), clip(disagreement.detail, 9)].filter(Boolean) },
        dim: false,
        subtask: current?.subtask,
        run: current?.run,
      });
      continue;
    }
    if (bot.id === input.chiefId) {
      const inFlight = runs.filter(isActiveRun).reduce((sum, run) => sum + run.subtasks.filter((subtask) => subtask.status === "running" && isLeafSubtask(subtask)).length, 0);
      set({
        status: "leading",
        tone: inFlight || bot.busy ? "blue" : "grey",
        line: inFlight ? t("{count} running · main bot", { count: inFlight }) : t("Main bot"),
        dim: false,
      });
      continue;
    }
    if (running) {
      const { subtask, run } = running;
      set({
        status: "working",
        tone: "blue",
        line: subtask.attempts > 1 ? t("Retrying · {title}", { title: clip(subtask.title, 8) }) : clip(subtask.title, 11),
        dim: false,
        since: subtask.startedAt,
        subtask,
        run,
      });
      continue;
    }
    if (bot.busy || bot.activity === "working") {
      const title = input.taskTitle?.(bot.id);
      set({ status: "working", tone: "blue", line: title ? clip(title, 11) : t("Busy"), dim: false });
      continue;
    }
    if (bot.activity === "waiting-on-you") {
      set({ status: "waiting", tone: "amber", line: t("Waiting for you"), bubble: { tone: "amber", lines: [t("Waiting for you")] }, dim: false });
      continue;
    }
    if (pending) {
      const { subtask, run } = pending;
      const blocker = subtask.dependsOn
        .map((id) => subtaskById.get(`${run.id}:${id}`))
        .find((dependency) => dependency && dependency.status !== "done");
      if (blocker) {
        set({
          status: "blocked",
          tone: "grey",
          line: t("Waiting on {title}", { title: clip(blocker.title, 7) }),
          bubble: { tone: "grey", lines: [t("Waiting for “{title}”", { title: clip(blocker.title, 6) }), t("before starting")] },
          dim: false,
          subtask,
          run,
        });
      } else {
        set({ status: "queued", tone: "grey", line: t("Queued"), dim: true, subtask, run });
      }
      continue;
    }
    if (done && now - (done.subtask.finishedAt ?? 0) < JUST_DELIVERED_MS) {
      set({ status: "delivered", tone: "green", line: t("{title} delivered", { title: clip(done.subtask.title, 8) }), dim: false, since: done.subtask.finishedAt, subtask: done.subtask, run: done.run });
      continue;
    }
    const lead = input.leads?.has(bot.id);
    const busySection = lead ? input.busySections?.get(bot.section?.trim() ?? "") : undefined;
    if (busySection) {
      set({ status: "overseeing", tone: "blue", line: t("Tracking {done}/{total}", busySection), dim: false });
      continue;
    }
    if (done && sameDay(done.subtask.finishedAt ?? 0, now)) {
      set({ status: "done", tone: "green", line: t("{time} delivered", { time: clock(done.subtask.finishedAt ?? 0) }), dim: false, subtask: done.subtask, run: done.run });
      continue;
    }
    set({ status: "idle", tone: "grey", line: t("Idle"), dim: true });
  }
  return out;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Counts for the "today" card: working / waiting on you / in trouble / idle. */
export function headcount(states: Iterable<PersonState>) {
  const out = { working: 0, waiting: 0, trouble: 0, idle: 0 };
  for (const state of states) {
    if (state.status === "working" || state.status === "leading" || state.status === "overseeing") out.working += 1;
    else if (state.status === "waiting" || state.status === "stuck") out.waiting += 1;
    else if (state.status === "failed" || state.status === "disagree") out.trouble += 1;
    else out.idle += 1;
  }
  return out;
}

// ── department numbers (the brief's when it has them, else from runs) ──────

export interface DeptStats {
  section: string;
  done: number;
  total: number;
  health: Health | null;
  lastReportAt?: number;
  status?: string;
  waiting: number;
  stuck: number;
  failed: number;
  disagree: number;
}

export function departmentStats(
  sections: ReadonlyArray<{ section: string; botIds: readonly string[] }>,
  runs: readonly DispatchRun[],
  states: ReadonlyMap<string, PersonState>,
  brief?: readonly BriefDepartment[],
): Map<string, DeptStats> {
  const out = new Map<string, DeptStats>();
  for (const { section, botIds } of sections) {
    const ids = new Set(botIds);
    const subtasks = runs
      .filter((run) => isActiveRun(run) || run.status === "done")
      .flatMap((run) => run.subtasks.filter((subtask) => ids.has(subtask.assigneeBotId) && isLeafSubtask(subtask) && subtask.status !== "canceled" && subtask.status !== "skipped"));
    const people = botIds.map((id) => states.get(id)).filter((state): state is PersonState => Boolean(state));
    const count = (status: PersonStatus) => people.filter((state) => state.status === status).length;
    const derived: DeptStats = {
      section,
      done: subtasks.filter((subtask) => subtask.status === "done").length,
      total: subtasks.length,
      health: null,
      lastReportAt: Math.max(0, ...subtasks.map((subtask) => subtask.finishedAt ?? subtask.startedAt ?? 0)) || undefined,
      waiting: count("waiting"),
      stuck: count("stuck"),
      failed: count("failed"),
      disagree: count("disagree"),
    };
    if (derived.total || people.some((state) => state.status !== "idle")) {
      derived.health = derived.failed || derived.stuck ? "red" : derived.waiting || derived.disagree || count("blocked") ? "yellow" : "green";
    }
    const reported = brief?.find((entry) => entry.section === section);
    if (reported) {
      derived.done = reported.done;
      derived.total = reported.total;
      derived.health = reported.health;
      derived.lastReportAt = reported.lastReportAt ?? derived.lastReportAt;
      derived.status = reported.status;
    }
    out.set(section, derived);
  }
  return out;
}

// ── 看人: the floor plan ─────────────────────────────────────────────────────

export const FLOOR = {
  left: 34,
  right: 16,
  gap: 14,
  bandTop: 14,
  bandHeight: 184,
  /** rooms start under the band and the 指派 bus */
  roomsTop: 226,
  roomHeight: 224,
  /** extra line inside a room when its groups wrap */
  lineHeight: 186,
  pad: 10,
  cellMin: 92,
  cellMax: 124,
  subGap: 12,
  subPad: 8,
  /** figures stand this far below the room's top edge (bubbles use the space above) */
  figureTop: 74,
  subTop: 40,
  sideWidth: 300,
  timelineHeight: 110,
} as const;

export interface FloorRoomInput {
  key: string;
  /** figures per group: [lead + first squad, second squad, …] */
  groups: readonly number[];
  isolated?: boolean;
}

export interface FloorGroupBox extends NodeBox {
  /** squads after the first are drawn as dashed sub-rooms */
  boxed: boolean;
  /** which group of the room (0 = the lead's) and the index of its first figure */
  squad: number;
  offset: number;
  /** centre x and top y of each figure, in order */
  cells: Point[];
}

export interface FloorRoomBox extends NodeBox {
  key: string;
  row: number;
  isolated: boolean;
  groups: FloorGroupBox[];
}

export interface FloorPlan {
  width: number;
  rooms: FloorRoomBox[];
  side: NodeBox | null;
  /** y of each row's top edge */
  rows: number[];
  /** bottom of the last row */
  bottom: number;
}

const groupMin = (count: number, boxed: boolean) => (boxed ? FLOOR.subPad * 2 : 0) + count * FLOOR.cellMin;

/** Lines of groups inside a room that is `inner` wide (groups wrap, and one
 * group wider than a line is split across lines). */
type LinePart = { index: number; offset: number; count: number; boxed: boolean };

function roomLines(groups: readonly number[], inner: number): LinePart[][] {
  const lines: LinePart[][] = [[]];
  let used = 0;
  groups.forEach((count, index) => {
    const boxed = index > 0;
    let left = count;
    while (left > 0) {
      const line = lines[lines.length - 1]!;
      const gap = line.length ? FLOOR.subGap : 0;
      const room = inner - used - gap - (boxed ? FLOOR.subPad * 2 : 0);
      const fits = Math.floor(room / FLOOR.cellMin);
      if (fits < Math.min(left, 2) && line.length) {
        // start the group on a fresh line rather than leave one figure behind
        lines.push([]);
        used = 0;
        continue;
      }
      const take = Math.max(1, Math.min(left, fits));
      line.push({ index, offset: count - left, count: take, boxed });
      used += gap + groupMin(take, boxed);
      left -= take;
      if (left > 0) {
        lines.push([]);
        used = 0;
      }
    }
  });
  return lines.filter((line) => line.length);
}

function roomMinWidth(room: FloorRoomInput, avail: number): number {
  const natural = FLOOR.pad * 2 + room.groups.reduce((sum, count, index) => sum + (index ? FLOOR.subGap : 0) + groupMin(count, index > 0), 0);
  // an empty department still gets a room wide enough for its name
  return Math.min(avail, Math.max(natural, 200));
}

/** Pack department rooms (and the library/meeting column) into rows, first
 * fit in their stable order, then widen the rooms of each row to fill it. */
export function layoutFloor(rooms: readonly FloorRoomInput[], width: number, withSide = true): FloorPlan {
  const avail = Math.max(320, width - FLOOR.left - FLOOR.right);
  type Item = { key: string; min: number; room?: FloorRoomInput };
  const items: Item[] = rooms.map((room) => ({ key: room.key, min: roomMinWidth(room, avail), room }));
  if (withSide) items.push({ key: "__side__", min: Math.min(FLOOR.sideWidth, avail) });
  const rows: Array<{ items: Item[]; used: number }> = [];
  for (const item of items) {
    let row = rows.find((candidate) => candidate.used + FLOOR.gap + item.min <= avail);
    if (!row) {
      row = { items: [], used: -FLOOR.gap };
      rows.push(row);
    }
    row.items.push(item);
    row.used += FLOOR.gap + item.min;
  }

  const plan: FloorPlan = { width, rooms: [], side: null, rows: [], bottom: FLOOR.roomsTop };
  let y = FLOOR.roomsTop;
  rows.forEach((row, rowIndex) => {
    const roomsInRow = row.items.filter((item) => item.room);
    const spare = Math.max(0, avail - row.used);
    const cells = roomsInRow.reduce((sum, item) => sum + item.room!.groups.reduce((a, b) => a + b, 0), 0) || 1;
    // widen rooms by figure count, capped so a small room never sprawls
    const widths = new Map<string, number>();
    for (const item of roomsInRow) {
      const figures = item.room!.groups.reduce((a, b) => a + b, 0);
      const cap = FLOOR.pad * 2 + item.room!.groups.reduce((sum, count, index) => sum + (index ? FLOOR.subGap + FLOOR.subPad * 2 : 0) + count * FLOOR.cellMax, 0);
      widths.set(item.key, Math.min(Math.max(item.min, cap), item.min + (spare * figures) / cells));
    }
    let x = FLOOR.left;
    let rowHeight: number = FLOOR.roomHeight;
    for (const item of row.items) {
      if (!item.room) {
        // the side column sits at the right edge of its row
        const sideX = FLOOR.left + avail - item.min;
        plan.side = { x: Math.max(x, sideX), y, width: item.min, height: FLOOR.roomHeight };
        continue;
      }
      const w = widths.get(item.key) ?? item.min;
      const box = placeRoom(item.room, x, y, w, rowIndex);
      rowHeight = Math.max(rowHeight, box.height);
      plan.rooms.push(box);
      x += w + FLOOR.gap;
    }
    plan.rows.push(y);
    // rooms in a row share the row's height so the floor reads as a grid
    for (const box of plan.rooms) if (box.row === rowIndex) box.height = rowHeight;
    y += rowHeight + FLOOR.gap;
  });
  plan.bottom = y - FLOOR.gap;
  return plan;
}

function placeRoom(room: FloorRoomInput, x: number, y: number, w: number, row: number): FloorRoomBox {
  const inner = w - FLOOR.pad * 2;
  const lines = roomLines(room.groups, inner);
  const groups: FloorGroupBox[] = [];
  lines.forEach((line, lineIndex) => {
    const minUsed = line.reduce((sum, part, index) => sum + (index ? FLOOR.subGap : 0) + groupMin(part.count, part.boxed), 0);
    const spare = Math.max(0, inner - minUsed);
    const figures = line.reduce((sum, part) => sum + part.count, 0) || 1;
    let gx = x + FLOOR.pad;
    const lineTop = y + lineIndex * FLOOR.lineHeight;
    for (const part of line) {
      const gw = groupMin(part.count, part.boxed) + (spare * part.count) / figures;
      const pad = part.boxed ? FLOOR.subPad : 0;
      const cellW = (gw - pad * 2) / part.count;
      groups.push({
        x: gx,
        y: part.boxed ? lineTop + FLOOR.subTop : lineTop,
        width: gw,
        height: part.boxed ? FLOOR.roomHeight - FLOOR.subTop - 6 : FLOOR.roomHeight,
        boxed: part.boxed,
        squad: part.index,
        offset: part.offset,
        cells: Array.from({ length: part.count }, (_, i) => ({ x: gx + pad + cellW * (i + 0.5), y: lineTop + FLOOR.figureTop })),
      });
      gx += gw + FLOOR.subGap;
    }
  });
  return { key: room.key, row, isolated: Boolean(room.isolated), x, y, width: w, height: FLOOR.roomHeight + (lines.length - 1) * FLOOR.lineHeight, groups };
}

/** Rough rendered width of a label: CJK full width, Latin about 0.6 em —
 * erring wide, so a neighbour is never assumed narrower than it draws. */
export const labelWidth = (text: string, fontSize: number) => Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! > 0x2e80 ? fontSize : fontSize * 0.62), 0);

/** How wide each label under a row of figures may be. Every label gets its
 * cell (pitch − 4); a longer one may spill into the room its neighbours leave
 * free (the ends toward the room's padding), so labels never overlap and a
 * long English name next to short ones still reads in full. */
export function labelRoom(natural: readonly number[], pitch: number, edge = 10, max = 156): number[] {
  const base = pitch - 4;
  const fitted = natural.map((width) => Math.min(width, base));
  const space = (neighbour: number | undefined) => (neighbour === undefined ? pitch / 2 + edge - 3 : pitch - neighbour / 2 - 3);
  return natural.map((width, index) => (width <= base ? base : Math.max(base, Math.min(max, 2 * Math.min(space(fitted[index - 1]), space(fitted[index + 1]))))));
}

// ── 看事: the work tree with a persistent slot map ──────────────────────────

export const TREE = {
  top: 20,
  root: { x: 8, width: 160, height: 76 },
  bus1: 182,
  dept: { x: 196, width: 230, height: 58 },
  bus2: 440,
  child: { x: 454, width: 230 },
  task: { x: 706, width: 214, height: 34 },
  rowHeight: 34,
  squadHeight: 46,
  childGap: 8,
  /** space under a department node for its report rule, kept in every lens */
  ruleSpace: 26,
  bandGap: 18,
  decision: { width: 164, height: 54, gap: 10 },
} as const;

export type TreeNodeKind = "root" | "decision" | "dept" | "child" | "task";

export interface TreeInputChild {
  key: string;
  /** a squad node is taller (two lines) */
  squad?: boolean;
}

export interface TreeInputDept {
  key: string;
  children: readonly TreeInputChild[];
  /** outputs (tasks from decisions) hanging off a child, by child key */
  tasks?: ReadonlyArray<{ key: string; parent: string }>;
}

export interface TreeInput {
  departments: readonly TreeInputDept[];
  decisions: readonly string[];
}

export interface TreeLayout {
  nodes: Record<string, NodeBox & { kind: TreeNodeKind }>;
  /** each department's vertical band (for the isolated zone and hulls) */
  bands: Record<string, { top: number; bottom: number }>;
  /** the y of every node, to be saved and passed back next time */
  slots: Record<string, number>;
  frames: never[];
}

/** Place the tree. `previous` is the slot map from the last layout: every
 * node that has a slot keeps it, new nodes go after their siblings, and a
 * department band only moves down when the band above it needs the room. */
export function layoutTree(input: TreeInput, previous: Readonly<Record<string, number>> = {}): TreeLayout {
  const nodes: TreeLayout["nodes"] = {};
  const bands: TreeLayout["bands"] = {};
  const slots: Record<string, number> = {};
  const childHeight = (child: TreeInputChild) => (child.squad ? TREE.squadHeight : TREE.rowHeight);
  let cursor = TREE.top;

  for (const dept of input.departments) {
    const keys = [dept.key, ...dept.children.map((child) => child.key), ...(dept.tasks ?? []).map((task) => task.key)];
    const known = keys.map((key) => previous[key]).filter((value): value is number => Number.isFinite(value));
    // a band moves only down, and only as far as the band above pushes it
    const delta = known.length ? Math.max(0, cursor - Math.min(...known)) : 0;
    const want = (key: string) => (Number.isFinite(previous[key]) ? previous[key]! + delta : undefined);

    const deptWant = want(dept.key);
    const deptY = deptWant !== undefined && deptWant >= cursor ? deptWant : cursor;
    nodes[dept.key] = { kind: "dept", x: TREE.dept.x, y: deptY, width: TREE.dept.width, height: TREE.dept.height };

    // children: remembered ones keep their row; new ones go after the lowest
    const firstRow = deptY + (TREE.dept.height - TREE.rowHeight) / 2;
    const placed: Array<{ key: string; y: number; h: number }> = [];
    const remembered = dept.children.filter((child) => want(child.key) !== undefined);
    const fresh = dept.children.filter((child) => want(child.key) === undefined);
    let floor = firstRow;
    for (const child of [...remembered].sort((a, b) => want(a.key)! - want(b.key)!)) {
      const h = childHeight(child);
      const y = Math.max(want(child.key)!, floor);
      placed.push({ key: child.key, y, h });
      floor = y + h + TREE.childGap;
    }
    for (const child of fresh) {
      const h = childHeight(child);
      placed.push({ key: child.key, y: floor, h });
      floor += h + TREE.childGap;
    }
    for (const { key, y, h } of placed) nodes[key] = { kind: "child", x: TREE.child.x, y, width: TREE.child.width, height: h };

    // outputs sit beside their parent, stacking down when a parent has several
    let taskFloor = -Infinity;
    for (const task of [...(dept.tasks ?? [])].sort((a, b) => (nodes[a.parent]?.y ?? 0) - (nodes[b.parent]?.y ?? 0))) {
      const parent = nodes[task.parent];
      if (!parent) continue;
      const anchor = parent.y + (parent.height - TREE.task.height) / 2;
      const remembered = want(task.key);
      const y = Math.max(remembered ?? anchor, anchor, taskFloor);
      nodes[task.key] = { kind: "task", x: TREE.task.x, y, width: TREE.task.width, height: TREE.task.height };
      taskFloor = y + TREE.task.height + TREE.childGap;
    }

    const bottoms = [deptY + TREE.dept.height + TREE.ruleSpace, ...keys.slice(1).map((key) => (nodes[key] ? nodes[key]!.y + nodes[key]!.height : -Infinity))];
    const bottom = Math.max(...bottoms);
    bands[dept.key] = { top: deptY, bottom };
    cursor = bottom + TREE.bandGap;
  }

  // the root sits level with the middle of the departments the first time,
  // then stays put; decisions hang under it
  const deptNodes = input.departments.map((dept) => nodes[dept.key]!).filter(Boolean);
  const span = deptNodes.length ? [deptNodes[0]!.y, deptNodes[deptNodes.length - 1]!.y + TREE.dept.height] : [TREE.top, TREE.top + TREE.root.height];
  const centred = Math.max(TREE.top, Math.round((span[0]! + span[1]!) / 2 - TREE.root.height / 2));
  const rootY = Number.isFinite(previous.root) ? previous.root! : centred;
  nodes.root = { kind: "root", x: TREE.root.x, y: rootY, width: TREE.root.width, height: TREE.root.height };
  let decisionY = rootY + TREE.root.height + 26;
  for (const key of input.decisions) {
    nodes[key] = { kind: "decision", x: TREE.root.x, y: decisionY, width: TREE.decision.width, height: TREE.decision.height };
    decisionY += TREE.decision.height + TREE.decision.gap;
  }

  for (const [key, box] of Object.entries(nodes)) slots[key] = box.y;
  return { nodes, bands, slots, frames: [] };
}

/** horizontal → vertical bus at `xb` → horizontal, with rounded corners */
export function elbow(x1: number, y1: number, xb: number, y2: number, x2: number, radius = 8): string {
  if (Math.abs(y2 - y1) < 0.5) return `M${x1} ${y1}H${x2}`;
  const s = y2 > y1 ? 1 : -1;
  const h1 = xb > x1 ? 1 : -1;
  const h2 = x2 > xb ? 1 : -1;
  const r = Math.min(radius, Math.abs(y2 - y1) / 2, Math.abs(xb - x1), Math.abs(x2 - xb));
  return `M${x1} ${y1}H${xb - h1 * r}Q${xb} ${y1} ${xb} ${y1 + s * r}V${y2 - s * r}Q${xb} ${y2} ${xb + h2 * r} ${y2}H${x2}`;
}

export const centreY = (box: NodeBox) => box.y + box.height / 2;

const SLOTS_KEY = "omb.workbench.slots";

export function loadSlots(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SLOTS_KEY) ?? "{}") as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSlots(slots: Record<string, number>): void {
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
  } catch {
    // the layout is recomputed from scratch next time
  }
}

/** Squads of a department's members (beyond the lead's span of control), with
 * the index of each member's squad. Mirrors org.ts squads(). */
export function squadOf<T>(groups: readonly (readonly T[])[], member: T): number {
  return groups.findIndex((group) => group.includes(member));
}

// ── the day timeline (compressed hours) ─────────────────────────────────────

export interface DayScale {
  start: number;
  end: number;
  /** x in 0..1 for a time */
  at: (time: number) => number;
  /** the hour drawn widest, 0–23 */
  zoomHour: number;
}

/** Hours with more events get more width; quiet hours shrink. The current
 * hour is always a little wider so "now" never sits in a squeezed corner. */
export function compressDay(times: readonly number[], now: number, futureHours = 2): DayScale {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const hourOf = (time: number) => Math.floor((time - day.getTime()) / (60 * MIN));
  const todays = times.filter((time) => time >= day.getTime() && time < day.getTime() + 24 * 60 * MIN);
  const nowHour = hourOf(now);
  const first = Math.min(9, nowHour, ...todays.map(hourOf));
  const last = Math.min(24, Math.max(nowHour + futureHours, ...todays.map((time) => hourOf(time) + 1)));
  const weights: number[] = [];
  for (let hour = first; hour < last; hour += 1) {
    const events = todays.filter((time) => hourOf(time) === hour).length;
    weights.push(1 + events * 2.2 + (hour === nowHour ? 1.5 : 0));
  }
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const offsets = weights.map((_, index) => weights.slice(0, index).reduce((a, b) => a + b, 0) / total);
  const start = day.getTime() + first * 60 * MIN;
  const end = day.getTime() + last * 60 * MIN;
  const at = (time: number) => {
    if (time <= start) return 0;
    if (time >= end) return 1;
    const index = Math.min(weights.length - 1, hourOf(time) - first);
    const within = (time - (day.getTime() + (first + index) * 60 * MIN)) / (60 * MIN);
    return offsets[index]! + (weights[index]! / total) * within;
  };
  const zoomIndex = weights.indexOf(Math.max(...weights));
  return { start, end, at, zoomHour: first + Math.max(0, zoomIndex) };
}

/** Lay event labels on two rows (above / below the axis), dropping a label
 * when it would overlap its row neighbour. x is in pixels. */
export function placeLabels<T extends { x: number; width: number }>(events: readonly T[], minGap = 8): Array<T & { row: 0 | 1; hidden: boolean }> {
  const lastEnd: [number, number] = [-Infinity, -Infinity];
  return events.map((event, index) => {
    const preferred: 0 | 1 = (index % 2) as 0 | 1;
    const left = event.x - event.width / 2;
    for (const row of [preferred, (1 - preferred) as 0 | 1]) {
      if (left >= lastEnd[row] + minGap) {
        lastEnd[row] = left + event.width;
        return { ...event, row, hidden: false };
      }
    }
    return { ...event, row: preferred, hidden: true };
  });
}

/** Events that concern the owner directly. */
export function concernsOwner(event: Pick<OrgEvent, "kind">): boolean {
  return event.kind === "decision" || event.kind === "approval.requested" || event.kind === "approval.resolved" || event.kind === "escalation" || event.kind === "approval.expired";
}

// ── adding people mid-run ───────────────────────────────────────────────────

/** The mascot for a model or engine name ("kimi-k2" → the moon). */
export function mascotForModelName(name: string): MascotKind {
  const lower = name.toLowerCase();
  const exact = MASCOT_KINDS.find((kind) => kind === lower);
  if (exact) return exact;
  const rules: Array<[RegExp, MascotKind]> = [
    [/kimi|moonshot/, "kimi"],
    [/qwen|通义/, "qwen"],
    [/claude|sonnet|opus|haiku/, "claude"],
    [/gpt|codex|\bo\d/, "codex"],
    [/grok/, "grok"],
    [/hermes/, "hermes"],
    [/droid/, "droid"],
    [/cursor/, "cursor"],
    [/gemini|antigravity/, "antigravity"],
    [/opencode/, "opencode"],
    [/local|llama|ollama|lm.?studio|deepseek|glm|hunyuan/, "local"],
  ];
  return rules.find(([pattern]) => pattern.test(lower))?.[1] ?? "workbuddy";
}

/** Split the not-started items: newcomers take the last, independent ones
 * (about two each); the current people keep the rest. Finished and running
 * items never move. Uses the server's own assignment when it sends one. */
export function splitRemaining<T extends { status: "done" | "running" | "pending"; moved?: boolean }>(remaining: readonly T[], add: number) {
  const done = remaining.filter((item) => item.status === "done");
  const running = remaining.filter((item) => item.status === "running");
  const pending = remaining.filter((item) => item.status === "pending");
  // the server marks what the suggestion hands to the new squad
  if (remaining.some((item) => typeof item.moved === "boolean")) {
    return { done, running, keep: pending.filter((item) => !item.moved), fresh: pending.filter((item) => item.moved) };
  }
  const toNew = Math.min(pending.length, Math.max(1, add * 2));
  return { done, running, keep: pending.slice(0, pending.length - toNew), fresh: pending.slice(pending.length - toNew) };
}

/** Communication lines when everyone talks to everyone: n(n-1)/2. */
export const ungroupedLines = (people: number) => (people * (people - 1)) / 2;

// ── dispatch routes (who may hand work to whom) ─────────────────────────────

export type WireState = "running" | "queued" | "done" | "failed" | "idle";
export type WireKind = "default" | "explicit";

export interface Wire {
  fromBotId: string;
  toBotId: string;
  kind: WireKind;
  state: WireState;
  /** Short label for what is moving along the wire right now. */
  label?: string;
}

/** Every live route: a Chief's default same-section members unless unplugged,
 * plus explicit routes. Each carries the state of the latest work that
 * travelled along it (dispatch subtasks and upstream delegations). */
export function buildWires(
  bots: readonly WorkbenchBot[],
  routes: readonly DispatchRoute[],
  runs: readonly DispatchRun[],
  snapshot: TeamMapSnapshot,
): Wire[] {
  const visible = new Map(bots.filter((bot) => !bot.hidden).map((bot) => [bot.id, bot]));
  const wires = new Map<string, Wire>();
  const key = (from: string, to: string) => `${from}→${to}`;
  const explicit = new Map(routes.map((route) => [key(route.fromBotId, route.toBotId), route]));
  for (const chief of visible.values()) {
    if (!chief.chiefOfStaff) continue;
    const section = chief.section?.trim() || "";
    for (const member of visible.values()) {
      if (member.id === chief.id || member.chiefOfStaff) continue;
      if ((member.section?.trim() || "") !== section) continue;
      const route = explicit.get(key(chief.id, member.id));
      if (route && !route.enabled) continue;
      wires.set(key(chief.id, member.id), { fromBotId: chief.id, toBotId: member.id, kind: route ? "explicit" : "default", state: "idle" });
    }
  }
  for (const route of routes) {
    if (!route.enabled || !visible.has(route.fromBotId) || !visible.has(route.toBotId)) continue;
    wires.set(key(route.fromBotId, route.toBotId), { fromBotId: route.fromBotId, toBotId: route.toBotId, kind: "explicit", state: "idle" });
  }
  // newest runs first: the first state written to a wire wins
  const stamped = new Set<string>();
  for (const run of runs) {
    for (const subtask of run.subtasks) {
      const id = key(run.chiefBotId, subtask.assigneeBotId);
      const wire = wires.get(id);
      if (!wire || stamped.has(id)) continue;
      const state: WireState | null =
        subtask.status === "running" ? "running" :
        subtask.status === "pending" && (run.status === "running" || run.status === "awaiting-approval") ? "queued" :
        subtask.status === "done" && Date.now() - (subtask.finishedAt ?? 0) < 120_000 ? "done" :
        subtask.status === "failed" && Date.now() - (subtask.finishedAt ?? 0) < 600_000 ? "failed" :
        null;
      if (!state) continue;
      wire.state = state;
      wire.label = subtask.title;
      stamped.add(id);
    }
  }
  for (const delegation of snapshot.running) {
    const wire = wires.get(key(delegation.sourceBotId, delegation.targetBotId));
    if (wire && wire.state === "idle") wire.state = "running";
  }
  for (const delegation of snapshot.queued) {
    const wire = wires.get(key(delegation.sourceBotId, delegation.targetBotId));
    if (wire && wire.state === "idle") {
      wire.state = "queued";
      wire.label = delegation.reason;
    }
  }
  return [...wires.values()];
}

// ── view math ───────────────────────────────────────────────────────────────

/** Zoom around a fixed screen point: the canvas point under the cursor stays put. */
export function zoomAround(view: { x: number; y: number; zoom: number }, screen: Point, nextZoom: number) {
  const zoom = Math.min(2, Math.max(0.3, nextZoom));
  const worldX = (screen.x - view.x) / view.zoom;
  const worldY = (screen.y - view.y) / view.zoom;
  return { zoom, x: screen.x - worldX * zoom, y: screen.y - worldY * zoom };
}

/** The view that fits every node inside the viewport, with a margin; never
 * zooms in past 100% so a small team keeps its real size at the top left. */
export function fitView(layout: { nodes: Record<string, NodeBox> }, viewport: { width: number; height: number }, margin = 24) {
  const boxes = Object.values(layout.nodes);
  if (!boxes.length || viewport.width <= 0 || viewport.height <= 0) return { x: margin, y: margin, zoom: 1 };
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const zoom = Math.min(1, Math.max(0.3, Math.min((viewport.width - margin * 2) / (maxX - minX), (viewport.height - margin * 2) / (maxY - minY))));
  return { zoom, x: margin - minX * zoom, y: margin - minY * zoom };
}

/** Undo/redo for workbench edits (route plugs). */
export interface WorkbenchEdit {
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

export class EditHistory {
  private past: WorkbenchEdit[] = [];
  private future: WorkbenchEdit[] = [];

  push(edit: WorkbenchEdit): void {
    this.past.push(edit);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }

  async undo(): Promise<string | null> {
    const edit = this.past.pop();
    if (!edit) return null;
    await edit.undo();
    this.future.push(edit);
    return edit.label;
  }

  async redo(): Promise<string | null> {
    const edit = this.future.pop();
    if (!edit) return null;
    await edit.redo();
    this.past.push(edit);
    return edit.label;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

/** Progress of a run as done / total settled subtasks. */
export function runProgress(run: DispatchRun): { done: number; failed: number; total: number } {
  return {
    done: run.subtasks.filter((subtask) => subtask.status === "done").length,
    failed: run.subtasks.filter((subtask) => subtask.status === "failed" || subtask.status === "skipped").length,
    total: run.subtasks.length,
  };
}
