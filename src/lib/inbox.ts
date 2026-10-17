// 「需要你」收件箱的前端数据层：服务端 /api/inbox 是唯一来源。
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";

export interface InboxItem {
  id: string;
  kind: "gate_failed" | "signoff" | "question" | "failed_exhausted" | "handoff_stuck";
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
  /** Optional server field once it exists; until then "later" is derived from seenAt. */
  snoozeUntil?: number;
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

/** 「稍后」的临时规则：服务端 /api/inbox 目前不下发 snoozeUntil。
 * 前端用 seenAt + 24h 本地回推到期时刻（纯前端临时方案，不写回服务端）；
 * 后端补上字段后这里自动优先使用它，调用方不用改。 */
export const INBOX_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** The only fields the snooze rules read; plain objects are accepted. */
export interface SnoozeFields {
  snoozeUntil?: number;
  seenAt?: number;
  resolvedAt?: number;
}

/** When this item's "later" runs out (null = never snoozed). */
export function snoozeUntil(item: Pick<SnoozeFields, "snoozeUntil" | "seenAt">): number | null {
  if (typeof item.snoozeUntil === "number") return item.snoozeUntil;
  if (typeof item.seenAt === "number") return item.seenAt + INBOX_SNOOZE_MS;
  return null;
}

/** Still snoozed at `now`? Resolved items never are. */
export function isSnoozed(item: SnoozeFields, now = Date.now()): boolean {
  if (item.resolvedAt) return false;
  const until = snoozeUntil(item);
  return until !== null && until > now;
}

/** Items whose snooze expired (or never started): the queue that is due again. */
export function dueInboxItems<T extends SnoozeFields>(items: readonly T[], now = Date.now()): T[] {
  return items.filter((item) => !item.resolvedAt && !isSnoozed(item, now));
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
