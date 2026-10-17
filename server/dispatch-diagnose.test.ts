// Adding people mid-run: the four questions, the squad plan and its maths
// (communication lines, finish-time simulation, who takes what), the budget
// line and the 30-minute review — on hand-built runs with fixed clocks.
import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../shared/dispatch-types.ts";
import { DEFAULT_ORG_RULES } from "../shared/org-types.ts";
import {
  chooseRoles,
  communicationLines,
  diagnoseRun,
  pairs,
  planSquad,
  poolSchedule,
  reviewSquad,
  simulateMakespan,
  throughput,
  typicalDuration,
  type DiagnoseBot,
  type DiagnoseContext,
} from "./dispatch-diagnose.ts";
import { roleCore, uniqueName } from "./dispatch.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 16, 8, 10); // 16:10 in the story
const START = NOW - 130 * MIN; // 14:00

function subtask(id: string, patch: Partial<DispatchSubtask> = {}): DispatchSubtask {
  return {
    id,
    title: id,
    brief: `做 ${id}`,
    role: "前端",
    needs: [],
    difficulty: 3,
    dependsOn: [],
    assigneeBotId: "w1",
    status: "pending",
    attempts: 0,
    ...patch,
  };
}

function run(subtasks: DispatchSubtask[], patch: Partial<DispatchRun> = {}): DispatchRun {
  return {
    id: "run-1",
    chiefBotId: "lead",
    sourceThreadId: "lead-thread",
    goal: "商品详情页 24 页",
    policy: "balanced",
    status: "running",
    subtasks,
    createdAt: START,
    updatedAt: NOW,
    maxConcurrent: 4,
    ...patch,
  };
}

/** The story at 16:10: 24 pages, 9 done (53 min each), 4 being made for 30
 * minutes, 11 not started — 4 front-end people, one page each at a time. */
function storyRun(): DispatchRun {
  const workers = ["w1", "w2", "w3", "w4"];
  const pages: DispatchSubtask[] = [];
  for (let n = 1; n <= 24; n += 1) {
    const id = `P${String(n).padStart(2, "0")}`;
    const worker = workers[(n - 1) % 4]!;
    if (n <= 9) {
      const startedAt = START + Math.floor((n - 1) / 4) * 35 * MIN;
      pages.push(subtask(id, { assigneeBotId: worker, status: "done", attempts: n === 5 ? 2 : 1, startedAt, finishedAt: startedAt + 53 * MIN, result: `${id} 成品`, acceptance: "主图 + 3 段卖点 + 参数表" }));
    } else if (n <= 13) {
      pages.push(subtask(id, { assigneeBotId: worker, status: "running", attempts: 1, startedAt: NOW - 30 * MIN }));
    } else {
      pages.push(subtask(id, { assigneeBotId: worker, acceptance: "主图 + 3 段卖点 + 参数表" }));
    }
  }
  return run(pages);
}

const bots: Record<string, DiagnoseBot> = {
  lead: { id: "lead", name: "阿杰", modelSelection: { instanceId: "codex", model: "gpt-5.5" } },
  w1: { id: "w1", name: "前端 1", modelSelection: { instanceId: "opencode", model: "kimi-k2" } },
  w2: { id: "w2", name: "前端 2", modelSelection: { instanceId: "cursor", model: "sonnet" } },
  w3: { id: "w3", name: "前端 3", modelSelection: { instanceId: "droid", model: "glm-4.6" } },
  w4: { id: "w4", name: "测试", modelSelection: { instanceId: "antigravity", model: "gemini-3-pro" } },
};

function context(patch: Partial<DiagnoseContext> = {}): DiagnoseContext {
  return {
    now: NOW,
    bot: (id) => bots[id],
    maxConcurrent: 3,
    rules: DEFAULT_ORG_RULES,
    budgetCny: 60,
    room: 50,
    roleKey: roleCore,
    modelFor: () => ({ selection: { instanceId: "kimi", model: "kimi-k2" }, label: "Kimi K2", costLevel: 2 }),
    costLevel: () => 2,
    costCny: () => null,
    engineName: (id) => ({ opencode: "OpenCode", cursor: "Cursor", droid: "Droid", antigravity: "Antigravity" })[id] ?? id,
    takenNames: Object.values(bots).map((bot) => bot.name),
    uniqueName,
    squadName: "Squad B",
    leadName: "阿杰",
    ...patch,
  };
}

