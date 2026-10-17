// 「需要你」的统一口径（2.0 收口）。
//
// 现在有两个可见队列：`/api/inbox`（任务的 gate/签收/问题/交接卡）与
// `/api/brief` 里的 org `needsYou`（选择卡/审批/升级）。它们各自的接口都对，
// 但「老板到底欠几件事」在两个界面上会给出不同的数。这个模块把两份输入
// 归一成一份纯数据投影：不读文件、不碰 store、不调模型，调用方把快照传进来
// （server/index.ts 负责接线，见 Lead 的接线改动）。
//
// 口径（刻意保守，宁少勿假）：
//   · 已 resolved 的不算；
//   · 重复 id 只算一次（/api/inbox 优先于 brief）；
//   · 同一 subtask 的多张卡只算一次（保留等得最久的那张）；
//   · 已知 run 的终态（done/failed/canceled）会丢掉仍挂在它上面的 brief
//     plan 审批——那是过期卡片，不是老板欠的事；
//   · 排序稳定：等得最久的在前；同一时刻按 source（inbox 先）再按 id。
import type { DispatchRun, InboxItem as TaskInboxItem } from "../shared/dispatch-types.ts";
import type { InboxItem as BriefInboxItem } from "../shared/org-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";

export type NeedsOwnerSource = "inbox" | "brief";

/** 一条「需要你」的统一视图。 */
export interface NeedsOwnerItem {
  id: string;
  source: NeedsOwnerSource;
  kind: string;
  title: string;
  reason?: string;
  taskId?: string;
  runId?: string;
  subtaskId?: string;
  /** when it started waiting (epoch ms) */
  since: number;
  /** how long the owner has been kept waiting at `now` */
  waitedMs: number;
}

export interface NeedsOwnerSummary {
  total: number;
  items: NeedsOwnerItem[];
  /** counts by task folder id; `__untasked__` collects items with no task */
  byTask: Record<string, number>;
  bySource: { inbox: number; brief: number };
  /** how long the oldest open item has been waiting (0 when nothing is open) */
  oldestWaitMs: number;
}

export interface NeedsOwnerInput {
  /** items from GET /api/inbox (already the server's in-memory list) */
  inboxItems?: readonly TaskInboxItem[];
  /** the org layer's `needsYou` from /api/brief (choice/approval/escalation) */
  orgNeedsYou?: readonly BriefInboxItem[];
  /** dispatch runs, used to drop plan approvals whose run already settled */
  dispatchRuns?: readonly DispatchRun[];
  /** task folders, used to map run → task and to title untitled items */
  folders?: readonly TaskFolderRecord[];
  now?: number;
}

export const UNTASKED = "__untasked__";
const SOURCE_RANK: Record<NeedsOwnerSource, number> = { inbox: 0, brief: 1 };

const isFinished = (run: DispatchRun): boolean =>
  run.status === "done" || run.status === "failed" || run.status === "canceled";

/** Build the one visible "needs you" projection both surfaces can render. */
export function buildNeedsOwner(input: NeedsOwnerInput = {}): NeedsOwnerSummary {
  const now = input.now ?? Date.now();
  const folders = input.folders ?? [];
  const runToTask = new Map<string, string>();
  for (const folder of folders) if (folder.runId) runToTask.set(folder.runId, folder.id);
  const taskTitles = new Map(folders.map((folder) => [folder.id, folder.title]));
  const runs = input.dispatchRuns ?? [];
  const openRunIds = runs.length ? new Set(runs.filter((run) => !isFinished(run)).map((run) => run.id)) : null;

  const items: NeedsOwnerItem[] = [];
  const seenIds = new Set<string>();
  const claimId = (id: string): boolean => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  };

  for (const item of input.inboxItems ?? []) {
    if (item.resolvedAt) continue;
    if (!claimId(item.id)) continue;
    const runId = item.runId;
    items.push({
      id: item.id,
      source: "inbox",
      kind: item.kind,
      title: item.title || "需要你",
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.taskId ? { taskId: item.taskId } : runId && runToTask.has(runId) ? { taskId: runToTask.get(runId)! } : {}),
      ...(runId ? { runId } : {}),
      ...(item.subtaskId ? { subtaskId: item.subtaskId } : {}),
      since: item.createdAt,
      waitedMs: Math.max(0, now - item.createdAt),
    });
  }

  for (const item of input.orgNeedsYou ?? []) {
    // A plan approval whose dispatch run already settled is stale, not owed.
    if (item.runId && openRunIds && !openRunIds.has(item.runId)) continue;
    if (!claimId(item.id)) continue;
    const taskId = item.runId ? runToTask.get(item.runId) : undefined;
    const title = item.title?.trim() || (taskId ? taskTitles.get(taskId) : undefined) || "需要你";
    items.push({
      id: item.id,
      source: "brief",
      kind: item.kind,
      title,
      ...(item.detail ? { reason: item.detail } : {}),
      ...(taskId ? { taskId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
      since: item.since,
      waitedMs: Math.max(0, now - item.since),
    });
  }

  // One subtask can raise more than one card (gate_failed + failed_exhausted,
  // or a retry attempt). Keep the one the owner has been waiting on longest.
  const bySubtask = new Map<string, NeedsOwnerItem>();
  const deduped: NeedsOwnerItem[] = [];
  for (const item of items) {
    const key = item.subtaskId ? `${item.taskId ?? "-"}:${item.subtaskId}` : undefined;
    if (!key) {
      deduped.push(item);
      continue;
    }
    const existing = bySubtask.get(key);
    if (!existing) {
      bySubtask.set(key, item);
      deduped.push(item);
      continue;
    }
    if (item.since < existing.since) {
      const at = deduped.indexOf(existing);
      if (at >= 0) deduped[at] = item;
      bySubtask.set(key, item);
    }
  }

  deduped.sort((a, b) => {
    if (a.since !== b.since) return a.since - b.since;
    const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (rank !== 0) return rank;
    return a.id.localeCompare(b.id);
  });

  const byTask: Record<string, number> = {};
  const bySource = { inbox: 0, brief: 0 };
  for (const item of deduped) {
    const key = item.taskId ?? UNTASKED;
    byTask[key] = (byTask[key] ?? 0) + 1;
    bySource[item.source] += 1;
  }

  return {
    total: deduped.length,
    items: deduped,
    byTask,
    bySource,
    oldestWaitMs: deduped.length ? Math.max(0, now - deduped[0]!.since) : 0,
  };
}
