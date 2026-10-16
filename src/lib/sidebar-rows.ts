// The rules behind the sidebar's rows and its top navigation, kept free of
// React and the store so they can be tested: what a bot or group row says
// (status, preview, time, unread count), what each nav row counts, which
// quiet members of a department fold behind its lead, and what a department
// header shows next to its name.
import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types";
import type { BriefDepartment, InboxItem, LibraryDoc, OrgDecision } from "../../shared/org-types";
import { intlLocale, t, tn } from "@/lib/i18n";
import { squadName } from "@/lib/org";
import { addDays, atLocalTime, projectedRoutineItems, startOfDay } from "@/lib/routine-calendar";
import type { Routine, RoutineRun } from "@/lib/routines";
import type { CalendarCall } from "@/lib/calendar-calls";

type Activity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";

// ── top navigation ────────────────────────────────────────────────────────────

const ACTIVE_RUN = new Set<DispatchRun["status"]>(["running", "synthesizing"]);

export function runIsActive(run: Pick<DispatchRun, "status">): boolean {
  return ACTIVE_RUN.has(run.status);
}

/** 工作台 "N running": dispatch runs in flight (a lead's run for one step of
 * the chief's run is part of that run, not another one); with none, the bots
 * that are busy on a turn of their own (a bot waiting on you is not running). */
export function runningWorkCount(
  runs: ReadonlyArray<Pick<DispatchRun, "status" | "parentRunId">>,
  bots: ReadonlyArray<{ hidden?: boolean; busy?: boolean; activity?: Activity }>,
): number {
  const active = runs.filter((run) => runIsActive(run) && !run.parentRunId).length;
  if (active) return active;
  return bots.filter(
    (bot) => !bot.hidden && bot.activity !== "waiting-on-you" && (bot.activity === "working" || Boolean(bot.busy)),
  ).length;
}

/** The newest version a library doc has. */
export function libraryCurrentVersion(doc: Pick<LibraryDoc, "versions">): number {
  return doc.versions.reduce((top, entry) => Math.max(top, entry.version), 0);
}

/** Bots still working from an older version of a doc. */
export function staleLibraryUsers(doc: Pick<LibraryDoc, "versions" | "inUse">): Array<{ botId: string; version: number }> {
  const current = libraryCurrentVersion(doc);
  return doc.inUse.filter((use) => use.version < current);
}

/** 资料库 "N to update": docs some bot still uses an older version of. */
export function staleLibraryDocCount(docs: ReadonlyArray<Pick<LibraryDoc, "versions" | "inUse">>): number {
  return docs.filter((doc) => staleLibraryUsers(doc).length > 0).length;
}

/** Does a calendar call (a scheduled meeting) happen in [from, to)? */
export function callOccursBetween(call: Pick<CalendarCall, "schedule" | "createdAt">, from: number, to: number): boolean {
  if (call.schedule.type === "once") return call.schedule.at >= from && call.schedule.at < to;
  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
    if (!call.schedule.weekdays.includes(new Date(day).getDay())) continue;
    const at = atLocalTime(day, call.schedule.time);
    if (at >= from && at < to && at >= call.createdAt) return true;
  }
  return false;
}

/** 日历 "today N": every routine occurrence (run or still to come) and every
 * meeting on today's calendar. */
export function todayScheduleCount(
  routines: Routine[],
  runs: RoutineRun[],
  calls: ReadonlyArray<Pick<CalendarCall, "schedule" | "createdAt">>,
  now = Date.now(),
): number {
  const from = startOfDay(now);
  const to = addDays(from, 1);
  return projectedRoutineItems(routines, runs, from, to).length + calls.filter((call) => callOccursBetween(call, from, to)).length;
}

// ── the "needs you" inbox on rows ─────────────────────────────────────────────

export function inboxByBot(items: readonly InboxItem[]): Map<string, InboxItem[]> {
  const byBot = new Map<string, InboxItem[]>();
  for (const item of items) {
    const list = byBot.get(item.botId);
    if (list) list.push(item);
    else byBot.set(item.botId, [item]);
  }
  return byBot;
}

/** The few words after "Needs you ·" on a row. */
export function inboxReason(item: Pick<InboxItem, "kind" | "title">): string {
  if (item.kind === "escalation") return t("stuck");
  if (item.kind === "approval") return t("needs your approval");
  return item.title.trim() || t("waiting for your pick");
}

// ── dispatch runs on rows ─────────────────────────────────────────────────────

export interface RunSummary {
  /** distinct bots with work in the run */
  people: number;
  done: number;
  total: number;
  /** subtasks being retried after a failed attempt */
  retrying: number;
}

const COUNTED = (subtask: Pick<DispatchSubtask, "status">) => subtask.status !== "skipped" && subtask.status !== "canceled";