describe("communication lines", () => {
  it("counts everyone-talks-to-everyone among direct reports and a star inside each squad", () => {
    expect(pairs(4)).toBe(6);
    expect(pairs(1)).toBe(0);
    // 4 people → 6; a squad of 4 joins under its own lead → 10 + 3; ungrouped 8 → 28
    expect(communicationLines(4, [])).toBe(6);
    expect(communicationLines(5, [4])).toBe(13);
    expect(pairs(8)).toBe(28);
  });
});

describe("finish-time simulation", () => {
  it("runs each worker one subtask at a time, under the cap, after dependencies", () => {
    const tasks = [
      { id: "a", worker: "x", deps: [], remaining: 10 },
      { id: "b", worker: "y", deps: [], remaining: 10 },
      { id: "c", worker: "x", deps: [], remaining: 10 },
      { id: "d", worker: "y", deps: ["a"], remaining: 5 },
    ];
    // x: a 0–10, c 10–20; y: b 0–10, d 10–15
    expect(simulateMakespan(tasks, new Set(), 2)).toBe(20);
    // one at a time: 10 + 10 + 10 + 5
    expect(simulateMakespan(tasks, new Set(), 1)).toBe(35);
    // work already in progress finishes first and counts against the cap
    expect(simulateMakespan([{ id: "r", worker: "x", deps: [], remaining: 4, running: true }, { id: "s", worker: "x", deps: ["r"], remaining: 6 }], new Set(), 1)).toBe(10);
    // a dependency that can never finish
    expect(simulateMakespan([{ id: "e", worker: "x", deps: ["missing"], remaining: 1 }], new Set(), 2)).toBeNull();
    expect(simulateMakespan([], new Set(), 2)).toBe(0);
  });

  it("lets newcomers take ready work of their kind while the team keeps its own", () => {
    const taken = poolSchedule({
      running: [{ id: "r1", worker: "old", remaining: 5 }],
      pending: [
        { id: "p1", owner: "old", role: "fe", deps: [] },
        { id: "p2", owner: "old", role: "fe", deps: [] },
        { id: "p3", owner: "old", role: "qa", deps: [] },
        { id: "p4", owner: "old", role: "fe", deps: ["p1"] },
      ],
      workers: [
        { id: "new", fresh: true, roles: new Set(["fe"]) },
        { id: "old", fresh: false, roles: new Set(["fe", "qa"]) },
      ],
      doneIds: new Set(),
      cap: 4,
      duration: 10,
    });
    // the newcomer starts p1 at once and picks p4 once p1 is done; the old
    // worker, free at 5, takes its next own subtask (p2), then the qa one
    expect(taken.get("p1")).toBe("new");
    expect(taken.get("p2")).toBe("old");
    expect(taken.get("p3")).toBe("old");
    expect(taken.get("p4")).toBe("new");
  });

  it("spreads newcomers over the kinds of work with the most left per person", () => {
    const pending = new Map([["fe", 8], ["qa", 1]]);
    expect(chooseRoles(3, pending, new Map([["fe", 3], ["qa", 1]]))).toEqual(["fe", "fe", "fe"]);
    expect(chooseRoles(5, new Map([["fe", 2], ["qa", 1]]), new Map())).toEqual(["fe", "qa", "fe"]);
  });

  it("measures typical duration and throughput from finished work", () => {
    const story = storyRun();
    expect(typicalDuration(story)).toBe(53 * MIN);
    expect(throughput(story, START, NOW)).toBeCloseTo(9 / (130 / 60), 1);
    expect(typicalDuration(run([subtask("x", { status: "running", startedAt: NOW })]))).toBeNull();
  });
});

