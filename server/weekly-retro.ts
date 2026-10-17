// 周复盘（代码生成，不调模型）。
//
// 每周一凌晨的固定动作：把上一周的事实折成几个数字与几句固定文案——
// 完成了多少、返工率多少、老板做了多少决定、进化提案采纳/驳回/延后各几件。
// 全部由输入（DispatchRetro / 收件箱 / 进化提案）算出来；没有模型叙述，
// 也不编造指标：算不出来就返回 null，而不是给一个好看的近似值。
//
// 窗口口径：**本地周一 00:00 起 7 天**（默认 Asia/Shanghai，与时区边界
// 统一的 owner-time 一致）。部门子计划（parentRunId）不重复计入完成数。
import type { DispatchRetro } from "./dispatch.ts";
import type { EvolutionItem } from "./evolution.ts";
import type { InboxItem } from "../shared/dispatch-types.ts";
import { DEFAULT_OWNER_TIME_ZONE, ownerWeekStart } from "./owner-metrics.ts";

export interface WeeklyRetro {
  generatedAt: number;
  windowDays: 7;
  metrics: {
    completed: number;
    retriedRate: number | null;
    decisionLatencyP50Ms: number | null;
    decisions: number;
  };
  review: { adopted: number; rejected: number; deferred: number };
  highlights: string[];
  warnings: string[];
}

export interface WeeklyRetroInput {
  retros?: readonly DispatchRetro[];
  inboxItems?: readonly InboxItem[];
  evolutionProposals?: readonly EvolutionItem[];
  now?: number;
  timeZone?: string;
}

const MINUTE = 60_000;
/** Above this share of retried subtasks the week is flagged, not celebrated. */
export const RETRY_WARN_RATE = 0.3;

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};

const percent = (rate: number): number => Math.round(rate * 100);

export function buildWeeklyRetro(input: WeeklyRetroInput = {}): WeeklyRetro {
  const now = input.now ?? Date.now();
  const timeZone = input.timeZone ?? DEFAULT_OWNER_TIME_ZONE;
  const windowStart = ownerWeekStart(now, timeZone);
  const inWindow = (at: number | undefined): at is number =>
    typeof at === "number" && at >= windowStart && at <= now;

  // Completed work. A department's child run is part of its parent's retro,
  // so only top-level runs are counted (no double counting).
  const retros = (input.retros ?? []).filter((retro) => !retro.parentRunId && inWindow(retro.finishedAt));
  const completed = retros.length;
  const totals = retros.reduce(
    (sum, retro) => ({ total: sum.total + retro.counts.total, retried: sum.retried + retro.counts.retried }),
    { total: 0, retried: 0 },
  );
  const retriedRate = totals.total > 0 ? Math.round((totals.retried / totals.total) * 1000) / 1000 : null;

  // Owner decisions: only items the owner actually resolved inside the window.
  const resolved = (input.inboxItems ?? []).filter((item) => inWindow(item.resolvedAt));
  const decisions = resolved.length;
  const latencies = resolved.map((item) => Math.max(0, item.resolvedAt! - item.createdAt));
  const decisionLatencyP50Ms = percentile(latencies, 50);

  // Evolution proposals decided this week (open ones are not a decision yet).
  const decided = (input.evolutionProposals ?? []).filter((proposal) => proposal.status !== "open" && inWindow(proposal.resolvedAt));
  const review = {
    adopted: decided.filter((proposal) => proposal.status === "accepted").length,
    rejected: decided.filter((proposal) => proposal.status === "rejected").length,
    deferred: decided.filter((proposal) => proposal.status === "deferred").length,
  };

  const highlights: string[] = [
    completed > 0 ? `本周完成 ${completed} 个任务。` : "本周还没有完成的任务。",
    retriedRate === null
      ? "本周没有可计算的返工率。"
      : `返工率 ${percent(retriedRate)}%：${totals.retried} / ${totals.total} 个子任务重试过。`,
    decisions > 0
      ? `你做了 ${decisions} 个决定，中位等待 ${Math.round(decisionLatencyP50Ms! / MINUTE)} 分钟。`
      : "本周没有需要你拍板的事。",
    `改进提案：采纳 ${review.adopted}，驳回 ${review.rejected}，延后 ${review.deferred}。`,
    `统计窗口：本地周一 00:00 起 7 天（${timeZone}）。`,
  ];

  const openItems = (input.inboxItems ?? []).filter((item) => !item.resolvedAt).length;
  const warnings: string[] = [];
  if (completed === 0) warnings.push("本周没有可复盘的任务。");
  if (retriedRate !== null && retriedRate > RETRY_WARN_RATE) {
    warnings.push(`返工率超过 ${percent(RETRY_WARN_RATE)}%：下周先查验收标准与评审人。`);
  }
  if (completed > 0 && decisions === 0) {
    warnings.push("有任务完成但 0 个决定：确认是自治生效，而不是漏记。");
  }
  if (openItems > 0) warnings.push(`${openItems} 件还挂在「需要你」，周复盘前先清掉。`);

  return {
    generatedAt: now,
    windowDays: 7,
    metrics: { completed, retriedRate, decisionLatencyP50Ms, decisions },
    review,
    highlights,
    warnings,
  };
}
