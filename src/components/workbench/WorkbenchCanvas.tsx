// The workbench canvas: section frames, bot nodes, and the cables between a
// Chief's plug (派发) and its members' sockets (接收).
//
// Mac habits: two-finger scroll pans, pinch (or ⌘-scroll) zooms around the
// pointer, dragging empty space pans, dragging a card moves it, dragging from
// a plug pulls a cable you drop on any socket, ⌫ unplugs the selected cable,
// double-click opens a conversation, and right-click everywhere has a menu.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Crown, Maximize2, Minus, Plus } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import { teamMapStatus } from "@/lib/team-map";
import { plugOf, socketOf, wirePath, zoomAround, type NodeBox, type Point, type Wire, type WorkbenchLayout } from "@/lib/workbench";
import type { Bot } from "@/state/store";

export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

export type CanvasSelection = { kind: "bot"; id: string } | { kind: "wire"; from: string; to: string } | null;

export type CanvasTarget = { kind: "bot"; id: string } | { kind: "wire"; wire: Wire } | { kind: "canvas"; world: Point };

interface Props {
  bots: Bot[];
  layout: WorkbenchLayout;
  wires: Wire[];
  view: CanvasView;
  onView: (view: CanvasView) => void;
  onFit: () => void;
  selection: CanvasSelection;
  onSelect: (selection: CanvasSelection) => void;
  modelLabel: (bot: Bot) => string;
  onConnect: (fromBotId: string, toBotId: string) => void;
  onMove: (botId: string, point: Point, commit: boolean) => void;
  onOpenChat: (botId: string) => void;
  onContextMenu: (target: CanvasTarget, x: number, y: number) => void;
}

type Gesture =
  | { mode: "pan"; startX: number; startY: number; view: CanvasView; moved: boolean }
  | { mode: "move"; botId: string; startX: number; startY: number; origin: Point; moved: boolean }
  | { mode: "wire"; fromBotId: string };

const statusDot = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  idle: "bg-ink-secondary/40",
} as const;

const WIRE_CLASS: Record<Wire["state"], string> = {
  idle: "",
  running: "stroke-accent wb-wire-running",
  queued: "stroke-warning wb-wire-queued",
  done: "stroke-success",
  failed: "stroke-danger",
};

const cubicMid = (from: Point, to: Point): Point => {
  const sag = Math.max(48, Math.abs(to.y - from.y) * 0.5);
  const c1 = { x: from.x, y: from.y + sag };
  const c2 = { x: to.x, y: to.y - sag };
  return { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 };
};

