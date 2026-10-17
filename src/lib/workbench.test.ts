// Workbench model: people states, the floor plan, the work tree's slot map,
// the compressed day, the project header, routes, view math and undo.
import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSquad, DispatchSubtask } from "../../shared/dispatch-types";
import type { InboxItem } from "../../shared/org-types";
import { EMPTY_TEAM_MAP_SNAPSHOT } from "./team-map";
import {
  EditHistory,
  FLOOR,
  TREE,
  activeRun,
  activeSquads,
  buildWires,
  compressDay,
  departmentStats,
  fitView,
  headcount,
  isLeafSubtask,
  labelRoom,
  labelWidth,
  layoutFloor,
  layoutTree,
  parseDeadline,
  peopleStates,
  placeLabels,
  projectTitle,
  runMemberIds,
  splitRemaining,
  zoomAround,
  type TreeInput,
  type WorkbenchBot,
} from "./workbench";

const NOW = new Date(2026, 9, 15, 16, 52).getTime(); // Thursday 16:52
const MIN = 60_000;

const BOTS: WorkbenchBot[] = [
  { id: "chief", name: "总控", chiefOfStaff: true, createdAt: 1 },
  { id: "lead", name: "小文", section: "内容部", chiefOfStaff: true, createdAt: 2 },
  { id: "a", name: "社媒写手", section: "内容部", createdAt: 3 },
  { id: "b", name: "新闻稿写手", section: "内容部", createdAt: 4 },
  { id: "c", name: "运维", section: "技术部", createdAt: 5 },
  { id: "h", name: "隐藏", section: "内容部", hidden: true, createdAt: 6 },
];

const subtask = (id: string, assignee: string, status: DispatchSubtask["status"], extra: Partial<DispatchSubtask> = {}): DispatchSubtask => ({
  id,
  title: `任务 ${id}`,
  brief: "b",
  role: "r",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId: assignee,
  status,
  attempts: status === "pending" ? 0 : 1,
  ...extra,
});

const run = (subtasks: DispatchSubtask[], extra: Partial<DispatchRun> = {}): DispatchRun => ({
  id: "r1",
  chiefBotId: "chief",
  sourceThreadId: "t",
  goal: "新品发布会 · 全套材料，周五 19:30 上线",
  policy: "balanced",
  status: "running",
  createdAt: NOW - 120 * MIN,
  updatedAt: NOW,
  subtasks,
  ...extra,
});

const inbox = (item: Partial<InboxItem> & Pick<InboxItem, "kind" | "botId">): InboxItem => ({ id: item.botId + item.kind, title: "主视觉 4 选 1", since: NOW - 5 * MIN, ...item });

describe("task scoping", () => {
  it("collects every bot in a task, including its department child runs and squads", () => {
    const parent = run([subtask("a", "lead", "running", { childRunId: "child" })], {
      id: "parent",
      squads: [{ name: "组 B", leadBotId: "b", botIds: ["b"], subtaskIds: [], addedAt: 1, by: "owner", reviewAt: 2 }],
    });
    const child = run([subtask("c", "a", "pending")], { id: "child", parentRunId: "parent" });
    const other = run([subtask("d", "c", "done")], { id: "other" });
    expect([...runMemberIds([parent, child, other], "parent")].sort()).toEqual(["a", "b", "lead"]);
    expect([...runMemberIds([parent, child, other], "missing")]).toEqual([]);
  });
});

