// Dispatch hub: plan validation, team matching and specialist creation,
// dependency-ordered execution, retries, skipping, routes, and synthesis —
// against an in-memory host that stands in for the harness.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Recommendation } from "../shared/model-recommender.ts";
import {
  Dispatcher,
  dispatchSettings,
  findCycle,
  roleSimilarity,
  uniqueName,
  validatePlan,
  type DispatchBot,
  type DispatchHost,
  type DispatchRun,
  type DispatchSettings,
} from "./dispatch.ts";
import { removeTempDir } from "./testing/cleanup.ts";

interface Turn {
  botId: string;
  text: string;
  threadId: string;
  continuation?: boolean;
}

class FakeHost implements DispatchHost {
  bots_: DispatchBot[] = [];
  turns: Turn[] = [];
  chips: Array<{ threadId: string; label: string; ok?: boolean }> = [];
  created: DispatchBot[] = [];
  interrupted: string[] = [];
  broadcasts = 0;
  failStart = new Set<string>();
  maxBots = 100;
  settingsValue: DispatchSettings = dispatchSettings({});
  recommendation: Recommendation | null = {
    instanceId: "claude",
    engineName: "Claude",
    model: "sonnet",
    modelLabel: "Claude Sonnet",
    effort: "medium",
    score: 1,
    profile: { id: "claude-sonnet", family: "Claude Sonnet", match: /sonnet/, tier: 4, cost: 3, speed: 3, strengths: [] },
    reasons: [],
  };
  private taskCount = 0;

  add(bot: Partial<DispatchBot> & { id: string; name: string }): DispatchBot {
    const full: DispatchBot = { title: "", description: "", modelSelection: { instanceId: "codex", model: "gpt-5.5" }, ...bot };
    this.bots_.push(full);
    return full;
  }
  bots() {
    return this.bots_;
  }
  bot(id: string) {
    return this.bots_.find((bot) => bot.id === id);
  }
  createBot(input: { name: string; title: string; description: string; section?: string; modelSelection: DispatchBot["modelSelection"] }) {
    const bot = this.add({ id: `new-${this.created.length + 1}`, ...input });
    this.created.push(bot);
    return bot;
  }
  createTask(botId: string, _title: string) {
    return this.bot(botId) ? { threadId: `task-${++this.taskCount}` } : null;
  }
  async startTurn(botId: string, text: string, opts: { threadId: string; continuation?: boolean }) {
    if (this.failStart.has(botId)) throw new Error("engine unavailable");
    const bot = this.bot(botId)!;
    bot.busy = true;
    this.turns.push({ botId, text, threadId: opts.threadId, continuation: opts.continuation });
  }
  async interrupt(_botId: string, threadId: string) {
    this.interrupted.push(threadId);
  }
  activity(threadId: string, label: string, ok?: boolean) {
    this.chips.push({ threadId, label, ok });
  }
  recommend() {
    return this.recommendation;
  }
  broadcast(_run: DispatchRun) {
    this.broadcasts += 1;
  }
  broadcastRoutes() {}
  settings() {
    return this.settingsValue;
  }
  /** Settle the worker turn running in `threadId`. */
  finish(dispatcher: Dispatcher, threadId: string, ok: boolean, reply: string) {
    const turn = this.turns.find((entry) => entry.threadId === threadId)!;
    this.bot(turn.botId)!.busy = false;
    dispatcher.onTurnSettled(threadId, ok, reply, ok ? undefined : "provider error");
    dispatcher.onBotIdle(turn.botId);
  }
  workerTurns() {
    return this.turns.filter((turn) => !turn.continuation);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("plan validation", () => {
  it("accepts a DAG and normalizes fields", () => {
    const plan = validatePlan(
      {
        goal: "Launch kit",
        subtasks: [
          { id: "research", title: "Market research", brief: "Collect competitor pricing", role: "Analyst", needs: ["reasoning", "bogus"], difficulty: 9 },
          { id: "copy", title: "Write copy", brief: "Write the landing page copy", depends_on: ["research"] },
        ],
      },
      8,
    );
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    expect(plan.subtasks[0]).toMatchObject({ id: "research", role: "Analyst", needs: ["reasoning"], difficulty: 5, dependsOn: [] });
    expect(plan.subtasks[1]).toMatchObject({ id: "copy", role: "Write copy", dependsOn: ["research"] });
  });

  it("explains what to fix", () => {
    expect(validatePlan({ subtasks: [] }, 8)).toMatchObject({ error: expect.stringContaining("goal") });
    expect(validatePlan({ goal: "g", subtasks: [{ title: "t" }] }, 8)).toMatchObject({ error: expect.stringContaining("brief") });
    expect(validatePlan({ goal: "g", subtasks: [{ id: "a", title: "t", brief: "b", depends_on: ["zzz"] }] }, 8)).toMatchObject({
      error: expect.stringContaining("unknown id"),
    });
    const tooMany = Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, brief: "b" }));
    expect(validatePlan({ goal: "g", subtasks: tooMany }, 3)).toMatchObject({ error: expect.stringContaining("limit is 3") });
  });

