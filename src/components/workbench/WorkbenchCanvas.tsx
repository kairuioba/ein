// 看事 (U2/U3): the work tree. 总控 → departments → people → outputs, left to
// right, with only the "assigned" lines always drawn. Everything else is a
// badge on a node (stuck ✋, approval 🔒, failure, disagreement ⚡, new) or
// belongs to a lens:
//   汇报  health dots + last report, the report rule, overdue reports, the
//         escalation path glowing along the tree
//   协作  discussion bands between departments (width = volume), work orders,
//         the meeting hull, "from decision #n" tags, blocked dependencies
//   数据  lines from the people using a library document to the data dock
//   依赖  every dependency between subtasks (red when blocked)
//   时间  today's timeline along the bottom
// Node rows come from a persistent slot map (layoutTree), so switching lens
// or adding people never moves the nodes already on screen.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Database, Lock, Maximize2, Minus, Plus, Users } from "lucide-react";

import { BotTile } from "@/components/mascot/Mascot";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import { squadName } from "@/lib/org";
import {
  TREE,
  ago,
  centreY,
  clip,
  clock,
  elbow,
  fitView,
  isActiveRun,
  layoutTree,
  loadSlots,
  saveSlots,
  zoomAround,
  type NodeBox,
  type PersonState,
  type TreeLayout,
} from "@/lib/workbench";
import type { DispatchRun, DispatchSubtask } from "../../../shared/dispatch-types";
import type { Health, OrgDecision } from "../../../shared/org-types";

import { DayTimeline, type TimelineMark } from "./DayTimeline";
import type { BotWithMeta, Room, SquadInfo, WorkbenchModel } from "./model";
import { Badge, DecisionMark, DiamondMark, HealthDot, NewTag, StatusGlyph, TicketMark, healthOfTone, useElementSize, type GlyphStatus } from "./parts";

export type Lens = "tree" | "report" | "collab" | "data" | "deps" | "time";
export const LENSES: ReadonlyArray<{ id: Lens; label: string; color: string }> = [
  { id: "tree", label: msg("Tree"), color: "var(--color-ink)" },
  { id: "report", label: msg("Reports"), color: "#3B5BFF" },
  { id: "collab", label: msg("Collaboration"), color: "#EC4899" },
  { id: "data", label: msg("Data"), color: "#14B8A6" },
  { id: "deps", label: msg("Dependencies"), color: "#E5484D" },
  { id: "time", label: msg("Time"), color: "#9AA0AC" },
];

export type TreeSelection =
  | { kind: "root" }
  | { kind: "dept"; section: string }
  | { kind: "bot"; id: string }
  | { kind: "squad"; section: string; index: number }
  | { kind: "decision"; id: number }
  | { kind: "order"; key: string }
  | { kind: "task"; key: string }
  | null;

// ── the tree's content ──────────────────────────────────────────────────────
export type TreeChild =
  | { kind: "bot"; key: string; bot: BotWithMeta; state?: PersonState }
  | { kind: "leadTask"; key: string; bot: BotWithMeta; title: string; status: GlyphStatus; subtask?: DispatchSubtask; run?: DispatchRun; decisionId?: number; progress?: string }
  | { kind: "squad"; key: string; section: string; index: number; members: BotWithMeta[]; info?: SquadInfo };

export interface TreeTask {
  key: string;
  parent: string;
  title: string;
  status: GlyphStatus;
  decisionId: number;
  botId?: string;
}

export interface TreeDept {
  key: string;
  room: Room;
  children: TreeChild[];
  tasks: TreeTask[];
}

export interface WorkOrder {
  key: string;
  fromBotId: string;
  toBotId: string;
  reason: string;
  state: "queued" | "running";
  threadId?: string;
}

const ITEM_GLYPH: Record<OrgDecision["actionItems"][number]["status"], GlyphStatus> = { pending: "queue", running: "run", done: "done", failed: "fail" };
const SUBTASK_GLYPH: Record<DispatchSubtask["status"], GlyphStatus> = { pending: "queue", running: "run", done: "done", failed: "fail", skipped: "queue", canceled: "queue" };

export function glyphOf(state: PersonState | undefined): GlyphStatus {
  switch (state?.status) {
    case "working":
    case "leading":
    case "overseeing":
    case "disagree":
      return "run";
    case "waiting":
    case "stuck":
      return "wait";
    case "failed":
      return "fail";
    case "delivered":
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    default:
      return "queue";
  }
}

/** A squad keeps its row by when it joined (a run squad) or its position. */
export function squadKey(room: Room, index: number): string {
  const info = room.squadInfo[index - 1];
  return info?.addedAt ? `squad:${room.key}:t${info.addedAt}` : `squad:${room.key}:${index}`;
}

export function buildTree(model: WorkbenchModel): { departments: TreeDept[]; decisions: OrgDecision[] } {
  const decisions = model.decisions.slice(0, 3);
  const items = model.decisions.flatMap((decision) => decision.actionItems.map((item, index) => ({ decision, item, index })));
  const departments = model.rooms.map((room): TreeDept => {
    const children: TreeChild[] = [];
    const tasks: TreeTask[] = [];
    const lead = room.lead;
    if (lead) {
      const own = model.dispatch.runs
        .filter(isActiveRun)
        .flatMap((run) => run.subtasks.filter((subtask) => subtask.assigneeBotId === lead.id && subtask.status !== "canceled" && subtask.status !== "skipped").map((subtask) => ({ run, subtask })))
        .slice(0, 3);
      for (const { run, subtask } of own) {
        const origin = items.find(({ item }) => item.subtaskId === subtask.id && (!item.runId || item.runId === run.id));
        // a task the lead handed to its own team shows the team's progress
        const child = subtask.childRunId ? model.dispatch.runs.find((entry) => entry.id === subtask.childRunId) : undefined;
        const progress = child ? `${child.subtasks.filter((entry) => entry.status === "done").length}/${child.subtasks.length}` : undefined;
        children.push({ kind: "leadTask", key: `task:${run.id}:${subtask.id}`, bot: lead, title: subtask.title, status: SUBTASK_GLYPH[subtask.status], subtask, run, decisionId: origin?.decision.id, progress });
      }
      for (const { decision, item, index } of items) {
        if (item.botId !== lead.id || (item.subtaskId && own.some(({ subtask }) => subtask.id === item.subtaskId))) continue;
        children.push({ kind: "leadTask", key: `derived:${decision.id}:${index}`, bot: lead, title: item.title, status: ITEM_GLYPH[item.status], decisionId: decision.id });
      }
    }
    const firstSquad = room.main.filter((bot) => bot.id !== lead?.id);
    for (const bot of firstSquad) children.push({ kind: "bot", key: `bot:${bot.id}`, bot, state: model.states.get(bot.id) });
    room.squads.forEach((members, index) => children.push({ kind: "squad", key: squadKey(room, index + 1), section: room.section, index: index + 1, members, info: room.squadInfo[index] }));
    // outputs owned by members hang off their node (or their squad's)
    for (const { decision, item, index } of items) {
      if (!item.botId || item.botId === lead?.id) continue;
      const owner = room.everyone.find((bot) => bot.id === item.botId);
      if (!owner) continue;
      const squadIndex = room.squads.findIndex((squad) => squad.some((bot) => bot.id === owner.id));
      const parent = squadIndex >= 0 ? squadKey(room, squadIndex + 1) : `bot:${owner.id}`;
      tasks.push({ key: `derived:${decision.id}:${index}`, parent, title: item.title, status: ITEM_GLYPH[item.status], decisionId: decision.id, botId: owner.id });
    }
    return { key: `dept:${room.key}`, room, children, tasks };
  });
  return { departments, decisions };
}

