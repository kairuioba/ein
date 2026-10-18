// 「需要你」收件箱的前端数据层：服务端 /api/inbox 是唯一来源。
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";

export interface InboxItem {
  id: string;
  kind: "gate_failed" | "signoff" | "question" | "failed_exhausted" | "handoff_stuck" | "plan_approval";
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

// ── 本地「稍后」回流（2.0 收口）─────────────────────────────────────────
//
// 「稍后」在 2.0 里要真的回来：老板点稍后 → 该条从列表消失 24 小时 → 到期
// 自动重新出现，且能撤销。服务端 /api/inbox 目前不下发 snoozeUntil，所以
// 状态存在本机 localStorage 的 `ein.inbox.snooze`：{ [itemId]: 到期时间戳 }。
// 都写成可注入 storage 的纯函数，方便单测；界面只用下面几个入口。
export const INBOX_SNOOZE_STORAGE_KEY = "ein.inbox.snooze";

export type InboxSnoozeMap = Record<string, number>;

/** The slice of Storage this module needs (tests pass a fake). */
export interface InboxSnoozeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultInboxSnoozeStorage(): InboxSnoozeStorage | null {
  try {
    const scope = globalThis as { localStorage?: InboxSnoozeStorage };
    return scope.localStorage ?? null;
  } catch {
    // private mode / non-browser: the panel still works, snoozes just don't persist
    return null;
  }
}

/** Parse the stored JSON defensively: bad or partial data is dropped row by row. */
export function parseInboxSnoozes(raw: string | null | undefined): InboxSnoozeMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const map: InboxSnoozeMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const at = typeof value === "number" ? value : Number(value);
    if (id && Number.isFinite(at) && at > 0) map[id] = at;
  }
  return map;
}

/** Only the snoozes that have not expired yet. */
export function activeInboxSnoozes(map: InboxSnoozeMap, now = Date.now()): InboxSnoozeMap {
  const active: InboxSnoozeMap = {};
  for (const [id, until] of Object.entries(map)) {
    if (Number.isFinite(until) && until > now) active[id] = until;
  }
  return active;
}

/** Is this specific item still snoozed? */
export function isInboxItemSnoozed(id: string, map: InboxSnoozeMap, now = Date.now()): boolean {
  const until = map[id];
  return typeof until === "number" && until > now;
}

/** Split a list into what is due now and what is still snoozed (order kept). */
export function splitBySnooze<T extends { id: string }>(
  items: readonly T[],
  map: InboxSnoozeMap,
  now = Date.now(),
): { due: T[]; snoozed: T[] } {
  const due: T[] = [];
  const snoozed: T[] = [];
  for (const item of items) (isInboxItemSnoozed(item.id, map, now) ? snoozed : due).push(item);
  return { due, snoozed };
}

export function readInboxSnoozes(storage: InboxSnoozeStorage | null = defaultInboxSnoozeStorage()): InboxSnoozeMap {
  try {
    return parseInboxSnoozes(storage?.getItem(INBOX_SNOOZE_STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

export function writeInboxSnoozes(
  map: InboxSnoozeMap,
  storage: InboxSnoozeStorage | null = defaultInboxSnoozeStorage(),
): void {
  if (!storage) return;
  try {
    const active = activeInboxSnoozes(map);
    if (Object.keys(active).length === 0) storage.removeItem(INBOX_SNOOZE_STORAGE_KEY);
    else storage.setItem(INBOX_SNOOZE_STORAGE_KEY, JSON.stringify(active));
  } catch {
    // a full quota must never break the panel; the in-memory state still works
  }
}

/** Snooze one item for the standard 24h; returns the expiry timestamp. */
export function snoozeInboxItem(
  id: string,
  now = Date.now(),
  storage: InboxSnoozeStorage | null = defaultInboxSnoozeStorage(),
): number {
  const until = now + INBOX_SNOOZE_MS;
  const map = readInboxSnoozes(storage);
  map[id] = until;
  writeInboxSnoozes(map, storage);
  return until;
}

/** Undo a snooze ("bring it back"). Returns true when one was removed. */
export function cancelInboxSnooze(
  id: string,
  storage: InboxSnoozeStorage | null = defaultInboxSnoozeStorage(),
): boolean {
  const map = readInboxSnoozes(storage);
  if (!(id in map)) return false;
  delete map[id];
  writeInboxSnoozes(map, storage);
  return true;
}

// ── 统一「需要你」口径（GET /api/needs-owner）─────────────────────────────
//
// 服务端把 /api/inbox 与公司层 brief 的 needsYou 合并成一份口径（见
// server/needs-owner.ts）。标题用它的 total；接口未部署或失败时返回 null，
// 调用方回退到自己列表的长度，绝不因此挡住收件箱。

/** `{ needsOwner: { total } }` → number（形状不对返回 null）。 */
export function needsOwnerTotalFromPayload(payload: unknown): number | null {
  const value = payload as
    | { needsOwner?: { total?: unknown } | null; total?: unknown }
    | null
    | undefined;
  const total = value?.needsOwner?.total ?? value?.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? Math.floor(total) : null;
}

export async function fetchNeedsOwnerTotal(): Promise<number | null> {
  try {
    return needsOwnerTotalFromPayload(await api("/api/needs-owner"));
  } catch {
    return null;
  }
}

/** Poll the unified count; `enabled=false` (panel closed) does not fetch. */
export function useNeedsOwnerTotal(options: { enabled?: boolean; intervalMs?: number } = {}): number | null {
  const { enabled = true, intervalMs = 10_000 } = options;
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const next = await fetchNeedsOwnerTotal();
      if (alive) setTotal(next);
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs]);
  return total;
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