describe("people states", () => {
  const states = (runs: DispatchRun[], items: InboxItem[] = [], lastSeen = 0) =>
    peopleStates({ bots: BOTS, runs, inbox: items, chiefId: "chief", leads: new Set(["lead"]), maxAttempts: 2, lastSeen, now: NOW });

  it("turns work into poses: working, queued, just delivered, delivered earlier, idle", () => {
    const map = states([
      run([
        subtask("1", "a", "running", { title: "改两份社媒稿" }),
        subtask("2", "b", "pending"),
        subtask("3", "c", "done", { finishedAt: NOW - 5 * MIN, title: "价格表 v4" }),
      ]),
    ]);
    expect(map.get("a")).toMatchObject({ status: "working", pose: "work", tone: "blue", line: "改两份社媒稿" });
    expect(map.get("b")).toMatchObject({ status: "queued", pose: "idle", dim: true });
    expect(map.get("c")).toMatchObject({ status: "delivered", pose: "cheer", tone: "green" });
    expect(map.has("h")).toBe(false);
    const later = states([run([subtask("3", "c", "done", { finishedAt: NOW - 90 * MIN })])]);
    expect(later.get("c")).toMatchObject({ status: "done", pose: "idle", dim: false });
    expect(states([]).get("a")).toMatchObject({ status: "idle", dim: true });
  });

  it("puts the owner's inbox first: waiting, then stuck for an escalation", () => {
    const map = states([run([subtask("1", "a", "running")])], [
      inbox({ kind: "approval", botId: "a", title: "18:00 发帖" }),
      inbox({ kind: "escalation", botId: "b", title: "嘉宾名单", chain: [{ botId: "b", at: NOW - 17 * MIN }, { botId: "lead", at: NOW - 7 * MIN }] }),
    ]);
    expect(map.get("a")).toMatchObject({ status: "waiting", pose: "wave", tone: "amber", line: "Needs your OK" });
    expect(map.get("a")!.bubble).toMatchObject({ tone: "amber" });
    expect(map.get("b")).toMatchObject({ status: "stuck", pose: "scared", line: "Stuck 17 min" });
  });

  it("shows a failing subtask that will retry, and a blocked one with what it waits for", () => {
    const map = states([
      run([
        subtask("form", "a", "pending", { attempts: 1, error: "接口超时" }),
        subtask("copy", "lead", "running", { title: "三段卖点终稿" }),
        subtask("preview", "b", "pending", { dependsOn: ["copy"] }),
      ]),
    ]);
    expect(map.get("a")).toMatchObject({ status: "failed", pose: "scared", line: "Failed · retrying" });
    expect(map.get("a")!.bubble!.lines[1]).toBe("Retry 1/2");
    expect(map.get("b")).toMatchObject({ status: "blocked", tone: "grey", dim: false });
    expect(map.get("b")!.line).toContain("三段卖点");
  });

  it("leads the chief and marks people who joined since the owner last looked", () => {
    const map = states([run([subtask("1", "a", "running")])], [], 4);
    expect(map.get("chief")).toMatchObject({ status: "leading", pose: "point", line: "1 running · main bot" });
    expect(map.get("c")!.isNew).toBe(true);
    expect(map.get("a")!.isNew).toBe(false);
    expect(headcount(map.values())).toEqual({ working: 2, waiting: 0, trouble: 0, idle: 3 });
    // with nothing in flight the chief still leads, but it is not at work
    const quiet = states([]);
    expect(quiet.get("chief")).toMatchObject({ status: "leading", tone: "grey" });
    expect(headcount(quiet.values()).working).toBe(0);
  });

  it("derives department numbers from runs unless the brief has them", () => {
    const runs = [run([subtask("1", "a", "done", { finishedAt: NOW - MIN }), subtask("2", "b", "failed", { finishedAt: NOW })])];
    const map = states(runs);
    const stats = departmentStats([{ section: "内容部", botIds: ["lead", "a", "b"] }], runs, map);
    expect(stats.get("内容部")).toMatchObject({ done: 1, total: 2, health: "red", failed: 1 });
    const briefed = departmentStats([{ section: "内容部", botIds: ["lead", "a", "b"] }], runs, map, [
      { section: "内容部", color: "#65A30D", done: 3, total: 7, health: "yellow", status: "三段卖点 17:20 交" },
    ]);
    expect(briefed.get("内容部")).toMatchObject({ done: 3, total: 7, health: "yellow", status: "三段卖点 17:20 交" });
  });

  it("counts the fallback numbers the way the brief counts its own", () => {
    const dayStart = new Date(NOW).setHours(0, 0, 0, 0);
    // a run that settled yesterday is history; today's failed/blocked work stays in view
    const yesterday = run([subtask("old", "a", "done", { finishedAt: dayStart - MIN })], {
      id: "r-old",
      status: "done",
      createdAt: dayStart - 3 * 60 * MIN,
      updatedAt: dayStart - MIN,
    });
    const today = run(
      [
        subtask("done", "a", "done", { finishedAt: NOW - MIN }),
        subtask("failed", "b", "failed", { finishedAt: NOW }),
        subtask("skipped", "lead", "skipped"),
        subtask("canceled", "a", "canceled"),
        // a department's plan is a container: its team's subtasks are the work
        subtask("container", "lead", "running", { childRunId: "r-child" }),
      ],
      { id: "r-today", updatedAt: NOW },
    );
    const child = run([subtask("build", "a", "running")], { id: "r-child", parentRunId: "r-today", updatedAt: NOW });
    const runs = [yesterday, today, child];
    const map = states(runs);
    const stats = departmentStats([{ section: "内容部", botIds: ["lead", "a", "b"] }], runs, map, undefined, NOW);
    // yesterday isn't in today's picture, blocked and failed work counts, the
    // container isn't counted next to the team's own subtasks
    expect(stats.get("内容部")).toMatchObject({ done: 1, total: 4 });
  });
});