export function workOrders(model: WorkbenchModel): WorkOrder[] {
  const out = new Map<string, WorkOrder>();
  for (const [state, list] of [["queued", model.dispatch.snapshot.queued], ["running", model.dispatch.snapshot.running]] as const) {
    for (const entry of list) {
      const from = model.roomOf.get(entry.sourceBotId);
      const to = model.roomOf.get(entry.targetBotId);
      if (!from || !to || from === to) continue;
      const key = `${entry.sourceBotId}→${entry.targetBotId}`;
      out.set(key, {
        key,
        fromBotId: entry.sourceBotId,
        toBotId: entry.targetBotId,
        reason: "reason" in entry && entry.reason ? entry.reason : "",
        state,
        threadId: "threadId" in entry ? entry.threadId : undefined,
      });
    }
  }
  return [...out.values()];
}

// ── the canvas ──────────────────────────────────────────────────────────────
interface View {
  x: number;
  y: number;
  zoom: number;
}

export function WorkbenchCanvas({
  model,
  lens,
  marks,
  selection,
  onSelect,
  onOpenChat,
  onNudge,
  onContextMenu,
  resetToken,
  fitToken,
}: {
  model: WorkbenchModel;
  lens: Lens;
  marks: TimelineMark[];
  selection: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
  onOpenChat: (botId: string) => void;
  onNudge: (botId: string) => void;
  onContextMenu: (target: { kind: "bot"; id: string } | { kind: "dept"; section: string } | { kind: "canvas" }, x: number, y: number) => void;
  /** bump to forget remembered rows and lay the tree out afresh */
  resetToken: number;
  /** bump to fit the tree into the window */
  fitToken: number;
}) {
  const tree = useMemo(() => buildTree(model), [model]);
  const slots = useRef<Record<string, number> | null>(null);
  const lastReset = useRef(resetToken);
  if (slots.current === null) slots.current = loadSlots();
  if (lastReset.current !== resetToken) {
    lastReset.current = resetToken;
    slots.current = {};
  }
  const layout = useMemo(
    () =>
      layoutTree(
        {
          departments: tree.departments.map((dept) => ({
            key: dept.key,
            children: dept.children.map((child) => ({ key: child.key, squad: child.kind === "squad" })),
            tasks: dept.tasks.map((task) => ({ key: task.key, parent: task.parent })),
          })),
          decisions: tree.decisions.map((decision) => `decision:${decision.id}`),
        },
        slots.current ?? {},
      ),
    // the slot map is read, not a dependency: it only ever follows the layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, resetToken],
  );
  useEffect(() => {
    slots.current = layout.slots;
    saveSlots(layout.slots);
  }, [layout]);

  const [hostRef, size] = useElementSize<HTMLDivElement>();
  const [view, setView] = useState<View>({ x: 16, y: 8, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitted = useRef(false);
  const fit = useCallback(() => {
    if (!size.width) return;
    const extra = lens === "time" ? 130 : 56;
    const fitted = fitView(layout, { width: size.width, height: Math.max(200, size.height - extra) }, 16);
    // never shrink the tree past readable; a tall team scrolls instead
    setView(fitted.zoom < 0.85 ? { zoom: 0.85, x: 16 - TREE.root.x * 0.85, y: 8 } : fitted);
  }, [layout, size.width, size.height, lens]);
  useEffect(() => {
    if (fitted.current || !size.width || !Object.keys(layout.nodes).length) return;
    fitted.current = true;
    fit();
  }, [fit, size.width, layout.nodes]);
  const lastFit = useRef(`${fitToken}:${resetToken}`);
  useEffect(() => {
    const token = `${fitToken}:${resetToken}`;
    if (token === lastFit.current) return;
    lastFit.current = token;
    fit();
  }, [fitToken, resetToken, fit]);

  // two-finger scroll pans, pinch or ⌘-scroll zooms around the pointer
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.004));
        setView(zoomAround(current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, current.zoom * factor));
      } else {
        setView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [hostRef]);
  const pan = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  const nodes = layout.nodes;
  const nodeOfBot = useCallback(
    (botId: string): NodeBox | undefined => {
      if (botId === model.chief?.id) return nodes.root;
      const room = model.roomOf.get(botId);
      if (!room) return undefined;
      if (room.lead?.id === botId) return nodes[`dept:${room.key}`];
      const squad = room.squads.findIndex((members) => members.some((bot) => bot.id === botId));
      return squad >= 0 ? nodes[squadKey(room, squad + 1)] : nodes[`bot:${botId}`];
    },
    [model.chief?.id, model.roomOf, nodes],
  );

  const orders = useMemo(() => workOrders(model), [model]);
  const zoomBy = (factor: number) => setView((current) => zoomAround(current, { x: size.width / 2, y: size.height / 2 }, current.zoom * factor));
  const selectedKey =
    selection?.kind === "dept" ? `dept:${selection.section}` :
    selection?.kind === "bot" ? `bot:${selection.id}` :
    selection?.kind === "squad" ? (() => { const room = model.rooms.find((candidate) => candidate.section === selection.section); return room ? squadKey(room, selection.index) : null; })() :
    selection?.kind === "decision" ? `decision:${selection.id}` :
    selection?.kind === "root" ? "root" :
    selection?.kind === "task" ? selection.key : null;

  return (
    <div
      ref={hostRef}
      className="wb-grid relative min-h-0 min-w-0 flex-1 cursor-default overflow-hidden bg-inset/60 outline-none select-none"
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.zoom}px ${22 * view.zoom}px` }}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        pan.current = { x: event.clientX, y: event.clientY, view, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = pan.current;
        if (!current) return;
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) current.moved = true;
        setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
      }}
      onPointerUp={(event) => {
        const current = pan.current;
        pan.current = null;
        if (current && !current.moved && event.target === event.currentTarget) onSelect(null);
      }}
      onDoubleClick={(event) => event.target === event.currentTarget && fit()}
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onContextMenu({ kind: "canvas" }, event.clientX, event.clientY);
      }}
    >
      <div className="pointer-events-none absolute top-0 left-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}>
        <IsolatedZones tree={tree} layout={layout} />
        {lens === "collab" && <MeetingHull model={model} nodeOfBot={nodeOfBot} layout={layout} />}
        <TreeLines tree={tree} layout={layout} />
        {lens === "report" && <EscalationPaths model={model} layout={layout} nodeOfBot={nodeOfBot} />}
        {lens === "collab" && <CollabLayer model={model} layout={layout} orders={orders} />}
        {lens === "deps" && <DependencyLayer model={model} nodeOfBot={nodeOfBot} layout={layout} all />}
        {lens === "collab" && <DependencyLayer model={model} nodeOfBot={nodeOfBot} layout={layout} all={false} />}
        {lens === "data" && <DataLayer model={model} layout={layout} nodeOfBot={nodeOfBot} />}

        <RootNode model={model} box={nodes.root!} lens={lens} selected={selectedKey === "root"} onSelect={() => onSelect({ kind: "root" })} onOpen={() => model.chief && onOpenChat(model.chief.id)} />
        {tree.decisions.map((decision) => {
          const box = nodes[`decision:${decision.id}`];
          return box ? (
            <DecisionNode key={decision.id} decision={decision} model={model} box={box} selected={selectedKey === `decision:${decision.id}`} onSelect={() => onSelect({ kind: "decision", id: decision.id })} />
          ) : null;
        })}
        {tree.departments.map((dept) => (
          <DeptBranch
            key={dept.key}
            dept={dept}
            model={model}
            layout={layout}
            lens={lens}
            selectedKey={selectedKey}
            onSelect={onSelect}
            onOpenChat={onOpenChat}
            onNudge={onNudge}
            onContextMenu={onContextMenu}
          />
        ))}
        {lens === "collab" && <OrderPills model={model} layout={layout} orders={orders} selectedKey={selection?.kind === "order" ? `order:${selection.key}` : null} onSelect={onSelect} />}
      </div>

      {lens !== "tree" && lens !== "time" && <LensLegend lens={lens} />}
      {lens === "time" && (
        <div className="absolute inset-x-3 bottom-3 z-10">
          <DayTimeline marks={marks} now={model.now} compact />
        </div>
      )}

      <div className={cn("absolute right-3 z-10 flex items-center overflow-hidden rounded-lg bg-raised/95 text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.06)]", lens === "time" ? "bottom-[150px]" : "bottom-3")}>
        <button type="button" onClick={() => zoomBy(1 / 1.2)} className="flex size-7 items-center justify-center hover:bg-control hover:text-ink" title={t("Zoom out (⌘−)")} aria-label={t("Zoom out")}>
          <Minus size={13} />
        </button>
        <button type="button" onClick={() => setView((current) => ({ ...current, zoom: 1 }))} className="h-7 min-w-[48px] px-1.5 text-[11px] tabular-nums hover:bg-control hover:text-ink" title={t("Actual size")}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} className="flex size-7 items-center justify-center hover:bg-control hover:text-ink" title={t("Zoom in (⌘+)")} aria-label={t("Zoom in")}>
          <Plus size={13} />
        </button>
        <button type="button" onClick={fit} className="flex size-7 items-center justify-center hover:bg-control hover:text-ink" title={t("Fit to window (⌘0)")} aria-label={t("Fit to window")}>
          <Maximize2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ── lines (L1: only "assigned") ─────────────────────────────────────────────
function TreeLines({ tree, layout }: { tree: ReturnType<typeof buildTree>; layout: TreeLayout }) {
  const root = layout.nodes.root!;
  const paths: Array<{ d: string; strong: boolean }> = [];
  for (const dept of tree.departments) {
    const node = layout.nodes[dept.key];
    if (!node) continue;
    if (!dept.room.unassigned) paths.push({ d: elbow(root.x + root.width, centreY(root), TREE.bus1, centreY(node), node.x), strong: true });
    for (const child of dept.children) {
      const box = layout.nodes[child.key];
      if (box) paths.push({ d: elbow(node.x + node.width, centreY(node), TREE.bus2, centreY(box), box.x), strong: false });
    }
    for (const task of dept.tasks) {
      const parent = layout.nodes[task.parent];
      const box = layout.nodes[task.key];
      if (parent && box) paths.push({ d: elbow(parent.x + parent.width, centreY(parent), parent.x + parent.width + 11, centreY(box), box.x, 6), strong: false });
    }
  }
  for (const decision of tree.decisions) {
    const box = layout.nodes[`decision:${decision.id}`];
    if (box) paths.push({ d: `M${root.x + 80} ${root.y + root.height}V${box.y}`, strong: true });
  }
  return (
    <svg className="absolute top-0 left-0 overflow-visible" width="1" height="1" fill="none" strokeLinecap="round" aria-hidden>
      {paths.map((path, index) => (
        <path key={index} d={path.d} strokeWidth={path.strong ? 1.8 : 1.5} className={path.strong ? "stroke-ink-secondary/40" : "stroke-ink-secondary/30"} />
      ))}
    </svg>
  );
}

function IsolatedZones({ tree, layout }: { tree: ReturnType<typeof buildTree>; layout: TreeLayout }) {
  return (
    <>
      {tree.departments
        .filter((dept) => dept.room.isolated && layout.bands[dept.key])
        .map((dept) => {
          const band = layout.bands[dept.key]!;
          const top = band.top - 18;
          const height = band.bottom - band.top + 24;
          return (
            <div key={dept.key}>
              <div
                className="absolute rounded-2xl border-[1.5px] border-dashed border-ink-secondary/35"
                style={{
                  left: TREE.dept.x - 6,
                  top,
                  width: TREE.task.x + TREE.task.width + 6 - (TREE.dept.x - 6),
                  height,
                  background: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-ink-secondary) 7.5%, transparent) 0 5px, transparent 5px 11px), var(--color-inset)",
                }}
              />
              <div className="absolute flex flex-col gap-0.5 whitespace-nowrap" style={{ left: TREE.task.x + 4, top: top + Math.min(30, height / 2 - 26) }}>
                <b className="flex items-center gap-[5px] text-[12.5px] text-ink">
                  <Lock size={13} className="text-ink-secondary" />
                  {t("Isolated · {name}", { name: dept.room.label })}
                </b>
                <span className="pl-[18px] text-[11.5px] text-ink-secondary">{t("Other departments can only ask")}</span>
                <span className="pl-[18px] text-[11.5px] text-ink-secondary">{t("and get redacted answers")}</span>
              </div>
            </div>
          );
        })}
    </>
  );
}

// ── nodes ───────────────────────────────────────────────────────────────────
const nodeShadow = "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_60%,transparent),0_1px_2px_rgb(16_24_40/0.05)]";

function RootNode({ model, box, lens, selected, onSelect, onOpen }: { model: WorkbenchModel; box: NodeBox; lens: Lens; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const chief = model.chief;
  const total = [...model.stats.values()].reduce((sum, stats) => sum + stats.total, 0);
  const done = [...model.stats.values()].reduce((sum, stats) => sum + stats.done, 0);
  const healths = model.rooms.filter((room) => !room.unassigned).map((room) => model.stats.get(room.section)?.health ?? null);
  const escalated = model.needsYou.some((item) => item.kind === "escalation");
  const last = Math.max(0, ...model.dispatch.runs.map((run) => run.updatedAt));
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "pointer-events-auto absolute flex flex-col justify-center gap-1.5 rounded-2xl bg-[#14161C] px-3.5 text-left text-white shadow-[0_18px_36px_-18px_rgb(16_24_40/0.55)] ring-1 ring-white/10",
        selected && "ring-2 ring-select",
        lens === "report" && escalated && "shadow-[0_0_0_3px_rgb(245_158_11/0.45),0_18px_36px_-18px_rgb(16_24_40/0.55)]",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span className="flex items-center gap-2">
        {chief && <BotTile kind={model.mascotOf(chief)} size={24} chief />}
        <b className="truncate text-[15px]">{chief?.name ?? t("Chief")}</b>
        <span className="ml-auto flex gap-[3px]">
          {healths.slice(0, 6).map((health, index) => (
            <HealthDot key={index} health={health} size={8} />
          ))}
        </span>
      </span>
      <span className="flex items-center text-[11.5px] whitespace-nowrap text-white/65">
        {total ? t("{done}/{total} done", { done, total }) : t("{count} departments", { count: model.rooms.filter((room) => !room.unassigned).length })}
        {lens === "report" && last > 0 && (
          <span className="ml-1.5 inline-flex h-[17px] items-center gap-[3px] rounded-[5px] bg-white/14 px-[5px] text-[10.5px] font-bold text-white">{ago(last, model.now)}</span>
        )}
      </span>
    </button>
  );
}

function DecisionNode({ decision, model, box, selected, onSelect }: { decision: OrgDecision; model: WorkbenchModel; box: NodeBox; selected: boolean; onSelect: () => void }) {
  const source = decision.source.kind === "group" ? model.groups.find((group) => group.id === decision.source.id)?.name : model.botById.get(decision.source.id)?.name;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("pointer-events-auto absolute flex items-center gap-2 rounded-xl bg-raised px-2.5 text-left shadow-[inset_0_0_0_1.5px_var(--color-ink)]", selected && "ring-2 ring-select ring-offset-2 ring-offset-inset")}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <DecisionMark size={22} />
      <span className="flex min-w-0 flex-col leading-[1.3]">
        <b className="truncate text-[12.5px] text-ink">{t("Decision #{id}: {choice}", { id: decision.id, choice: clip(decision.choice || decision.title, 9) })}</b>
        <span className="truncate text-[11px] text-ink-secondary">
          {[source, decidedByLabel(decision.decidedBy)].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

export function decidedByLabel(level: OrgDecision["decidedBy"]): string {
  return level === "owner" ? t("you decided") : level === "chief" ? t("the chief decided") : level === "lead" ? t("the lead decided") : t("decided at work");
}

function DeptBranch({
  dept,
  model,
  layout,
  lens,
  selectedKey,
  onSelect,
  onOpenChat,
  onNudge,
  onContextMenu,
}: {
  dept: TreeDept;
  model: WorkbenchModel;
  layout: TreeLayout;
  lens: Lens;
  selectedKey: string | null;
  onSelect: (selection: TreeSelection) => void;
  onOpenChat: (botId: string) => void;
  onNudge: (botId: string) => void;
  onContextMenu: (target: { kind: "bot"; id: string } | { kind: "dept"; section: string }, x: number, y: number) => void;
}) {
  const box = layout.nodes[dept.key];
  if (!box) return null;
  const { room } = dept;
  const stats = model.stats.get(room.section);
  const cadence = model.org.rules.reportCadence;
  const complete = Boolean(stats && stats.total > 0 && stats.done === stats.total);
  const people = room.everyone.length;
  const sub = room.lead
    ? [room.lead.name, people > 3 ? t("{count} people", { count: people }) : null, stats?.total ? `${stats.done}/${stats.total}` : null].filter(Boolean).join(" · ")
    : t("{count} people", { count: people });
  const escalatedHere = lens === "report" && model.needsYou.some((item) => item.kind === "escalation" && item.chain?.some((step) => step.botId === room.lead?.id));
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect({ kind: "dept", section: room.section })}
        onDoubleClick={() => room.lead && onOpenChat(room.lead.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu({ kind: "dept", section: room.section }, event.clientX, event.clientY);
        }}
        className={cn(
          "pointer-events-auto absolute flex items-center gap-2 overflow-hidden rounded-[14px] bg-raised pr-2.5 pl-2 text-left",
          escalatedHere ? "shadow-[inset_0_0_0_1.5px_#F2C27A,0_6px_18px_-10px_rgb(16_24_40/0.25)]" : "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_60%,transparent),0_6px_18px_-10px_rgb(16_24_40/0.25)]",
          selectedKey === dept.key && "ring-2 ring-select",
        )}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      >
        <i className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-[3px]" style={{ background: room.color }} />
        {room.lead ? <BotTile kind={model.mascotOf(room.lead)} size={24} /> : <i className="ml-1 size-[10px] rounded-[3px]" style={{ background: room.color }} />}
        <span className="flex min-w-0 flex-col leading-[1.3]">
          <b className="flex items-center text-[14px] whitespace-nowrap text-ink">
            {room.unassigned ? t("No department") : room.label}
            {complete && <span className="ml-1.5 inline-flex h-[17px] items-center rounded-[5px] bg-success/12 px-[5px] text-[10.5px] font-bold text-success">{t("Delivered")}</span>}
          </b>
          <span className="truncate text-[11.5px] whitespace-nowrap text-ink-secondary">{sub}</span>
        </span>
        <span className="mr-0.5 ml-auto flex shrink-0 items-center gap-1">
          {lens === "report" && stats && (
            <>
              <HealthDot health={stats.health} />
              {stats.lastReportAt ? <Badge kind="clock">{ago(stats.lastReportAt, model.now)}</Badge> : <Badge kind="clock">{t("Not yet")}</Badge>}
            </>
          )}
          {lens !== "report" && stats?.waiting ? <DiamondMark size={10} /> : null}
        </span>
      </button>
      {lens === "report" && !room.unassigned && (
        <span
          className="absolute inline-flex h-5 items-center gap-1 rounded-[6px] bg-raised/95 px-[7px] text-[10.5px] whitespace-nowrap text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]"
          style={{ left: box.x + 10, top: box.y + box.height + 6 }}
        >
          {cadenceLabel(cadence)}
        </span>
      )}
      {dept.children.map((child) => {
        const childBox = layout.nodes[child.key];
        if (!childBox) return null;
        if (child.kind === "squad") {
          return (
            <SquadNode
              key={child.key}
              child={child}
              box={childBox}
              model={model}
              lens={lens}
              selected={selectedKey === child.key}
              onSelect={() => onSelect({ kind: "squad", section: child.section, index: child.index })}
            />
          );
        }
        if (child.kind === "leadTask") {
          return (
            <TaskNodeBox
              key={child.key}
              box={childBox}
              title={child.title}
              owner={child.progress ? `${child.progress} · ${child.bot.name}` : child.bot.name}
              status={child.status}
              decisionId={lens === "collab" ? child.decisionId : undefined}
              lens={lens}
              model={model}
              subtask={child.subtask}
              selected={selectedKey === child.key}
              onSelect={() => onSelect({ kind: "task", key: child.key })}
              onOpen={() => onOpenChat(child.bot.id)}
            />
          );
        }
        return (
          <BotNode
            key={child.key}
            child={child}
            box={childBox}
            model={model}
            lens={lens}
            selected={selectedKey === child.key}
            onSelect={() => onSelect({ kind: "bot", id: child.bot.id })}
            onOpen={() => onOpenChat(child.bot.id)}
            onNudge={() => onNudge(child.bot.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect({ kind: "bot", id: child.bot.id });
              onContextMenu({ kind: "bot", id: child.bot.id }, event.clientX, event.clientY);
            }}
          />
        );
      })}
      {dept.tasks.map((task) => {
        const taskBox = layout.nodes[task.key];
        return taskBox ? (
          <TaskNodeBox
            key={task.key}
            box={taskBox}
            title={task.title}
            status={task.status}
            decisionId={lens === "collab" ? task.decisionId : undefined}
            lens={lens}
            model={model}
            selected={selectedKey === task.key}
            onSelect={() => onSelect({ kind: "task", key: task.key })}
            onOpen={() => task.botId && onOpenChat(task.botId)}
          />
        ) : null;
      })}
    </>
  );
}

export function cadenceLabel(cadence: WorkbenchModel["org"]["rules"]["reportCadence"]): string {
  const parts = [t("Every {count} h", { count: cadence.everyHours })];
  if (cadence.onDone) parts.push(t("when done"));
  if (cadence.onIncident) parts.push(t("at once on trouble"));
  return parts.join(" · ");
}

/** Running work quiet for longer than the report cadence. */
export function overdueMinutes(state: PersonState | undefined, model: WorkbenchModel): number | null {
  const started = state?.subtask?.startedAt;
  if (state?.status !== "working" || !started) return null;
  const limit = model.org.rules.reportCadence.everyHours * 60;
  const minutes = Math.floor((model.now - started) / 60_000) - limit;
  return minutes > 0 ? minutes : null;
}

const STATUS_RING: Partial<Record<GlyphStatus, string>> = {
  wait: "bg-[color-mix(in_srgb,#F59E0B_7%,var(--color-raised))] shadow-[inset_0_0_0_1.5px_#F2C27A]",
  fail: "bg-[color-mix(in_srgb,var(--color-danger)_5%,var(--color-raised))] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-danger)_40%,transparent)]",
  run: "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-select)_35%,transparent),0_0_0_3px_color-mix(in_srgb,var(--color-select)_10%,transparent)]",
};

function BotNode({
  child,
  box,
  model,
  lens,
  selected,
  onSelect,
  onOpen,
  onNudge,
  onContextMenu,
}: {
  child: Extract<TreeChild, { kind: "bot" }>;
  box: NodeBox;
  model: WorkbenchModel;
  lens: Lens;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onNudge: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { bot, state } = child;
  const glyph = glyphOf(state);
  const overdue = lens === "report" ? overdueMinutes(state, model) : null;
  const working = state?.subtask && (state.status === "working" || state.status === "blocked" || state.status === "queued") ? state.subtask.title : undefined;
  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onOpen}
        onContextMenu={onContextMenu}
        className={cn(
          "pointer-events-auto absolute flex items-center gap-[7px] rounded-[10px] bg-raised pr-2 pl-[9px] text-left text-[12.5px] whitespace-nowrap",
          STATUS_RING[glyph] ?? nodeShadow,
          (glyph === "done" || glyph === "queue") && "text-ink-secondary",
          overdue !== null && "opacity-55 grayscale",
          selected && "ring-2 ring-select",
        )}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        title={t("{name} · {status} — double-click to open the chat", { name: bot.name, status: state?.line ?? "" })}
      >
        <StatusGlyph status={glyph} />
        <span className="flex min-w-0 items-baseline">
          <span className={cn("max-w-[8.5em] shrink-0 truncate", glyph !== "done" && glyph !== "queue" && "text-ink")}>{bot.name}</span>
          {working && <span className="ml-[5px] min-w-0 truncate text-[11px] text-ink-secondary/80">{working}</span>}
        </span>
        {/* badges that do not fit wrap onto a hidden line: the last ones drop first */}
        <span className="ml-auto flex h-5 min-w-5 flex-wrap content-start items-center justify-end gap-x-[5px] overflow-hidden [&>*]:shrink-0">
          <NodeBadges state={state} model={model} lens={lens} />
        </span>
      </button>
      {overdue !== null && (
        <div className="pointer-events-auto absolute flex items-center gap-1.5" style={{ left: TREE.task.x - 8, top: box.y + box.height / 2 - 13 }}>
          <Badge kind="fail" className="bg-danger/10">{t("Report overdue {count} min", { count: overdue })}</Badge>
          <Button size="sm" className="h-[26px]" onClick={onNudge}>
            {t("Nudge")}
          </Button>
        </div>
      )}
    </>
  );
}

function NodeBadges({ state, model, lens }: { state?: PersonState; model: WorkbenchModel; lens: Lens }) {
  if (!state) return null;
  const always: ReactNode[] = [];
  if (state.status === "stuck") always.push(<Badge key="hand" kind="hand">{t("Stuck {count}m", { count: Math.max(1, Math.round((model.now - (state.since ?? model.now)) / 60_000)) })}</Badge>);
  if (state.status === "waiting" && state.inbox?.kind === "approval") always.push(<Badge key="lock" kind="lock" title={t("Needs your approval")}>{t("Manual")}</Badge>);
  if (state.status === "waiting" && state.inbox?.kind !== "approval") always.push(<span key="pick" className="inline-flex h-5 items-center gap-[3px] rounded-[6px] bg-warning/12 px-1.5 text-[11px] font-bold text-warning"><DiamondMark size={9} />{state.line}</span>);
  if (state.status === "failed") always.push(<Badge key="fail" kind="fail">{state.bubble?.lines[1] && /\d\/\d/.test(state.bubble.lines[1]) ? state.bubble.lines[1] : t("Failed")}</Badge>);
  if (state.status === "disagree") always.push(<Badge key="bolt" kind="bolt">{clip(state.line, 8)}</Badge>);
  if (state.isNew) always.push(<NewTag key="new" />);
  if (lens !== "report") return <>{always}</>;
  // the report lens leads with what it is about — a call for help, then health
  // and the last report — before the other badges
  const last = state.subtask?.finishedAt ?? state.subtask?.startedAt;
  const [first, ...rest] = state.status === "stuck" ? always : [null, ...always];
  return (
    <>
      {first}
      <HealthDot key="h" health={healthOfTone(state.tone, state.status) as Health | null} />
      <Badge key="c" kind="clock">{last ? ago(last, model.now) : t("Not started")}</Badge>
      {rest}
    </>
  );
}

function SquadNode({ child, box, model, lens, selected, onSelect }: { child: Extract<TreeChild, { kind: "squad" }>; box: NodeBox; model: WorkbenchModel; lens: Lens; selected: boolean; onSelect: () => void }) {
  const states = child.members.map((bot) => model.states.get(bot.id));
  const fresh = states.some((state) => state?.isNew);
  const ids = new Set(child.members.map((bot) => bot.id));
  const subtasks = model.dispatch.runs.filter(isActiveRun).flatMap((run) => run.subtasks.filter((subtask) => ids.has(subtask.assigneeBotId)));
  const done = subtasks.filter((subtask) => subtask.status === "done").length;
  const glyph: GlyphStatus = states.some((state) => state?.status === "failed") ? "fail" : states.some((state) => state?.status === "working") ? "run" : subtasks.length && done === subtasks.length ? "done" : "queue";
  const worst: Health | null = states.some((state) => state?.tone === "red") ? "red" : states.some((state) => state?.tone === "amber") ? "yellow" : subtasks.length ? "green" : null;
  const last = Math.max(0, ...subtasks.map((subtask) => subtask.finishedAt ?? subtask.startedAt ?? 0));
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "pointer-events-auto absolute flex flex-col justify-center gap-1 rounded-[11px] bg-raised px-[9px] text-left",
        fresh
          ? "bg-[color-mix(in_srgb,#8B5CF6_4%,var(--color-raised))] shadow-[inset_0_0_0_1.5px_rgb(139_92_246/0.45),0_0_0_4px_rgb(139_92_246/0.1)]"
          : glyph === "run"
            ? STATUS_RING.run
            : nodeShadow,
        selected && "ring-2 ring-select",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span className="flex items-center gap-1.5 leading-[1.2] whitespace-nowrap">
        <StatusGlyph status={glyph} />
        <b className="text-[13px] text-ink">{child.info?.name ?? squadName(child.index)}</b>
        {fresh && <NewTag />}
        <span className="text-[11.5px] text-ink-secondary">{t("{count} people", { count: child.members.length })}</span>
        <span className="ml-auto flex">
          {child.members.slice(0, 4).map((bot, index) => (
            <span key={bot.id} style={{ marginLeft: index ? -2 : 0 }}>
              <BotTile kind={model.mascotOf(bot)} size={14} />
            </span>
          ))}
        </span>
      </span>
      <span className="flex items-center gap-1.5 pl-[19px] text-[11.5px] leading-[1.2] whitespace-nowrap text-ink-secondary">
        <span>{subtasks.length ? t("{done}/{total} done", { done, total: subtasks.length }) : t("Not started")}</span>
        <span className="ml-auto flex items-center gap-[5px]">
          {lens === "report" && (
            <>
              <HealthDot health={worst} />
              <Badge kind="clock">{last ? ago(last, model.now) : t("Not started")}</Badge>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function TaskNodeBox({
  box,
  title,
  owner,
  status,
  decisionId,
  lens,
  model,
  subtask,
  selected,
  onSelect,
  onOpen,
}: {
  box: NodeBox;
  title: string;
  owner?: string;
  status: GlyphStatus;
  decisionId?: number;
  lens: Lens;
  model: WorkbenchModel;
  subtask?: DispatchSubtask;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const last = subtask?.finishedAt ?? subtask?.startedAt;
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "pointer-events-auto absolute flex items-center gap-[7px] rounded-[10px] bg-raised pr-2 pl-[9px] text-left text-[12.5px] whitespace-nowrap",
        STATUS_RING[status] ?? nodeShadow,
        (status === "done" || status === "queue") && "text-ink-secondary",
        selected && "ring-2 ring-select",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <StatusGlyph status={status} />
      <span className="flex min-w-0 items-baseline">
        <span className={cn("truncate", status !== "done" && status !== "queue" && "text-ink")}>{title}</span>
        {owner && <span className="ml-[5px] shrink-0 text-[11px] text-ink-secondary/80">{owner}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-[5px]">
        {decisionId !== undefined && <span className="inline-flex h-[18px] items-center rounded-[5px] bg-control/80 px-[5px] text-[10.5px] text-ink-secondary">{t("From decision #{id}", { id: decisionId })}</span>}
        {lens === "report" && subtask && (
          <>
            <HealthDot health={status === "fail" ? "red" : status === "wait" ? "yellow" : "green"} />
            <Badge kind="clock">{last ? ago(last, model.now) : t("Not started")}</Badge>
          </>
        )}
      </span>
    </button>
  );
}

// ── lens: reports — the escalation path glows along the existing tree ──────
function EscalationPaths({ model, layout, nodeOfBot }: { model: WorkbenchModel; layout: TreeLayout; nodeOfBot: (botId: string) => NodeBox | undefined }) {
  const root = layout.nodes.root!;
  const items = model.needsYou.filter((item) => item.kind === "escalation");
  if (!items.length) return null;
  const paths: string[] = [];
  for (const item of items) {
    const origin = item.chain?.[0]?.botId ?? item.botId;
    const box = nodeOfBot(origin);
    const room = model.roomOf.get(origin);
    const dept = room ? layout.nodes[`dept:${room.key}`] : undefined;
    if (box && dept && box !== dept) paths.push(elbow(box.x, centreY(box), TREE.bus2, centreY(dept), dept.x + dept.width));
    if (dept) paths.push(elbow(dept.x, centreY(dept), TREE.bus1, centreY(root), root.x + root.width));
  }
  const first = items[0]!;
  const chain = first.chain ?? [];
  const steps = chain.slice(1).map((step) => t("{time} to {name}", { time: clock(step.at), name: model.botById.get(step.botId)?.name ?? "?" }));
  const boxTop = root.y - 64 >= 0 ? root.y - 60 : root.y + root.height + 10 + model.decisions.slice(0, 3).length * (TREE.decision.height + TREE.decision.gap);
  return (
    <>
      <svg className="absolute top-0 left-0 overflow-visible" width="1" height="1" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <defs>
          <marker id="wb-esc-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M1 1L9 5L1 9z" fill="#D97706" />
          </marker>
        </defs>
        {paths.map((d, index) => (
          <path key={`g${index}`} d={d} stroke="#F59E0B" strokeWidth="11" opacity=".22" />
        ))}
        {paths.map((d, index) => (
          <path key={`l${index}`} d={d} stroke="#D97706" strokeWidth="2.2" markerEnd="url(#wb-esc-arrow)" />
        ))}
      </svg>
      <div
        className="absolute flex flex-col gap-0.5 rounded-[10px] px-[9px] py-1.5 shadow-[inset_0_0_0_1px_rgb(246_212_154)]"
        style={{ left: root.x, top: boxTop, width: Math.max(root.width, 168), background: "color-mix(in srgb, #F59E0B 8%, var(--color-raised))" }}
      >
        <b className="flex items-center gap-1 text-[12px] whitespace-nowrap text-warning">✋ {t("Sent up to the chief · waiting on you")}</b>
        {steps.length > 0 && <span className="truncate text-[10.5px] text-warning/85">{steps.join(" → ")}</span>}
      </div>
    </>
  );
}

// ── lens: collaboration ─────────────────────────────────────────────────────
function MeetingHull({ model, nodeOfBot, layout }: { model: WorkbenchModel; nodeOfBot: (botId: string) => NodeBox | undefined; layout: TreeLayout }) {
  const meeting = meetingOfNote(model);
  if (!meeting) return null;
  const boxes = meeting.group.memberIds.map(nodeOfBot).filter((box): box is NodeBox => Boolean(box));
  const unique = [...new Set(boxes)];
  if (unique.length < 2) return null;
  const pad = 9;
  const root = layout.nodes.root!;
  const ys = unique.map(centreY);
  const spine = `M${TREE.bus1} ${Math.min(...ys)}V${Math.max(...ys)}`;
  return (
    <>
      <svg className="absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden>
        <g opacity=".11" fill="#EC4899">
          {unique.map((box, index) => (
            <rect key={index} x={box.x - pad} y={box.y - pad} width={box.width + pad * 2} height={box.height + pad * 2} rx="20" />
          ))}
          <path d={spine} fill="none" stroke="#EC4899" strokeWidth="26" strokeLinecap="round" />
        </g>
      </svg>
      <div
        className="absolute flex items-center gap-[7px] rounded-[10px] px-[9px] py-[5px] text-[#BE185D] shadow-[inset_0_0_0_1px_rgb(247_198_223)]"
        style={{ left: root.x, top: Math.max(0, root.y - 56), width: 150, background: "color-mix(in srgb, #EC4899 6%, var(--color-raised))" }}
      >
        <Users size={13} />
        <span className="flex min-w-0 flex-col leading-[1.3] whitespace-nowrap">
          <b className="truncate text-[12px]">{meeting.group.name}</b>
          <em className="text-[10.5px] text-[#9D3A6B] not-italic">
            {meeting.group.busyBotId ? t("In session · {count} people", { count: meeting.group.memberIds.length }) : t("Ended {time} · {count} people", { time: clock(meeting.last), count: meeting.group.memberIds.length })}
          </em>
        </span>
      </div>
    </>
  );
}

/** The meeting to outline: the room behind the newest decision, else the
 * busiest group chat today. */
export function meetingOfNote(model: WorkbenchModel) {
  const groupDecision = model.decisions.find((decision) => decision.source.kind === "group");
  const today = new Date(model.now).toDateString();
  const candidates = model.groups
    .filter((group) => !group.dm)
    .map((group) => ({ group, last: group.messages[group.messages.length - 1]?.at ?? 0, count: group.messages.filter((message) => new Date(message.at).toDateString() === today).length }));
  const chosen = (groupDecision && candidates.find((candidate) => candidate.group.id === groupDecision.source.id)) ?? candidates.filter((candidate) => candidate.count > 0).sort((a, b) => b.count - a.count)[0];
  return chosen && chosen.last ? chosen : undefined;
}

/** The middle of the gap between department bands that lies between `a` and
 * `b` and is nearest their midpoint, so a label never sits on a node. `pick`
 * chooses another gap when two labels would share one. */
function gapNear(layout: TreeLayout, a: number, b: number, pick = 0): number {
  const [low, high] = a < b ? [a, b] : [b, a];
  const bands = Object.values(layout.bands).sort((x, y) => x.top - y.top);
  const gaps: number[] = [];
  for (let i = 0; i < bands.length - 1; i += 1) {
    const centre = (bands[i]!.bottom + bands[i + 1]!.top) / 2;
    if (centre > low && centre < high) gaps.push(centre);
  }
  if (!gaps.length) return (a + b) / 2;
  const mid = (a + b) / 2;
  const sorted = [...gaps].sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid));
  return sorted[Math.min(pick, sorted.length - 1)]!;
}

function CollabLayer({ model, layout, orders }: { model: WorkbenchModel; layout: TreeLayout; orders: WorkOrder[] }) {
  // discussions between departments: bot⇄bot channels bundled per pair of rooms
  const bundles = new Map<string, { a: Room; b: Room; volume: number }>();
  for (const pair of model.dispatch.snapshot.collaborations) {
    const a = model.roomOf.get(pair.botIds[0]);
    const b = model.roomOf.get(pair.botIds[1]);
    if (!a || !b || a === b) continue;
    const [first, second] = model.rooms.indexOf(a) < model.rooms.indexOf(b) ? [a, b] : [b, a];
    const key = `${first.key}|${second.key}`;
    const channel = model.groups.find((group) => group.id === pair.groupId);
    const volume = channel ? Math.max(1, channel.messages.filter((message) => message.role === "bot").length) : 1;
    const entry = bundles.get(key) ?? { a: first, b: second, volume: 0 };
    entry.volume += volume;
    bundles.set(key, entry);
  }
  const xb = TREE.bus1 + 7;
  const tkx = TREE.dept.x + TREE.dept.width - 16;
  return (
    <>
      <svg className="absolute top-0 left-0 overflow-visible" width="1" height="1" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <defs>
          <marker id="wb-order-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1 1L9 5L1 9z" fill="#3B5BFF" />
          </marker>
        </defs>
        {[...bundles.values()].map(({ a, b, volume }) => {
          const top = layout.nodes[`dept:${a.key}`];
          const bottom = layout.nodes[`dept:${b.key}`];
          if (!top || !bottom) return null;
          return (
            <path
              key={`${a.key}|${b.key}`}
              d={elbow(TREE.dept.x, centreY(top) + 6, xb, centreY(bottom) - 6, TREE.dept.x, 6)}
              stroke="#EC4899"
              strokeWidth={Math.min(8, 2.2 + volume * 0.45)}
              opacity={volume > 4 ? 0.55 : 0.7}
            />
          );
        })}
        {orders.map((order) => {
          const from = model.roomOf.get(order.fromBotId);
          const to = model.roomOf.get(order.toBotId);
          const source = from && layout.nodes[`dept:${from.key}`];
          const target = to && layout.nodes[`dept:${to.key}`];
          if (!source || !target) return null;
          const down = target.y > source.y;
          return (
            <path
              key={order.key}
              d={`M${tkx} ${down ? source.y + source.height + 2 : source.y - 2}V${down ? target.y - 4 : target.y + target.height + 4}`}
              stroke="#3B5BFF"
              strokeWidth="1.8"
              strokeDasharray="5 4"
              markerEnd="url(#wb-order-arrow)"
            />
          );
        })}
      </svg>
      {[...bundles.values()].map(({ a, b, volume }) => {
        const top = layout.nodes[`dept:${a.key}`];
        const bottom = layout.nodes[`dept:${b.key}`];
        if (!top || !bottom) return null;
        const y = gapNear(layout, centreY(top), centreY(bottom)) - 11;
        return (
          <span
            key={`l${a.key}|${b.key}`}
            className="absolute inline-flex h-[22px] items-center gap-1 rounded-[6px] bg-[color-mix(in_srgb,#EC4899_9%,var(--color-raised))] px-[7px] text-[11px] font-bold whitespace-nowrap text-[#BE185D] shadow-[inset_0_0_0_1px_rgb(249_196_222)]"
            style={{ left: TREE.dept.x + 4, top: y }}
          >
            ↰ {t("{a} ↔ {b} · {count} messages", { a: a.label || t("No department"), b: b.label || t("No department"), count: volume })}
          </span>
        );
      })}
    </>
  );
}

/** Work orders are pinned to the department that received them (drawn above
 * the nodes), so they never land on another department's node. */
function OrderPills({ model, layout, orders, selectedKey, onSelect }: { model: WorkbenchModel; layout: TreeLayout; orders: WorkOrder[]; selectedKey: string | null; onSelect: (selection: TreeSelection) => void }) {
  const perTarget = new Map<string, number>();
  return (
    <>
      {orders.map((order) => {
        const to = model.roomOf.get(order.toBotId);
        const target = to && layout.nodes[`dept:${to.key}`];
        if (!to || !target) return null;
        const index = perTarget.get(to.key) ?? 0;
        perTarget.set(to.key, index + 1);
        const from = model.roomOf.get(order.fromBotId);
        return (
          <button
            key={`m${order.key}`}
            type="button"
            onClick={() => onSelect({ kind: "order", key: order.key })}
            title={order.reason}
            className={cn(
              "pointer-events-auto absolute z-[2] flex h-6 items-center gap-1 rounded-[8px] bg-raised px-2 whitespace-nowrap text-accent-text shadow-[inset_0_0_0_1.5px_var(--color-select),0_0_0_3px_color-mix(in_srgb,var(--color-select)_12%,transparent)]",
              selectedKey === `order:${order.key}` && "bg-select/10",
            )}
            style={{ left: target.x + target.width - 104, top: target.y + target.height - 12 + index * 28, maxWidth: 170 }}
          >
            <TicketMark size={13} />
            <b className="text-[11.5px]">{t("Work order")}</b>
            {from && <span className="truncate text-[11px] text-ink-secondary">{t("from {department}", { department: from.label || t("No department") })}</span>}
          </button>
        );
      })}
    </>
  );
}

// ── lens: dependencies (and the blocked ones in 协作) ────────────────────────
function DependencyLayer({ model, nodeOfBot, layout, all }: { model: WorkbenchModel; nodeOfBot: (botId: string) => NodeBox | undefined; layout: TreeLayout; all: boolean }) {
  const edges: Array<{ from: NodeBox; to: NodeBox; blocked: boolean; label: string; key: string }> = [];
  // a lead's own task has its own node; everyone else's work sits on their node
  const nodeOf = (run: DispatchRun, subtask: DispatchSubtask) => layout.nodes[`task:${run.id}:${subtask.id}`] ?? nodeOfBot(subtask.assigneeBotId);
  for (const run of model.dispatch.runs.filter(isActiveRun)) {
    const byId = new Map(run.subtasks.map((subtask) => [subtask.id, subtask]));
    for (const subtask of run.subtasks) {
      for (const id of subtask.dependsOn) {
        const dependency = byId.get(id);
        if (!dependency) continue;
        const blocked = subtask.status === "pending" && dependency.status !== "done";
        if (!all && !blocked) continue;
        const from = nodeOf(run, dependency);
        const to = nodeOf(run, subtask);
        if (!from || !to || from === to) continue;
        edges.push({ from, to, blocked, key: `${run.id}:${id}>${subtask.id}`, label: t("{title} waits for “{dependency}”", { title: clip(subtask.title, 6), dependency: clip(dependency.title, 8) }) });
      }
    }
  }
  if (!edges.length) return null;
  return (
    <>
      <svg className="absolute top-0 left-0 overflow-visible" width="1" height="1" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <defs>
          <marker id="wb-dep-red" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M1 1L9 5L1 9z" fill="#E5484D" />
          </marker>
          <marker id="wb-dep-grey" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M1 1L9 5L1 9z" fill="#9AA0AC" />
          </marker>
        </defs>
        {edges.map((edge, index) => {
          const x1 = edge.from.x + edge.from.width;
          const x2 = edge.to.x + edge.to.width;
          const xd = Math.max(x1, x2) + 14 + (index % 3) * 6;
          const y1 = centreY(edge.from);
          const y2 = centreY(edge.to);
          const s = y2 > y1 ? 1 : -1;
          const d = `M${x1} ${y1}H${xd - 6}Q${xd} ${y1} ${xd} ${y1 + s * 6}V${y2 - s * 6}Q${xd} ${y2} ${xd - 6} ${y2}H${x2 + 2}`;
          return (
            <path
              key={edge.key}
              d={d}
              stroke={edge.blocked ? "#E5484D" : "#9AA0AC"}
              strokeWidth="1.8"
              strokeDasharray="4 3"
              markerEnd={edge.blocked ? "url(#wb-dep-red)" : "url(#wb-dep-grey)"}
            />
          );
        })}
      </svg>
      {edges
        .filter((edge) => edge.blocked)
        .map((edge) => (
          <div key={`b${edge.key}`} className="absolute flex items-center gap-1.5 text-[11.5px] font-semibold whitespace-nowrap text-danger" style={{ left: Math.max(edge.from.x + edge.from.width, edge.to.x + edge.to.width) + 26, top: (centreY(edge.from) + centreY(edge.to)) / 2 - 10 }}>
            <span className="inline-flex h-5 items-center rounded-[6px] bg-[#E5484D] px-1.5 text-[11px] font-bold text-white">{t("Blocked")}</span>
            {edge.label}
          </div>
        ))}
    </>
  );
}

// ── lens: data — radial lines to the dock, never pairwise ──────────────────
function DataLayer({ model, layout, nodeOfBot }: { model: WorkbenchModel; layout: TreeLayout; nodeOfBot: (botId: string) => NodeBox | undefined }) {
  const ys = Object.values(layout.nodes).map((box) => box.y + box.height);
  const dock = { x: TREE.task.x + TREE.task.width + 70, y: Math.max(40, (Math.max(...ys) - 120) / 2), width: 200, height: 0 };
  const docs = [...model.library].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  dock.height = 44 + Math.max(1, docs.length) * 26;
  const users = new Map<string, { box: NodeBox; stale: boolean }>();
  for (const doc of model.library) {
    const latest = Math.max(0, ...doc.versions.map((version) => version.version));
    for (const use of doc.inUse) {
      const box = nodeOfBot(use.botId);
      if (!box) continue;
      const key = `${box.x}:${box.y}`;
      const stale = use.version < latest;
      users.set(key, { box, stale: stale || users.get(key)?.stale === true });
    }
  }
  const target = { x: dock.x, y: dock.y + dock.height / 2 };
  return (
    <>
      <svg className="absolute top-0 left-0 overflow-visible" width="1" height="1" fill="none" aria-hidden>
        {[...users.values()].map(({ box, stale }, index) => {
          const x1 = box.x + box.width;
          const y1 = centreY(box);
          const mx = (x1 + target.x) / 2;
          return <path key={index} d={`M${x1} ${y1}C${mx} ${y1} ${mx} ${target.y} ${target.x} ${target.y}`} stroke={stale ? "#D97706" : "#14B8A6"} strokeWidth="1.6" strokeDasharray={stale ? "4 3" : undefined} opacity=".75" />;
        })}
      </svg>
      <div className="absolute rounded-[14px] bg-raised px-3 py-2 shadow-[inset_0_0_0_1.5px_rgb(20_184_166/0.45),0_6px_18px_-10px_rgb(16_24_40/0.25)]" style={{ left: dock.x, top: dock.y, width: dock.width, minHeight: dock.height }}>
        <b className="flex items-center gap-1.5 text-[12.5px] text-ink">
          <Database size={13} className="text-[#0F766E]" />
          {t("Library")}
        </b>
        {docs.length === 0 ? (
          <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">{t("No shared documents yet.")}</div>
        ) : (
          docs.map((doc) => {
            const latest = Math.max(0, ...doc.versions.map((version) => version.version));
            const stale = doc.inUse.filter((use) => use.version < latest).length;
            return (
              <div key={doc.id} className="mt-1 flex h-[22px] items-center gap-1.5 text-[12px] whitespace-nowrap">
                <span className="truncate text-ink">{doc.title}</span>
                {latest > 0 && <span className="font-mono text-[10.5px] font-bold text-ink-secondary">v{latest}</span>}
                {stale > 0 && <span className="ml-auto text-[11px] font-semibold text-warning">{t("{count} on an old version", { count: stale })}</span>}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ── legends ─────────────────────────────────────────────────────────────────
function LensLegend({ lens }: { lens: Lens }) {
  const item = (key: string, glyph: ReactNode, label: string) => (
    <span key={key} className="inline-flex items-center gap-1.5">
      {glyph}
      {label}
    </span>
  );
  let title = "";
  let items: ReactNode[] = [];
  if (lens === "report") {
    title = t("Report lens");
    items = [
      item("h", <span className="flex gap-[3px]"><HealthDot health="green" /><HealthDot health="yellow" /><HealthDot health="red" /></span>, t("Report health")),
      item("c", <Badge kind="clock">{t("18 min ago")}</Badge>, t("Last report")),
      item("s", <Badge kind="hand" />, t("Stuck, asking for help")),
      item("g", <i className="inline-block h-3.5 w-[22px] rounded-[4px] bg-control shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_60%,transparent)]" />, t("Greyed = report overdue")),
      item("e", <svg width="26" height="10" aria-hidden><path d="M2 5H24" stroke="#F59E0B" strokeWidth="8" opacity=".25" strokeLinecap="round" /><path d="M2 5H24" stroke="#D97706" strokeWidth="2" /></svg>, t("Escalation path")),
    ];
  } else if (lens === "collab") {
    title = t("Collaboration lens");
    items = [
      item("d", <svg width="30" height="12" aria-hidden><path d="M2 4H28" stroke="#EC4899" strokeWidth="5" opacity=".55" strokeLinecap="round" /><path d="M2 10H28" stroke="#EC4899" strokeWidth="1.6" opacity=".7" strokeLinecap="round" /></svg>, t("Discussion · thicker = more")),
      item("o", <svg width="26" height="10" aria-hidden><path d="M2 5H20" stroke="#3B5BFF" strokeWidth="1.6" strokeDasharray="4 3" /><path d="M19 1.5L24 5L19 8.5z" fill="#3B5BFF" /></svg>, t("Work order")),
      item("k", <DecisionMark size={12} />, t("Decision")),
      item("t", <span className="inline-flex h-[18px] items-center rounded-[5px] bg-control/80 px-[5px] text-[10.5px]">{t("From decision #{id}", { id: 3 })}</span>, t("Derived task")),
      item("b", <svg width="26" height="10" aria-hidden><path d="M2 5H24" stroke="#E5484D" strokeWidth="1.6" strokeDasharray="4 3" /></svg>, t("Blocked dependency")),
      item("m", <i className="inline-block h-3.5 w-[22px] rounded-[7px] bg-[#EC4899]/15" />, t("Meeting")),
    ];
  } else if (lens === "data") {
    title = t("Data lens");
    items = [
      item("u", <svg width="26" height="10" aria-hidden><path d="M2 5H24" stroke="#14B8A6" strokeWidth="1.6" /></svg>, t("Uses the current version")),
      item("s", <svg width="26" height="10" aria-hidden><path d="M2 5H24" stroke="#D97706" strokeWidth="1.6" strokeDasharray="4 3" /></svg>, t("Still on an old version")),
    ];
  } else if (lens === "deps") {
    title = t("Dependency lens");
    items = [
      item("w", <svg width="26" height="10" aria-hidden><path d="M2 5H24" stroke="#9AA0AC" strokeWidth="1.6" strokeDasharray="4 3" /></svg>, t("Waits for")),
      item("b", <svg width="26" height="10" aria-hidden><path d="M2 5H24" stroke="#E5484D" strokeWidth="1.6" strokeDasharray="4 3" /></svg>, t("Blocked now")),
    ];
  }
  return (
    <div className="absolute bottom-3 left-3 z-10 flex min-h-9 max-w-[calc(100%-170px)] flex-wrap items-center gap-x-4 gap-y-1 rounded-[11px] bg-raised/95 px-3.5 py-1.5 text-[11.5px] whitespace-nowrap text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.06)]">
      <b className="text-ink">{title}</b>
      {items}
    </div>
  );
}