  it("rejects dependency cycles", () => {
    const plan = validatePlan(
      {
        goal: "g",
        subtasks: [
          { id: "a", title: "A", brief: "b", depends_on: ["c"] },
          { id: "b", title: "B", brief: "b", depends_on: ["a"] },
          { id: "c", title: "C", brief: "b", depends_on: ["b"] },
        ],
      },
      8,
    );
    expect(plan).toMatchObject({ error: expect.stringContaining("cycle") });
    expect(findCycle([{ id: "x", dependsOn: [] }])).toBeNull();
  });

  it("accepts subtasks sent as a JSON string", () => {
    const plan = validatePlan({ goal: "g", subtasks: JSON.stringify([{ title: "A", brief: "b" }]) }, 8);
    expect("error" in plan).toBe(false);
  });
});

describe("matching helpers", () => {
  it("scores Chinese and English roles by shared tokens", () => {
    expect(roleSimilarity("前端工程师", "资深前端开发")).toBeGreaterThan(0.3);
    expect(roleSimilarity("Frontend engineer", "frontend developer")).toBeGreaterThan(0.3);
    expect(roleSimilarity("文案", "数据分析")).toBe(0);
  });

  it("makes unique specialist names", () => {
    expect(uniqueName("文案策划", ["Scout"])).toBe("文案策划");
    expect(uniqueName("文案策划", ["文案策划", "文案策划 2"])).toBe("文案策划 3");
  });

  it("clamps settings", () => {
    expect(dispatchSettings({ maxConcurrent: 99, policy: "nonsense" as never })).toMatchObject({ maxConcurrent: 8, policy: "balanced" });
  });
});