export function summarizeRun(run: Pick<DispatchRun, "subtasks">): RunSummary {
  const counted = run.subtasks.filter(COUNTED);
  return {
    people: new Set(counted.map((subtask) => subtask.assigneeBotId)).size,
    done: counted.filter((subtask) => subtask.status === "done").length,
    total: counted.length,
    retrying: counted.filter(
      (subtask) =>
        (subtask.status === "running" && subtask.attempts > 1) ||
        (subtask.status === "pending" && subtask.attempts >= 1 && Boolean(subtask.error)),
    ).length,
  };
}

/** "8 people · 13/24 · 1 retrying" — a lead's row while its run is going. */
export function runSummaryText(summary: RunSummary): string {
  const parts = [
    tn(summary.people, "{count} person", "{count} people"),
    `${summary.done}/${summary.total}`,
  ];
  if (summary.retrying > 0) parts.push(tn(summary.retrying, "{count} retrying", "{count} retrying"));
  return parts.join(" · ");
}

/** The newest active run each bot is leading. */
export function activeRunsByLead(runs: readonly DispatchRun[]): Map<string, DispatchRun> {
  const byLead = new Map<string, DispatchRun>();
  for (const run of runs) {
    if (!runIsActive(run)) continue;
    const current = byLead.get(run.chiefBotId);
    if (!current || run.createdAt > current.createdAt) byLead.set(run.chiefBotId, run);
  }
  return byLead;
}

/** Everyone with work in a run. */
export function runAssignees(run: Pick<DispatchRun, "subtasks"> | undefined): Set<string> {
  return new Set(run ? run.subtasks.filter(COUNTED).map((subtask) => subtask.assigneeBotId) : []);
}

/** Squads added to work that is still going ("Squad B"), by the department
 * they joined — the squad lead's section, else the run lead's — newest per
 * department: the "Squad B new" chip on a department heading. A run lists
 * only added squads; the original team is the implicit Squad A. */
export function addedSquadsBySection(
  runs: ReadonlyArray<Pick<DispatchRun, "status" | "chiefBotId" | "squads">>,
  sectionOf: (botId: string) => string | undefined,
): Map<string, string> {
  const newest = new Map<string, { name: string; at: number }>();
  for (const run of runs) {
    if (!runIsActive(run)) continue;
    (run.squads ?? []).forEach((squad, index) => {
      if (squad.endedAt) return;
      const section = sectionOf(squad.leadBotId) || sectionOf(run.chiefBotId);
      if (!section) return;
      const current = newest.get(section);
      // the original team is Squad A, so the first added one is B
      if (!current || squad.addedAt > current.at) newest.set(section, { name: squad.name.trim() || squadName(index + 1), at: squad.addedAt });
    });
  }
  return new Map([...newest].map(([section, squad]) => [section, squad.name]));
}

// ── rows ──────────────────────────────────────────────────────────────────────

export type BotRowStatus =
  | { kind: "waiting"; reason: string }
  | { kind: "run"; text: string }
  | { kind: "working" }
  | { kind: "preview"; text: string };

/** What a bot row's second line says. Waiting on you wins, then a lead's run,
 * then plain work, then the last message. */
export function botRowStatus(input: {
  activity?: Activity;
  busy?: boolean;
  inbox: readonly InboxItem[];
  /** the open question in the bot's own thread, when it is waiting on you */
  waitingReason?: string;
  run?: RunSummary | null;
  preview: string;
}): BotRowStatus {
  const first = input.inbox[0];
  if (first) return { kind: "waiting", reason: inboxReason(first) };
  if (input.activity === "waiting-on-you") return { kind: "waiting", reason: input.waitingReason?.trim() || t("waiting for you") };
  if (input.run && input.run.total > 0) return { kind: "run", text: runSummaryText(input.run) };
  if (input.activity === "working" || input.busy) return { kind: "working" };
  return { kind: "preview", text: input.preview };
}

/** Messages that arrived since you last spoke in a group (at least one while
 * it is marked unread). */
export function groupUnreadCount(group: { unread?: boolean; messages: ReadonlyArray<{ role: string; kind: string }> }): number {
  if (!group.unread) return 0;
  let count = 0;
  for (let index = group.messages.length - 1; index >= 0; index -= 1) {
    const message = group.messages[index]!;
    if (message.role === "user") break;
    if (message.kind === "text" || message.kind === "options") count += 1;
  }
  return Math.max(1, count);
}

/** The newest decision made in a group. */
export function latestGroupDecision(decisions: readonly OrgDecision[], groupId: string): OrgDecision | undefined {
  let latest: OrgDecision | undefined;
  for (const decision of decisions) {
    if (decision.source.kind !== "group" || decision.source.id !== groupId) continue;
    if (!latest || decision.at > latest.at) latest = decision;
  }
  return latest;
}

type PreviewCard = { title: string; subtitle?: string; requestId?: string; tool?: string; answered?: string };

