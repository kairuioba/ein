// The daily brief (简报): one screen that says where every department stands,
// what needs the owner, what was decided for them, what went wrong, what it
// cost, and what changed since they last looked. Built fresh from the live
// state on every request — nothing here is stored.
import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types.ts";
import { msg, t } from "../../shared/i18n.ts";
import type { Brief, BriefDepartment, Health, InboxItem, OrgConfig, OrgEvent, UsageSummary } from "../../shared/org-types.ts";
import { botThreads, clockTime, firstLine, sectionOf, startOfDay, workThreads, type OrgBot, type OrgGroup } from "./util.ts";

export interface AutoApprovedRow {
  id: string;
  title: string;
  botId: string;
  at: number;
  rule: string;
}

/** What the brief needs to know about one conversation. */
export interface ConversationState {
  /** the newest message */
  lastAt?: number;
  /** the newest message the owner typed */
  lastUserAt?: number;
  /** a bot replied after the owner's newest message */
  replied: boolean;
}

export interface BriefInput {
  now: number;
  /** the caller's last visit; `changes` are the events after it */
  since: number;
  org: OrgConfig;
  bots: readonly OrgBot[];
  groups: readonly OrgGroup[];
  runs: readonly DispatchRun[];
  needsYou: InboxItem[];
  /** recent events, oldest first */
  events: readonly OrgEvent[];
  autoApproved: readonly AutoApprovedRow[];
  spend: UsageSummary;
  conversation(threadId: string): ConversationState;
  /** when a bot last said something itself, in any of its conversations */
  lastBotMessageAt(botId: string): number | undefined;
}

const MAX_CHANGES = 50;
const MAX_TIMELINE = 200;
/** auto mode approves every tool call; the brief shows the newest and the count */
const MAX_AUTO_APPROVED = 50;

const finished = (run: DispatchRun) => run.status === "done" || run.status === "failed" || run.status === "canceled";

/** Runs that belong to today's picture: still going, or settled today. */
export function runsInView(runs: readonly DispatchRun[], dayStart: number): DispatchRun[] {
  return runs.filter((run) => !finished(run) || run.updatedAt >= dayStart);
}

const titleOf = (subtask: DispatchSubtask) => firstLine(subtask.title, 40) || subtask.id;

/** `one` for a single subtask, `many` ("… and {count} more") otherwise. */
function about(subtasks: DispatchSubtask[], one: string, many: string): string {
  const first = subtasks[0]!;
  return subtasks.length === 1 ? t(one, { title: titleOf(first) }) : t(many, { title: titleOf(first), count: subtasks.length - 1 });
}

export function headlineFor(done: number, total: number, needs: number): string {
  if (total === 0) {
    if (needs === 0) return t("Nothing in progress, and nothing needs your decision.");
    if (needs === 1) return t("Nothing in progress; 1 thing needs your decision.");
    return t("Nothing in progress; {n} things need your decision.", { n: needs });
  }
  if (needs === 0) return t("Overall {done}/{total}; nothing needs your decision.", { done, total });
  if (needs === 1) return t("Overall {done}/{total}; 1 thing needs your decision.", { done, total });
  return t("Overall {done}/{total}; {n} things need your decision.", { done, total, n: needs });
}

