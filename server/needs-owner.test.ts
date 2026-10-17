import { describe, expect, it } from "vitest";

import type { DispatchRun, InboxItem as TaskInboxItem } from "../shared/dispatch-types.ts";
import type { InboxItem as BriefInboxItem } from "../shared/org-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";
import { buildNeedsOwner, UNTASKED } from "./needs-owner.ts";

const taskItem = (extra: Partial<TaskInboxItem>): TaskInboxItem => ({
  id: "i1",
  kind: "signoff",
  title: "确认交付",
  reason: "任务已完成",
  createdAt: 1_000,
  ...extra,
});

const briefItem = (extra: Partial<BriefInboxItem>): BriefInboxItem => ({
  id: "b1",
  kind: "approval",
  title: "要发布吗",
  botId: "bot-1",
  since: 2_000,
  ...extra,
});

const folder = (extra: Partial<TaskFolderRecord>): TaskFolderRecord => ({
  id: "t1",
  title: "官网改版",
  color: "#0EA5E9",
  order: 0,
  collapsed: false,
  createdAt: 1,
  ...extra,
});

const run = (extra: Partial<DispatchRun>): DispatchRun =>
  ({
    id: "r1",
    chiefBotId: "c",
    sourceThreadId: "s",
    goal: "g",
    policy: "balanced",
    status: "running",
    subtasks: [],
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  }) as DispatchRun;

describe("buildNeedsOwner", () => {
  it("merges the task inbox and the org brief into one visible projection", () => {
    const summary = buildNeedsOwner({
      inboxItems: [
        taskItem({ id: "gate", kind: "gate_failed", taskId: "t1", createdAt: 1_000 }),
        taskItem({ id: "done", taskId: "t1", resolvedAt: 2_000 }),
      ],
      orgNeedsYou: [briefItem({ id: "approve", kind: "approval", since: 3_000 })],
      folders: [folder({ id: "t1" })],
      now: 10_000,
    });

    expect(summary.total).toBe(2);
    expect(summary.bySource).toEqual({ inbox: 1, brief: 1 });
    expect(summary.byTask).toEqual({ t1: 1, [UNTASKED]: 1 });
    expect(summary.items.map((item) => item.id)).toEqual(["gate", "approve"]);
    expect(summary.items[0]!.waitedMs).toBe(9_000);
    expect(summary.oldestWaitMs).toBe(9_000);
  });

  it("counts a duplicate id once and keeps one card per subtask", () => {
    const summary = buildNeedsOwner({
      inboxItems: [
        taskItem({ id: "same", subtaskId: "s1", createdAt: 5_000 }),
        taskItem({ id: "same", subtaskId: "s1", createdAt: 5_000 }),
        taskItem({ id: "newer", kind: "gate_failed", subtaskId: "s1", createdAt: 9_000 }),
        taskItem({ id: "older", kind: "question", subtaskId: "s2", createdAt: 1_000 }),
        taskItem({ id: "other", kind: "failed_exhausted", subtaskId: "s2", createdAt: 7_000 }),
      ],
      now: 10_000,
    });

    expect(summary.total).toBe(2);
    // s1 keeps the longest wait; the later duplicate on s2 is dropped
    expect(summary.items.map((item) => item.id)).toEqual(["older", "same"]);
    expect(summary.oldestWaitMs).toBe(9_000);
  });

  it("drops a brief plan approval whose dispatch run already settled", () => {
    const summary = buildNeedsOwner({
      orgNeedsYou: [
        briefItem({ id: "stale", runId: "r-done", since: 1_000 }),
        briefItem({ id: "live", runId: "r-live", since: 2_000 }),
      ],
      dispatchRuns: [run({ id: "r-done", status: "done" }), run({ id: "r-live", status: "awaiting-approval" })],
      folders: [folder({ id: "t1", runId: "r-live" })],
      now: 10_000,
    });

    expect(summary.items.map((item) => item.id)).toEqual(["live"]);
    expect(summary.items[0]!.taskId).toBe("t1"); // run → folder mapping fills the task
  });

  it("sorts deterministically by wait, then source, then id (input order irrelevant)", () => {
    const one = buildNeedsOwner({
      inboxItems: [taskItem({ id: "b", createdAt: 2_000 })],
      orgNeedsYou: [briefItem({ id: "a", since: 2_000 })],
      now: 5_000,
    });
    const two = buildNeedsOwner({
      orgNeedsYou: [briefItem({ id: "a", since: 2_000 })],
      inboxItems: [taskItem({ id: "b", createdAt: 2_000 })],
      now: 5_000,
    });
    expect(one.items.map((item) => item.id)).toEqual(["b", "a"]); // inbox first on a tie
    expect(two.items.map((item) => item.id)).toEqual(one.items.map((item) => item.id));
  });

  it("returns an empty, zero-wait summary when nothing is open", () => {
    expect(buildNeedsOwner({ inboxItems: [], orgNeedsYou: [], now: 42 })).toEqual({
      total: 0,
      items: [],
      byTask: {},
      bySource: { inbox: 0, brief: 0 },
      oldestWaitMs: 0,
    });
  });
});