type PreviewMessage = {
  role: string;
  kind: string;
  text?: string;
  tool?: { name: string };
  from?: { name: string };
  card?: PreviewCard;
};

/** One line for a card in a preview: a bot's question is its subtitle (the
 * title is the generic "Your bot has a question"); an approval or an options
 * card leads with its title. */
export function cardLine(card: PreviewCard): string {
  const oneLine = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const answer = card.answered?.trim();
  if (answer) {
    // settled: say how, not what was asked
    if (answer === "expired") return t("Voided");
    if (card.tool) {
      const verdict = /^allow/i.test(answer) ? t("Allowed") : /^deny/i.test(answer) ? t("Denied") : answer;
      const what = oneLine(card.subtitle || card.title);
      return what ? `${verdict} · ${what}` : verdict;
    }
    return t("You chose {choice}", { choice: answer });
  }
  return oneLine(card.requestId && !card.tool ? card.subtitle || card.title : card.title || card.subtitle);
}

/** A message's one-line preview: its text, the card it carries, or the tool it ran. */
export function messageLine(message: PreviewMessage | undefined): string {
  if (!message) return "";
  if (message.card && (message.kind === "options" || !message.text)) return cardLine(message.card);
  if (message.kind === "activity" && message.tool) return message.tool.name;
  return (message.text ?? "").replace(/\s+/g, " ").trim();
}

/** A group row's second line: who is talking now, the decision it reached, or
 * its last message with the member count in front. */
export function groupRowPreview(input: {
  memberCount: number;
  busyName?: string | null;
  decision?: Pick<OrgDecision, "id" | "choice"> | null;
  unread?: boolean;
  last?: PreviewMessage;
}): string {
  if (input.busyName) return t("{name} is working…", { name: input.busyName });
  if (input.decision && !input.unread) return t("Decision #{id} made · {choice}", { id: input.decision.id, choice: input.decision.choice });
  const last = input.last;
  if (!last) return t("No messages yet");
  const oneLine = messageLine(last);
  if (last.role === "user") return tn(input.memberCount, "{count} bot · You: {text}", "{count} bots · You: {text}", { text: oneLine });
  if (last.from?.name) return tn(input.memberCount, "{count} bot · {name}: {text}", "{count} bots · {name}: {text}", { name: last.from.name, text: oneLine });
  return tn(input.memberCount, "{count} bot · {text}", "{count} bots · {text}", { text: oneLine });
}

/** A row's time: the clock today, "Yesterday", the weekday this week, else the date. */
export function sidebarTime(at: number | undefined, now = Date.now()): string {
  if (!at || !Number.isFinite(at)) return "";
  const locale = intlLocale();
  const day = startOfDay(at);
  const today = startOfDay(now);
  if (day >= today) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  if (day === addDays(today, -1)) return t("Yesterday");
  if (day > addDays(today, -7)) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(at);
}

// ── departments ───────────────────────────────────────────────────────────────

/** "Delivered": every piece of today's work in the department is done. The
 * brief's numbers win; without them, today's dispatch subtasks decide. */
export function departmentDelivered(
  section: string,
  brief: ReadonlyArray<Pick<BriefDepartment, "section" | "done" | "total">>,
  runs: ReadonlyArray<Pick<DispatchRun, "updatedAt" | "subtasks">>,
  memberIds: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  const reported = brief.find((department) => department.section === section);
  if (reported) return reported.total > 0 && reported.done >= reported.total;
  const today = startOfDay(now);
  const work = runs
    .filter((run) => run.updatedAt >= today)
    .flatMap((run) => run.subtasks)
    .filter((subtask) => memberIds.has(subtask.assigneeBotId) && COUNTED(subtask));
  return work.length > 0 && work.every((subtask) => subtask.status === "done");
}

export interface FoldedMembers<B> {
  /** members listed under the lead */
  shown: B[];
  /** quiet members behind the header's "+N" */
  folded: number;
  /** members summed up on the lead's row by its run */
  inRun: number;
}

/** A department lists its lead, then the members who need a look (waiting,
 * unread, busy on their own, selected). Members working in the lead's run are
 * summed up on the lead's row; the quiet rest fold behind "+N" until the
 * section is expanded. Without a lead nothing folds. */
export function foldDepartmentMembers<B extends { id: string }>(
  members: readonly B[],
  options: {
    hasLead: boolean;
    expanded: boolean;
    keep: (bot: B) => boolean;
    runAssignees?: ReadonlySet<string>;
  },
): FoldedMembers<B> {
  if (options.expanded || !options.hasLead) return { shown: [...members], folded: 0, inRun: 0 };
  const shown: B[] = [];
  let folded = 0;
  let inRun = 0;
  for (const member of members) {
    if (options.keep(member)) shown.push(member);
    else if (options.runAssignees?.has(member.id)) inRun += 1;
    else folded += 1;
  }
  return { shown, folded, inRun };
}