describe("floor plan", () => {
  it("packs rooms first-fit in order and puts the library column at the right of its row", () => {
    // the launch story at full width: three 3-person rooms + the isolated one, then 技术部 with a new squad
    const plan = layoutFloor(
      [
        { key: "市场部", groups: [3] },
        { key: "内容部", groups: [3] },
        { key: "设计部", groups: [3] },
        { key: "技术部", groups: [5, 4] },
        { key: "财务法务", groups: [3], isolated: true },
      ],
      1360,
    );
    const row = (key: string) => plan.rooms.find((room) => room.key === key)!.row;
    expect(["市场部", "内容部", "设计部", "财务法务"].map(row)).toEqual([0, 0, 0, 0]);
    expect(row("技术部")).toBe(1);
    expect(plan.side!.y).toBe(plan.rows[1]);
    expect(plan.side!.x + plan.side!.width).toBe(1360 - FLOOR.right);
    const tech = plan.rooms.find((room) => room.key === "技术部")!;
    expect(tech.groups.map((group) => group.boxed)).toEqual([false, true]);
    expect(tech.groups[1]!.cells).toHaveLength(4);
    for (const room of plan.rooms) expect(room.x + room.width).toBeLessThanOrEqual(1360 - FLOOR.right + 0.01);
  });

  it("wraps a room's squads onto a second line when the window is narrow", () => {
    const plan = layoutFloor([{ key: "技术部", groups: [5, 4, 4] }], 900, false);
    const tech = plan.rooms[0]!;
    expect(tech.height).toBeGreaterThan(FLOOR.roomHeight);
    expect(new Set(tech.groups.map((group) => group.y)).size).toBeGreaterThan(1);
    const figures = tech.groups.reduce((sum, group) => sum + group.cells.length, 0);
    expect(figures).toBe(13);
  });

  it("lets a long label spill only into the room short neighbours leave free", () => {
    const pitch = 114;
    const [first, middle, last] = labelRoom([140, 60, 150], pitch);
    // ends spill toward the room's padding, never past the neighbour's half
    expect(first).toBeGreaterThan(pitch - 4);
    expect(first! / 2 + 60 / 2).toBeLessThanOrEqual(pitch);
    expect(middle).toBe(pitch - 4);
    expect(last! / 2 + 60 / 2).toBeLessThanOrEqual(pitch);
    // two long neighbours each keep about their own cell, so they never touch
    const [a, b] = labelRoom([160, 160], pitch);
    expect(a! / 2 + b! / 2).toBeLessThan(pitch);
    expect(labelWidth("Market analyst 2", 12)).toBeGreaterThan(labelWidth("市场分析师", 12));
  });

  it("never reorders people: a new squad only adds cells after the existing ones", () => {
    const before = layoutFloor([{ key: "技术部", groups: [5] }], 1360, false).rooms[0]!;
    const after = layoutFloor([{ key: "技术部", groups: [5, 4] }], 1360, false).rooms[0]!;
    expect(after.x).toBe(before.x);
    expect(after.groups[0]!.cells).toHaveLength(5);
    // the lead's group stays first and left of the new squad
    expect(after.groups[0]!.cells[4]!.x).toBeLessThan(after.groups[1]!.x);
  });
});