describe("squad plan", () => {
  it("only moves not-started subtasks and finishes sooner", () => {
    const story = storyRun();
    const plan = planSquad(story, 4, { now: NOW, maxConcurrent: 3, roleKey: roleCore }, typicalDuration(story));
    expect(plan.people).toHaveLength(4);
    const moved = [...plan.moves.keys()];
    expect(moved.length).toBeGreaterThan(0);
    for (const id of moved) expect(story.subtasks.find((entry) => entry.id === id)!.status).toBe("pending");
    // newcomers start the first free pages; the team keeps the ones it frees up for
    expect(moved).toContain("P14");
    expect(moved.length).toBeLessThan(11);
    // 4 at a time → 8 at a time: the run's concurrency follows the people
    expect(plan.cap).toBe(8);
    expect(plan.makespanBefore).toBe(23 * MIN + 3 * 53 * MIN);
    expect(plan.makespanAfter).toBe(2 * 53 * MIN);
  });

  it("never moves a subtask that stays with its owner, and still counts it in the estimate", () => {
    const story = storyRun();
    // P14 and P15 are a department lead's share: that lead staffs them itself
    const keep = (entry: DispatchSubtask) => entry.id === "P14" || entry.id === "P15";
    const plan = planSquad(story, 4, { now: NOW, maxConcurrent: 3, roleKey: roleCore, keep }, typicalDuration(story));
    expect(plan.moves.has("P14")).toBe(false);
    expect(plan.moves.has("P15")).toBe(false);
    expect(plan.moves.size).toBeGreaterThan(0);
    expect(plan.makespanAfter!).toBeLessThan(plan.makespanBefore!);
    // when nothing else is left to take, nobody is planned and the check says why
    const leadsOnly = run(story.subtasks.map((entry) => (entry.status === "pending" && !keep(entry) ? { ...entry, status: "done" as const, startedAt: NOW - 60 * MIN, finishedAt: NOW - 5 * MIN } : entry)));
    expect(planSquad(leadsOnly, 2, { now: NOW, maxConcurrent: 3, roleKey: roleCore, keep }, typicalDuration(leadsOnly)).people).toEqual([]);
    expect(diagnoseRun(leadsOnly, context({ keep }))).toMatchObject({ verdict: "add-wont-help", reason: expect.stringContaining("leads staff") });
  });

  it("estimates nothing without a finished subtask, but still splits the work", () => {
    const fresh = run([subtask("a"), subtask("b"), subtask("c", { status: "running", attempts: 1, startedAt: NOW - MIN })]);
    const plan = planSquad(fresh, 2, { now: NOW, maxConcurrent: 3, roleKey: roleCore }, null);
    expect(plan.makespanBefore).toBeNull();
    expect(plan.makespanAfter).toBeNull();
    expect(plan.people.length).toBeGreaterThan(0);
  });
});

