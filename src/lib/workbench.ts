// Workbench (汇总工作台) model: where nodes sit on the canvas, which wires
// exist between a Chief's plug and its members' sockets, and what each wire
// is doing right now. Pure functions so the canvas stays a thin renderer.
import type { DispatchRoute, DispatchRun } from "../../shared/dispatch-types";
import type { TeamMapSnapshot } from "./team-map";

export interface WorkbenchBot {
  id: string;
  name: string;
  section?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
}

export interface Point {
  x: number;
  y: number;
}

export interface NodeBox extends Point {
  width: number;
  height: number;
}

export const NODE = { width: 216, height: 84, chiefWidth: 236, chiefHeight: 92, gapX: 36, gapY: 96, sectionGap: 120, perRow: 4 } as const;

export interface SectionFrame {
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkbenchLayout {
  nodes: Record<string, NodeBox>;
  frames: SectionFrame[];
}

/** Lay each section out as a column group: Chiefs on top, members in rows
 * below. Saved positions (from dragging) win over the computed spot, and the
 * section frame grows to cover wherever its nodes ended up. */
export function layoutWorkbench(
  bots: readonly WorkbenchBot[],
  saved: Readonly<Record<string, Point>> = {},
  sectionLabel: (key: string) => string = (key) => key || "General",
): WorkbenchLayout {
  const visible = bots.filter((bot) => !bot.hidden);
  const order: string[] = [];
  const groups = new Map<string, WorkbenchBot[]>();
  for (const bot of visible) {
    const key = bot.section?.trim() || "";
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(bot);
  }
  const nodes: Record<string, NodeBox> = {};
  const frames: SectionFrame[] = [];
  let cursorX = 0;
  for (const key of order) {
    const members = groups.get(key)!;
    const chiefs = members.filter((bot) => bot.chiefOfStaff);
    const workers = members.filter((bot) => !bot.chiefOfStaff);
    const columns = Math.max(1, Math.min(NODE.perRow, workers.length || 1));
    const innerWidth = Math.max(columns * NODE.width + (columns - 1) * NODE.gapX, chiefs.length * (NODE.chiefWidth + NODE.gapX) - NODE.gapX, NODE.chiefWidth);
    const padding = 28;
    const top = 56;
    const chiefRowWidth = chiefs.length * NODE.chiefWidth + Math.max(0, chiefs.length - 1) * NODE.gapX;
    chiefs.forEach((bot, index) => {
      nodes[bot.id] = {
        x: cursorX + padding + (innerWidth - chiefRowWidth) / 2 + index * (NODE.chiefWidth + NODE.gapX),
        y: top,
        width: NODE.chiefWidth,
        height: NODE.chiefHeight,
      };
    });
    const workersTop = top + (chiefs.length ? NODE.chiefHeight + NODE.gapY : 0);
    workers.forEach((bot, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const inRow = Math.min(columns, workers.length - row * columns);
      const rowWidth = inRow * NODE.width + (inRow - 1) * NODE.gapX;
      nodes[bot.id] = {
        x: cursorX + padding + (innerWidth - rowWidth) / 2 + column * (NODE.width + NODE.gapX),
        y: workersTop + row * (NODE.height + 44),
        width: NODE.width,
        height: NODE.height,
      };
    });
    for (const bot of members) {
      const position = saved[bot.id];
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        nodes[bot.id] = { ...nodes[bot.id]!, x: position.x, y: position.y };
      }
    }
    const boxes = members.map((bot) => nodes[bot.id]!);
    const minX = Math.min(...boxes.map((box) => box.x)) - padding;
    const minY = Math.min(...boxes.map((box) => box.y)) - 44;
    const maxX = Math.max(...boxes.map((box) => box.x + box.width)) + padding;
    const maxY = Math.max(...boxes.map((box) => box.y + box.height)) + padding;
    frames.push({ key, name: sectionLabel(key), x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    cursorX = Math.max(cursorX + innerWidth + padding * 2, maxX) + NODE.sectionGap;
  }
  return { nodes, frames };
}

export type WireState = "running" | "queued" | "done" | "failed" | "idle";
export type WireKind = "default" | "explicit";

export interface Wire {
  fromBotId: string;
  toBotId: string;
  kind: WireKind;
  state: WireState;
  /** Short label for what is moving along the wire right now. */
  label?: string;
}

/** Every live wire: a Chief's default same-section members unless unplugged,
 * plus explicit routes. Each wire carries the state of the latest work that
 * travelled along it (dispatch subtasks and upstream delegations). */
export function buildWires(
  bots: readonly WorkbenchBot[],
  routes: readonly DispatchRoute[],
  runs: readonly DispatchRun[],
  snapshot: TeamMapSnapshot,
): Wire[] {
  const visible = new Map(bots.filter((bot) => !bot.hidden).map((bot) => [bot.id, bot]));
  const wires = new Map<string, Wire>();
  const key = (from: string, to: string) => `${from}→${to}`;
  const explicit = new Map(routes.map((route) => [key(route.fromBotId, route.toBotId), route]));
  for (const chief of visible.values()) {
    if (!chief.chiefOfStaff) continue;
    const section = chief.section?.trim() || "";
    for (const member of visible.values()) {
      if (member.id === chief.id || member.chiefOfStaff) continue;
      if ((member.section?.trim() || "") !== section) continue;
      const route = explicit.get(key(chief.id, member.id));
      if (route && !route.enabled) continue;
      wires.set(key(chief.id, member.id), { fromBotId: chief.id, toBotId: member.id, kind: route ? "explicit" : "default", state: "idle" });
    }
  }
  for (const route of routes) {
    if (!route.enabled || !visible.has(route.fromBotId) || !visible.has(route.toBotId)) continue;
    wires.set(key(route.fromBotId, route.toBotId), { fromBotId: route.fromBotId, toBotId: route.toBotId, kind: "explicit", state: "idle" });
  }
  // newest runs first: the first state written to a wire wins
  const stamped = new Set<string>();
  for (const run of runs) {
    for (const subtask of run.subtasks) {
      const id = key(run.chiefBotId, subtask.assigneeBotId);
      const wire = wires.get(id);
      if (!wire || stamped.has(id)) continue;
      const state: WireState | null =
        subtask.status === "running" ? "running" :
        subtask.status === "pending" && (run.status === "running" || run.status === "awaiting-approval") ? "queued" :
        subtask.status === "done" && Date.now() - (subtask.finishedAt ?? 0) < 120_000 ? "done" :
        subtask.status === "failed" && Date.now() - (subtask.finishedAt ?? 0) < 600_000 ? "failed" :
        null;
      if (!state) continue;
      wire.state = state;
      wire.label = subtask.title;
      stamped.add(id);
    }
  }
  for (const delegation of snapshot.running) {
    const wire = wires.get(key(delegation.sourceBotId, delegation.targetBotId));
    if (wire && wire.state === "idle") wire.state = "running";
  }
  for (const delegation of snapshot.queued) {
    const wire = wires.get(key(delegation.sourceBotId, delegation.targetBotId));
    if (wire && wire.state === "idle") {
      wire.state = "queued";
      wire.label = delegation.reason;
    }
  }
  return [...wires.values()];
}

/** The plug (bottom centre) and socket (top centre) of a node. */
export function plugOf(box: NodeBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height };
}

export function socketOf(box: NodeBox): Point {
  return { x: box.x + box.width / 2, y: box.y };
}

/** A cable-like cubic curve from a plug down to a socket. */
export function wirePath(from: Point, to: Point): string {
  const sag = Math.max(48, Math.abs(to.y - from.y) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + sag}, ${to.x} ${to.y - sag}, ${to.x} ${to.y}`;
}

/** Zoom around a fixed screen point: the canvas point under the cursor stays put. */
export function zoomAround(view: { x: number; y: number; zoom: number }, screen: Point, nextZoom: number) {
  const zoom = Math.min(2, Math.max(0.3, nextZoom));
  const worldX = (screen.x - view.x) / view.zoom;
  const worldY = (screen.y - view.y) / view.zoom;
  return { zoom, x: screen.x - worldX * zoom, y: screen.y - worldY * zoom };
}

/** The view that fits every node inside the viewport, with a margin. */
export function fitView(layout: WorkbenchLayout, viewport: { width: number; height: number }) {
  const boxes = [...Object.values(layout.nodes), ...layout.frames];
  if (!boxes.length || viewport.width <= 0 || viewport.height <= 0) return { x: 40, y: 40, zoom: 1 };
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const margin = 48;
  const zoom = Math.min(1.1, Math.max(0.3, Math.min((viewport.width - margin * 2) / (maxX - minX), (viewport.height - margin * 2) / (maxY - minY))));
  return {
    zoom,
    x: (viewport.width - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: (viewport.height - (maxY - minY) * zoom) / 2 - minY * zoom,
  };
}

const POSITIONS_KEY = "omb.workbench.positions";

export function loadPositions(): Record<string, Point> {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as Record<string, Point>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function savePositions(positions: Record<string, Point>): void {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // positions are a convenience; layout falls back to the computed spots
  }
}

/** Undo/redo for workbench edits (wire plugs and node moves). */
export interface WorkbenchEdit {
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

export class EditHistory {
  private past: WorkbenchEdit[] = [];
  private future: WorkbenchEdit[] = [];

  push(edit: WorkbenchEdit): void {
    this.past.push(edit);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }

  async undo(): Promise<string | null> {
    const edit = this.past.pop();
    if (!edit) return null;
    await edit.undo();
    this.future.push(edit);
    return edit.label;
  }

  async redo(): Promise<string | null> {
    const edit = this.future.pop();
    if (!edit) return null;
    await edit.redo();
    this.past.push(edit);
    return edit.label;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

/** Progress of a run as done / total settled subtasks. */
export function runProgress(run: DispatchRun): { done: number; failed: number; total: number } {
  return {
    done: run.subtasks.filter((subtask) => subtask.status === "done").length,
    failed: run.subtasks.filter((subtask) => subtask.status === "failed" || subtask.status === "skipped").length,
    total: run.subtasks.length,
  };
}
