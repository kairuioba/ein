// Where a click on a bot row should land.
//
// A bot can own several tasks. `bot.threadId` is the active one, but the
// unread badge may belong to a *different* task (a dispatched subtask that
// finished while the bot's active task was empty or older). Clicking the row
// used to open the active task — often a fresh "新任务" — and the finished
// work was only reachable through the task picker. Return the task whose
// activity the badge is about, so the row opens what the user just saw.
import type { Bot } from "@/state/store";

export function activityTask(bot: Pick<Bot, "threadId" | "tasks" | "unread">): { threadId: string; title: string } | undefined {
  const tasks = bot.tasks ?? [];
  if (tasks.length < 2) return undefined;
  const active = tasks.find((task) => task.threadId === bot.threadId);
  const activeAt = active?.lastActivityAt ?? 0;
  const latest = tasks
    .filter((task) => task.threadId !== bot.threadId && (task.lastActivityAt ?? 0) > 0)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
  if (!latest) return undefined;
  const latestAt = latest.lastActivityAt ?? 0;
  // unread: the badge is about the newest activity, wherever it is
  if (bot.unread && latestAt >= activeAt) return { threadId: latest.threadId, title: latest.title };
  // the active task has never had a message: don't strand the user on a blank one
  if (!active || activeAt === 0) return { threadId: latest.threadId, title: latest.title };
  return undefined;
}
