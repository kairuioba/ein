// 站会摘要（代码生成，不调模型）。
//
// 老板每天只需要知道三件事：还跑着什么、谁在等他、什么东西卡住了。
// 这个模块把 dispatch runs 与收件箱的**事实**折成几行固定文案；没有模型
// 叙述、没有推测。文案模板是常量，数字全部由输入算出来——测试可以直接
// 断言"输出只由数字与固定模板组成"。
//
// 口径：
//   · running  = 未结束的顶层 run（含 synthesizing；不含部门子计划）；
//   · waitingOwner = 未 resolved 的收件箱条目 + awaiting-approval 的 run；
//   · blocked  = 活动 run 里的失败子任务、超过 30 分钟无进展的 run、
//                以及等老板超过 SLA（默认 2 小时）的收件箱条目；
//   · blockers 按等待时长从长到短，最多 5 条；站会正文最多列 3 条。
import type { DispatchRun, InboxItem } from "../shared/dispatch-types.ts";
import { DEFAULT_OWNER_TIME_ZONE } from "./owner-metrics.ts";

/** A run with no state change for this long is stuck for stand-up purposes. */
export const STANDUP_STALL_MS = 30 * 60 * 1000;
/** An owner-facing item waiting longer than this is a stand-up blocker. */
export const STANDUP_OWNER_SLA_MS = 2 * 60 * 60 * 1000;
/** The stand-up body lists at most this many blockers. */
const MAX_LINES = 3;
const MAX_BLOCKERS = 5;

export interface StandupBlocker {
  taskTitle: string;
  item: string;
  waitingMinutes: number;
}

export interface Standup {
  generatedAt: number;
  lines: string[];
  blockers: StandupBlocker[];
  counts: { running: number; blocked: number; waitingOwner: number };
}

export interface StandupInput {
  runs?: readonly DispatchRun[];
  inboxItems?: readonly InboxItem[];
  now?: number;
  timeZone?: string;
}

const MINUTE = 60_000;

const activeRun = (run: DispatchRun): boolean => run.status === "running" || run.status === "synthesizing";

/** "09:05" in the owner's timezone (h23), so the stand-up reads as a local morning line. */
export function standupClock(now: number, timeZone = DEFAULT_OWNER_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(now));
}

const firstLine = (text: string | undefined, max = 24): string => {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : line;
};

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / MINUTE));

export function buildStandup(input: StandupInput = {}): Standup {
  const now = input.now ?? Date.now();
  const timeZone = input.timeZone ?? DEFAULT_OWNER_TIME_ZONE;
  const runs = input.runs ?? [];
  const inboxItems = input.inboxItems ?? [];
  const topRuns = runs.filter((run) => !run.parentRunId);
  const active = topRuns.filter(activeRun);
  const goalByRun = new Map(runs.map((run) => [run.id, firstLine(run.goal)]));

  const blockers: StandupBlocker[] = [];
  for (const run of active) {
    const taskTitle = firstLine(run.goal);
    // A failed subtask is a fact the owner must see, even if the run is still
    // retrying other work.
    for (const subtask of run.subtasks) {
      if (subtask.status !== "failed") continue;
      const since = subtask.finishedAt ?? run.updatedAt ?? now;
      blockers.push({
        taskTitle,
        item: `子任务「${firstLine(subtask.title, 20)}」失败${subtask.error ? `：${firstLine(subtask.error, 24)}` : ""}`,
        waitingMinutes: minutes(now - since),
      });
    }
    // No state change for 30 minutes: stuck, not "busy".
    const quietFor = now - (run.updatedAt || run.createdAt || now);
    if (quietFor >= STANDUP_STALL_MS) {
      blockers.push({
        taskTitle,
        item: `已 ${minutes(quietFor)} 分钟没有进展`,
        waitingMinutes: minutes(quietFor),
      });
    }
  }
  for (const item of inboxItems) {
    if (item.resolvedAt) continue;
    const waiting = minutes(now - item.createdAt);
    if (now - item.createdAt < STANDUP_OWNER_SLA_MS) continue;
    blockers.push({
      taskTitle: item.runId ? goalByRun.get(item.runId) ?? "需要你" : "需要你",
      item: `「${firstLine(item.title, 20)}」已等你 ${waiting} 分钟`,
      waitingMinutes: waiting,
    });
  }
  // deterministic: longest wait first, then a stable title/item tie-break.
  blockers.sort((a, b) => b.waitingMinutes - a.waitingMinutes || a.taskTitle.localeCompare(b.taskTitle) || a.item.localeCompare(b.item));
  const top = blockers.slice(0, MAX_BLOCKERS);

  const waitingOwner = inboxItems.filter((item) => !item.resolvedAt).length + topRuns.filter((run) => run.status === "awaiting-approval").length;
  const running = active.length;
  const counts = { running, blocked: top.length, waitingOwner };

  const lines: string[] = [];
  if (running === 0 && waitingOwner === 0 && top.length === 0) {
    lines.push("今天没有需要你的事，团队在自己跑。");
  } else {
    lines.push(`${standupClock(now, timeZone)} 站会：${running} 个任务在跑，${waitingOwner} 件等你，${top.length} 件卡住。`);
    for (const blocker of top.slice(0, MAX_LINES)) {
      lines.push(`${blocker.taskTitle}：${blocker.item}，已等 ${blocker.waitingMinutes} 分钟。`);
    }
    if (waitingOwner > 0) lines.push(`${waitingOwner} 件在等你拍板，打开「需要你」处理。`);
  }

  return { generatedAt: now, lines, blockers: top, counts };
}
