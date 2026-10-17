import { describe, expect, it } from "vitest";

import { activityTask } from "./bot-tasks";

const task = (threadId: string, lastActivityAt?: number) => ({ threadId, title: threadId, createdAt: 0, lastActivityAt });

describe("bot row click target", () => {
  it("opens the task the unread badge is about", () => {
    const target = activityTask({
      threadId: "empty-new-task",
      unread: true,
      tasks: [task("empty-new-task"), task("subtask-finished", 500)],
    });
    expect(target?.threadId).toBe("subtask-finished");
  });

  it("keeps the active task when it has the newest activity", () => {
    expect(
      activityTask({ threadId: "active", unread: true, tasks: [task("active", 900), task("old", 500)] }),
    ).toBeUndefined();
  });

  it("leaves an ordinary single-task bot alone", () => {
    expect(activityTask({ threadId: "dm", unread: true, tasks: [task("dm", 100)] })).toBeUndefined();
  });

  it("does not jump for a read bot whose active task has content", () => {
    expect(
      activityTask({ threadId: "active", unread: false, tasks: [task("active", 100), task("other", 500)] }),
    ).toBeUndefined();
  });

  it("does not strand the user on a blank active task", () => {
    const target = activityTask({
      threadId: "blank",
      unread: false,
      tasks: [task("blank"), task("worked", 300)],
    });
    expect(target?.threadId).toBe("worked");
  });
});