export function WorkbenchCanvas(props: Props) {
  const { bots, layout, wires, view, onView, selection, onSelect } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [cable, setCable] = useState<{ from: Point; to: Point; fromBotId: string; target: string | null } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const rect = viewport.current?.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - current.x) / current.zoom,
      y: (clientY - (rect?.top ?? 0) - current.y) / current.zoom,
    };
  }, []);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const wired = useMemo(() => new Set(wires.map((wire) => `${wire.fromBotId}→${wire.toBotId}`)), [wires]);

  /** The socket a dangling cable would plug into at `point`, if any. */
  const socketAt = useCallback(
    (point: Point, fromBotId: string): string | null => {
      let best: { id: string; distance: number } | null = null;
      for (const [id, box] of Object.entries(layout.nodes)) {
        if (id === fromBotId || botsById.get(id)?.chiefOfStaff) continue;
        const socket = socketOf(box);
        const insideCard = point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y - 24 && point.y <= box.y + box.height;
        const distance = Math.hypot(point.x - socket.x, point.y - socket.y);
        if ((insideCard || distance < 40) && (!best || distance < best.distance)) best = { id, distance };
      }
      return best?.id ?? null;
    },
    [layout.nodes, botsById],
  );

  // Trackpad and wheel: two-finger scroll pans, pinch (ctrl) or ⌘-scroll zooms.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.004));
        onView(zoomAround(current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, current.zoom * factor));
      } else {
        onView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onView]);

  const endGesture = (event: ReactPointerEvent) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current) return;
    if (current.mode === "pan" && !current.moved && event.target === viewport.current) onSelect(null);
    if (current.mode === "move") {
      if (current.moved) {
        const world = toWorld(event.clientX, event.clientY);
        props.onMove(current.botId, { x: current.origin.x + world.x - current.startX, y: current.origin.y + world.y - current.startY }, true);
      } else {
        onSelect({ kind: "bot", id: current.botId });
      }
    }
    if (current.mode === "wire") {
      const target = cable?.target;
      setCable(null);
      if (target && !wired.has(`${current.fromBotId}→${target}`)) props.onConnect(current.fromBotId, target);
    }
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current) return;
    if (current.mode === "pan") {
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) current.moved = true;
      onView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
    } else if (current.mode === "move") {
      const world = toWorld(event.clientX, event.clientY);
      const dx = world.x - current.startX;
      const dy = world.y - current.startY;
      if (!current.moved && Math.abs(dx) + Math.abs(dy) < 4 / viewRef.current.zoom) return;
      current.moved = true;
      props.onMove(current.botId, { x: current.origin.x + dx, y: current.origin.y + dy }, false);
    } else if (current.mode === "wire") {
      const world = toWorld(event.clientX, event.clientY);
      setCable((previous) => (previous ? { ...previous, to: world, target: socketAt(world, current.fromBotId) } : previous));
    }
  };

  const startNodeMove = (event: ReactPointerEvent, botId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const box = layout.nodes[botId];
    if (!box) return;
    const world = toWorld(event.clientX, event.clientY);
    gesture.current = { mode: "move", botId, startX: world.x, startY: world.y, origin: { x: box.x, y: box.y }, moved: false };
    viewport.current?.setPointerCapture(event.pointerId);
  };

  const startCable = (event: ReactPointerEvent, botId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const box = layout.nodes[botId];
    if (!box) return;
    const from = plugOf(box);
    gesture.current = { mode: "wire", fromBotId: botId };
    setCable({ from, to: from, fromBotId: botId, target: null });
    onSelect({ kind: "bot", id: botId });
    viewport.current?.setPointerCapture(event.pointerId);
  };

  const zoomBy = (factor: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    onView(zoomAround(view, { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 }, view.zoom * factor));
  };

  return (
    <div
      ref={viewport}
      className="wb-grid relative min-h-0 flex-1 cursor-default overflow-hidden bg-app outline-none select-none"
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px` }}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        gesture.current = { mode: "pan", startX: event.clientX, startY: event.clientY, view, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={() => {
        gesture.current = null;
        setCable(null);
      }}
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        props.onContextMenu({ kind: "canvas", world: toWorld(event.clientX, event.clientY) }, event.clientX, event.clientY);
      }}
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) props.onFit();
      }}
    >
      <div className="pointer-events-none absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}>
        {layout.frames.map((frame) => (
          <div
            key={frame.key || "__general__"}
            className="absolute rounded-[26px] border border-hairline/45 bg-panel/45"
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
          >
            <div className="absolute left-5 top-3.5 text-[11.5px] font-semibold tracking-[0.06em] text-ink-secondary">{frame.name}</div>
          </div>
        ))}

        <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden>
          {wires.map((wire) => {
            const from = layout.nodes[wire.fromBotId];
            const to = layout.nodes[wire.toBotId];
            if (!from || !to) return null;
            const d = wirePath(plugOf(from), socketOf(to));
            const selected = selection?.kind === "wire" && selection.from === wire.fromBotId && selection.to === wire.toBotId;
            return (
              <g key={`${wire.fromBotId}→${wire.toBotId}`}>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={selected ? 4 : 2.5}
                  strokeLinecap="round"
                  className={cn(
                    "transition-[stroke-width]",
                    WIRE_CLASS[wire.state] ||
                      (wire.kind === "explicit" ? "stroke-accent/70" : "stroke-ink-secondary/35"),
                    selected && "drop-shadow-[0_0_6px_var(--color-accent)]",
                  )}
                />
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={16}
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect({ kind: "wire", from: wire.fromBotId, to: wire.toBotId });
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect({ kind: "wire", from: wire.fromBotId, to: wire.toBotId });
                    props.onContextMenu({ kind: "wire", wire }, event.clientX, event.clientY);
                  }}
                />
              </g>
            );
          })}
          {cable && (
            <path
              d={wirePath(cable.from, cable.target && layout.nodes[cable.target] ? socketOf(layout.nodes[cable.target]!) : cable.to)}
              fill="none"
              strokeWidth={2.5}
              strokeDasharray="7 6"
              strokeLinecap="round"
              className={cable.target ? "stroke-accent" : "stroke-ink-secondary/60"}
            />
          )}
        </svg>

        {wires.map((wire) => {
          if (!wire.label || (wire.state !== "running" && wire.state !== "queued")) return null;
          const from = layout.nodes[wire.fromBotId];
          const to = layout.nodes[wire.toBotId];
          if (!from || !to) return null;
          const mid = cubicMid(plugOf(from), socketOf(to));
          return (
            <div
              key={`label-${wire.fromBotId}→${wire.toBotId}`}
              className={cn(
                "absolute max-w-[180px] -translate-x-1/2 -translate-y-1/2 truncate rounded-full border px-2 py-0.5 text-[10.5px] font-medium shadow-sm",
                wire.state === "running" ? "border-accent/40 bg-accent/15 text-accent-text" : "border-warning/40 bg-warning/15 text-warning",
              )}
              style={{ left: mid.x, top: mid.y }}
            >
              {wire.label}
            </div>
          );
        })}

        {bots.map((bot) => {
          const box = layout.nodes[bot.id];
          if (!box) return null;
          return (
            <BotCard
              key={bot.id}
              bot={bot}
              box={box}
              selected={selection?.kind === "bot" && selection.id === bot.id}
              plugTarget={cable?.target === bot.id}
              cableActive={Boolean(cable)}
              modelLabel={props.modelLabel(bot)}
              onPointerDown={(event) => startNodeMove(event, bot.id)}
              onPlugDown={(event) => startCable(event, bot.id)}
              onDoubleClick={() => props.onOpenChat(bot.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelect({ kind: "bot", id: bot.id });
                props.onContextMenu({ kind: "bot", id: bot.id }, event.clientX, event.clientY);
              }}
            />
          );
        })}
      </div>

      <div className="absolute bottom-3 left-3 flex items-center overflow-hidden rounded-lg border border-hairline/60 bg-panel/90 text-ink-secondary shadow-sm backdrop-blur">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} className="flex size-7 items-center justify-center hover:bg-raised hover:text-ink" title={t("Zoom out (⌘−)")} aria-label={t("Zoom out")}>
          <Minus size={13} />
        </button>
        <button type="button" onClick={() => onView({ ...view, zoom: 1 })} className="h-7 min-w-[48px] border-x border-hairline/60 px-1.5 text-[11px] tabular-nums hover:bg-raised hover:text-ink" title={t("Actual size")}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} className="flex size-7 items-center justify-center hover:bg-raised hover:text-ink" title={t("Zoom in (⌘+)")} aria-label={t("Zoom in")}>
          <Plus size={13} />
        </button>
        <button type="button" onClick={props.onFit} className="flex size-7 items-center justify-center border-l border-hairline/60 hover:bg-raised hover:text-ink" title={t("Fit to window (⌘0)")} aria-label={t("Fit to window")}>
          <Maximize2 size={12} />
        </button>
      </div>
    </div>
  );
}

function BotCard({
  bot,
  box,
  selected,
  plugTarget,
  cableActive,
  modelLabel,
  onPointerDown,
  onPlugDown,
  onDoubleClick,
  onContextMenu,
}: {
  bot: Bot;
  box: NodeBox;
  selected: boolean;
  plugTarget: boolean;
  cableActive: boolean;
  modelLabel: string;
  onPointerDown: (event: ReactPointerEvent) => void;
  onPlugDown: (event: ReactPointerEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const status = teamMapStatus(bot);
  const chief = Boolean(bot.chiefOfStaff);
  const waiting = bot.activity === "waiting-on-you";
  const working = status.tone === "success";
  return (
    <div
      className={cn(
        "pointer-events-auto absolute rounded-[18px] border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.25),0_8px_24px_-12px_rgba(0,0,0,0.5)] transition-[box-shadow,border-color]",
        chief ? "border-accent/45" : "border-hairline/60",
        selected && "border-accent ring-2 ring-accent/35",
        plugTarget && "border-accent ring-4 ring-accent/30",
        waiting && !selected && "border-warning/70",
        working && !selected && "ring-2 ring-success/25",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={t("Double-click to open the conversation")}
    >
      {!chief && (
        <div
          className={cn(
            "absolute -top-[8px] left-1/2 flex size-4 -translate-x-1/2 items-center justify-center rounded-full border-2 bg-app transition-colors",
            plugTarget ? "border-accent bg-accent" : cableActive ? "border-accent/70" : "border-ink-secondary/50",
          )}
          aria-label={t("Socket (receives tasks)")}
        >
          <span className="size-1.5 rounded-full bg-current text-ink-secondary/60" />
        </div>
      )}
      <div className="flex h-full items-center gap-3 px-3.5">
        <BotAvatar bot={bot} size={chief ? 42 : 36} motion="none" motionKey={0} animated={false} state={normalizeState(bot.mascotExpression) ?? "idle"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-ink">{bot.name}</span>
            {chief && <Crown size={12} className="shrink-0 text-warning" aria-label={t("Chief of Staff")} />}
          </div>
          <div className="truncate text-[11.5px] text-ink-secondary">{bot.title || (chief ? t("Chief of Staff") : t("Team member"))}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={cn("size-1.5 shrink-0 rounded-full", statusDot[status.tone], working && "animate-pulse")} />
            <span className={cn("shrink-0 text-[10.5px]", waiting ? "font-medium text-warning" : "text-ink-secondary")}>{t(status.label)}</span>
            <span className="truncate rounded bg-control px-1.5 py-px text-[10px] text-ink-secondary">{modelLabel}</span>
          </div>
        </div>
      </div>
      {chief && (
        <button
          type="button"
          onPointerDown={onPlugDown}
          className="absolute -bottom-[11px] left-1/2 flex h-[22px] -translate-x-1/2 cursor-crosshair items-center gap-1 rounded-full border border-accent/60 bg-primary px-2.5 text-[10.5px] font-semibold text-primary-ink shadow-md hover:brightness-110"
          title={t("Drag a cable to a team member to let this Chief dispatch to them")}
        >
          {t("Dispatch")}
          <span className="size-1.5 rounded-full bg-white" />
        </button>
      )}
    </div>
  );
}
