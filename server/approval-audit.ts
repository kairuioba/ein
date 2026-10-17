// 自动批准审计：追加 JSONL + 启动折叠。关键约束（来自设计讨论）：
// 自动批准的资格只数「老板手动批准」的次数，自动批准不能给自己加信任；
// 一次撤销从撤销时间起清零手动计数并冷却 14 天；同一对象累计 2 次撤销锁定
// 为 ask_only。这里不写任何 UI，所有数字都是折叠推导，不存可变状态。
import { existsSync, readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type AuditMode = "manual" | "auto";
export type AuditEventKind = "approved" | "reverted";

export interface AuditEvent {
  id: string;
  idempotencyKey: string;
  event: AuditEventKind;
  actionType: string;
  project: string;
  target: string;
  beforeHash?: string;
  afterHash?: string;
  actor: string;
  mode: AuditMode;
  ruleVersion: number;
  decidedAt: number;
  revertedAt?: number;
  rollbackRef?: string;
  evidence?: string[];
}

export interface ApprovalStats {
  actionType: string;
  project: string;
  manualApproved: number;
  autoApproved: number;
  revertedCount: number;
  lastRevertAt?: number;
  /** auto eligibility: enough manual approvals, no recent revert */
  eligibleForAuto: boolean;
  trustLevel: "ask_only" | "manual" | "auto";
}

export const AUTO_MANUAL_MIN = 3;
export const AUTO_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const ASK_ONLY_AFTER_REVERTS = 2;

/** Fold the append-only log into per (actionType, project) counters. */
export function foldAuditEvents(events: readonly AuditEvent[], options: { now?: number } = {}): Map<string, ApprovalStats> {
  const now = options.now ?? Date.now();
  const groups = new Map<string, { events: AuditEvent[] }>();
  for (const event of events) {
    const key = `${event.actionType}\u0000${event.project}`;
    const group = groups.get(key) ?? { events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  const stats = new Map<string, ApprovalStats>();
  for (const [key, group] of groups) {
    const [actionType, project] = key.split("\u0000") as [string, string];
    const approvals = group.events.filter((event) => event.event === "approved");
    const reverts = group.events.filter((event) => event.event === "reverted");
    const lastRevertAt = reverts.reduce<number | undefined>((max, event) => Math.max(max ?? 0, event.revertedAt ?? event.decidedAt), undefined);
    const sinceRevert = (event: AuditEvent) => (lastRevertAt === undefined ? true : event.decidedAt > lastRevertAt);
    const manualApproved = approvals.filter((event) => event.mode === "manual" && sinceRevert(event)).length;
    const autoApproved = approvals.filter((event) => event.mode === "auto" && sinceRevert(event)).length;
    const revertedCount = reverts.length;
    // lock per object, not per group: two reverts of one target are worse
    // than one revert each of two targets
    const revertsByTarget = new Map<string, number>();
    for (const event of reverts) {
      const key = event.target || event.idempotencyKey;
      revertsByTarget.set(key, (revertsByTarget.get(key) ?? 0) + 1);
    }
    const locked = [...revertsByTarget.values()].some((count) => count >= ASK_ONLY_AFTER_REVERTS);
    const cooled = lastRevertAt !== undefined && now - lastRevertAt < AUTO_COOLDOWN_MS;
    const eligibleForAuto = !locked && !cooled && manualApproved >= AUTO_MANUAL_MIN;
    stats.set(key, {
      actionType,
      project,
      manualApproved,
      autoApproved,
      revertedCount,
      ...(lastRevertAt !== undefined ? { lastRevertAt } : {}),
      eligibleForAuto,
      trustLevel: locked ? "ask_only" : eligibleForAuto ? "auto" : "manual",
    });
  }
  return stats;
}

/** An owner's explicit approval of an inbox item is a manual approval event:
 * only these grant trust to the matching action type, never automatic ones. */
export function inboxDecisionAudit(input: {
  item: { id: string; kind: string; taskId?: string; title?: string };
  action: "approve" | "reject" | "abandon";
  note?: string;
  now?: number;
}): Omit<AuditEvent, "id"> | null {
  if (input.action !== "approve") return null;
  const now = input.now ?? Date.now();
  return {
    idempotencyKey: `inbox:approve:${input.item.id}`,
    event: "approved",
    actionType: `inbox.approve:${input.item.kind}`,
    project: input.item.taskId ?? "ein",
    target: input.item.id,
    actor: "owner",
    mode: "manual",
    ruleVersion: 1,
    decidedAt: now,
    ...(input.note ? { evidence: [input.note.slice(0, 300)] } : {}),
  };
}

/** In-memory index over the JSONL log; append is the only write. */
export class ApprovalAuditStore {
  private readonly file: string;
  private events: AuditEvent[] = [];
  private byKey = new Map<string, AuditEvent>();

  constructor(dataDir = DATA_DIR) {
    this.file = join(dataDir, "approval-audit.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      console.error("approval audit: could not read the log", error);
      return;
    }
    // a torn write must not hide the rest of the log (a reverted event could
    // be dropped, silently restoring trust)
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEvent;
        if (parsed && typeof parsed.idempotencyKey === "string") {
          this.events.push(parsed);
          this.byKey.set(parsed.idempotencyKey, parsed);
        }
      } catch {
        console.error("approval audit: skipped a corrupt line");
      }
    }
  }

  list(): AuditEvent[] {
    return [...this.events];
  }

  /** Idempotent append: the same key returns the stored event untouched. */
  append(input: Omit<AuditEvent, "id" | "decidedAt"> & { id?: string; decidedAt?: number }): { event: AuditEvent; deduped: boolean } {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return { event: existing, deduped: true };
    const event: AuditEvent = { ...input, id: input.id ?? newId(), decidedAt: input.decidedAt ?? Date.now() };
    this.events.push(event);
    this.byKey.set(event.idempotencyKey, event);
    try {
      // if a crash left a line without newline, repair before appending
      let prefix = "";
      if (existsSync(this.file)) {
        const tail = readFileSync(this.file, "utf8").slice(-1);
        if (tail && tail !== "\n") prefix = "\n";
      }
      appendFileSync(this.file, `${prefix}${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error("approval audit: could not persist", error);
    }
    return { event, deduped: false };
  }

  stats(actionType: string, project: string, now = Date.now()): ApprovalStats {
    const folded = foldAuditEvents(this.events, { now });
    return (
      folded.get(`${actionType}\u0000${project}`) ?? {
        actionType,
        project,
        manualApproved: 0,
        autoApproved: 0,
        revertedCount: 0,
        eligibleForAuto: false,
        trustLevel: "manual",
      }
    );
  }
}
