// Workbench model: layout, wires and their live state, view math, undo.
import { describe, expect, it } from "vitest";

import type { DispatchRun } from "../../shared/dispatch-types";
import { EMPTY_TEAM_MAP_SNAPSHOT } from "./team-map";
import { EditHistory, buildWires, fitView, layoutWorkbench, plugOf, socketOf, wirePath, zoomAround, type WorkbenchBot } from "./workbench";

const BOTS: WorkbenchBot[] = [
  { id: "chief", name: "总控", section: "市场部", chiefOfStaff: true },
  { id: "a", name: "文案", section: "市场部" },
  { id: "b", name: "设计", section: "市场部" },
  { id: "c", name: "运维", section: "技术部" },
  { id: "h", name: "隐藏", section: "市场部", hidden: true },
];

const run = (status: DispatchRun["subtasks"][number]["status"]): DispatchRun => ({
  id: "r1",
  chiefBotId: "chief",
  sourceThreadId: "t",
  goal: "g",
  policy: "balanced",
  status: "running",
  createdAt: 0,
  updatedAt: 0,
  subtasks: [{ id: "s1", title: "写文案", brief: "b", role: "文案", needs: [], difficulty: 2, dependsOn: [], assigneeBotId: "a", status, attempts: 1, finishedAt: Date.now() }],
});

describe("workbench layout", () => {
  it("puts Chiefs above their members and gives each section a frame", () => {
    const layout = layoutWorkbench(BOTS);
    expect(Object.keys(layout.nodes).sort()).toEqual(["a", "b", "c", "chief"]);
    expect(layout.nodes.chief!.y).toBeLessThan(layout.nodes.a!.y);
    expect(layout.frames.map((frame) => frame.key)).toEqual(["市场部", "技术部"]);
    const [market, tech] = layout.frames;
    expect(tech!.x).toBeGreaterThan(market!.x + market!.width);
  });

  it("keeps a dragged position and grows the frame around it", () => {
    const layout = layoutWorkbench(BOTS, { a: { x: 900, y: 600 } });
    expect(layout.nodes.a).toMatchObject({ x: 900, y: 600 });
    const market = layout.frames[0]!;
    expect(market.x + market.width).toBeGreaterThan(900);
  });
});

describe("workbench wires", () => {
  it("wires a Chief to its section by default and honours routes", () => {
    expect(buildWires(BOTS, [], [], EMPTY_TEAM_MAP_SNAPSHOT).map((wire) => wire.toBotId).sort()).toEqual(["a", "b"]);
    const routed = buildWires(
      BOTS,
      [
        { fromBotId: "chief", toBotId: "b", enabled: false, updatedAt: 1 },
        { fromBotId: "chief", toBotId: "c", enabled: true, updatedAt: 1 },
      ],
      [],
      EMPTY_TEAM_MAP_SNAPSHOT,
    );
    expect(routed.map((wire) => `${wire.toBotId}:${wire.kind}`).sort()).toEqual(["a:default", "c:explicit"]);
  });

  it("shows what is travelling along a wire", () => {
    const [running] = buildWires(BOTS, [], [run("running")], EMPTY_TEAM_MAP_SNAPSHOT).filter((wire) => wire.toBotId === "a");
    expect(running).toMatchObject({ state: "running", label: "写文案" });
    const [done] = buildWires(BOTS, [], [run("done")], EMPTY_TEAM_MAP_SNAPSHOT).filter((wire) => wire.toBotId === "a");
    expect(done!.state).toBe("done");
    const [delegated] = buildWires(BOTS, [], [], { ...EMPTY_TEAM_MAP_SNAPSHOT, queued: [{ sourceBotId: "chief", targetBotId: "b", reason: "查资料" }] }).filter((wire) => wire.toBotId === "b");
    expect(delegated).toMatchObject({ state: "queued", label: "查资料" });
  });
});

describe("workbench geometry", () => {
  it("runs cables from a plug down to a socket", () => {
    const box = { x: 0, y: 0, width: 200, height: 80 };
    expect(plugOf(box)).toEqual({ x: 100, y: 80 });
    expect(socketOf({ ...box, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(wirePath({ x: 0, y: 0 }, { x: 0, y: 200 })).toMatch(/^M 0 0 C/);
  });

  it("zooms around the cursor and fits the content", () => {
    const next = zoomAround({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2);
    expect(next).toEqual({ zoom: 2, x: -100, y: -100 });
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 9).zoom).toBe(2);
    const view = fitView(layoutWorkbench(BOTS), { width: 1200, height: 800 });
    expect(view.zoom).toBeGreaterThan(0.3);
  });
});

describe("edit history", () => {
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
