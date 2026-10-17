import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";
import { buildTaskRetro } from "./task-retro.ts";

const folder: TaskFolderRecord = {
  id: "f1",
  title: "发布会筹备",
  color: "#0EA5E9",
  order: 0,
  collapsed: false,
  runId: "r1",
  conversationId: "main-thread",
  createdAt: 1000,
};

const subtask = (extra: Partial<DispatchSubtask>): DispatchSubtask => ({
  id: "s1",
  title: "文案",
  brief: "b",
  role: "文案策划",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId: "bot-1",
  status: "done",
  attempts: 1,
  ...extra,
});

const run: DispatchRun = {
  id: "r1",
  chiefBotId: "chief",
  sourceThreadId: "main-thread",
  goal: "发布会",
  policy: "balanced",
  status: "done",
  createdAt: 1000,
  updatedAt: 2000,
  finishedAt: 2000,
  subtasks: [
    subtask({
      threadId: "worker-thread",
      currentAttemptId: "attempt-1",
      startedAt: 1200,
      finishedAt: 1800,
      ranWith: { instanceId: "workbuddy", model: "minimax-m3" },
      handoff: {
        status: "done",
        summary: "三段文案",
        artifacts: ["docs/copy.md"],
        evidence: ["reply"],
      },
    }),
  ],
};

describe("task retrospective", () => {
  it("lists the task window, worker conversations, attempts and artifacts without moving anything", () => {
    const retro = buildTaskRetro({
      folder,
      run,
      conversation: (threadId) =>
        threadId === "main-thread"
          ? { title: "发布会筹备", botId: "chief", botName: "总控", createdAt: 900, closedAt: 2100 }
          : { title: "【派发】文案", botId: "bot-1", botName: "小文", createdAt: 1100, closedAt: 2100 },
      botName: (id) => (id === "bot-1" ? "小文" : "总控"),
    });
    expect(retro.status).toBe("done");
    expect(retro.conversations).toHaveLength(2);
    expect(retro.conversations[0]).toMatchObject({ role: "main", threadId: "main-thread", closedAt: 2100 });
    expect(retro.conversations[1]).toMatchObject({ role: "worker", threadId: "worker-thread", attemptId: "attempt-1" });
    expect(retro.attempts[0]).toMatchObject({ subtaskId: "s1", status: "done", durationMs: 600, model: { instanceId: "workbuddy", model: "minimax-m3" } });
    expect(retro.artifacts).toEqual([{ path: "docs/copy.md", fromSubtaskId: "s1" }]);
    expect(retro.sharedFromTaskIds).toEqual([]);
  });

  it("works for a folder whose run is gone (draft/manual task)", () => {
    const retro = buildTaskRetro({ folder: { ...folder, runId: undefined } });
    expect(retro.status).toBe("draft");
    expect(retro.conversations[0]?.threadId).toBe("main-thread");
    expect(retro.attempts).toEqual([]);
  });
});
