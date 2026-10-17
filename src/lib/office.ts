// 项目内协同办公的只读投影：GET /api/task-folders/:id/office。
// 所有状态由服务端从 dispatch 子任务/Handoff 推导；这里只负责取数与轮询。
import { useEffect, useState } from "react";

import { api } from "@/state/store";

export interface OfficeWaiting {
  from: { botId?: string; name: string };
  to: { botId?: string; name: string };
  item: string;
  status: string;
  since?: number;
  minutes: number;
}

export interface OfficeMember {
  botId: string;
  name: string;
  title?: string;
  presence: "working" | "waiting" | "reviewing" | "blocked" | "idle";
  current?: string;
  waitingOn?: string;
}

export interface OfficeAnomaly {
  subtaskId: string;
  title: string;
  kind: "failed" | "needs_human" | "rework" | "stalled";
  detail: string;
}

export interface ProjectOffice {
  project: {
    id: string;
    title: string;
    status: string;
    goal?: string;
    leadName?: string;
    progress: { done: number; total: number };
    closedAt?: number;
  };
  departments: Array<{ name: string; members: OfficeMember[] }>;
  now: { waiting: OfficeWaiting[] };
  decisions: Array<{ id: string; kind: string; title: string; reason: string; risk?: string }>;
  activity: Array<{ at: number; kind: string; actor: string; summary: string }>;
  anomalies: OfficeAnomaly[];
}

export function useProjectOffice(folderId: string | undefined, intervalMs = 5000) {
  const [office, setOffice] = useState<ProjectOffice | null>(null);
  useEffect(() => {
    if (!folderId) {
      setOffice(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const next = (await api(`/api/task-folders/${folderId}/office`)) as { office?: ProjectOffice };
        if (alive) setOffice(next.office ?? null);
      } catch {
        // 旧服务端没有这个投影：静默隐藏，不影响聊天
        if (alive) setOffice(null);
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
  }, [folderId, intervalMs]);
  return office;
}