describe("work tree slot map", () => {
  const tree = (members: Record<string, string[]>, decisions: string[] = []): TreeInput => ({
    departments: Object.entries(members).map(([dept, kids]) => ({ key: `dept:${dept}`, children: kids.map((key) => ({ key, squad: key.startsWith("squad") })) })),
    decisions,
  });

  it("puts departments in a column with their people beside them, top-aligned", () => {
    const layout = layoutTree(tree({ 市场部: ["m1"], 内容部: ["c1", "c2", "c3"] }, ["decision:3"]));
    expect(layout.nodes["dept:市场部"]!.x).toBe(TREE.dept.x);
    expect(layout.nodes.c1!.x).toBe(TREE.child.x);
    expect(layout.nodes["dept:内容部"]!.y).toBeGreaterThan(layout.nodes.m1!.y);
    expect(layout.nodes.c1!.y + layout.nodes.c1!.height / 2).toBeCloseTo(layout.nodes["dept:内容部"]!.y + TREE.dept.height / 2);
    expect(layout.nodes["decision:3"]!.y).toBeGreaterThan(layout.nodes.root!.y);
  });

  it("keeps every existing node where it was when people join", () => {
    const first = layoutTree(tree({ 市场部: ["m1"], 内容部: ["c1", "c2"], 技术部: ["t1", "t2", "t3", "t4"] }));
    const second = layoutTree(tree({ 市场部: ["m1"], 内容部: ["c1", "c2"], 技术部: ["t1", "t2", "t3", "t4", "squad:技术部:1"] }), first.slots);
    for (const key of ["root", "dept:市场部", "m1", "dept:内容部", "c1", "c2", "dept:技术部", "t1", "t2", "t3", "t4"]) {
      expect(second.nodes[key]).toEqual(first.nodes[key]);
    }
    expect(second.nodes["squad:技术部:1"]!.y).toBeGreaterThan(second.nodes.t4!.y);
  });

  it("moves a later department only down, as a block, when the one above needs room", () => {
    const first = layoutTree(tree({ 内容部: ["c1"], 设计部: ["d1", "d2"] }));
    const second = layoutTree(tree({ 内容部: ["c1", "c2", "c3", "c4"], 设计部: ["d1", "d2"] }), first.slots);
    const shift = second.nodes["dept:设计部"]!.y - first.nodes["dept:设计部"]!.y;
    expect(shift).toBeGreaterThan(0);
    expect(second.nodes.d1!.y - first.nodes.d1!.y).toBe(shift);
    expect(second.nodes.d2!.y - first.nodes.d2!.y).toBe(shift);
    expect(second.nodes.c1).toEqual(first.nodes.c1);
    // the root keeps its place
    expect(second.nodes.root).toEqual(first.nodes.root);
  });

  it("leaves a gap rather than pulling nodes up when someone leaves", () => {
    const first = layoutTree(tree({ 内容部: ["c1", "c2", "c3"], 设计部: ["d1"] }));
    const second = layoutTree(tree({ 内容部: ["c1", "c3"], 设计部: ["d1"] }), first.slots);
    expect(second.nodes.c3).toEqual(first.nodes.c3);
    expect(second.nodes.d1).toEqual(first.nodes.d1);
  });
});

