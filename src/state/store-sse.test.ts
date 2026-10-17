// SSE fold for polled data (task office / inbox / evolution / dispatch runs).
// The server broadcasts these snapshots (server/index.ts); the screens read
// them through polled query hooks, not AppState. These tests pin the pure
// helper the store's frame switch uses: idempotent, order-safe, same-reference
// no-ops when there is nothing to patch.
import { describe, expect, it } from "vitest";

import type { DispatchRun, InboxItem } from "../../shared/dispatch-types";
import type { TaskFolderView } from "../../shared/task-folders";
import type { EvolutionProposal } from "../lib/evolution";
import { INBOX_SNOOZE_MS, dueInboxItems, isSnoozed, snoozeUntil } from "../lib/inbox";
import { applyServerFrame, initialState, sseFullRefreshPaths, sseRefreshTargets, type SseStoreCaches } from "./store";

const folder = (id: string, title = id): TaskFolderView => ({
  id,
  title,
  color: "#0EA5E9",
  order: 0,
  collapsed: false,
  createdAt: 1_700_000_000_000,
  status: "running",
  progress: { done: 1, total: 3 },
  memberCount: 2,
  departments: [{ section: "内容部", people: 2 }],
});

const run = (id: string, updatedAt: number): DispatchRun => ({
  id,
  chiefBotId: "chief",
  sourceThreadId: "thread",
  goal: "把首页改出来",
  policy: "balanced",
  status: "running",
  subtasks: [],
  createdAt: 1_700_000_000_000,
  updatedAt,
});

const inboxItem = (id: string): InboxItem => ({
  id,
  kind: "signoff",
  title: "确认交付",
  reason: "任务已完成",
  createdAt: 1_700_000_000_000,
});

const proposal = (id: string, status: EvolutionProposal["status"] = "open"): EvolutionProposal => ({
  id,
  signal: "gate-needs-human",
  title: "把验收标准写得更可判定",
  why: "连续两次无法验证",
  suggestedChange: "plan prompt 里要求 deterministic check",
  area: "prompt",
  risk: "low",
  evidence: ["task-1"],
  status,
  createdAt: 1_700_000_000_000,
});

