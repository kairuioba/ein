// Persistence for task folders (the sidebar's outermost layer). One JSON file
// in the data dir: the user's own ordering/colour/fold state plus each task's
// lead. Dispatch runs remain the execution truth; a folder only references one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import type { DispatchRun } from "../shared/dispatch-types.ts";
import {
  DEFAULT_TASK_FOLDER_COLOR,
  TASK_FOLDER_COLORS,
  type TaskFolderRecord,
} from "../shared/task-folders.ts";

const FILE = "task-folders.json";
const MAX_TITLE = 120;
const HEX = /^#[0-9a-fA-F]{6}$/;

const cleanTitle = (value: unknown): string => (typeof value === "string" ? value.trim().slice(0, MAX_TITLE) : "");
const cleanColor = (value: unknown): string | undefined => (typeof value === "string" && HEX.test(value) ? value : undefined);
const cleanOrder = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : undefined;
};

export class TaskFolderStore {
  private readonly file: string;
  private folders: TaskFolderRecord[] = [];
  private listeners = new Set<() => void>();

  constructor(dataDir = DATA_DIR) {
    this.file = join(dataDir, FILE);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return;
      this.folders = raw
        .filter((entry): entry is TaskFolderRecord => Boolean(entry && typeof entry === "object" && typeof (entry as TaskFolderRecord).id === "string"))
        .map((entry) => ({
          id: entry.id,
          title: cleanTitle(entry.title) || entry.title,
          color: cleanColor(entry.color) ?? DEFAULT_TASK_FOLDER_COLOR,
          order: cleanOrder(entry.order) ?? 0,
          collapsed: entry.collapsed === true,
          createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
          ...(typeof entry.leadBotId === "string" && entry.leadBotId ? { leadBotId: entry.leadBotId } : {}),
          ...(typeof entry.runId === "string" && entry.runId ? { runId: entry.runId } : {}),
          ...(Number.isFinite(entry.archivedAt) ? { archivedAt: Number(entry.archivedAt) } : {}),
        }));
    } catch (error) {
      console.error("task folders: could not read the file, starting empty", error);
      this.folders = [];
    }
  }

  private save(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.folders, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("task folders: could not persist", error);
    }
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): TaskFolderRecord[] {
    return [...this.folders].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  byRun(runId: string): TaskFolderRecord | undefined {
    return this.folders.find((folder) => folder.runId === runId);
  }

  byId(id: string): TaskFolderRecord | undefined {
    return this.folders.find((folder) => folder.id === id);
  }

  private nextOrder(): number {
    return this.folders.reduce((max, folder) => Math.max(max, folder.order), -1) + 1;
  }

  /** Create the folder for a dispatch run (idempotent). The caller supplies
   * the task's own lead; the store never assumes the company chief. */
  ensureForRun(run: DispatchRun, leadBotId?: string, conversationId?: string): TaskFolderRecord {
    const existing = this.byRun(run.id);
    if (existing) {
      let changed = false;
      if (leadBotId && !existing.leadBotId) {
        existing.leadBotId = leadBotId;
        changed = true;
      }
      if (conversationId && !existing.conversationId) {
        existing.conversationId = conversationId;
        changed = true;
      }
      if (changed) this.save();
      return existing;
    }
    const folder: TaskFolderRecord = {
      id: newId(),
      title: cleanTitle(run.goal) || run.goal.slice(0, MAX_TITLE),
      color: TASK_FOLDER_COLORS[this.folders.length % TASK_FOLDER_COLORS.length],
      order: this.nextOrder(),
      collapsed: false,
      ...(leadBotId ? { leadBotId } : {}),
      ...(conversationId ? { conversationId } : {}),
      runId: run.id,
      createdAt: Number.isFinite(run.createdAt) ? run.createdAt : Date.now(),
    };
    this.folders.push(folder);
    this.save();
    return folder;
  }

  /** First boot with existing runs: give the recent top-level ones a folder so
   * the sidebar does not start empty. Newer runs win; at most `limit`. */
  seedFromRuns(runs: readonly DispatchRun[], limit = 12, leadFor?: (run: DispatchRun) => string | undefined): void {
    const top = runs
      .filter((run) => !run.parentRunId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .reverse();
    let changed = false;
    for (const run of top) {
      if (this.byRun(run.id)) continue;
      this.folders.push({
        id: newId(),
        title: cleanTitle(run.goal) || run.goal.slice(0, MAX_TITLE),
        color: TASK_FOLDER_COLORS[this.folders.length % TASK_FOLDER_COLORS.length],
        order: this.nextOrder(),
        collapsed: false,
        ...(leadFor?.(run) ? { leadBotId: leadFor(run) } : {}),
        runId: run.id,
        createdAt: run.createdAt,
      });
      changed = true;
    }
    if (changed) this.save();
  }

  /** A manual task (no dispatch run yet). */
  create(input: { title?: unknown; color?: unknown; leadBotId?: unknown }): TaskFolderRecord | { error: string } {
    const title = cleanTitle(input.title);
    if (!title) return { error: "a task folder needs a title" };
    const folder: TaskFolderRecord = {
      id: newId(),
      title,
      color: cleanColor(input.color) ?? TASK_FOLDER_COLORS[this.folders.length % TASK_FOLDER_COLORS.length],
      order: this.nextOrder(),
      collapsed: false,
      ...(typeof input.leadBotId === "string" && input.leadBotId ? { leadBotId: input.leadBotId } : {}),
      createdAt: Date.now(),
    };
    this.folders.push(folder);
    this.save();
    return folder;
  }

  patch(
    id: string,
    patch: { title?: unknown; color?: unknown; order?: unknown; collapsed?: unknown; leadBotId?: unknown; archived?: unknown },
  ): TaskFolderRecord | { error: string } {
    const folder = this.byId(id);
    if (!folder) return { error: "no such task folder" };
    if (patch.title !== undefined) {
      const title = cleanTitle(patch.title);
      if (!title) return { error: "a task folder needs a title" };
      folder.title = title;
    }
    if (patch.color !== undefined) {
      const color = cleanColor(patch.color);
      if (!color) return { error: "color must be #RRGGBB" };
      folder.color = color;
    }
    if (patch.order !== undefined) {
      const order = cleanOrder(patch.order);
      if (order === undefined) return { error: "order must be a number" };
      folder.order = order;
    }
    if (patch.collapsed !== undefined) folder.collapsed = patch.collapsed === true;
    if (patch.leadBotId !== undefined) {
      if (patch.leadBotId === null || patch.leadBotId === "") delete folder.leadBotId;
      else if (typeof patch.leadBotId === "string") folder.leadBotId = patch.leadBotId;
    }
    if (patch.archived !== undefined) {
      if (patch.archived === true) folder.archivedAt = Date.now();
      else delete folder.archivedAt;
    }
    this.save();
    return folder;
  }

  /** Archive, don't delete: bots and their conversations stay. */
  archive(id: string): TaskFolderRecord | { error: string } {
    return this.patch(id, { archived: true });
  }
}