describe("day timeline", () => {
  it("widens busy hours and keeps time monotonic", () => {
    const day = new Date(NOW);
    const at = (h: number, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
    const events = [at(9, 0), at(14, 0), at(16, 5), at(16, 10), at(16, 24), at(16, 26), at(16, 35), at(16, 40), at(16, 47), at(16, 51)];
    const scale = compressDay(events, NOW);
    expect(scale.zoomHour).toBe(16);
    const xs = [at(9, 0), at(12, 0), at(16, 0), at(16, 30), at(17, 0), at(18, 0)].map(scale.at);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    // the busy hour takes far more room than a quiet one
    expect(scale.at(at(17, 0)) - scale.at(at(16, 0))).toBeGreaterThan(3 * (scale.at(at(13, 0)) - scale.at(at(12, 0))));
    expect(scale.at(at(8, 0))).toBe(0);
  });

  it("alternates labels above and below and hides the ones that would collide", () => {
    const placed = placeLabels([
      { x: 0, width: 60 },
      { x: 30, width: 60 },
      { x: 50, width: 60 },
      { x: 200, width: 60 },
    ]);
    expect(placed.map((label) => label.row)).toEqual([0, 1, 0, 1]);
    expect(placed.map((label) => label.hidden)).toEqual([false, false, true, false]);
  });
});

describe("project header", () => {
  it("names the newest active run and finds the deadline in its goal", () => {
    expect(projectTitle([run([])])).toBe("新品发布会 · 全套材料，周五 19:30 上线");
    expect(projectTitle([run([], { status: "done" })])).toBeNull();
    const friday = parseDeadline("周五 19:30 上线", NOW)!;
    expect(new Date(friday).getDay()).toBe(5);
    expect(Math.round((friday - NOW) / (60 * MIN))).toBe(27);
    expect(new Date(parseDeadline("明天 18:00 前", NOW)!).getDate()).toBe(16);
    expect(parseDeadline("尽快", NOW)).toBeNull();
  });

  it("treats a department's own plan as part of its parent run", () => {
    const parent = run([subtask("1", "lead", "running", { childRunId: "child" }), subtask("2", "c", "pending")], { createdAt: NOW - 60 * MIN });
    const child = run([subtask("c1", "a", "running")], { id: "child", goal: "内容部自己的计划", parentRunId: "r1", parentSubtaskId: "1", createdAt: NOW - 5 * MIN });
    expect(activeRun([parent, child])?.id).toBe("r1");
    expect(projectTitle([child])).toBeNull();
    expect(parent.subtasks.filter(isLeafSubtask).map((item) => item.id)).toEqual(["2"]);
  });
});

describe("adding people mid-run", () => {
  const squad = (name: string, botIds: string[], extra: Partial<DispatchSquad> = {}): DispatchSquad => ({
    name,
    leadBotId: botIds[0]!,
    botIds,
    subtaskIds: [],
    addedAt: NOW - 20 * MIN,
    by: "owner",
    reviewAt: NOW + 10 * MIN,
    ...extra,
  });

  it("finds the squads still together on running work, by member", () => {
    const live = run([], { squads: [squad("组 B", ["x", "y"]), squad("组 C", ["z"], { endedAt: NOW })] });
    const finished = run([], { id: "r0", status: "done", squads: [squad("组 B", ["old"])] });
    const squads = activeSquads([live, finished]);
    expect([...squads.keys()].sort()).toEqual(["x", "y"]);
    expect(squads.get("y")?.squad.name).toBe("组 B");
  });

  it("follows the server's split when it marks what moves, else hands newcomers the last items", () => {
    const item = (status: "done" | "running" | "pending", id: string, moved?: boolean) => ({ id, status, moved });
    const marked = splitRemaining([item("done", "a", false), item("running", "b", false), item("pending", "c", false), item("pending", "d", true), item("pending", "e", true)], 1);
    expect(marked.keep.map((entry) => entry.id)).toEqual(["c"]);
    expect(marked.fresh.map((entry) => entry.id)).toEqual(["d", "e"]);
    expect(marked.done.map((entry) => entry.id)).toEqual(["a"]);
    const guessed = splitRemaining(["p1", "p2", "p3", "p4", "p5"].map((id) => ({ id, status: "pending" as const })), 1);
    expect(guessed.keep.map((entry) => entry.id)).toEqual(["p1", "p2", "p3"]);
    expect(guessed.fresh.map((entry) => entry.id)).toEqual(["p4", "p5"]);
    expect(splitRemaining([{ status: "pending" as const }], 4).fresh).toHaveLength(1);
  });
});

describe("routes", () => {
  const ROUTE_BOTS: WorkbenchBot[] = [
    { id: "chief", name: "总控", section: "市场部", chiefOfStaff: true },
    { id: "a", name: "文案", section: "市场部" },
    { id: "b", name: "设计", section: "市场部" },
    { id: "c", name: "运维", section: "技术部" },
  ];

  it("wires a Chief to its section by default and honours routes", () => {
    expect(buildWires(ROUTE_BOTS, [], [], EMPTY_TEAM_MAP_SNAPSHOT).map((wire) => wire.toBotId).sort()).toEqual(["a", "b"]);
    const routed = buildWires(
      ROUTE_BOTS,
      [
        { fromBotId: "chief", toBotId: "b", enabled: false, updatedAt: 1 },
        { fromBotId: "chief", toBotId: "c", enabled: true, updatedAt: 1 },
      ],
      [],
      EMPTY_TEAM_MAP_SNAPSHOT,
    );
    expect(routed.map((wire) => `${wire.toBotId}:${wire.kind}`).sort()).toEqual(["a:default", "c:explicit"]);
  });

  it("shows what is travelling along a route", () => {
    const [running] = buildWires(ROUTE_BOTS, [], [run([subtask("1", "a", "running", { title: "写文案", finishedAt: Date.now() })])], EMPTY_TEAM_MAP_SNAPSHOT).filter((wire) => wire.toBotId === "a");
    expect(running).toMatchObject({ state: "running", label: "写文案" });
    const [delegated] = buildWires(ROUTE_BOTS, [], [], { ...EMPTY_TEAM_MAP_SNAPSHOT, queued: [{ sourceBotId: "chief", targetBotId: "b", reason: "查资料" }] }).filter((wire) => wire.toBotId === "b");
    expect(delegated).toMatchObject({ state: "queued", label: "查资料" });
  });
});

describe("view math and undo", () => {
  it("zooms around the cursor and fits the content without zooming past 100%", () => {
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2)).toEqual({ zoom: 2, x: -100, y: -100 });
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 9).zoom).toBe(2);
    const layout = layoutTree({ departments: [{ key: "dept:a", children: [{ key: "x" }] }], decisions: [] });
    expect(fitView(layout, { width: 1200, height: 800 }).zoom).toBe(1);
    expect(fitView(layout, { width: 300, height: 200 }).zoom).toBeLessThan(1);
  });

  it("undoes and redoes in order", async () => {
    const log: string[] = [];
    const history = new EditHistory();
    history.push({ label: "plug", undo: () => void log.push("unplug"), redo: () => void log.push("plug") });
    expect(await history.undo()).toBe("plug");
    expect(await history.redo()).toBe("plug");
    expect(log).toEqual(["unplug", "plug"]);
    expect(history.canRedo).toBe(false);
  });
});
