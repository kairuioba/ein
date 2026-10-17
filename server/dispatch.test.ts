// Dispatch hub: plan validation, team matching and specialist creation,
// dependency-ordered execution, retries, skipping, routes, and synthesis —
// against an in-memory host that stands in for the harness. Also: turns
// whose setup fails after startTurn resolved, the owner's Stop, the org's
// chief planning through department leads, and adding people mid-run.
import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Recommendation } from "../shared/model-recommender.ts";
import { DEFAULT_ORG_RULES } from "../shared/org-types.ts";
import { handleDispatchApi } from "./dispatch-api.ts";
import { RunWatcher, type OrgEventInput } from "./org/run-events.ts";
import {
  Dispatcher,
  dispatchSettings,
  findCycle,
  readOrgSnapshot,
  roleSimilarity,
  uniqueName,
  validatePlan,
  type DispatchBot,
  type DispatchHost,
  type DispatchOrgEvent,
  type DispatchRun,
  type DispatchSettings,
  type DispatchTurnOptions,
} from "./dispatch.ts";
import { removeTempDir } from "./testing/cleanup.ts";

interface Turn {
  botId: string;
  text: string;
  threadId: string;
  continuation?: boolean;
  mayPlan?: boolean;
  sourceThreadId?: string;
  instanceId?: string;
  model?: string;
  effort?: string;
}

const MIN = 60_000;

