// 晨报 / 老板时间账本的前端数据层（数字由服务端代码生成，不调模型）。
import { useEffect, useState } from "react";

import { api } from "@/state/store";

export interface MorningBrief {
  generatedAt: number;
  openDecisions: number;
  waitingProjects: number;
  reworkRate: number | null;
  decisionLatencyP50Ms: number | null;
  decisionsToday: number;
  headline: "nothing" | "decisions" | "running";
}

export function useMorningBrief(intervalMs = 30_000) {
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = (await api("/api/office/brief")) as { brief?: MorningBrief };
        if (alive) setBrief(next.brief ?? null);
      } catch {
        if (alive) setBrief(null);
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
  return brief;
}

export const formatMinutes = (ms: number | null): string => (ms === null ? "—" : ms < 60_000 ? "<1" : String(Math.round(ms / 60_000)));

export const formatRate = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