describe("diagnoseRun", () => {
  it("answers the four questions and suggests a squad for the story", () => {
    const story = storyRun();
    // the owner said "up to 8 people": 4 more
    const diagnosis = diagnoseRun(story, context({ requested: 4 }));
    expect(diagnosis.verdict).toBe("add-helps");
    expect(diagnosis.checks.map((check) => [check.id, check.ok])).toEqual([
      ["waiting", true],
      ["parallel", true],
      ["capability", true],
      ["rateLimit", true],
    ]);
    expect(diagnosis.checks[0]!.finding).toBe("No, nothing is waiting");
    expect(diagnosis.checks[1]!.finding).toBe("Yes, 11 don't depend on each other");
    expect(diagnosis.checks[1]!.evidence).toBe("P14–P24 not started yet");
    // 13 pages started, P05 needed a second go: 1 / 13 ≈ 8%
    expect(diagnosis.checks[2]!.finding).toBe("Rework rate 8%, normal");
    expect(diagnosis.checks[2]!.evidence).toBe("13 started, sent back 1 times");
    expect(diagnosis.checks[3]!.evidence).toContain("OpenCode");
    const suggestion = diagnosis.suggestion!;
    expect(suggestion).toMatchObject({ add: 4, squad: "Squad B", linesBefore: 6, linesAfter: 13, linesUngrouped: 28, withinBudget: true, costCny: 0, concurrency: 8 });
    expect(suggestion.models).toEqual(["Kimi K2", "Kimi K2", "Kimi K2", "Kimi K2"]);
    expect(suggestion.etaBefore).toBe(NOW + 23 * MIN + 3 * 53 * MIN);
    expect(suggestion.etaAfter).toBe(NOW + 2 * 53 * MIN);
    expect(suggestion.people[0]).toMatchObject({ name: "前端", role: "前端" });
    expect(suggestion.people[1]!.name).toBe("前端 4");
    expect(suggestion.pack.map((item) => item.id)).toEqual(["acceptance", "examples", "scope", "goal", "contact"]);
    expect(suggestion.pack[0]!.text).toBe("主图 + 3 段卖点 + 参数表");
    expect(suggestion.pack[1]!.text).toBe("P01–P09 finished samples");
    expect(diagnosis.speedPerHour).toBeGreaterThan(4);
    // every page is listed: done and running stay put, only not-started ones move
    expect(diagnosis.remaining).toHaveLength(24);
    expect(diagnosis.remaining.filter((entry) => entry.status === "done")).toHaveLength(9);
    expect(diagnosis.remaining.filter((entry) => entry.moved).every((entry) => entry.status === "pending")).toBe(true);
    expect(diagnosis.remaining.find((entry) => entry.subtaskId === "P14")).toMatchObject({ moved: true, squad: "Squad B" });
    expect(diagnosis.remaining.find((entry) => entry.subtaskId === "P10")).toMatchObject({ moved: false, squad: "Squad A", status: "running" });
  });

  it("suggests the smallest squad that gets most of the speed-up when nobody asked for a number", () => {
    const diagnosis = diagnoseRun(storyRun(), context());
    expect(diagnosis.verdict).toBe("add-helps");
    const suggestion = diagnosis.suggestion!;
    expect(suggestion.add).toBeGreaterThanOrEqual(1);
    expect(suggestion.add).toBeLessThanOrEqual(DEFAULT_ORG_RULES.spanOfControl);
    expect(suggestion.etaAfter!).toBeLessThan(suggestion.etaBefore!);
  });

  it("says adding won't help while an engine is rate limiting", () => {
    const story = storyRun();
    story.subtasks[10]!.rateLimitedAt = [NOW - 2 * MIN, NOW - MIN];
    const diagnosis = diagnoseRun(story, context());
    expect(diagnosis.verdict).toBe("add-wont-help");
    expect(diagnosis.reason).toContain("rate limiting");
    expect(diagnosis.checks.find((check) => check.id === "rateLimit")).toMatchObject({ ok: false, finding: "Yes, 2 rate-limit hits in the last 15 minutes" });
    expect(diagnosis.suggestion).toBeUndefined();
    // old throttling has passed
    story.subtasks[10]!.rateLimitedAt = [NOW - 40 * MIN];
    expect(diagnoseRun(story, context()).verdict).toBe("add-helps");
  });

  it("says adding won't help when most of what is left waits on earlier work", () => {
    const chain = run([
      subtask("a", { status: "running", attempts: 1, startedAt: NOW - 5 * MIN }),
      subtask("b", { dependsOn: ["a"] }),
      subtask("c", { dependsOn: ["b"] }),
      subtask("d", { dependsOn: ["c"] }),
    ]);
    const diagnosis = diagnoseRun(chain, context());
    expect(diagnosis.verdict).toBe("add-wont-help");
    expect(diagnosis.checks[0]).toMatchObject({ id: "waiting", ok: false, finding: "3 of 4 are waiting on others" });
    expect(diagnosis.reason).toContain("waiting on earlier results");
  });

  it("counts a worker waiting for the owner's approval as waiting", () => {
    const waitingBots: Record<string, DiagnoseBot> = { ...bots, w1: { ...bots.w1!, activity: "waiting-on-you" } };
    const pending = run([
      subtask("a", { status: "running", attempts: 1, startedAt: NOW - MIN, assigneeBotId: "w1" }),
      subtask("b", { status: "running", attempts: 1, startedAt: NOW - MIN, assigneeBotId: "w2" }),
      subtask("c", { assigneeBotId: "w1" }),
    ]);
    const diagnosis = diagnoseRun(pending, context({ bot: (id) => waitingBots[id] }));
    expect(diagnosis.checks[0]).toMatchObject({ ok: true, finding: "Only 1 waiting on others", evidence: "1 waiting for your approval" });
  });

  it("points at the model, not the headcount, when too much work is sent back", () => {
    const shaky = run([
      subtask("a", { status: "done", attempts: 2, startedAt: NOW - 20 * MIN, finishedAt: NOW - 10 * MIN, result: "ok" }),
      subtask("b", { status: "failed", attempts: 2, finishedAt: NOW - 5 * MIN }),
      subtask("c", { status: "running", attempts: 2, startedAt: NOW - MIN }),
      subtask("d"),
      subtask("e"),
    ]);
    const diagnosis = diagnoseRun(shaky, context());
    expect(diagnosis.checks[2]).toMatchObject({ id: "capability", ok: false });
    expect(diagnosis.verdict).toBe("add-wont-help");
    expect(diagnosis.reason).toContain("stronger model");
    // retries forced by throttling are not the worker's fault
    for (const entry of shaky.subtasks) entry.throttledAttempts = entry.attempts > 1 ? 2 : 0;
    expect(diagnoseRun(shaky, context()).checks[2]!.ok).toBe(true);
  });

  it("has nothing to hand out once everything is running or done", () => {
    const busy = run([subtask("a", { status: "done", attempts: 1, startedAt: START, finishedAt: START + MIN, result: "ok" }), subtask("b", { status: "running", attempts: 1, startedAt: NOW })]);
    const diagnosis = diagnoseRun(busy, context());
    expect(diagnosis.verdict).toBe("add-wont-help");
    expect(diagnosis.reason).toContain("Nothing is left");
    expect(diagnoseRun({ ...busy, status: "done" }, context()).reason).toContain("no longer in progress");
  });

  it("keeps the squad inside the budget line, or says it is over", () => {
    const story = storyRun();
    // ¥2 per finished page so far; newcomers on a pricier model (level 4 vs 2)
    const priced = context({
      requested: 4,
      costCny: (entry) => (entry.status === "done" ? 2 : null),
      modelFor: () => ({ selection: { instanceId: "claude", model: "opus" }, label: "Claude Opus", costLevel: 4 }),
    });
    const roomy = diagnoseRun(story, { ...priced, budgetCny: 500 });
    // each moved page: ¥2 × (4/2 − 1 + 0.1)
    const moved = roomy.remaining.filter((entry) => entry.moved).length;
    expect(roomy.suggestion!.costCny).toBeCloseTo(moved * 2 * 1.1, 1);
    expect(roomy.suggestion!.withinBudget).toBe(true);
    // ¥18 spent + 15 left × ¥2 = ¥48 of a ¥55 line: little room, so a smaller squad
    const tight = diagnoseRun(story, { ...priced, budgetCny: 55 });
    expect(tight.suggestion!.add).toBeLessThan(4);
    const over = diagnoseRun(story, { ...priced, budgetCny: 40 });
    expect(over.suggestion!.withinBudget).toBe(false);
  });
});

describe("reviewSquad", () => {
  it("compares the speed before the squad joined with the speed since", () => {
    const story = storyRun();
    const squad = { name: "Squad B", leadBotId: "n1", botIds: ["n1"], subtaskIds: ["P14"], addedAt: NOW, by: "owner" as const, reviewAt: NOW + 30 * MIN };
    // three more pages finish in the half hour after the squad joined
    for (const id of ["P10", "P11", "P12"]) Object.assign(story.subtasks.find((entry) => entry.id === id)!, { status: "done", finishedAt: NOW + 20 * MIN });
    const review = reviewSquad(story, squad, NOW + 31 * MIN);
    expect(review.speedBefore).toBeCloseTo(9 / (130 / 60), 1);
    expect(review.speedAfter).toBe(6);
    expect(review.faster).toBe(true);
    // nothing finished since: not faster
    expect(reviewSquad(storyRun(), squad, NOW + 31 * MIN)).toMatchObject({ speedAfter: 0, faster: false });
  });
});