class FakeHost implements DispatchHost {
  bots_: DispatchBot[] = [];
  turns: Turn[] = [];
  chips: Array<{ threadId: string; label: string; ok?: boolean }> = [];
  created: DispatchBot[] = [];
  interrupted: string[] = [];
  events: DispatchOrgEvent[] = [];
  broadcasts = 0;
  failStart = new Set<string>();
  /** botId → messages: the next turns resolve, then their setup fails (the
   * harness's async catch path, which never emits turn.completed) */
  setupFailures = new Map<string, string[]>();
  /** threadId → what that task conversation has spent, USD */
  costs = new Map<string, number>();
  dispatcher?: Dispatcher;
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
  async startTurn(botId: string, text: string, opts: DispatchTurnOptions) {
    if (this.failStart.has(botId)) throw new Error("engine unavailable");
    const bot = this.bot(botId)!;
    bot.busy = true;
    this.turns.push({ botId, text, threadId: opts.threadId, continuation: opts.continuation, mayPlan: opts.mayPlan, sourceThreadId: opts.sourceThreadId, instanceId: opts.instanceId, model: opts.model, effort: opts.effort });
    const failure = this.setupFailures.get(botId)?.shift();
    if (failure !== undefined) {
      // like index.ts: the setup runs after startTurn resolved; on failure the
      // bot goes idle, onDispatchError fires, and the idle hook follows
      setTimeout(() => {
        bot.busy = false;
        opts.onError?.(failure);
        queueMicrotask(() => this.dispatcher?.onBotIdle(botId));
      }, 0);
    }
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
  /** Claude: three models and every effort level; Codex: two models, no
   * effort knob; Gemini: low–high and cannot coordinate; Grok: signed out */
  engineKnobs(instanceId: string) {
    if (instanceId === "claude") return { models: ["sonnet", "opus", "haiku"], defaultModel: "sonnet", effortLevels: ["low", "medium", "high", "xhigh", "max"], ready: true, coordinates: true };
    if (instanceId === "codex") return { models: ["gpt-5.5", "gpt-5.5-mini"], defaultModel: "gpt-5.5", effortLevels: [] as string[], ready: true, coordinates: true };
    if (instanceId === "gemini") return { models: ["gemini-pro", "gemini-flash"], defaultModel: "gemini-flash", effortLevels: ["low", "medium", "high"], ready: true, coordinates: false };
    if (instanceId === "grok") return { models: ["grok-4"], defaultModel: "grok-4", effortLevels: ["low", "medium", "high"], ready: false, coordinates: true };
    return { models: [], effortLevels: [] as string[] };
  }
  broadcast(_run: DispatchRun) {
    this.broadcasts += 1;
  }
  broadcastRoutes() {}
  settings() {
    return this.settingsValue;
  }
  usage(_botId: string, threadId: string) {
    return this.costs.has(threadId) ? { costUsd: this.costs.get(threadId)! } : null;
  }
  event(event: DispatchOrgEvent) {
    this.events.push(event);
  }
  /** Settle the latest turn running in `threadId`. */
  finish(dispatcher: Dispatcher, threadId: string, ok: boolean, reply: string, reason: string | undefined = ok ? undefined : "provider error") {
    const turn = this.turns.filter((entry) => entry.threadId === threadId).at(-1)!;
    this.bot(turn.botId)!.busy = false;
    dispatcher.onTurnSettled(threadId, ok, reply, reason);
    dispatcher.onBotIdle(turn.botId);
  }
  workerTurns() {
    return this.turns.filter((turn) => !turn.continuation);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Let queued microtasks and the fake host's async setup failures run. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

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

  it("allows plans of up to 30 subtasks", () => {
    expect(dispatchSettings({ maxSubtasks: 99 }).maxSubtasks).toBe(30);
    expect(dispatchSettings({ maxSubtasks: 24 }).maxSubtasks).toBe(24);
    const thirty = Array.from({ length: 30 }, (_, i) => ({ title: `P${i + 1}`, brief: "做一页" }));
    expect("error" in validatePlan({ goal: "24 页详情页", subtasks: thirty }, dispatchSettings({ maxSubtasks: 30 }).maxSubtasks)).toBe(false);
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

  it("reads an org config defensively", () => {
    expect(readOrgSnapshot(undefined)).toMatchObject({ chiefBotId: null, departments: [], rules: DEFAULT_ORG_RULES });
    expect(readOrgSnapshot("garbage")).toMatchObject({ chiefBotId: null });
    const org = readOrgSnapshot({
      chiefBotId: " boss ",
      departments: [{ section: "技术部", budgetPerDay: 20, color: "#F59E0B" }, { section: "" }, null, { section: 3 }],
      rules: { spanOfControl: 1, budgetPerDay: -5, chiefMay: { addPeople: false } },
    });
    expect(org.chiefBotId).toBe("boss");
    expect(org.departments).toEqual([{ section: "技术部", budgetPerDay: 20 }]);
    // nonsense numbers fall back; known flags are kept
    expect(org.rules).toMatchObject({ spanOfControl: 5, budgetPerDay: 60, chiefMay: { addPeople: false, newSpecialist: true, switchModel: false } });
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
    host.dispatcher = dispatcher;
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
    expect(host.created[0]).toMatchObject({ name: "数据分析师", title: "数据分析师", section: "市场部", modelSelection: { instanceId: "claude", model: "sonnet" } });
    // the effort is left open: each task it gets thinks as hard as that task needs
    expect(host.created[0]!.modelSelection.effort).toBeUndefined();
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

  it("recommends a model and an effort for every subtask, and runs at the effort its difficulty calls for", async () => {
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet" };
    const result = submit([
      { id: "easy", title: "改一句标语", brief: "简单改一下标语", role: "文案策划", difficulty: 1 },
      { id: "hard", title: "全套发布会方案", brief: "从零设计完整的发布会方案，端到端", role: "文案策划", difficulty: 5 },
    ]);
    if ("error" in result) throw new Error(result.error);
    // the recommendation rides on each subtask, for you to take or leave
    expect(result.run.subtasks.map((subtask) => subtask.recommended?.modelLabel)).toEqual(["Claude Sonnet", "Claude Sonnet"]);
    await flush();
    const [first] = host.workerTurns();
    expect(first).toMatchObject({ botId: "writer" });
    // the bot set no effort, so each task gets the one its difficulty calls for
    expect(result.run.subtasks[0]!.ranWith).toEqual({ instanceId: "claude", model: "sonnet", effort: "low", autoEffort: true });
    expect(first!.effort).toBe("low");
    host.finish(dispatcher, first!.threadId, true, "改好了");
    await flush();
    const second = host.workerTurns()[1]!;
    expect(dispatcher.get(result.run.id)!.subtasks[1]!.ranWith).toMatchObject({ effort: "max", autoEffort: true });
    expect(second.effort).toBe("max");
  });

  it("lets you pick a model and an effort for a subtask that has not started; the bot's own effort beats the automatic one", async () => {
    host.settingsValue = dispatchSettings({ requireApproval: true });
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet", effort: "high" };
    const result = submit([
      { id: "a", title: "发布会主持稿", brief: "写主持稿", role: "文案策划", difficulty: 2 },
      { id: "b", title: "公众号推文", brief: "写推文", role: "文案策划", difficulty: 5 },
    ]);
    if ("error" in result) throw new Error(result.error);
    const runId = result.run.id;
    expect(dispatcher.chooseModel(runId, "a", { model: "opus", effort: "max" })).not.toHaveProperty("error");
    expect(dispatcher.get(runId)!.subtasks[0]!.choice).toEqual({ model: "opus", effort: "max" });
    // what the engine does not offer is refused
    expect(dispatcher.chooseModel(runId, "a", { model: "gpt-9" })).toMatchObject({ error: expect.any(String) });
    expect(dispatcher.chooseModel(runId, "a", { effort: "turbo" })).toMatchObject({ error: expect.any(String) });
    expect(dispatcher.chooseModel(runId, "nope", { effort: "low" })).toMatchObject({ error: expect.any(String) });
    // the bot's own model clears the pick
    expect(dispatcher.chooseModel(runId, "b", { model: "sonnet" })).not.toHaveProperty("error");
    expect(dispatcher.get(runId)!.subtasks[1]!.choice).toBeUndefined();
    dispatcher.approve(runId);
    await flush();
    const turns = host.workerTurns();
    expect(turns[0]).toMatchObject({ model: "opus", effort: "max" });
    expect(dispatcher.get(runId)!.subtasks[0]!.ranWith).toEqual({ instanceId: "claude", model: "opus", effort: "max" });
    // started work cannot change any more
    expect(dispatcher.chooseModel(runId, "a", { effort: "low" })).toMatchObject({ error: expect.stringContaining("not started") });
    host.finish(dispatcher, turns[0]!.threadId, true, "好了");
    await flush();
    // no pick: the bot's own effort, not the automatic one (the bot is the default, so nothing is overridden)
    expect(dispatcher.get(runId)!.subtasks[1]!.ranWith).toEqual({ instanceId: "claude", model: "sonnet", effort: "high" });
    expect(host.workerTurns()[1]).toMatchObject({ model: undefined, effort: undefined });
  });

  it("leaves the effort alone when automatic effort is off or the engine has no such knob", async () => {
    host.settingsValue = dispatchSettings({ autoEffort: false });
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet" };
    const off = submit([{ id: "a", title: "主持稿", brief: "写主持稿", role: "文案策划", difficulty: 5 }]);
    if ("error" in off) throw new Error(off.error);
    await flush();
    expect(dispatcher.get(off.run.id)!.subtasks[0]!.ranWith).toEqual({ instanceId: "claude", model: "sonnet" });
    // Codex here has no effort levels
    host.settingsValue = dispatchSettings({});
    host.bot("other")!.modelSelection = { instanceId: "codex", model: "gpt-5.5" };
    expect(dispatcher.turnPick({ difficulty: 5 } as never, host.bot("other")!)).toEqual({ instanceId: "codex", model: "gpt-5.5" });
  });

  it("lets you pick any model on any engine you are signed in to; the bot keeps its own", async () => {
    host.settingsValue = dispatchSettings({ requireApproval: true });
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet" };
    const result = submit([
      { id: "a", title: "主持稿", brief: "写主持稿", role: "文案策划", difficulty: 2 },
      { id: "b", title: "推文", brief: "写推文", role: "文案策划", difficulty: 5 },
      { id: "c", title: "标语", brief: "改标语", role: "文案策划", difficulty: 3 },
    ]);
    if ("error" in result) throw new Error(result.error);
    const runId = result.run.id;
    const sub = (id: string) => dispatcher.get(runId)!.subtasks.find((subtask) => subtask.id === id)!;
    // another engine and one of its models
    expect(dispatcher.chooseModel(runId, "a", { instanceId: "codex", model: "gpt-5.5-mini" })).not.toHaveProperty("error");
    expect(sub("a").choice).toEqual({ instanceId: "codex", model: "gpt-5.5-mini" });
    // an engine alone starts on its default model; a level it lacks is dropped
    expect(dispatcher.chooseModel(runId, "b", { effort: "max" })).not.toHaveProperty("error");
    expect(dispatcher.chooseModel(runId, "b", { instanceId: "gemini" })).not.toHaveProperty("error");
    expect(sub("b").choice).toEqual({ instanceId: "gemini", model: "gemini-flash" });
    expect(dispatcher.chooseModel(runId, "b", { model: "gemini-pro", effort: "high" })).not.toHaveProperty("error");
    expect(sub("b").choice).toEqual({ instanceId: "gemini", model: "gemini-pro", effort: "high" });
    // refused: an engine you are not signed in to, one that is gone, a model or level it lacks
    expect(dispatcher.chooseModel(runId, "c", { instanceId: "grok" })).toMatchObject({ error: expect.stringContaining("Sign in") });
    expect(dispatcher.chooseModel(runId, "c", { instanceId: "nowhere" })).toMatchObject({ error: expect.any(String) });
    expect(dispatcher.chooseModel(runId, "c", { instanceId: "codex", model: "opus" })).toMatchObject({ error: expect.any(String) });
    expect(dispatcher.chooseModel(runId, "c", { instanceId: "codex", effort: "high" })).toMatchObject({ error: expect.any(String) });
    expect(sub("c").choice).toBeUndefined();
    // back to the bot's own engine clears the borrowed engine and its model
    expect(dispatcher.chooseModel(runId, "c", { instanceId: "gemini", effort: "low" })).not.toHaveProperty("error");
    expect(dispatcher.chooseModel(runId, "c", { instanceId: null })).not.toHaveProperty("error");
    expect(sub("c").choice).toEqual({ effort: "low" });
    expect(dispatcher.chooseModel(runId, "c", { effort: null })).not.toHaveProperty("error");
    expect(sub("c").choice).toBeUndefined();
    dispatcher.approve(runId);
    await flush();
    const [first] = host.workerTurns();
    // the borrowed engine runs this turn only; Codex has no effort knob
    expect(first).toMatchObject({ botId: "writer", instanceId: "codex", model: "gpt-5.5-mini", effort: undefined });
    expect(sub("a").ranWith).toEqual({ instanceId: "codex", model: "gpt-5.5-mini" });
    expect(host.bot("writer")!.modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
    host.finish(dispatcher, first!.threadId, true, "好了");
    await flush();
    expect(host.workerTurns()[1]).toMatchObject({ instanceId: "gemini", model: "gemini-pro", effort: "high" });
    host.finish(dispatcher, host.workerTurns()[1]!.threadId, true, "好了");
    await flush();
    // no pick: the bot's own engine, at the effort a moderate task calls for
    expect(host.workerTurns()[2]).toMatchObject({ instanceId: undefined, model: undefined, effort: "high" });
    expect(sub("c").ranWith).toEqual({ instanceId: "claude", model: "sonnet", effort: "high", autoEffort: true });
  });

  it("thinks as hard as the task needs on a borrowed engine too, within that engine's levels", () => {
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet", effort: "xhigh" };
    const subtask = { difficulty: 5, choice: { instanceId: "gemini", model: "gemini-pro" } } as never;
    // the bot's own xhigh is not on Gemini; the difficulty's max falls to its top level
    expect(dispatcher.turnPick(subtask, host.bot("writer")!)).toEqual({ instanceId: "gemini", model: "gemini-pro", effort: "high", autoEffort: true });
    // a borrowed engine that signed out since: back to the bot's own
    const signedOut = { difficulty: 5, choice: { instanceId: "grok", model: "grok-4" } } as never;
    expect(dispatcher.turnPick(signedOut, host.bot("writer")!)).toEqual({ instanceId: "claude", model: "sonnet", effort: "xhigh" });
  });

  it("takes your pick over HTTP: PATCH a subtask with an engine, a model and an effort", async () => {
    host.settingsValue = dispatchSettings({ requireApproval: true });
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet" };
    const result = submit([{ id: "a", title: "主持稿", brief: "写主持稿", role: "文案策划", difficulty: 3 }]);
    if ("error" in result) throw new Error(result.error);
    const patch = async (body: unknown) => {
      let status = 0;
      let payload: any;
      const path = `/api/dispatch/runs/${result.run.id}/subtasks/a`;
      await handleDispatchApi(
        "PATCH",
        path,
        new URL(`http://localhost${path}`),
        {} as IncomingMessage,
        {} as ServerResponse,
        {
          dispatcher,
          readBody: async () => body,
          json: (_res, code, value) => {
            status = code;
            payload = value;
          },
          teamMapSnapshot: () => null,
          ownsThread: () => true,
          botName: (id) => host.bot(id)?.name,
          modelLabel: () => "Claude · Sonnet",
        },
        () => host.settings(),
      );
      return { status, payload };
    };
    const picked = await patch({ instanceId: "codex", model: "gpt-5.5-mini" });
    expect(picked.status).toBe(200);
    expect(picked.payload.run.subtasks[0].choice).toEqual({ instanceId: "codex", model: "gpt-5.5-mini" });
    expect(await patch({ effort: "turbo" })).toMatchObject({ status: 400 });
    // null clears: back to the bot's own engine and model
    expect((await patch({ instanceId: null })).payload.run.subtasks[0].choice).toBeUndefined();
    expect((await patch({ effort: "xhigh" })).payload.run.subtasks[0].choice).toEqual({ effort: "xhigh" });
  });

  it("lets a failed subtask change its model before it is retried", async () => {
    host.settingsValue = dispatchSettings({ maxAttempts: 1 });
    host.bot("writer")!.modelSelection = { instanceId: "claude", model: "sonnet" };
    const result = submit([{ id: "a", title: "主持稿", brief: "写主持稿", role: "文案策划", difficulty: 4 }]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    expect(dispatcher.chooseModel(result.run.id, "a", { model: "opus" })).toMatchObject({ error: expect.stringContaining("not started") });
    host.finish(dispatcher, host.workerTurns()[0]!.threadId, false, "", "provider error");
    await flush();
    expect(dispatcher.get(result.run.id)!.subtasks[0]!.status).toBe("failed");
    expect(dispatcher.chooseModel(result.run.id, "a", { model: "opus", effort: "max" })).not.toHaveProperty("error");
    dispatcher.retry(result.run.id, "a");
    await flush();
    expect(host.workerTurns().at(-1)).toMatchObject({ model: "opus", effort: "max" });
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

  it("runs subtasks in dependency order, feeds results forward, and is done when the report is", async () => {
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
    expect(first.sourceThreadId).toBe("chief-thread");
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
    // the run is done when the report turn completes, not when it starts
    expect(dispatcher.get(result.run.id)!.status).toBe("synthesizing");
    host.finish(dispatcher, "chief-thread", true, "两份材料都已完成：……");
    expect(dispatcher.get(result.run.id)).toMatchObject({ status: "done", report: "两份材料都已完成：……", finishedAt: expect.any(Number) });
    // every subtask records when it started and finished
    for (const subtask of dispatcher.get(result.run.id)!.subtasks) {
      expect(subtask.finishedAt! >= subtask.startedAt!).toBe(true);
    }
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
    expect(run.subtasks.every((subtask) => typeof subtask.finishedAt === "number")).toBe(true);
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

  it("ends the run when a retried subtask's bot is gone, instead of leaving its dependents waiting", async () => {
    host.settingsValue = dispatchSettings({ autoSynthesize: false });
    host.add({ id: "w2", name: "设计", title: "视觉设计师", section: "市场部" });
    const result = submit([
      { id: "a", title: "第一步", brief: "做", role: "文案策划" },
      { id: "b", title: "第二步", brief: "按文案画海报", role: "视觉设计师", depends_on: ["a"] },
    ]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    host.bots_ = host.bots_.filter((bot) => bot.id !== "writer");
    dispatcher.onBotDeleted("writer");
    const run = dispatcher.get(result.run.id)!;
    expect(run.subtasks.map((subtask) => subtask.status)).toEqual(["failed", "skipped"]);
    expect(run.status).toBe("failed");
    // the owner retries the first step anyway: it cannot start, so the second never will
    dispatcher.retry(run.id, "a");
    await flush();
    expect(run.subtasks.map((subtask) => subtask.status)).toEqual(["failed", "skipped"]);
    expect(run.status).toBe("failed");
  });

  it("never drops a run still in progress to make room for finished ones", async () => {
    host.settingsValue = dispatchSettings({ requireApproval: true });
    const waiting = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }], "等你批的计划");
    if ("error" in waiting) throw new Error(waiting.error);
    // sixty more plans come and go while it waits for the owner
    for (let i = 0; i < 60; i += 1) {
      const other = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }], `计划 ${i}`);
      if ("error" in other) throw new Error(other.error);
      await dispatcher.cancel(other.run.id);
    }
    expect(dispatcher.get(waiting.run.id)?.status).toBe("awaiting-approval");
    const reloaded = new Dispatcher(host, dir);
    reloaded.load();
    expect(reloaded.get(waiting.run.id)?.status).toBe("awaiting-approval");
    // the cap still holds: the oldest finished run made room
    expect(reloaded.list()).toHaveLength(60);
    expect(reloaded.approve(waiting.run.id)).toMatchObject({ status: "running" });
  });

  it("waits for a fresh report when a subtask is retried while the chief writes one", async () => {
    host.settingsValue = dispatchSettings({ maxAttempts: 1 });
    host.add({ id: "w2", name: "设计", title: "视觉设计师", section: "市场部" });
    const result = submit([
      { id: "copy", title: "文案", brief: "写", role: "文案策划" },
      { id: "poster", title: "海报", brief: "画", role: "视觉设计师" },
    ]);
    if ("error" in result) throw new Error(result.error);
    await flush();
    const [copy, poster] = host.workerTurns();
    host.finish(dispatcher, copy!.threadId, true, "文案定稿");
    host.finish(dispatcher, poster!.threadId, false, "");
    await flush();
    const run = dispatcher.get(result.run.id)!;
    // the chief is writing its report on the copy alone
    expect(run.status).toBe("synthesizing");
    expect(host.turns.filter((turn) => turn.continuation)).toHaveLength(1);
    // meanwhile the owner retries the poster, and it is done before that report
    dispatcher.retry(run.id, "poster");
    await flush();
    const again = host.workerTurns().at(-1)!;
    expect(again.botId).toBe("w2");
    host.finish(dispatcher, again.threadId, true, "海报定稿");
    await flush();
    host.finish(dispatcher, "chief-thread", true, "只有文案的汇总");
    await flush();
    // the report written before the retry does not close the reopened run
    expect(run.report).toBeUndefined();
    expect(run.status).toBe("synthesizing");
    const reports = host.turns.filter((turn) => turn.continuation);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.text).toContain("海报定稿");
    host.finish(dispatcher, "chief-thread", true, "文案和海报都好了");
    expect(run).toMatchObject({ status: "done", report: "文案和海报都好了" });
  });

  // ── turns that never report back, and the owner's Stop ──

  describe("settling every turn", () => {
    it("settles a subtask whose setup fails after startTurn resolved", async () => {
      host.setupFailures.set("writer", ["connected apps could not start"]);
      host.settingsValue = dispatchSettings({ maxAttempts: 1, autoSynthesize: false });
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await settle();
      const run = dispatcher.get(result.run.id)!;
      expect(run.subtasks[0]).toMatchObject({ status: "failed", error: "connected apps could not start", finishedAt: expect.any(Number) });
      expect(run.status).toBe("failed");
      expect(dispatcher._watching()).toEqual([]);
      // a late, duplicate report of the same failure changes nothing
      dispatcher.onTurnSettled(run.subtasks[0]!.threadId!, false, "", "late");
      expect(run.subtasks[0]).toMatchObject({ status: "failed", attempts: 1, error: "connected apps could not start" });
    });

    it("retries after an asynchronous setup failure and finishes the run", async () => {
      host.setupFailures.set("writer", ["provider instance is unavailable"]);
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await settle();
      expect(host.workerTurns()).toHaveLength(2);
      expect(host.chips.some((chip) => chip.label.includes("will retry") && chip.label.includes("provider instance is unavailable"))).toBe(true);
      host.finish(dispatcher, host.workerTurns()[1]!.threadId, true, "文案");
      await flush();
      host.finish(dispatcher, "chief-thread", true, "汇总");
      expect(dispatcher.get(result.run.id)).toMatchObject({ status: "done", report: "汇总" });
      expect(dispatcher.get(result.run.id)!.subtasks[0]).toMatchObject({ status: "done", attempts: 2 });
    });

    it("never retries a subtask the owner stopped", async () => {
      host.add({ id: "w2", name: "设计", title: "视觉设计师", section: "市场部" });
      const result = submit([
        { id: "a", title: "文案", brief: "写", role: "文案策划" },
        { id: "b", title: "海报", brief: "画", role: "视觉设计师" },
        { id: "c", title: "推文", brief: "用文案发推", role: "文案策划", depends_on: ["a"] },
      ]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      const [copy, poster] = host.workerTurns();
      host.finish(dispatcher, copy!.threadId, false, "", "interrupted");
      await flush();
      const run = dispatcher.get(result.run.id)!;
      expect(run.subtasks[0]).toMatchObject({ status: "canceled", error: "Stopped by you", attempts: 1 });
      expect(run.subtasks[2]!.status).toBe("skipped");
      expect(host.workerTurns()).toHaveLength(2);
      expect(host.chips.some((chip) => chip.label.includes("will not be retried"))).toBe(true);
      // the rest of the run carries on and still reports
      host.finish(dispatcher, poster!.threadId, true, "海报");
      await flush();
      expect(run.status).toBe("synthesizing");
      // the owner can still retry it from the workbench
      expect(dispatcher.retry(run.id, "a")).toMatchObject({ status: "running" });
    });

    it("treats an engine's ok-but-cancelled settle as a stop, not a finished deliverable", async () => {
      host.settingsValue = dispatchSettings({ autoSynthesize: false });
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      host.finish(dispatcher, host.workerTurns()[0]!.threadId, true, "半截文案", "cancelled");
      const subtask = dispatcher.get(result.run.id)!.subtasks[0]!;
      expect(subtask).toMatchObject({ status: "canceled", error: "Stopped by you" });
      expect(subtask.result).toBeUndefined();
      expect(host.workerTurns()).toHaveLength(1);
    });

    it("does not retry a turn stopped during its setup", async () => {
      // index.ts reports a setup the owner cancelled as "interrupted"
      host.setupFailures.set("writer", ["interrupted"]);
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await settle();
      expect(dispatcher.get(result.run.id)!.subtasks[0]).toMatchObject({ status: "canceled", attempts: 1 });
      expect(host.workerTurns()).toHaveLength(1);
    });

    it("settles a watched turn whose bot went idle without a turn.completed", async () => {
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      // a provider reload released the bot but no turn.completed came
      host.bot("writer")!.busy = false;
      dispatcher.onBotIdle("writer");
      expect(dispatcher.get(result.run.id)!.subtasks[0]).toMatchObject({ status: "running", attempts: 2 });
      expect(host.workerTurns()).toHaveLength(2);
    });

    it("posts the fallback when the report turn's setup fails after resolving", async () => {
      host.setupFailures.set("chief", ["engine unavailable"]);
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      host.finish(dispatcher, host.workerTurns()[0]!.threadId, true, "文案");
      await settle();
      const run = dispatcher.get(result.run.id)!;
      expect(run).toMatchObject({ status: "done", synthesisStarted: false });
      expect(run.report).toBeUndefined();
      expect(host.chips.at(-1)).toMatchObject({ threadId: "chief-thread", label: "All subtasks finished — open the workbench to read the results" });
      // the report's late turn.completed no longer touches the run
      dispatcher.onTurnSettled("chief-thread", true, "迟到的汇总");
      expect(run.report).toBeUndefined();
    });

    it("posts the fallback when the report turn cannot start at all", async () => {
      host.failStart.add("chief");
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      host.finish(dispatcher, host.workerTurns()[0]!.threadId, true, "文案");
      await settle();
      expect(dispatcher.get(result.run.id)).toMatchObject({ status: "done", synthesisStarted: false });
      expect(host.chips.some((chip) => chip.label.includes("open the workbench"))).toBe(true);
    });

    it("finishes a run whose report the owner stopped, without the fallback", async () => {
      const result = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      host.finish(dispatcher, host.workerTurns()[0]!.threadId, true, "文案");
      await flush();
      const chips = host.chips.length;
      host.finish(dispatcher, "chief-thread", false, "", "interrupted");
      expect(dispatcher.get(result.run.id)!.status).toBe("done");
      expect(host.chips.slice(chips).some((chip) => chip.label.includes("open the workbench"))).toBe(false);
    });
  });

  // ── the org's chief (主 Bot) plans across departments ──

  describe("org chief", () => {
    const writeOrg = (org: Record<string, unknown>) => writeFileSync(join(dir, "org.json"), JSON.stringify(org));

    beforeEach(() => {
      host.add({ id: "boss", name: "总控台", title: "我的幕僚长", chiefOfStaff: true });
      host.add({ id: "tech", name: "阿杰", title: "前端主管", description: "负责落地页和商品详情页的前端", chiefOfStaff: true, section: "技术部" });
      host.add({ id: "fe1", name: "前端 1", title: "前端", description: "做商品详情页", section: "技术部" });
      host.add({ id: "helper", name: "翻译", title: "翻译", description: "中英互译" });
    });

    const orgPlan = (subtasks: unknown[]) => dispatcher.submitPlan("boss", "boss-thread", { goal: "新品发布会全套材料", subtasks });

    it("behaves as before without an org config: the chief's team is its own section", () => {
      expect(dispatcher.isOrgChief("boss")).toBe(false);
      expect(dispatcher.team("boss").map((bot) => bot.id)).toEqual(["helper"]);
      expect(dispatcher.chiefContext("boss")).toEqual({});
    });

    it("reaches every department lead, the unsectioned bots and wired routes", () => {
      writeOrg({ chiefBotId: "boss" });
      expect(dispatcher.isOrgChief("boss")).toBe(true);
      expect(dispatcher.team("boss").map((bot) => bot.id).sort()).toEqual(["chief", "helper", "tech"]);
      dispatcher.setRoute("boss", "fe1", true);
      dispatcher.setRoute("boss", "chief", false);
      expect(dispatcher.team("boss").map((bot) => bot.id).sort()).toEqual(["fe1", "helper", "tech"]);
      // a section chief's team is unchanged
      expect(dispatcher.team("tech").map((bot) => bot.id).sort()).toEqual(["fe1", "other"]);
      expect(dispatcher.chiefContext("boss").departments).toEqual([{ section: "技术部", leadId: "tech", leadName: "阿杰", leadTitle: "前端主管", people: 3 }]);
    });

    it("gives each department's part to its lead", () => {
      writeOrg({ chiefBotId: "boss" });
      const result = orgPlan([
        { id: "page", title: "落地页", brief: "做发布会落地页", role: "前端工程师" },
        { id: "copy", title: "发布会文案", brief: "写主持稿", role: "文案策划" },
        { id: "qa", title: "上线检查", brief: "检查落地页", assignee: "技术部" },
        { id: "en", title: "英文版", brief: "翻译新闻稿", role: "翻译" },
      ]);
      if ("error" in result) throw new Error(result.error);
      expect(result.run.subtasks.map((subtask) => subtask.assigneeBotId)).toEqual(["tech", "chief", "tech", "helper"]);
      expect(host.created).toHaveLength(0);
      // the org chief need not be a chief of staff
      host.bot("boss")!.chiefOfStaff = false;
      expect("error" in orgPlan([{ id: "x", title: "英文版", brief: "翻译", role: "翻译" }])).toBe(false);
    });

    it("keeps a lead that plans its department's share on an engine that can coordinate", () => {
      writeOrg({ chiefBotId: "boss" });
      host.settingsValue = dispatchSettings({ requireApproval: true });
      host.bot("tech")!.modelSelection = { instanceId: "claude", model: "sonnet" };
      const result = orgPlan([
        { id: "page", title: "落地页", brief: "做发布会落地页", role: "前端工程师" },
        { id: "en", title: "英文版", brief: "翻译新闻稿", role: "翻译" },
      ]);
      if ("error" in result) throw new Error(result.error);
      expect(dispatcher.chooseModel(result.run.id, "page", { instanceId: "gemini" })).toMatchObject({ error: expect.stringContaining("coordinate") });
      expect(dispatcher.chooseModel(result.run.id, "page", { instanceId: "codex" })).not.toHaveProperty("error");
      // a plain worker may use any engine
      expect(dispatcher.chooseModel(result.run.id, "en", { instanceId: "gemini" })).not.toHaveProperty("error");
    });

    it("does not hire specialists when the company rules say the chief may not", () => {
      writeOrg({ chiefBotId: "boss", rules: { chiefMay: { newSpecialist: false } } });
      const refused = orgPlan([{ id: "video", title: "发布会视频", brief: "剪一条 30 秒视频", role: "视频剪辑师" }]);
      expect(refused).toMatchObject({ error: expect.stringContaining("company rules") });
      expect(host.created).toHaveLength(0);
      writeOrg({ chiefBotId: "boss", rules: { chiefMay: { newSpecialist: true } } });
      expect("error" in orgPlan([{ id: "video", title: "发布会视频", brief: "剪一条 30 秒视频", role: "视频剪辑师" }])).toBe(false);
    });

    it("lets a lead plan its part with its own team; the subtask finishes with the lead's report", async () => {
      writeOrg({ chiefBotId: "boss" });
      const top = orgPlan([{ id: "page", title: "落地页", brief: "做发布会落地页", role: "前端工程师" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns()[0]!;
      expect(leadTurn).toMatchObject({ botId: "tech", mayPlan: true, sourceThreadId: "boss-thread" });
      expect(leadTurn.text).toContain("You lead the 技术部 department");
      expect(leadTurn.text).toContain("submit_plan");
      // from inside the subtask, the lead hands it to its team
      const child = dispatcher.submitPlan("tech", leadTurn.threadId, {
        goal: "落地页",
        subtasks: [{ id: "build", title: "页面开发", brief: "写页面", role: "前端" }],
      });
      if ("error" in child) throw new Error(child.error);
      expect(child.run).toMatchObject({ parentRunId: top.run.id, parentSubtaskId: "page", chiefBotId: "tech", sourceThreadId: leadTurn.threadId });
      expect(child.run.subtasks[0]!.assigneeBotId).toBe("fe1");
      expect(dispatcher.get(top.run.id)!.subtasks[0]!.childRunId).toBe(child.run.id);
      // a second plan for the same subtask is refused
      expect(dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "again", subtasks: [{ title: "x", brief: "y" }] })).toMatchObject({
        error: expect.stringContaining("already handed"),
      });
      // the lead's planning turn ends; the subtask keeps waiting on the team
      host.finish(dispatcher, leadTurn.threadId, true, "已派给前端 1");
      await flush();
      expect(dispatcher.get(top.run.id)!.subtasks[0]!.status).toBe("running");
      const workerTurn = host.workerTurns().find((turn) => turn.botId === "fe1")!;
      // the lead's workers cannot plan
      expect(workerTurn.mayPlan).toBeUndefined();
      expect(dispatcher.submitPlan("tech", workerTurn.threadId, { goal: "x", subtasks: [{ title: "x", brief: "y" }] })).toMatchObject({
        error: expect.stringContaining("dispatched subtask"),
      });
      host.finish(dispatcher, workerTurn.threadId, true, "页面完成");
      await flush();
      // the lead writes its department's report in the subtask's conversation
      const leadReport = host.turns.find((turn) => turn.continuation && turn.botId === "tech")!;
      expect(leadReport.threadId).toBe(leadTurn.threadId);
      expect(leadReport.text).toContain("@总控台");
      expect(leadReport.text).toContain("页面完成");
      host.finish(dispatcher, leadTurn.threadId, true, "落地页已上线");
      await flush();
      expect(dispatcher.get(child.run.id)).toMatchObject({ status: "done", report: "落地页已上线" });
      expect(dispatcher.get(top.run.id)!.subtasks[0]).toMatchObject({ status: "done", result: "落地页已上线" });
      // and the org chief writes the company report
      const bossReport = host.turns.find((turn) => turn.continuation && turn.botId === "boss")!;
      expect(bossReport.text).toContain("落地页已上线");
      host.finish(dispatcher, "boss-thread", true, "全套材料就绪");
      expect(dispatcher.get(top.run.id)).toMatchObject({ status: "done", report: "全套材料就绪" });
    });

    it("lets only a lead working for the org chief plan from inside a subtask", async () => {
      writeOrg({ chiefBotId: "boss" });
      // a section chief's run: its wired lead is just a worker there
      dispatcher.setRoute("chief", "tech", true);
      const run = submit([{ id: "a", title: "落地页", brief: "做页面", assignee: "阿杰" }]);
      if ("error" in run) throw new Error(run.error);
      await flush();
      const turn = host.workerTurns()[0]!;
      expect(turn.mayPlan).toBeUndefined();
      expect(dispatcher.submitPlan("tech", turn.threadId, { goal: "x", subtasks: [{ title: "x", brief: "y" }] })).toMatchObject({
        error: expect.stringContaining("dispatched subtask"),
      });
      // a non-lead doing the org chief's subtask gets no planning either
      const top = orgPlan([{ id: "en", title: "英文版", brief: "翻译", role: "翻译" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      expect(host.workerTurns().find((entry) => entry.botId === "helper")!.mayPlan).toBeUndefined();
    });

    it("stopping the lead stops its team and nothing is retried", async () => {
      writeOrg({ chiefBotId: "boss" });
      const top = orgPlan([{ id: "page", title: "落地页", brief: "做落地页", role: "前端工程师" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns()[0]!;
      const child = dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "落地页", subtasks: [{ id: "build", title: "页面开发", brief: "写", role: "前端" }] });
      if ("error" in child) throw new Error(child.error);
      host.finish(dispatcher, leadTurn.threadId, false, "", "interrupted");
      await settle();
      expect(dispatcher.get(top.run.id)!.subtasks[0]).toMatchObject({ status: "canceled", error: "Stopped by you" });
      expect(dispatcher.get(child.run.id)!.status).toBe("canceled");
      expect(host.workerTurns().filter((turn) => turn.botId === "tech")).toHaveLength(1);
    });

    it("fails the lead's subtask when its team's plan produced nothing", async () => {
      writeOrg({ chiefBotId: "boss" });
      host.settingsValue = dispatchSettings({ maxAttempts: 1 });
      const top = orgPlan([{ id: "page", title: "落地页", brief: "做落地页", role: "前端工程师" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns()[0]!;
      const child = dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "落地页", subtasks: [{ id: "build", title: "页面开发", brief: "写", role: "前端" }] });
      if ("error" in child) throw new Error(child.error);
      host.finish(dispatcher, leadTurn.threadId, true, "已派出");
      await flush();
      host.finish(dispatcher, host.workerTurns().find((turn) => turn.botId === "fe1")!.threadId, false, "");
      await flush();
      expect(dispatcher.get(child.run.id)!.status).toBe("failed");
      expect(dispatcher.get(top.run.id)!.subtasks[0]).toMatchObject({ status: "failed", error: "The team's plan finished without results" });
      expect(dispatcher.get(top.run.id)!.status).toBe("failed");
    });

    it("brings back the company subtasks that wait on a department whose plan is retried", async () => {
      writeOrg({ chiefBotId: "boss" });
      host.settingsValue = dispatchSettings({ maxAttempts: 1 });
      const top = orgPlan([
        { id: "page", title: "落地页", brief: "做发布会落地页", role: "前端工程师" },
        { id: "en", title: "英文版", brief: "把落地页译成英文", role: "翻译", depends_on: ["page"] },
        { id: "press", title: "新闻稿", brief: "翻译新闻稿", role: "翻译" },
      ]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns().find((turn) => turn.botId === "tech")!;
      const press = host.workerTurns().find((turn) => turn.botId === "helper")!;
      const child = dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "落地页", subtasks: [{ id: "build", title: "页面开发", brief: "写", role: "前端" }] });
      if ("error" in child) throw new Error(child.error);
      host.finish(dispatcher, leadTurn.threadId, true, "已派出");
      await flush();
      host.finish(dispatcher, host.workerTurns().find((turn) => turn.botId === "fe1")!.threadId, false, "");
      await flush();
      const sub = (id: string) => dispatcher.get(top.run.id)!.subtasks.find((entry) => entry.id === id)!;
      expect(sub("page").status).toBe("failed");
      expect(sub("en").status).toBe("skipped");
      // the owner retries the department's failed step; the company plan is still going
      dispatcher.retry(child.run.id, "build");
      await flush();
      expect(sub("page")).toMatchObject({ status: "running", childRunId: child.run.id });
      host.finish(dispatcher, host.workerTurns().filter((turn) => turn.botId === "fe1").at(-1)!.threadId, true, "页面完成");
      await flush();
      host.finish(dispatcher, leadTurn.threadId, true, "落地页好了");
      await flush();
      expect(sub("page")).toMatchObject({ status: "done", result: "落地页好了" });
      // the translation that waited on the page runs once the translator is free
      expect(sub("en").status).toBe("pending");
      host.finish(dispatcher, press.threadId, true, "新闻稿英文版");
      await flush();
      const en = host.workerTurns().filter((turn) => turn.botId === "helper").at(-1)!;
      expect(en.text).toContain("英文版");
      expect(en.text).toContain("落地页好了");
      expect(sub("en").status).toBe("running");
    });

    it("reopens a company plan that failed for want of a department whose plan is retried", async () => {
      writeOrg({ chiefBotId: "boss" });
      host.settingsValue = dispatchSettings({ maxAttempts: 1 });
      const top = orgPlan([{ id: "page", title: "落地页", brief: "做落地页", role: "前端工程师" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns()[0]!;
      const child = dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "落地页", subtasks: [{ id: "build", title: "页面开发", brief: "写", role: "前端" }] });
      if ("error" in child) throw new Error(child.error);
      host.finish(dispatcher, leadTurn.threadId, true, "已派出");
      await flush();
      host.finish(dispatcher, host.workerTurns().find((turn) => turn.botId === "fe1")!.threadId, false, "");
      await flush();
      expect(dispatcher.get(top.run.id)!.status).toBe("failed");
      dispatcher.retry(child.run.id, "build");
      await flush();
      expect(dispatcher.get(top.run.id)).toMatchObject({ status: "running" });
      expect(dispatcher.get(top.run.id)!.finishedAt).toBeUndefined();
      expect(dispatcher.get(top.run.id)!.subtasks[0]).toMatchObject({ status: "running", childRunId: child.run.id });
      host.finish(dispatcher, host.workerTurns().filter((turn) => turn.botId === "fe1").at(-1)!.threadId, true, "页面完成");
      await flush();
      host.finish(dispatcher, leadTurn.threadId, true, "落地页好了");
      await flush();
      expect(dispatcher.get(top.run.id)!.subtasks[0]).toMatchObject({ status: "done", result: "落地页好了" });
      host.finish(dispatcher, "boss-thread", true, "落地页已上线");
      expect(dispatcher.get(top.run.id)).toMatchObject({ status: "done", report: "落地页已上线" });
    });

    it("keeps a lead planning for the chief to the company's hiring rule", async () => {
      writeOrg({ chiefBotId: "boss", rules: { chiefMay: { newSpecialist: false } } });
      const top = orgPlan([{ id: "page", title: "落地页", brief: "做发布会落地页", role: "前端工程师" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns()[0]!;
      // nobody in 技术部 edits video: the lead may not hire where the chief may not
      const refused = dispatcher.submitPlan("tech", leadTurn.threadId, {
        goal: "落地页",
        subtasks: [{ id: "video", title: "宣传视频", brief: "剪一条 30 秒视频", role: "视频剪辑师" }],
      });
      expect(refused).toMatchObject({ error: expect.stringContaining("company rules") });
      expect(host.created).toHaveLength(0);
      // its own people it can still plan with
      const own = dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "落地页", subtasks: [{ id: "build", title: "页面开发", brief: "写页面", role: "前端" }] });
      expect("error" in own).toBe(false);
    });

    it("never hands a department's subtask to people added to the chief's run, past the department's lead", async () => {
      writeOrg({ chiefBotId: "boss" });
      const top = orgPlan([
        { id: "page", title: "落地页", brief: "做发布会落地页", role: "前端工程师" },
        { id: "qa", title: "上线检查", brief: "检查落地页", assignee: "技术部" },
        { id: "en", title: "英文版", brief: "翻译新闻稿", role: "翻译" },
        { id: "jp", title: "日文版", brief: "翻译新闻稿", role: "翻译" },
      ]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const sub = (id: string) => dispatcher.get(top.run.id)!.subtasks.find((entry) => entry.id === id)!;
      // the lead plans the page; its second subtask waits for it, the translator does one at a time
      expect([sub("page").status, sub("qa").status, sub("en").status, sub("jp").status]).toEqual(["running", "pending", "running", "pending"]);
      const result = dispatcher.amend(top.run.id, 2, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      // the translation the chief gave a plain worker may move; 技术部's subtask stays with its lead
      expect(result.moved).toEqual(["jp"]);
      expect(sub("qa").assigneeBotId).toBe("tech");
      expect(host.created.every((bot) => !bot.section)).toBe(true);
      // what is left now is 技术部's own: its lead staffs it, so the check says so
      const diagnosis = dispatcher.diagnose(top.run.id);
      if ("error" in diagnosis) throw new Error(diagnosis.error);
      expect(diagnosis).toMatchObject({ verdict: "add-wont-help", reason: expect.stringContaining("leads staff") });
      expect(diagnosis.remaining.find((entry) => entry.subtaskId === "qa")?.moved).toBe(false);
      expect(dispatcher.amend(top.run.id, 1, { by: "owner" })).toMatchObject({ error: expect.stringContaining("leads staff") });
      expect(dispatcher.amend(top.run.id, 1, { by: "chief", botId: "boss" })).toMatchObject({ error: expect.stringContaining("would not help") });
      expect(sub("qa").assigneeBotId).toBe("tech");
    });

    it("keeps a lead's subtask waiting on its team across a restart", async () => {
      writeOrg({ chiefBotId: "boss" });
      const top = orgPlan([{ id: "page", title: "落地页", brief: "做落地页", role: "前端工程师" }]);
      if ("error" in top) throw new Error(top.error);
      await flush();
      const leadTurn = host.workerTurns()[0]!;
      const child = dispatcher.submitPlan("tech", leadTurn.threadId, { goal: "落地页", subtasks: [{ id: "build", title: "页面开发", brief: "写", role: "前端" }] });
      if ("error" in child) throw new Error(child.error);
      host.finish(dispatcher, leadTurn.threadId, true, "已派出");
      await flush();
      for (const bot of host.bots_) bot.busy = false;
      const reloaded = new Dispatcher(host, dir);
      host.dispatcher = reloaded;
      reloaded.load();
      expect(reloaded.get(top.run.id)!.subtasks[0]!.status).toBe("running");
      expect(reloaded.get(child.run.id)!.subtasks[0]!.status).toBe("pending");
      reloaded.resumeAll();
      const restarted = host.workerTurns().filter((turn) => turn.botId === "fe1").at(-1)!;
      host.finish(reloaded, restarted.threadId, true, "页面完成");
      await flush();
      host.finish(reloaded, leadTurn.threadId, true, "落地页好了");
      await flush();
      expect(reloaded.get(top.run.id)!.subtasks[0]).toMatchObject({ status: "done", result: "落地页好了" });
    });

    it("keeps two unfinished runs per chief, counted per lead", () => {
      writeOrg({ chiefBotId: "boss" });
      const plan = (botId: string, thread: string) =>
        dispatcher.submitPlan(botId, thread, { goal: "g", subtasks: [{ title: "页面", brief: "写", role: "前端" }] });
      expect("error" in plan("tech", "tech-1")).toBe(false);
      expect("error" in plan("tech", "tech-2")).toBe(false);
      expect(plan("tech", "tech-3")).toMatchObject({ error: expect.stringContaining("Two dispatch runs") });
      // the org chief and the other leads are counted separately
      expect("error" in orgPlan([{ title: "英文版", brief: "翻译", role: "翻译" }])).toBe(false);
      expect("error" in submit([{ title: "文案", brief: "写", role: "文案策划" }])).toBe(false);
    });
  });

  // ── adding people mid-run ──

  describe("adding people", () => {
    beforeEach(() => {
      host.settingsValue = dispatchSettings({ maxConcurrent: 2 });
      host.add({ id: "w2", name: "小美", title: "文案策划", description: "写小红书", section: "市场部" });
    });

    /** Eight independent pages for two writers; two finished in 30 minutes,
     * two more under way for 10 minutes. */
    const busyRun = async () => {
      const result = submit(
        Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, title: `第 ${i + 1} 页`, brief: `写第 ${i + 1} 页`, role: "文案策划", acceptance: "标题 + 三段卖点" })),
      );
      if ("error" in result) throw new Error(result.error);
      await flush();
      for (const turn of host.workerTurns().slice(0, 2)) host.finish(dispatcher, turn.threadId, true, `${turn.text.slice(0, 4)} 完成稿`);
      await flush();
      const run = dispatcher.get(result.run.id)!;
      const now = Date.now();
      for (const subtask of run.subtasks) {
        if (subtask.status === "done") Object.assign(subtask, { startedAt: now - 40 * MIN, finishedAt: now - 10 * MIN });
        if (subtask.status === "running") subtask.startedAt = now - 10 * MIN;
      }
      return run;
    };

    it("diagnoses a slow run and suggests a squad", async () => {
      const run = await busyRun();
      const diagnosis = dispatcher.diagnose(run.id, { total: 5 });
      if ("error" in diagnosis) throw new Error(diagnosis.error);
      expect(diagnosis.verdict).toBe("add-helps");
      expect(diagnosis.suggestion).toMatchObject({ add: 3, squad: "Squad B", models: ["Claude Sonnet", "Claude Sonnet", "Claude Sonnet"], linesBefore: 1, withinBudget: true });
      expect(diagnosis.suggestion!.etaAfter!).toBeLessThan(diagnosis.suggestion!.etaBefore!);
      expect(diagnosis.remaining.map((entry) => entry.status)).toEqual(["done", "done", "running", "running", "pending", "pending", "pending", "pending"]);
      expect(dispatcher.diagnose("nope")).toMatchObject({ error: expect.any(String) });
    });

    it("prices the squad from what finished subtasks cost", async () => {
      const run = await busyRun();
      // $0.50 a page so far = ¥3.6
      for (const subtask of run.subtasks.filter((entry) => entry.status === "done")) host.costs.set(subtask.threadId!, 0.5);
      // newcomers on Sonnet (price level 3) instead of GPT-5.5 (4): cheaper pages offset reading the pack
      const cheaper = dispatcher.diagnose(run.id, { add: 2 });
      if ("error" in cheaper) throw new Error(cheaper.error);
      expect(cheaper.suggestion).toMatchObject({ costCny: 0, withinBudget: true });
      // on a pricier model each page they take costs ¥3.6 × (5/4 − 1 + 0.1) more
      host.recommendation = { ...host.recommendation!, profile: { ...host.recommendation!.profile, cost: 5 } };
      const pricier = dispatcher.diagnose(run.id, { add: 2 });
      if ("error" in pricier) throw new Error(pricier.error);
      const moved = pricier.remaining.filter((entry) => entry.moved).length;
      expect(moved).toBeGreaterThan(0);
      expect(pricier.suggestion!.costCny).toBeCloseTo(moved * 3.6 * 0.35, 1);
      expect(pricier.suggestion!.withinBudget).toBe(true);
    });

    it("hands only not-started subtasks to a new squad in the same run", async () => {
      const run = await busyRun();
      const before = run.subtasks.map((subtask) => ({ id: subtask.id, status: subtask.status, assignee: subtask.assigneeBotId }));
      const runs = dispatcher.list().length;
      const result = dispatcher.amend(run.id, 3, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      expect(result.added).toHaveLength(3);
      expect(dispatcher.list()).toHaveLength(runs);
      expect(result.run.id).toBe(run.id);
      // made like the dispatcher's own specialists: same section, recommended model, wired to the chief
      for (const id of result.added) {
        expect(host.bot(id)).toMatchObject({ section: "市场部", title: "文案策划", modelSelection: { instanceId: "claude", model: "sonnet" } });
        expect(dispatcher.routes()).toContainEqual(expect.objectContaining({ fromBotId: "chief", toBotId: id, enabled: true }));
      }
      // done and running work stays put; only pending work moved
      for (const entry of before.filter((item) => item.status !== "pending")) {
        expect(run.subtasks.find((subtask) => subtask.id === entry.id)!.assigneeBotId).toBe(entry.assignee);
      }
      expect(result.moved.length).toBeGreaterThan(0);
      for (const id of result.moved) {
        expect(before.find((entry) => entry.id === id)!.status).toBe("pending");
        expect(result.added).toContain(run.subtasks.find((subtask) => subtask.id === id)!.assigneeBotId);
        expect(run.subtasks.find((subtask) => subtask.id === id)).toMatchObject({ squad: "Squad B", createdBot: true });
      }
      const squad = run.squads![0]!;
      expect(squad).toMatchObject({ name: "Squad B", leadBotId: result.added[0], botIds: result.added, subtaskIds: result.moved, by: "owner" });
      expect(squad.reviewAt - squad.addedAt).toBe(30 * MIN);
      expect(squad.etaAfter!).toBeLessThan(squad.etaBefore!);
      // more people, more at once: the newcomers start right away
      expect(run.maxConcurrent).toBe(5);
      expect(host.workerTurns().filter((turn) => result.added.includes(turn.botId))).toHaveLength(3);
      expect(host.events).toContainEqual(expect.objectContaining({ kind: "people.added", runId: run.id, section: "市场部" }));
      expect(host.chips.some((chip) => chip.label.startsWith("Squad B joined"))).toBe(true);
    });

    it("gives a squad member its onboarding instead of the history", async () => {
      const run = await busyRun();
      const result = dispatcher.amend(run.id, 2, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      const [leadTurn, memberTurn] = result.added.map((id) => host.workerTurns().find((turn) => turn.botId === id)!);
      expect(leadTurn!.text).toContain("You joined Squad B");
      expect(leadTurn!.text).toContain("Match the standard of this finished subtask");
      expect(leadTurn!.text).toContain("You lead Squad B");
      expect(memberTurn!.text).toContain(`Questions go to your squad lead @${host.bot(result.added[0]!)!.name}`);
    });

    it("lets the chief add people only when it helps and the rules allow", async () => {
      const run = await busyRun();
      writeFileSync(join(dir, "org.json"), JSON.stringify({ chiefBotId: null, rules: { chiefMay: { addPeople: false } } }));
      expect(dispatcher.amend(run.id, 2, { by: "chief", botId: "chief" })).toMatchObject({ error: expect.stringContaining("rules") });
      writeFileSync(join(dir, "org.json"), JSON.stringify({ chiefBotId: null, rules: { chiefMay: { addPeople: true } } }));
      expect(dispatcher.amend(run.id, 2, { by: "chief", botId: "writer" })).toMatchObject({ error: expect.stringContaining("Only this run's chief") });
      const ok = dispatcher.amend(run.id, 2, { by: "chief", botId: "chief" });
      if ("error" in ok) throw new Error(ok.error);
      expect(run.squads![0]!.by).toBe("chief");
    });

    it("refuses the chief when more people would not help, but not the owner", async () => {
      const result = submit([
        { id: "a", title: "第一步", brief: "做", role: "文案策划" },
        { id: "b", title: "第二步", brief: "做", role: "文案策划", depends_on: ["a"] },
        { id: "c", title: "第三步", brief: "做", role: "文案策划", depends_on: ["b"] },
      ]);
      if ("error" in result) throw new Error(result.error);
      await flush();
      expect(dispatcher.amend(result.run.id, 1, { by: "chief", botId: "chief" })).toMatchObject({ error: expect.stringContaining("would not help") });
      const forced = dispatcher.amend(result.run.id, 1, { by: "owner" });
      expect("error" in forced).toBe(false);
    });

    it("refuses nonsense: no run, a finished run, nothing to hand out", async () => {
      expect(dispatcher.amend("nope", 2)).toMatchObject({ error: expect.any(String) });
      const run = await busyRun();
      expect(dispatcher.amend(run.id, 0)).toMatchObject({ error: expect.stringContaining("at least 1") });
      await dispatcher.cancel(run.id);
      expect(dispatcher.amend(run.id, 2)).toMatchObject({ error: expect.stringContaining("in progress") });
      // (the fake engines stop when interrupted)
      for (const bot of host.bots_) bot.busy = false;
      const single = submit([{ id: "a", title: "文案", brief: "写", role: "文案策划" }]);
      if ("error" in single) throw new Error(single.error);
      await flush();
      expect(dispatcher.amend(single.run.id, 2)).toMatchObject({ error: expect.stringContaining("Nothing is left") });
    });

    it("reviews the squad's speed 30 minutes later", async () => {
      const run = await busyRun();
      const result = dispatcher.amend(run.id, 2, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      const squad = run.squads![0]!;
      dispatcher.checkReviews(squad.reviewAt - 1);
      expect(squad.review).toBeUndefined();
      // two newcomers finish within the half hour
      for (const id of result.added) {
        const turn = host.workerTurns().find((entry) => entry.botId === id)!;
        host.finish(dispatcher, turn.threadId, true, "完成稿");
      }
      dispatcher.checkReviews(squad.reviewAt + 1);
      expect(squad.review).toMatchObject({ faster: true });
      expect(squad.review!.speedAfter).toBeGreaterThan(squad.review!.speedBefore);
      expect(host.chips.some((chip) => chip.label.startsWith("Review of Squad B"))).toBe(true);
      expect(host.events).toContainEqual(expect.objectContaining({ kind: "report", runId: run.id, severity: "info" }));
    });

    it("announces one addition once on the company timeline", async () => {
      const run = await busyRun();
      // index.ts: dispatcher events go to the timeline, broadcasts through the run watcher
      const watcher = new RunWatcher();
      watcher.seed([run]);
      const watched: OrgEventInput[] = [];
      host.broadcast = (changed) => {
        watched.push(...watcher.diff(changed, { botName: (id) => host.bot(id)?.name, botSection: (id) => host.bot(id)?.section, maxAttempts: 2 }));
      };
      const result = dispatcher.amend(run.id, 2, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      const added = [...host.events, ...watched].filter((event) => event.kind === "people.added");
      expect(added).toHaveLength(1);
      expect(added[0]!.title).toContain("Squad B");
    });

    it("dissolves the squad of a run a restart finishes", async () => {
      const run = await busyRun();
      const result = dispatcher.amend(run.id, 2, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      for (let round = 0; round < 10 && run.status === "running"; round += 1) {
        for (const subtask of run.subtasks.filter((entry) => entry.status === "running")) host.finish(dispatcher, subtask.threadId!, true, "完成稿");
        await flush();
      }
      // every page is in; the chief is writing the report when the app restarts
      expect(run).toMatchObject({ status: "synthesizing", synthesisStarted: true });
      for (const bot of host.bots_) bot.busy = false;
      const reloaded = new Dispatcher(host, dir);
      reloaded.load();
      const after = reloaded.get(run.id)!;
      expect(after.status).toBe("done");
      expect(after.squads![0]!.endedAt).toEqual(expect.any(Number));
      // a dissolved squad gets no speed review afterwards
      const chips = host.chips.length;
      reloaded.checkReviews(after.squads![0]!.reviewAt + 1);
      expect(host.chips).toHaveLength(chips);
      expect(after.squads![0]!.review).toBeUndefined();
    });

    it("dissolves the squad when its run ends, without a review from too short a window", async () => {
      const run = await busyRun();
      const result = dispatcher.amend(run.id, 2, { by: "owner" });
      if ("error" in result) throw new Error(result.error);
      await dispatcher.cancel(run.id);
      const squad = run.squads![0]!;
      expect(squad.endedAt).toEqual(expect.any(Number));
      expect(squad.review).toBeUndefined();
      const chips = host.chips.length;
      dispatcher.checkReviews(squad.reviewAt + 1);
      expect(squad.review).toBeUndefined();
      expect(host.chips).toHaveLength(chips);
    });

    it("serves diagnose and amend over HTTP", async () => {
      const run = await busyRun();
      const call = async (path: string, body: unknown) => {
        let status = 0;
        let payload: any;
        const handled = await handleDispatchApi(
          "POST",
          path,
          new URL(`http://localhost${path}`),
          {} as IncomingMessage,
          {} as ServerResponse,
          {
            dispatcher,
            readBody: async () => body,
            json: (_res, code, value) => {
              status = code;
              payload = value;
            },
            teamMapSnapshot: () => null,
            ownsThread: () => true,
            botName: (id) => host.bot(id)?.name,
            modelLabel: () => "Claude · Sonnet",
          },
          () => host.settings(),
        );
        return { handled, status, payload };
      };
      const diagnosis = await call(`/api/dispatch/runs/${run.id}/diagnose`, {});
      expect(diagnosis).toMatchObject({ handled: true, status: 200, payload: { runId: run.id, verdict: "add-helps" } });
      const amended = await call(`/api/dispatch/runs/${run.id}/amend`, { add: 2 });
      expect(amended).toMatchObject({ status: 200, payload: { ok: true, added: expect.any(Array) } });
      expect(await call(`/api/dispatch/runs/${run.id}/amend`, { add: "lots" })).toMatchObject({ status: 400 });
      // the chief's add_people tool, inside its rules
      const chief = await call("/api/internal/dispatch/amend", { fromBotId: "chief", runId: run.id, add: 1 });
      expect(chief.status).toBe(200);
      expect(chief.payload.squad ?? chief.payload.error).toBeTruthy();
      expect(await call("/api/internal/dispatch/amend", { fromBotId: "writer", runId: run.id })).toMatchObject({ payload: { error: expect.stringContaining("not one of your") } });
    });
  });
});
