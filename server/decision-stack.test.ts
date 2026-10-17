import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask, InboxItem } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";
import { buildDecisionStack } from "./decision-stack.ts";

// a fake clock: 10h after epoch, so "waited 2h" etc. reads clearly
const NOW = 10 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const item = (extra: Partial<InboxItem> & Pick<InboxItem, "kind" | "id">): InboxItem => ({
  title: "发布 v1.1.4 更新说明",
  reason: "最终确认",
  createdAt: NOW - MIN,
  ...extra,
});

const subtask = (extra: Partial<DispatchSubtask> = {}): DispatchSubtask => ({
  id: "s1",
  title: "文案",
  brief: "b",
  role: "文案",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId: "b1",
  status: "running",
  attempts: 1,
  ...extra,
});

const run = (extra: Partial<DispatchRun> = {}): DispatchRun => ({
  id: "r1",
  chiefBotId: "chief",
  sourceThreadId: "t",
  goal: "发布会",
  policy: "balanced",
  status: "running",
  subtasks: [subtask()],
  createdAt: NOW - 120 * MIN,
  updatedAt: NOW - 10 * MIN,
  ...extra,
});

const folder = (extra: Partial<TaskFolderRecord> = {}): TaskFolderRecord => ({
  id: "f1",
  title: "发布会",
  color: "#0EA5E9",
  order: 0,
  collapsed: false,
  createdAt: NOW - 300 * MIN,
  runId: "r1",
  ...extra,
});

describe("buildDecisionStack", () => {
  it("sorts by risk first, then by how long the owner has been kept waiting", () => {
    const stack = buildDecisionStack({
      items: [
        item({ id: "signoff", kind: "signoff", createdAt: NOW - MIN }),
        item({ id: "question", kind: "question", createdAt: NOW - 10 * MIN }),
        item({ id: "gate", kind: "gate_failed", createdAt: NOW - 5 * MIN }),
        item({ id: "failed", kind: "failed_exhausted", createdAt: NOW - 6 * 60 * MIN }),
      ],
      now: NOW,
    });
    expect(stack.cards.map((card) => card.id)).toEqual(["signoff", "question", "gate", "failed"]);
    expect(stack.cards.map((card) => card.risk)).toEqual(["high", "medium", "medium", "low"]);
    expect(stack.cards.map((card) => card.waitedMs)).toEqual([MIN, 10 * MIN, 5 * MIN, 6 * 60 * MIN]);
  });

  it("keeps a signoff on top and spells out what approving does", () => {
    const stack = buildDecisionStack({
      items: [
        item({ id: "gate", kind: "gate_failed", createdAt: NOW - 30 * MIN }),
        item({ id: "signoff", kind: "signoff", taskId: "f1", runId: "r1" }),
      ],
      runs: [run({ status: "done", subtasks: [subtask({ status: "done" })] })],
      folders: [folder()],
      now: NOW,
    });
    const signoff = stack.cards[0]!;
    expect(signoff).toMatchObject({
      id: "signoff",
      kind: "signoff",
      taskId: "f1",
      risk: "high",
      irreversible: true,
      approveEffect: "通过即完成",
    });
    expect(signoff.actions).toEqual(expect.arrayContaining(["approve", "reject", "snooze"]));
    const gate = stack.cards[1]!;
    expect(gate).toMatchObject({ kind: "gate_failed", risk: "medium", approveEffect: "通过后接受此结果" });
    expect(gate.irreversible).toBe(true);
  });

  it("raises a gate to high risk when evidence is broken or the work was already sent back", () => {
    const stack = buildDecisionStack({
      // r1/s1 was reworked before: "artifacts" plus a rework count
      items: [
        item({ id: "broken", kind: "gate_failed", runId: "r1", subtaskId: "s1", reason: "cannot verify: artifacts" }),
        item({ id: "plain", kind: "question", createdAt: NOW - 2 * MIN }),
      ],
      runs: [run({ subtasks: [subtask({ id: "s1", status: "done", reworkCount: 2 })] })],
      now: NOW,
    });
    expect(stack.cards.find((card) => card.id === "broken")).toMatchObject({ risk: "high" });
    expect(stack.cards.find((card) => card.id === "plain")).toMatchObject({ risk: "medium" });
  });

  it("flags a running task with no activity for 30 minutes and counts it", () => {
    const stack = buildDecisionStack({
      items: [],
      runs: [
        run({ id: "r1", updatedAt: NOW - 40 * MIN, subtasks: [subtask({ status: "done" }), subtask({ id: "s2" })] }),
        run({ id: "r2", status: "synthesizing", updatedAt: NOW - MIN }),
        run({ id: "r3", status: "done", subtasks: [subtask({ status: "done" })] }),
      ],
      folders: [folder({ id: "f1", title: "发布会", runId: "r1" }), folder({ id: "f2", title: "官网改版", runId: "r2" })],
      now: NOW,
    });
    expect(stack.running).toEqual([
      { taskId: "f1", title: "发布会", status: "running", progress: { done: 1, total: 2 }, stalled: true },
      { taskId: "f2", title: "官网改版", status: "synthesizing", progress: { done: 0, total: 1 }, stalled: false },
    ]);
    expect(stack.counts).toEqual({ waiting: 0, running: 2, stalled: 1 });
    expect(stack.statusLine).toBe("公司在自己运转。2 个任务在跑，其中 1 个卡住了。");
  });

  it("says nothing is waiting when the stack is empty", () => {
    const stack = buildDecisionStack({ items: [], now: NOW });
    expect(stack).toEqual({
      generatedAt: NOW,
      statusLine: "今天没有事找你了。",
      cards: [],
      running: [],
      counts: { waiting: 0, running: 0, stalled: 0 },
    });
  });

  it("summarises the company and drops already-handled items", () => {
    const runs = [run({ id: "r1" }), run({ id: "r2" }), run({ id: "r3" }), run({ id: "r4" })];
    const stack = buildDecisionStack({
      items: [
        item({ id: "signoff", kind: "signoff", taskId: "f1", runId: "r1" }),
        item({ id: "done", kind: "question", resolvedAt: NOW - MIN, createdAt: NOW - 3 * 60 * MIN }),
      ],
      runs,
      folders: [folder({ id: "f1", title: "发布 v1.1.4", runId: "r1" })],
      now: NOW,
    });
    expect(stack.statusLine).toBe("公司在自己运转。4 个任务在跑，1 件事等你拍板。");
    expect(stack.cards).toHaveLength(1);
    expect(stack.cards[0]).toMatchObject({ id: "signoff", taskId: "f1", title: "发布 v1.1.4 更新说明" });
    expect(stack.running[0]).toMatchObject({ taskId: "f1", title: "发布 v1.1.4" });
  });
});
