import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types.ts";
import { RunWatcher, type RunEventContext } from "./run-events.ts";

const NAMES: Record<string, string> = { chief: "Chief", a: "Ana", b: "Ben", new1: "Market analyst", new2: "Copywriter" };
const ctx: RunEventContext = {
  botName: (id) => NAMES[id],
  botSection: (id) => (id === "a" ? "Market" : undefined),
  maxAttempts: 2,
};

const subtask = (id: string, assigneeBotId: string, extra: Partial<DispatchSubtask> = {}): DispatchSubtask => ({
  id,
  title: `Task ${id}`,
  brief: "",
  role: "worker",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId,
  status: "pending",
  attempts: 0,
  ...extra,
});

function makeRun(extra: Partial<DispatchRun> = {}): DispatchRun {
  return {
    id: "run-1",
    chiefBotId: "chief",
    sourceThreadId: "t-chief",
    goal: "Launch kit",
    policy: "balanced",
    status: "running",
    subtasks: [subtask("s1", "a"), subtask("s2", "new1", { createdBot: true })],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const kinds = (events: Array<{ kind: string }>) => events.map((event) => event.kind);

describe("RunWatcher", () => {
  it("announces a new running run once, with the specialists it created", () => {
    const watcher = new RunWatcher();
    const run = makeRun();
    const events = watcher.diff(run, ctx);
    expect(kinds(events)).toEqual(["run.started", "people.added"]);
    expect(events[0]).toMatchObject({ runId: "run-1", botId: "chief", threadId: "t-chief", title: "Chief started “Launch kit” — 2 subtasks" });
    expect(events[1]).toMatchObject({ title: "Chief added 1 person: Market analyst", detail: "Market analyst" });
    // the same broadcast again says nothing new
    expect(watcher.diff(run, ctx)).toEqual([]);
  });

  it("says nothing about runs that were already on disk at boot", () => {
    const watcher = new RunWatcher();
    const run = makeRun();
    watcher.seed([run]);
    expect(watcher.diff(run, ctx)).toEqual([]);
  });

  it("waits for approval before announcing, then announces the start and its people", () => {
    const watcher = new RunWatcher();
    const run = makeRun({ status: "awaiting-approval" });
    expect(watcher.diff(run, ctx)).toEqual([]);
    run.status = "running";
    expect(kinds(watcher.diff(run, ctx))).toEqual(["run.started", "people.added"]);

    // a seeded plan still awaiting approval also announces its people on start
    const seeded = new RunWatcher();
    const pending = makeRun({ id: "run-2", status: "awaiting-approval" });
    seeded.seed([pending]);
    pending.status = "running";
    expect(kinds(seeded.diff(pending, ctx))).toEqual(["run.started", "people.added"]);
  });

  it("reports failures, retries and hand-ins of subtasks", () => {
    const watcher = new RunWatcher();
    const run = makeRun();
    watcher.diff(run, ctx);

    run.subtasks[0]!.status = "running";
    run.subtasks[0]!.attempts = 1;
    expect(watcher.diff(run, ctx)).toEqual([]);

    // the dispatcher's own retry: running → pending with the reason
    run.subtasks[0]!.status = "pending";
    run.subtasks[0]!.error = "timed out";
    const retry = watcher.diff(run, ctx);
    expect(retry).toEqual([
      expect.objectContaining({ kind: "subtask.retry", title: "Retrying “Task s1” (1/2)", detail: "timed out", botId: "a", section: "Market", severity: "warn" }),
    ]);

    run.subtasks[0]!.status = "running";
    run.subtasks[0]!.attempts = 2;
    watcher.diff(run, ctx);
    run.subtasks[0]!.status = "failed";
    run.subtasks[0]!.error = "boom";
    expect(watcher.diff(run, ctx)).toEqual([
      expect.objectContaining({ kind: "subtask.failed", title: "“Task s1” failed — boom", severity: "error", runId: "run-1" }),
    ]);

    // the owner's retry: failed → pending (attempts start over)
    run.subtasks[0]!.status = "pending";
    run.subtasks[0]!.attempts = 0;
    expect(watcher.diff(run, ctx)).toEqual([expect.objectContaining({ kind: "subtask.retry", title: "Retrying “Task s1”" })]);

    run.subtasks[0]!.status = "done";
    expect(watcher.diff(run, ctx)).toEqual([expect.objectContaining({ kind: "report", title: "Ana handed in “Task s1”" })]);
  });

  it("closes the run with done or failed", () => {
    const watcher = new RunWatcher();
    const run = makeRun();
    watcher.diff(run, ctx);
    run.subtasks.forEach((entry) => (entry.status = "done"));
    run.status = "synthesizing";
    expect(kinds(watcher.diff(run, ctx))).toEqual(["report", "report"]);
    run.status = "done";
    expect(watcher.diff(run, ctx)).toEqual([expect.objectContaining({ kind: "run.done", title: "Finished “Launch kit”: 2/2 done" })]);

    const failing = new RunWatcher();
    const lost = makeRun({ id: "run-3" });
    failing.diff(lost, ctx);
    lost.subtasks.forEach((entry) => (entry.status = "failed"));
    lost.status = "failed";
    expect(kinds(failing.diff(lost, ctx))).toEqual(["subtask.failed", "subtask.failed", "run.failed"]);
  });

  it("announces specialists who join a run already under way", () => {
    const watcher = new RunWatcher();
    const run = makeRun();
    watcher.diff(run, ctx);
    run.subtasks.push(subtask("s3", "new2", { createdBot: true }), subtask("s4", "b"));
    const events = watcher.diff(run, ctx);
    expect(events).toEqual([expect.objectContaining({ kind: "people.added", title: "Chief added 1 person: Copywriter" })]);
  });

  it("says nothing when a run is canceled", () => {
    const watcher = new RunWatcher();
    const run = makeRun();
    watcher.diff(run, ctx);
    run.status = "canceled";
    run.subtasks.forEach((entry) => (entry.status = "canceled"));
    expect(watcher.diff(run, ctx)).toEqual([]);
  });
});
