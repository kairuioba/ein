import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";
import { buildStateDoc } from "./state-doc.ts";

const folder: TaskFolderRecord = { id: "f1", title: "发布会", color: "#0EA5E9", order: 0, collapsed: false, createdAt: 1000 };

const subtask = (extra: Partial<DispatchSubtask>): DispatchSubtask => ({
  id: "s1", title: "文案", brief: "b", role: "文案", needs: [], difficulty: 2, dependsOn: [], assigneeBotId: "b1", status: "done", attempts: 1, ...extra,
});

const run = (extra: Partial<DispatchRun> = {}): DispatchRun => ({
  id: "r1", chiefBotId: "chief", sourceThreadId: "t", goal: "发布会", policy: "balanced", status: "running",
  subtasks: [subtask({ gate: { status: "pass", criteria: [], deterministic: [], at: 2000 }, handoff: { status: "done", summary: "写好了", artifacts: ["copy.md"] } })],
  createdAt: 1000, updatedAt: 2000, ...extra,
});

describe("StateDoc facts and drift", () => {
  it("summarizes progress, gates and artifacts from the run, not from a model", () => {
    const doc = buildStateDoc({ folder, run: run(), inboxOpen: 0, now: 5000 });
    expect(doc.facts.progress).toEqual({ done: 1, total: 1 });
    expect(doc.facts.gates).toEqual({ pass: 1, fail: 0, needsHuman: 0 });
    expect(doc.facts.artifacts).toEqual(["copy.md"]);
    expect(doc.drift).toEqual([]);
  });

  it("flags a stalled running task and anything waiting for the owner", () => {
    const doc = buildStateDoc({ folder, run: run(), inboxOpen: 2, now: 1000 + 3 * 60 * 60 * 1000 });
    expect(doc.drift).toEqual([
      expect.objectContaining({ type: "stalled" }),
      expect.objectContaining({ type: "gates_waiting" }),
    ]);
  });

  it("keeps closed/accepted state and the charter in the facts", () => {
    const doc = buildStateDoc({
      folder,
      run: run({ status: "done", charter: { successCriteria: "上线", nonGoals: "不改价格", budgetCny: 500 } }),
      closedAt: 9000,
      acceptedAt: 9500,
      now: 10000,
    });
    expect(doc.facts).toMatchObject({ status: "done", closedAt: 9000, acceptedAt: 9500, charter: { successCriteria: "上线", nonGoals: "不改价格", budgetCny: 500 } });
  });
});
