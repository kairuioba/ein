// 「需要你」收件箱：只放真正需要老板动手的事（验收、失败待决、最终确认）。
// 计数口径：needsYou = 尚未 resolve 的条目数；seen 只清红点，不减少计数。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import type { InboxItem } from "../shared/dispatch-types.ts";

const FILE = "inbox.json";
const MAX_ITEMS = 200;

export class InboxStore {
  private readonly file: string;
  private items: InboxItem[] = [];

  constructor(dataDir = DATA_DIR) {
    this.file = join(dataDir, FILE);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      this.items = Array.isArray(raw) ? (raw as InboxItem[]).filter((item) => item && typeof item.id === "string") : [];
    } catch (error) {
      console.error("inbox: could not read the file, starting empty", error);
      this.items = [];
    }
  }

  private save(): void {
    this.items = this.items.slice(-MAX_ITEMS);
    try {
      writeFileAtomic(this.file, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("inbox: could not persist", error);
    }
  }

  /** Idempotent by (kind, taskId, subtaskId, attemptId): retrying a subtask
   * reuses the same open item instead of flooding the owner. */
  add(input: Omit<InboxItem, "id" | "createdAt" | "seenAt" | "resolvedAt" | "resolution"> & { id?: string }): InboxItem {
    const existing = this.items.find(
      (item) =>
        !item.resolvedAt &&
        item.kind === input.kind &&
        item.taskId === input.taskId &&
        item.subtaskId === input.subtaskId &&
        item.attemptId === input.attemptId,
    );
    if (existing) return existing;
    const item: InboxItem = { id: newId(), createdAt: Date.now(), ...input };
    this.items.push(item);
    this.save();
    return item;
  }

  list(status: "open" | "all" = "open"): InboxItem[] {
    return this.items.filter((item) => (status === "all" ? true : !item.resolvedAt));
  }

  byId(id: string): InboxItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  counts(): { needsYou: number; unseen: number; byTask: Record<string, number> } {
    const open = this.list("open");
    const byTask: Record<string, number> = {};
    for (const item of open) if (item.taskId) byTask[item.taskId] = (byTask[item.taskId] ?? 0) + 1;
    return { needsYou: open.length, unseen: open.filter((item) => !item.seenAt).length, byTask };
  }

  seen(id: string): InboxItem | undefined {
    const item = this.byId(id);
    if (!item || item.seenAt) return item;
    item.seenAt = Date.now();
    this.save();
    return item;
  }

  resolve(id: string, action: "approve" | "reject" | "abandon", note?: string): InboxItem | { error: string } {
    const item = this.byId(id);
    if (!item) return { error: "no such inbox item" };
    if (item.resolvedAt) return item;
    item.resolvedAt = Date.now();
    item.resolution = { action, at: item.resolvedAt, ...(note ? { note } : {}) };
    this.save();
    return item;
  }
}
