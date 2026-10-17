// Owner-time 指标：用已有事件算「老板每天被打扰得值不值」，不埋点、不调模型。
// 决策延迟 = 收件项 createdAt → resolvedAt；返工率来自复盘；
// 自动处理占比需要审计记录，当前版本返回 null 而不是编数字。
import type { InboxItem } from "../shared/dispatch-types.ts";
import type { DispatchRetro } from "./dispatch.ts";

export interface OwnerTimeMetrics {
  generatedAt: number;
  decisions: { today: number; week: number; open: number };
  latency: { p50Ms: number | null; p90Ms: number | null; samples: number };
  rework: { rate: number | null; retriedSubtasks: number; totalSubtasks: number };
  automation: { ratio: number | null; note: string };
  waiting: { projects: number; actionable: number };
}

const DAY = 24 * 60 * 60 * 1000;

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};

export function buildOwnerMetrics(input: {
  items: InboxItem[];
  retros: DispatchRetro[];
  now?: number;
  waitingProjects?: number;
}): OwnerTimeMetrics {
  const now = input.now ?? Date.now();
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const weekStart = dayStart - 6 * DAY;
  const resolved = input.items.filter((item) => typeof item.resolvedAt === "number" && typeof item.createdAt === "number");
  const latencies = resolved.map((item) => Math.max(0, item.resolvedAt! - item.createdAt));
  const open = input.items.filter((item) => !item.resolvedAt);
  let totalSubtasks = 0;
  let retriedSubtasks = 0;
  for (const retro of input.retros) {
    totalSubtasks += retro.counts.total;
    retriedSubtasks += retro.counts.retried;
  }
  return {
    generatedAt: now,
    decisions: {
      today: resolved.filter((item) => item.resolvedAt! >= dayStart).length,
      week: resolved.filter((item) => item.resolvedAt! >= weekStart).length,
      open: open.length,
    },
    latency: { p50Ms: percentile(latencies, 50), p90Ms: percentile(latencies, 90), samples: latencies.length },
    rework: { rate: totalSubtasks ? retriedSubtasks / totalSubtasks : null, retriedSubtasks, totalSubtasks },
    automation: { ratio: null, note: "automatic decisions are not audited yet" },
    waiting: { projects: input.waitingProjects ?? 0, actionable: open.filter((item) => item.kind === "signoff" || item.kind === "gate_failed").length },
  };
}
