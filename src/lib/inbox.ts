// 「需要你」收件箱的前端数据层：服务端 /api/inbox 是唯一来源。
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";

export interface InboxItem {
  id: string;
  kind: "gate_failed" | "signoff" | "question" | "failed_exhausted";
  taskId?: string;
  runId?: string;
  subtaskId?: string;
  attemptId?: string;
  title: string;
  reason: string;
  evidence?: string[];
  createdAt: number;
  seenAt?: number;
  resolvedAt?: number;
}

export interface InboxCounts {
  needsYou: number;
  unseen: number;
  byTask: Record<string, number>;
}

export interface InboxGroup {
  taskId?: string;
  title: string;
  items: InboxItem[];
  counts: { open: number };
  signoff: boolean;
}

const EMPTY: { items: InboxItem[]; counts: InboxCounts; groups: InboxGroup[] } = {
  items: [],
  counts: { needsYou: 0, unseen: 0, byTask: {} },
  groups: [],
};

export function useInbox(intervalMs = 5000) {
  const [data, setData] = useState(EMPTY);
  const refresh = useCallback(async () => {
    try {
      const next = (await api("/api/inbox")) as { items?: InboxItem[]; counts?: InboxCounts; groups?: InboxGroup[] };
      setData({ items: next.items ?? [], counts: next.counts ?? EMPTY.counts, groups: next.groups ?? EMPTY.groups });
    } catch {
      // the inbox is an auxiliary surface: keep the last snapshot on failure
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);
  return { ...data, refresh };
}

export async function markInboxSeen(id: string): Promise<void> {
  await api(`/api/inbox/${id}/seen`, { method: "POST", body: "{}" });
}

export async function resolveInboxItem(id: string, action: "approve" | "reject" | "abandon", note?: string, expectedAttemptId?: string): Promise<void> {
  await api(`/api/inbox/${id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ action, ...(note ? { note } : {}), ...(expectedAttemptId ? { expectedAttemptId } : {}) }),
  });
}