describe("applyServerFrame", () => {
  it("replaces the task-folders cache and keeps the unrelated state references", () => {
    const unrelated = { selectedId: "bot-1", bots: [] as const };
    const state = { ...unrelated, taskFolders: [folder("t1")] };
    const next = applyServerFrame(state, { kind: "task-folders", tasks: [folder("t1", "改名"), folder("t2")] });

    expect(next).not.toBe(state);
    expect(next.taskFolders?.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(next.taskFolders?.[0]?.title).toBe("改名");
    expect(next.bots).toBe(state.bots);
    expect(next.selectedId).toBe("bot-1");
  });

  it("returns the same state for an unknown kind and for a frame with no payload", () => {
    const state = { taskFolders: [folder("t1")] };
    expect(applyServerFrame(state, { kind: "computer-control" })).toBe(state);
    expect(applyServerFrame(state, { kind: "task-folders" })).toBe(state);
    expect(applyServerFrame(state, {})).toBe(state);
  });

  it("is idempotent: replaying the identical task-folders frame does not rebuild", () => {
    const state = { taskFolders: [folder("t1")] };
    const once = applyServerFrame(state, { kind: "task-folders", tasks: [folder("t1")] });
    expect(once).toBe(state); // same snapshot → no reference change
    const changed = applyServerFrame(state, { kind: "task-folders", tasks: [folder("t2")] });
    const replay = applyServerFrame(changed, { kind: "task-folders", tasks: [folder("t2")] });
    expect(replay).toBe(changed);
  });

  it("is a safe no-op when the store has no inbox or evolution cache", () => {
    const state = { bots: [] };
    const withInbox = applyServerFrame(state, {
      kind: "inbox",
      items: [inboxItem("i1")],
      counts: { needsYou: 1, unseen: 1, byTask: {} },
    });
    const withEvolution = applyServerFrame(state, { kind: "evolution", proposal: proposal("p1") });
    expect(withInbox).toBe(state);
    expect(withEvolution).toBe(state);
  });

  it("patches an inbox cache when one exists and ignores an incomplete payload", () => {
    const state = { inbox: { items: [inboxItem("i1")], counts: { needsYou: 1, unseen: 1, byTask: {} } } };
    expect(applyServerFrame(state, { kind: "inbox", items: [inboxItem("i2")] })).toBe(state);
    const next = applyServerFrame(state, {
      kind: "inbox",
      items: [inboxItem("i1"), inboxItem("i2")],
      counts: { needsYou: 2, unseen: 2, byTask: { t1: 2 } },
    });
    expect(next.inbox?.counts.needsYou).toBe(2);
    expect(next.inbox?.items.map((item) => item.id)).toEqual(["i1", "i2"]);
    expect(applyServerFrame(next, {
      kind: "inbox",
      items: [inboxItem("i1"), inboxItem("i2")],
      counts: { needsYou: 2, unseen: 2, byTask: { t1: 2 } },
    })).toBe(next);
  });

  it("merges dispatch runs by id and ignores duplicate or out-of-order frames", () => {
    const state = { dispatchRuns: [run("r1", 100)] };
    const newer = applyServerFrame(state, { kind: "dispatch.run", run: run("r1", 200) });
    expect(newer.dispatchRuns?.[0]?.updatedAt).toBe(200);

    // duplicate and stale replays keep the object (idempotent / order-safe)
    expect(applyServerFrame(newer, { kind: "dispatch.run", run: run("r1", 200) })).toBe(newer);
    expect(applyServerFrame(newer, { kind: "dispatch.run", run: run("r1", 150) })).toBe(newer);

    const added = applyServerFrame(newer, { kind: "dispatch.run", run: run("r2", 300) });
    expect(added.dispatchRuns?.map((entry) => entry.id)).toEqual(["r1", "r2"]);
  });

  it("appends a new evolution proposal and upgrades it in place", () => {
    const state = { evolution: [] as EvolutionProposal[] };
    const opened = applyServerFrame(state, { kind: "evolution", proposal: proposal("p1") });
    expect(opened.evolution?.map((entry) => entry.status)).toEqual(["open"]);
    const accepted = applyServerFrame(opened, { kind: "evolution", proposal: proposal("p1", "accepted") });
    expect(accepted.evolution).toHaveLength(1);
    expect(accepted.evolution?.[0]?.status).toBe("accepted");
    expect(applyServerFrame(accepted, { kind: "evolution", proposal: proposal("p1", "accepted") })).toBe(accepted);
  });
});

describe("sseRefreshTargets", () => {
  it("maps dispatch and evolution frames to their polled cache URLs", () => {
    expect(sseRefreshTargets({ kind: "dispatch.run", run: run("r1", 1) })).toEqual(["/api/dispatch/state"]);
    expect(sseRefreshTargets({ kind: "dispatch.routes" })).toEqual(["/api/dispatch/state"]);
    expect(sseRefreshTargets({ kind: "evolution", proposal: proposal("p1") })).toEqual(["/api/evolution"]);
  });

  it("returns no target for frames whose data is not in a polled cache", () => {
    expect(sseRefreshTargets({ kind: "task-folders", tasks: [folder("t1")] })).toEqual([]);
    expect(sseRefreshTargets({ kind: "inbox", items: [], counts: { needsYou: 0, unseen: 0, byTask: {} } })).toEqual([]);
    expect(sseRefreshTargets({ kind: "message" })).toEqual([]);
    expect(sseRefreshTargets({})).toEqual([]);
  });
});

describe("store broadcast caches and reconnect refresh", () => {
  it("patches the task-folders and inbox caches on the real initial state", () => {
    const withTasks = applyServerFrame(initialState, { kind: "task-folders", tasks: [folder("t1")] });
    expect(withTasks).not.toBe(initialState);
    expect(withTasks.taskFolders?.map((task) => task.id)).toEqual(["t1"]);

    const withInbox = applyServerFrame(withTasks, {
      kind: "inbox",
      items: [inboxItem("i1")],
      counts: { needsYou: 1, unseen: 1, byTask: { t1: 1 } },
    });
    expect(withInbox.inbox?.counts.needsYou).toBe(1);
    expect(withInbox.inbox?.items.map((item) => item.id)).toEqual(["i1"]);

    // the same snapshot again does not rebuild (idempotent live fold)
    expect(applyServerFrame(withInbox, { kind: "task-folders", tasks: [folder("t1")] })).toBe(withInbox);
  });

  it("pulls the broadcast caches once when the stream opens or reconnects", () => {
    expect(sseFullRefreshPaths).toEqual(["/api/task-folders", "/api/inbox"]);
  });
});

describe("inbox snooze (frontend temporary rule)", () => {
  it("snoozes for 24h from seenAt until the server sends snoozeUntil", () => {
    const seenAt = 1_000_000;
    expect(snoozeUntil({ seenAt })).toBe(seenAt + INBOX_SNOOZE_MS);
    expect(snoozeUntil({ seenAt, snoozeUntil: seenAt + 60_000 })).toBe(seenAt + 60_000);
    expect(snoozeUntil({})).toBeNull();
  });

  it("comes back after expiry, and resolved items never snooze", () => {
    const now = 10_000_000;
    expect(isSnoozed({ seenAt: now - 1_000 }, now)).toBe(true);
    expect(isSnoozed({ seenAt: now - INBOX_SNOOZE_MS - 1 }, now)).toBe(false);
    expect(isSnoozed({ seenAt: now, resolvedAt: now }, now)).toBe(false);
    const items = [
      { id: "snoozed", seenAt: now - 1_000 },
      { id: "due", seenAt: now - INBOX_SNOOZE_MS - 1 },
      { id: "resolved", seenAt: now, resolvedAt: now },
    ];
    expect(dueInboxItems(items, now).map((item) => item.id)).toEqual(["due"]);
  });
});

// A fixture the helper is typed against: keeps the generic happy when tests
// build states with only some caches present.
const fixture: SseStoreCaches = { taskFolders: [], inbox: null, dispatchRuns: [], evolution: [] };
void fixture;
