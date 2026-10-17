// 晨报 / 站会的数据层：数字全部由代码给出，模型只允许以后补一句风险摘要。
// 这里不调模型，也不写自然语言长句——只给结构化事实，前端用固定文案渲染。
import type { OwnerTimeMetrics } from "./owner-metrics.ts";

export interface MorningBrief {
  generatedAt: number;
  openDecisions: number;
  waitingProjects: number;
  reworkRate: number | null;
  decisionLatencyP50Ms: number | null;
  decisionsToday: number;
  headline: "nothing" | "decisions" | "running";
}

export function buildMorningBrief(input: { metrics: OwnerTimeMetrics; waitingProjects?: number; now?: number }): MorningBrief {
  const metrics = input.metrics;
  const open = metrics.decisions.open;
  const waiting = input.waitingProjects ?? metrics.waiting.projects;
  const headline: MorningBrief["headline"] = open > 0 ? "decisions" : waiting > 0 ? "running" : "nothing";
  return {
    generatedAt: input.now ?? Date.now(),
    openDecisions: open,
    waitingProjects: waiting,
    reworkRate: metrics.rework.rate,
    decisionLatencyP50Ms: metrics.latency.p50Ms,
    decisionsToday: metrics.decisions.today,
    headline,
  };
}
