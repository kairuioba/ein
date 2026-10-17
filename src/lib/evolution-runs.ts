// 阶段4：已采纳提案的执行状态 + 老板操作（交给维护机器人 / 批准合并）。
import { useEffect, useState } from "react";

import { api } from "@/state/store";

export interface EvolutionExecution {
  proposalId: string;
  runId: string;
  state: string;
  branch?: string;
  worktreeDir?: string;
  headSha?: string;
  diff?: string;
  testLog?: string;
  review?: { pass: boolean; reason?: string; reviewer?: string };
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface EvolutionRunView {
  run: { id: string; proposalId?: string; state: string; headSha?: string };
  headline?: string;
}

export function useEvolutionRuns(intervalMs = 10_000) {
  const [runs, setRuns] = useState<EvolutionRunView[]>([]);
  const [executions, setExecutions] = useState<EvolutionExecution[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = (await api("/api/evolution/runs")) as { runs?: EvolutionRunView[]; executions?: EvolutionExecution[] };
        if (!alive) return;
        setRuns(next.runs ?? []);
        setExecutions(next.executions ?? []);
      } catch {
        // stage-4 is optional: hide when the endpoint is unavailable
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return { runs, executions };
}

export async function startEvolutionRun(runId: string): Promise<void> {
  await api(`/api/evolution/runs/${runId}/start`, { method: "POST", body: "{}" });
}

export async function mergeEvolutionRun(runId: string, headSha: string): Promise<void> {
  await api(`/api/evolution/runs/${runId}/merge`, { method: "POST", body: JSON.stringify({ headSha }) });
}

export const EVOLUTION_STATE_LABELS: Record<string, string> = {
  accepted: "已采纳，等待交给维护机器人",
  provisioning: "正在准备独立工作区",
  implementing: "维护机器人在改",
  guarding: "正在检查改动范围",
  testing: "正在跑测试",
  reviewing: "独立评审中",
  merge_ready: "等待你批准合并",
  merged: "已合并",
  rejected: "已拒绝（改动不合规或未通过）",
  aborted: "已放弃",
  expired: "已过期",
};