export function buildBrief(input: BriefInput): Brief {
  const { now, org } = input;
  const dayStart = startOfDay(now);
  const runs = runsInView(input.runs, dayStart);
  const chiefId = org.chiefBotId ?? undefined;
  const visible = input.bots.filter((bot) => !bot.hidden);
  const escalateMs = Math.max(1, org.rules.escalateAfterMin) * 60_000;

  const subtasks = runs.flatMap((run) => run.subtasks.filter((subtask) => subtask.status !== "canceled").map((subtask) => ({ run, subtask })));

  // ── risks ──
  const risks: Brief["risks"] = [];
  for (const { run, subtask } of subtasks) {
    if (subtask.status === "failed") {
      risks.push({ title: t("“{title}” failed", { title: titleOf(subtask) }), detail: firstLine(subtask.error, 120), botId: subtask.assigneeBotId, severity: "error" });
    } else if (subtask.status === "skipped") {
      const dep = subtask.dependsOn.map((id) => run.subtasks.find((entry) => entry.id === id)).find((entry) => entry && entry.status !== "done");
      risks.push({
        title: t("“{title}” is blocked", { title: titleOf(subtask) }),
        detail: dep ? t("Waiting on “{title}”, which did not finish", { title: titleOf(dep) }) : firstLine(subtask.error, 120),
        botId: subtask.assigneeBotId,
        severity: "warn",
      });
    } else if (subtask.status === "pending" && run.status === "running") {
      const retrying = subtask.dependsOn
        .map((id) => run.subtasks.find((entry) => entry.id === id))
        .find((entry) => entry?.status === "pending" && entry.error);
      if (retrying) {
        risks.push({
          title: t("“{title}” is waiting on “{dependency}”", { title: titleOf(subtask), dependency: titleOf(retrying) }),
          detail: t("“{title}” is being retried", { title: titleOf(retrying) }),
          botId: subtask.assigneeBotId,
          severity: "warn",
        });
      }
    }
  }
  // a bot working without any sign of progress for longer than the
  // escalation rule allows
  const stuck = new Set<string>();
  for (const bot of visible) {
    const working = bot.activity === "working" || (bot.busy === true && bot.activity === undefined);
    if (!working) continue;
    const lastAt = Math.max(0, ...workThreads(bot, input.groups).map((threadId) => input.conversation(threadId).lastAt ?? 0));
    if (lastAt && now - lastAt > escalateMs) {
      stuck.add(bot.id);
      risks.push({
        title: t("{name} has shown no progress for {minutes} min", { name: bot.name, minutes: Math.floor((now - lastAt) / 60_000) }),
        detail: t("Past the {minutes}-minute escalation rule", { minutes: org.rules.escalateAfterMin }),
        botId: bot.id,
        severity: "warn",
      });
    }
  }
  risks.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

  // ── departments ──
  const departments: BriefDepartment[] = [];
  let done = 0;
  let total = 0;
  const counted = new Set<DispatchSubtask>();
  for (const dep of org.departments) {
    const people = visible.filter((bot) => bot.id !== chiefId && sectionOf(bot.section) === dep.section);
    const ids = new Set(people.map((bot) => bot.id));
    const work = subtasks.filter(({ subtask }) => ids.has(subtask.assigneeBotId)).map(({ subtask }) => subtask);
    if (!people.length && !work.length) continue;
    for (const subtask of work) counted.add(subtask);
    let depDone = work.filter((subtask) => subtask.status === "done").length;
    let depTotal = work.length;
    if (!work.length) {
      // no dispatched work: the conversations the owner started with these
      // bots today, done once the bot has answered
      for (const bot of people) {
        for (const threadId of botThreads(bot)) {
          const state = input.conversation(threadId);
          if (!state.lastUserAt || state.lastUserAt < dayStart) continue;
          depTotal += 1;
          if (state.replied && !(bot.busy && bot.threadId === threadId)) depDone += 1;
        }
      }
    }
    done += depDone;
    total += depTotal;

    const failed = work.filter((subtask) => subtask.status === "failed");
    const blocked = work.filter((subtask) => subtask.status === "skipped");
    const retrying = work.filter((subtask) => subtask.status === "pending" && subtask.error);
    const running = work.filter((subtask) => subtask.status === "running");
    const waitingHere = input.needsYou.filter((item) => ids.has(item.botId));
    const dead = people.some((bot) => bot.activity === "dead");
    const yellow =
      waitingHere.length > 0 ||
      blocked.length > 0 ||
      retrying.length > 0 ||
      people.some((bot) => bot.activity === "waiting-on-you" || bot.activity === "no-signal" || stuck.has(bot.id));
    const health: Health = failed.length || dead ? "red" : yellow ? "yellow" : "green";

    const delivered = work
      .filter((subtask) => subtask.status === "done" && subtask.finishedAt)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    const busyPeople = people.filter((bot) => bot.busy || bot.activity === "working");
    let status: string;
    if (failed.length) status = about(failed, msg("“{title}” failed"), msg("“{title}” and {count} more failed"));
    else if (waitingHere.length) status = t("Waiting for you: {title}", { title: firstLine(waitingHere[0]!.title, 40) });
    else if (blocked.length) status = about(blocked, msg("“{title}” is blocked"), msg("“{title}” and {count} more are blocked"));
    else if (retrying.length) status = about(retrying, msg("Retrying “{title}”"), msg("Retrying “{title}” and {count} more"));
    else if (running.length) status = about(running, msg("Working on “{title}”"), msg("Working on “{title}” and {count} more"));
    else if (depTotal > 0 && depDone === depTotal && delivered) {
      status = t("“{title}” delivered at {time}", { title: titleOf(delivered), time: clockTime(delivered.finishedAt!) });
    } else if (busyPeople.length) status = t("{name} is working", { name: busyPeople[0]!.name });
    else if (depTotal > 0) status = t("{done} of {total} done", { done: depDone, total: depTotal });
    else status = t("Nothing in progress");

    const leadBot = people.find((bot) => bot.chiefOfStaff);
    const lastDelivered = Math.max(0, ...work.filter((subtask) => subtask.status === "done").map((subtask) => subtask.finishedAt ?? 0));
    const lastReportAt = Math.max(lastDelivered, leadBot ? (input.lastBotMessageAt(leadBot.id) ?? 0) : 0);
    departments.push({
      section: dep.section,
      color: dep.color,
      done: depDone,
      total: depTotal,
      health,
      status,
      ...(leadBot ? { leadBotId: leadBot.id } : {}),
      ...(lastReportAt ? { lastReportAt } : {}),
    });
  }
  // dispatched work assigned outside every department still counts toward the whole
  for (const { subtask } of subtasks) {
    if (counted.has(subtask)) continue;
    total += 1;
    if (subtask.status === "done") done += 1;
  }

  // ── events ──
  const changes = input.events.filter((event) => event.at > input.since).slice(-MAX_CHANGES).reverse();
  const timeline = input.events.filter((event) => event.at >= dayStart).slice(-MAX_TIMELINE);
  const expired = input.events
    .filter((event) => event.kind === "approval.expired" && event.at >= dayStart)
    .map((event) => ({ id: event.id, title: event.detail ?? event.title, botId: event.botId ?? "", at: event.at }))
    .reverse();
  const autoApproved = input.autoApproved.filter((row) => row.at >= dayStart).sort((a, b) => b.at - a.at);

  return {
    at: now,
    headline: headlineFor(done, total, input.needsYou.length),
    done,
    total,
    departments,
    needsYou: input.needsYou,
    autoApproved: autoApproved.slice(0, MAX_AUTO_APPROVED),
    autoApprovedTotal: autoApproved.length,
    expired,
    changes,
    risks,
    spend: input.spend,
    timeline,
  };
}
