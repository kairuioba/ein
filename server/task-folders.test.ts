import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DispatchRun } from "../shared/dispatch-types.ts";
import { TaskFolderStore } from "./task-folders.ts";

const run = (id: string, goal: string, extra: Partial<DispatchRun> = {}): DispatchRun => ({
  id,
  chiefBotId: "chief",
  sourceThreadId: "t",
  goal,
  policy: "balanced",
  status: "running",
  subtasks: [],
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-task-folders-"));
  return { dir, store: new TaskFolderStore(dir) };
};

describe("task folders", () => {
  it("creates, reorders, folds and archives folders", () => {
    const { store } = temp();
    const first = store.create({ title: "发布会筹备", color: "#0EA5E9" });
    if ("error" in first) throw new Error(first.error);
    const second = store.create({ title: "用户访谈提纲" });
    if ("error" in second) throw new Error(second.error);
    expect(store.list().map((folder) => folder.title)).toEqual(["发布会筹备", "用户访谈提纲"]);
    expect(store.patch(second.id, { order: -1 })).toMatchObject({ order: 0 });
    expect(store.patch(first.id, { collapsed: true, title: "发布会" })).toMatchObject({ collapsed: true, title: "发布会" });
    expect(store.archive(second.id)).toMatchObject({ archivedAt: expect.any(Number) });
    expect(store.create({ title: "  " })).toMatchObject({ error: expect.stringContaining("title") });
  });

  it("links the task's own window and never forgets it", () => {
    const { store } = temp();
    const a = store.ensureForRun(run("run-a", "做发布会材料"), "lead-a", "conv-a");
    expect(a.conversationId).toBe("conv-a");
    // a later sync without the conversation must not erase it
    const again = store.ensureForRun(run("run-a", "做发布会材料"), undefined, undefined);
    expect(again.conversationId).toBe("conv-a");
    expect(store.ensureForRun(run("run-b", "第二个任务"), undefined, "conv-b")).toMatchObject({ conversationId: "conv-b" });
  });

  it("is idempotent per run and keeps the task's own lead", () => {
    const { store } = temp();
    const a = store.ensureForRun(run("run-a", "做发布会材料"), "lead-a");
    const again = store.ensureForRun(run("run-a", "做发布会材料"));
    expect(again.id).toBe(a.id);
    expect(a.leadBotId).toBe("lead-a");
    expect(store.byRun("run-a")?.title).toBe("做发布会材料");
    expect(store.create({ title: "手动任务", leadBotId: "lead-b" })).toMatchObject({ leadBotId: "lead-b" });
  });

  it("attaches a dispatch run to the task window created before it", () => {
    const { store } = temp();
    const created = store.create({ title: "新任务", conversationId: "win-1", leadBotId: "lead" });
    if ("error" in created) throw new Error(created.error);
    const folder = store.ensureForRun(run("run-1", "新任务目标"), "lead-2", "win-1");
    expect(folder.id).toBe(created.id);
    expect(folder.runId).toBe("run-1");
    expect(folder.leadBotId).toBe("lead-2");
    expect(store.byConversation("win-1")?.id).toBe(created.id);
  });

  it("records fork lineage and is idempotent by client request id", () => {
    const { store } = temp();
    const forked = store.create({ title: "续作", conversationId: "win-2", forkedFromTaskId: "old", forkRequestId: "req-1" });
    if ("error" in forked) throw new Error(forked.error);
    expect(forked).toMatchObject({ forkedFromTaskId: "old", forkRequestId: "req-1", conversationId: "win-2" });
    expect(store.byForkRequest("req-1")?.id).toBe(forked.id);
    expect(store.byForkRequest("nope")).toBeUndefined();
  });

  it("keeps every context share as an append-only audit snapshot", () => {
    const { dir, store } = temp();
    const target = store.create({ title: "新任务" });
    if ("error" in target) throw new Error(target.error);
    const first = store.setContextShare(target.id, { fromTaskIds: ["t1"], tokens: 120, text: "第一版共享" });
    expect("error" in first).toBe(false);
    const second = store.setContextShare(target.id, { fromTaskIds: ["t1", "t2"], tokens: 90, text: "第二版共享" });
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.contextShares).toHaveLength(2);
    expect(second.contextShares?.[0]).toMatchObject({ fromTaskIds: ["t1"], text: "第一版共享", acceptedBasis: "proxy" });
    expect(second.contextShares?.[1]).toMatchObject({ fromTaskIds: ["t1", "t2"], text: "第二版共享" });
    const reloaded = new TaskFolderStore(dir);
    expect(reloaded.byId(target.id)?.contextShares).toHaveLength(2);
  });

  it("seeds one folder per recent top-level run and persists across reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "ein-task-folders-"));
    const runs = [
      run("r1", "旧任务", { createdAt: 1000 }),
      run("r2", "新任务", { createdAt: 2000 }),
      run("child", "部门计划", { parentRunId: "r2", createdAt: 2500 }),
    ];
    const store = new TaskFolderStore(dir);
    store.seedFromRuns(runs);
    store.seedFromRuns(runs);
    expect(store.list()).toHaveLength(2);
    const reloaded = new TaskFolderStore(dir);
    expect(reloaded.list().map((folder) => folder.title)).toEqual(["旧任务", "新任务"]);
    const raw = JSON.parse(readFileSync(join(dir, "task-folders.json"), "utf8")) as unknown[];
    expect(raw).toHaveLength(2);
  });
});
