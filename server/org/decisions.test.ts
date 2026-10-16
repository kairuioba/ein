import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { actionStatus, DECISION_LINK_WINDOW_MS, OrgDecisionStore } from "./decisions.ts";

const subtask = (id: string, status: DispatchSubtask["status"] = "pending", assigneeBotId = `bot-${id}`): DispatchSubtask => ({
  id,
  title: `Task ${id}`,
  brief: "",
  role: "worker",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId,
  status,
  attempts: 0,
});

const run = (id: string, createdAt: number, sourceThreadId: string, subtasks: DispatchSubtask[]): DispatchRun => ({
  id,
  chiefBotId: "chief",
  sourceThreadId,
  goal: "Ship it",
  policy: "balanced",
  status: "running",
  subtasks,
  createdAt,
  updatedAt: createdAt,
});

describe("decisions", () => {
  let dir: string;
  let store: OrgDecisionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-org-decisions-"));
    store = new OrgDecisionStore(dir);
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("numbers decisions from 1, lists newest first, and keeps counting across reloads", () => {
    const first = store.create({ title: "Price", options: ["699", "799"], choice: "799", source: { kind: "group", id: "g1", threadId: "t-g1", messageId: "m1" }, at: 10 });
    const second = store.create({ title: "Key visual", options: ["1", "2"], choice: "2", source: { kind: "chat", id: "bot", threadId: "t-bot" }, at: 20 });
    expect([first.id, second.id]).toEqual([1, 2]);
    expect(first.decidedBy).toBe("owner");
    expect(first.actionItems).toEqual([]);
    expect(store.list().map((decision) => decision.id)).toEqual([2, 1]);
    const reloaded = new OrgDecisionStore(dir);
    expect(reloaded.get(1)?.choice).toBe("799");
    expect(reloaded.create({ title: "x", options: [], choice: "y", source: { kind: "chat", id: "b" } }).id).toBe(3);
  });

  it("never reuses a number, even when the file lost its counter", () => {
    store.create({ title: "a", options: [], choice: "b", source: { kind: "chat", id: "x" } });
    store.create({ title: "c", options: [], choice: "d", source: { kind: "chat", id: "x" } });
    const raw = JSON.parse(readFileSync(join(dir, "org-decisions.json"), "utf8"));
    writeFileSync(join(dir, "org-decisions.json"), JSON.stringify({ decisions: raw.decisions }));
    expect(new OrgDecisionStore(dir).create({ title: "e", options: [], choice: "f", source: { kind: "chat", id: "x" } }).id).toBe(3);
  });

  it("links a run started in the same conversation within the window as the decision's action items", () => {
    const decision = store.create({ title: "Price", options: ["699", "799"], choice: "799", source: { kind: "chat", id: "chief", threadId: "t-chief" }, at: 1_000 });
    const linked = store.linkRun(run("r1", 1_000 + 60_000, "t-chief", [subtask("a"), subtask("b", "running")]), (d) => d.source.threadId === "t-chief");
    expect(linked).toBe(decision.id);
    expect(store.get(decision.id)!.actionItems).toEqual([
      { title: "Task a", botId: "bot-a", runId: "r1", subtaskId: "a", status: "pending" },
      { title: "Task b", botId: "bot-b", runId: "r1", subtaskId: "b", status: "running" },
    ]);
    expect(store.decisionForRun("r1")).toBe(decision.id);
    // linking again is idempotent
    expect(store.linkRun(run("r1", 61_000, "t-chief", [subtask("a")]), () => true)).toBe(decision.id);
    expect(store.get(decision.id)!.actionItems).toHaveLength(2);
  });

  it("links to the newest fitting decision only, and not across conversations or outside the window", () => {
    store.create({ title: "old", options: [], choice: "x", source: { kind: "chat", id: "c", threadId: "t1" }, at: 0 });
    const newer = store.create({ title: "new", options: [], choice: "y", source: { kind: "chat", id: "c", threadId: "t1" }, at: 5_000 });
    const same = (threadId: string) => (d: { source: { threadId?: string } }) => d.source.threadId === threadId;
    expect(store.linkRun(run("other-thread", 6_000, "t2", [subtask("a")]), same("t2"))).toBeUndefined();
    expect(store.linkRun(run("too-late", 5_000 + DECISION_LINK_WINDOW_MS + 1, "t1", [subtask("a")]), same("t1"))).toBeUndefined();
    expect(store.linkRun(run("before", 4_000, "t1", [subtask("a")]), same("t1"))).not.toBe(newer.id);
    expect(store.linkRun(run("ok", 7_000, "t1", [subtask("a")]), same("t1"))).toBe(newer.id);
  });

  it("keeps action items in step with the run, adding subtasks that join later", () => {
    const decision = store.create({ title: "Price", options: [], choice: "799", source: { kind: "chat", id: "c", threadId: "t" }, at: 0 });
    const r = run("r", 1, "t", [subtask("a"), subtask("b")]);
    store.linkRun(r, () => true);
    expect(store.syncRun(r)).toBe(false);
    r.subtasks[0]!.status = "done";
    r.subtasks[1]!.status = "skipped";
    r.subtasks.push(subtask("c", "running"));
    expect(store.syncRun(r)).toBe(true);
    expect(store.get(decision.id)!.actionItems.map((item) => [item.subtaskId, item.status])).toEqual([
      ["a", "done"],
      ["b", "failed"],
      ["c", "running"],
    ]);
    expect(new OrgDecisionStore(dir).get(decision.id)!.actionItems).toHaveLength(3);
    expect(store.syncRun(run("unlinked", 1, "t", [subtask("z")]))).toBe(false);
  });

  it("maps every subtask status onto an action item status", () => {
    expect(["pending", "running", "done", "failed", "skipped", "canceled"].map((status) => actionStatus(status as never))).toEqual([
      "pending",
      "running",
      "done",
      "failed",
      "failed",
      "failed",
    ]);
  });

  it("clips long titles and choices and drops a corrupt file", () => {
    const decision = store.create({ title: "x".repeat(500), options: ["a".repeat(300)], choice: "b".repeat(300), source: { kind: "chat", id: "c" } });
    expect(decision.title.length).toBeLessThanOrEqual(200);
    expect(decision.choice.length).toBeLessThanOrEqual(200);
    writeFileSync(join(dir, "org-decisions.json"), "{ nope");
    expect(new OrgDecisionStore(dir).list()).toEqual([]);
  });
});