describe("Dispatcher", () => {
  let dir: string;
  let host: FakeHost;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-dispatch-"));
    host = new FakeHost();
    host.add({ id: "chief", name: "总控", title: "Chief of Staff", chiefOfStaff: true, section: "市场部" });
    host.add({ id: "writer", name: "小文", title: "文案策划", description: "负责公众号与发布会文案", section: "市场部" });
    host.add({ id: "other", name: "Ops", title: "运维工程师", section: "技术部" });
    dispatcher = new Dispatcher(host, dir);
    dispatcher.load();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const submit = (subtasks: unknown[], goal = "新品发布会全套材料") => dispatcher.submitPlan("chief", "chief-thread", { goal, subtasks });

  it("only lets a Chief submit plans", () => {
    expect(dispatcher.submitPlan("writer", "t", { goal: "g", subtasks: [{ title: "a", brief: "b" }] })).toMatchObject({
      error: expect.stringContaining("Chief of Staff"),
    });
  });

  it("reuses a fitting member, creates a specialist with the recommended model otherwise", () => {
    const result = submit([
      { id: "copy", title: "发布会文案", brief: "写发布会主持稿和公众号推文", role: "文案策划" },
      { id: "data", title: "竞品数据分析", brief: "整理三家竞品的价格与功能对比表", role: "数据分析师", difficulty: 3 },
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.subtasks[0]!.assigneeBotId).toBe("writer");
    expect(host.created).toHaveLength(1);
    expect(host.created[0]).toMatchObject({ name: "数据分析师", title: "数据分析师", section: "市场部", modelSelection: { instanceId: "claude", model: "sonnet", effort: "medium" } });
    expect(result.run.subtasks[1]).toMatchObject({ assigneeBotId: host.created[0]!.id, createdBot: true });
    // the new specialist is wired to its Chief
    expect(dispatcher.routes()).toContainEqual(expect.objectContaining({ fromBotId: "chief", toBotId: host.created[0]!.id, enabled: true }));
    expect(host.chips[0]?.label).toContain("2");
  });

  it("falls back to the Chief's model when nothing can be recommended", () => {
    host.recommendation = null;
    const result = submit([{ id: "x", title: "视频剪辑", brief: "剪一条 30 秒预告片", role: "视频剪辑师" }]);
    expect("error" in result).toBe(false);
    expect(host.created[0]?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
  });

  it("respects a named assignee and refuses one outside the team", () => {
    const ok = submit([{ id: "a", title: "改稿", brief: "润色", assignee: "@小文" }]);
    expect("error" in ok).toBe(false);
    if (!("error" in ok)) expect(ok.run.subtasks[0]!.assigneeBotId).toBe("writer");
    expect(submit([{ id: "a", title: "部署", brief: "上线", assignee: "Ops" }])).toMatchObject({ error: expect.stringContaining("not on your team") });
  });

  it("creates no specialist when a later subtask makes the plan invalid", () => {
    const rejected = submit([
      { id: "data", title: "竞品数据分析", brief: "整理竞品对比表", role: "数据分析师" },
      { id: "ops", title: "部署", brief: "上线", assignee: "Ops" },
    ]);
    expect(rejected).toMatchObject({ error: expect.stringContaining("not on your team") });
    expect(host.created).toHaveLength(0);
    expect(dispatcher.routes()).toHaveLength(0);
    // the corrected plan creates the specialist exactly once
    const accepted = submit([{ id: "data", title: "竞品数据分析", brief: "整理竞品对比表", role: "数据分析师" }]);
    expect("error" in accepted).toBe(false);
    expect(host.created).toHaveLength(1);
  });

  it("lets a later subtask reuse a specialist the same plan creates", () => {
    const result = submit([
      { id: "a", title: "竞品数据分析", brief: "整理竞品对比表", role: "数据分析师" },
      { id: "b", title: "用户数据分析", brief: "分析留存数据", role: "数据分析师", depends_on: ["a"] },
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(host.created).toHaveLength(1);
    expect(result.run.subtasks.map((subtask) => subtask.assigneeBotId)).toEqual([host.created[0]!.id, host.created[0]!.id]);
    expect(result.created).toEqual([host.created[0]!.id]);
  });

  it("runs subtasks in dependency order and feeds results forward", async () => {
    const result = submit([
      { id: "research", title: "竞品调研", brief: "调研三家竞品", role: "文案策划" },
      { id: "copy", title: "发布会文案", brief: "根据调研写文案", role: "文案策划", depends_on: ["research"] },
    ]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    expect(host.workerTurns()).toHaveLength(1);
    const first = host.workerTurns()[0]!;
    expect(first.botId).toBe("writer");
    expect(first.text).toContain("竞品调研");
    host.finish(dispatcher, first.threadId, true, "竞品A 99元，竞品B 129元");
    await flush();
    expect(host.workerTurns()).toHaveLength(2);
    const second = host.workerTurns()[1]!;
    expect(second.text).toContain("竞品A 99元");
    expect(second.threadId).not.toBe(first.threadId);
    host.finish(dispatcher, second.threadId, true, "发布会文案定稿");
    await flush();
    // synthesis goes to the Chief, in the conversation the plan came from
    const synthesis = host.turns.find((turn) => turn.continuation);
    expect(synthesis).toMatchObject({ botId: "chief", threadId: "chief-thread" });
    expect(synthesis!.text).toContain("发布会文案定稿");
    expect(dispatcher.get(result.run.id)!.status).toBe("done");
  });

  it("runs independent subtasks in parallel up to the concurrency limit", async () => {
    host.settingsValue = dispatchSettings({ maxConcurrent: 2 });
    host.add({ id: "w2", name: "设计", title: "视觉设计师", section: "市场部" });
    host.add({ id: "w3", name: "运营", title: "社群运营", section: "市场部" });
    submit([
      { id: "a", title: "文案", brief: "写", role: "文案策划" },
      { id: "b", title: "海报", brief: "画", role: "视觉设计师" },
      { id: "c", title: "社群预热", brief: "发", role: "社群运营" },
    ]);
    await flush();
    expect(host.workerTurns().map((turn) => turn.botId)).toEqual(["writer", "w2"]);
    host.finish(dispatcher, host.workerTurns()[0]!.threadId, true, "ok");
    await flush();
    expect(host.workerTurns().map((turn) => turn.botId)).toEqual(["writer", "w2", "w3"]);
  });

  it("retries a failed subtask, then skips its dependents when it keeps failing", async () => {
    const result = submit([
      { id: "a", title: "第一步", brief: "做", role: "文案策划" },
      { id: "b", title: "第二步", brief: "接着做", role: "文案策划", depends_on: ["a"] },
    ]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    host.finish(dispatcher, host.workerTurns()[0]!.threadId, false, "");
    await flush();
    expect(host.workerTurns()).toHaveLength(2); // retried once
    host.finish(dispatcher, host.workerTurns()[1]!.threadId, false, "");
    await flush();
    const run = dispatcher.get(result.run.id)!;
    expect(run.subtasks.map((subtask) => subtask.status)).toEqual(["failed", "skipped"]);
    expect(run.status).toBe("failed");
    expect(host.turns.some((turn) => turn.continuation)).toBe(false);
  });

  it("treats a turn that cannot start as a failed attempt", async () => {
    host.failStart.add("writer");
    host.settingsValue = dispatchSettings({ maxAttempts: 1, autoSynthesize: false });
    const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    await flush();
    expect(dispatcher.get(result.run.id)!.subtasks[0]).toMatchObject({ status: "failed", error: "engine unavailable" });
  });

  it("waits for a busy assignee and starts when it goes idle", async () => {
    host.bot("writer")!.busy = true;
    submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
    await flush();
    expect(host.workerTurns()).toHaveLength(0);
    host.bot("writer")!.busy = false;
    dispatcher.onBotIdle("writer");
    expect(host.workerTurns()).toHaveLength(1);
  });

  it("holds a run for approval when required", async () => {
    host.settingsValue = dispatchSettings({ requireApproval: true });
    const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    expect(result.run.status).toBe("awaiting-approval");
    expect(host.workerTurns()).toHaveLength(0);
    dispatcher.approve(result.run.id);
    await flush();
    expect(host.workerTurns()).toHaveLength(1);
  });

  it("cancels a run and interrupts its running work", async () => {
    const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    const run = await dispatcher.cancel(result.run.id);
    expect(run).toMatchObject({ status: "canceled" });
    expect(host.interrupted).toEqual([host.workerTurns()[0]!.threadId]);
    expect(dispatcher._watching()).toEqual([]);
  });

  it("limits how many specialists one run creates and shares the rest", () => {
    host.settingsValue = dispatchSettings({ maxNewBots: 1 });
    const result = submit([
      { id: "a", title: "法务审核", brief: "审合同", role: "法务顾问" },
      { id: "b", title: "财务测算", brief: "算成本", role: "财务分析" },
    ]);
    if ("error" in result) throw new Error(result.error);
    expect(host.created).toHaveLength(1);
    expect(result.run.subtasks.map((subtask) => subtask.assigneeBotId).every(Boolean)).toBe(true);
  });

  it("uses routes: unplugged members are left out, wired bots from other sections join", () => {
    expect(dispatcher.team("chief").map((bot) => bot.id)).toEqual(["writer"]);
    dispatcher.setRoute("chief", "other", true);
    dispatcher.setRoute("chief", "writer", false);
    expect(dispatcher.team("chief").map((bot) => bot.id)).toEqual(["other"]);
    dispatcher.resetRoute("chief", "writer");
    expect(dispatcher.team("chief").map((bot) => bot.id).sort()).toEqual(["other", "writer"]);
    expect(dispatcher.setRoute("chief", "chief", true)).toMatchObject({ error: expect.any(String) });
  });

  it("survives a restart: running work goes back to pending and resumes", async () => {
    const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    host.bot("writer")!.busy = false;
    const reloaded = new Dispatcher(host, dir);
    reloaded.load();
    expect(reloaded.get(result.run.id)!.subtasks[0]!.status).toBe("pending");
    reloaded.resumeAll();
    expect(host.workerTurns()).toHaveLength(2);
  });

  it("fails a deleted assignee's work instead of waiting forever", async () => {
    host.bot("writer")!.busy = true;
    const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
    if ("error" in result) throw new Error(result.error);
    host.bots_ = host.bots_.filter((bot) => bot.id !== "writer");
    dispatcher.onBotDeleted("writer");
    expect(dispatcher.get(result.run.id)!.subtasks[0]!.status).toBe("failed");
  });
});
