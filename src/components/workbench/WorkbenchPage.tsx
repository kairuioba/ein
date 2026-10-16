// 汇总工作台 — the dispatch workbench.
//
// The Chief of Staff sits on top of each section with a Dispatch plug; every
// member has a socket. Cables are dispatch routes: plug one in to let a Chief
// hand work to a bot (from any section), unplug one to keep a bot out of its
// plans. Work moving along a cable lights it up, the inspector explains the
// selection and recommends models, and the board below tracks every run.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crown, LayoutGrid, Maximize2, MessageSquare, Network, PanelBottom, PanelRight, Plus, Radio, RefreshCw, Sparkles, Unplug, Undo2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { EMPTY_TEAM_MAP_SNAPSHOT, type TeamMapSnapshot } from "@/lib/team-map";
import {
  EditHistory,
  buildWires,
  fitView,
  layoutWorkbench,
  loadPositions,
  savePositions,
  type Point,
  type Wire,
} from "@/lib/workbench";
import { api, useStore, type Bot } from "@/state/store";
import { DEFAULT_DISPATCH_SETTINGS, type DispatchRoute, type DispatchRun, type DispatchSettings, type DispatchSubtask } from "../../../shared/dispatch-types";
import { recommendForText, policyLabel, RECOMMENDATION_POLICIES, type Recommendation, type RecommendationPolicy } from "../../../shared/model-recommender";

import { DispatchBoard } from "./DispatchBoard";
import { MacMenu, type MacMenuItem } from "./MacMenu";
import { WorkbenchCanvas, type CanvasSelection, type CanvasTarget, type CanvasView } from "./WorkbenchCanvas";
import { WorkbenchInspector } from "./WorkbenchInspector";

interface DispatchState {
  runs: DispatchRun[];
  routes: DispatchRoute[];
  settings: DispatchSettings;
  snapshot: TeamMapSnapshot;
}

const EMPTY_STATE: DispatchState = { runs: [], routes: [], settings: DEFAULT_DISPATCH_SETTINGS, snapshot: EMPTY_TEAM_MAP_SNAPSHOT };

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function WorkbenchPage({ onEditSectionContext }: { onEditSectionContext?: (section: string, label: string) => void }) {
  const { state, dispatch } = useStore();
  const [data, setData] = useState<DispatchState>(EMPTY_STATE);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [positions, setPositions] = useState<Record<string, Point>>(loadPositions);
  const [view, setView] = useState<CanvasView>({ x: 40, y: 40, zoom: 1 });
  const [menu, setMenu] = useState<{ x: number; y: number; items: MacMenuItem[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const history = useRef(new EditHistory());
  const canvasHost = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const sectionLabel = useCallback((key: string) => key || t("General"), []);
  const layout = useMemo(() => layoutWorkbench(bots, positions, sectionLabel), [bots, positions, sectionLabel]);
  const wires = useMemo(() => buildWires(bots, data.routes, data.runs, data.snapshot), [bots, data]);

  const say = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2400);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = (await api("/api/dispatch/state")) as DispatchState;
      setData({ runs: next.runs ?? [], routes: next.routes ?? [], settings: { ...DEFAULT_DISPATCH_SETTINGS, ...next.settings }, snapshot: next.snapshot ?? EMPTY_TEAM_MAP_SNAPSHOT });
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const fit = useCallback(() => {
    const rect = canvasHost.current?.getBoundingClientRect();
    if (rect) setView(fitView(layout, { width: rect.width, height: rect.height }));
  }, [layout]);

  useEffect(() => {
    if (fitted.current || !bots.length) return;
    fitted.current = true;
    requestAnimationFrame(fit);
  }, [bots.length, fit]);

  const modelLabel = useCallback(
    (bot: Bot) => {
      const instance = state.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
      const option = instance?.models.options.find((candidate) => candidate.id === bot.modelSelection.model);
      return `${instance?.displayName ?? bot.modelSelection.instanceId} · ${option?.label ?? bot.modelSelection.model}`;
    },
    [state.instances],
  );

  // ── routes (cables) ──

  const putRoute = useCallback(async (fromBotId: string, toBotId: string, enabled: boolean | null) => {
    if (enabled === null) {
      await api(`/api/dispatch/routes?from=${encodeURIComponent(fromBotId)}&to=${encodeURIComponent(toBotId)}`, { method: "DELETE" });
    } else {
      await api("/api/dispatch/routes", { method: "PUT", body: JSON.stringify({ fromBotId, toBotId, enabled }) });
    }
    await refresh();
  }, [refresh]);

  const routeEdit = useCallback(
    async (fromBotId: string, toBotId: string, next: boolean | null, label: string) => {
      const previous = data.routes.find((route) => route.fromBotId === fromBotId && route.toBotId === toBotId);
      const before = previous ? previous.enabled : null;
      try {
        await putRoute(fromBotId, toBotId, next);
        history.current.push({
          label,
          undo: () => putRoute(fromBotId, toBotId, before),
          redo: () => putRoute(fromBotId, toBotId, next),
        });
        say(label);
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
      }
    },
    [data.routes, putRoute, say],
  );

  const nameOf = useCallback((id: string) => bots.find((bot) => bot.id === id)?.name ?? "?", [bots]);

  const connect = useCallback(
    (fromBotId: string, toBotId: string) => {
      void routeEdit(fromBotId, toBotId, true, t("Connected {from} → {to}", { from: nameOf(fromBotId), to: nameOf(toBotId) }));
      setSelection({ kind: "wire", from: fromBotId, to: toBotId });
    },
    [routeEdit, nameOf],
  );

  const unplug = useCallback(
    (wire: Wire) => {
      const from = bots.find((bot) => bot.id === wire.fromBotId);
      const to = bots.find((bot) => bot.id === wire.toBotId);
      const sameSection = (from?.section?.trim() || "") === (to?.section?.trim() || "");
      void routeEdit(wire.fromBotId, wire.toBotId, sameSection ? false : null, t("Unplugged {from} → {to}", { from: nameOf(wire.fromBotId), to: nameOf(wire.toBotId) }));
      setSelection(null);
    },
    [bots, routeEdit, nameOf],
  );

  const resetWire = useCallback(
    (wire: Wire) => void routeEdit(wire.fromBotId, wire.toBotId, null, t("Reset {from} → {to} to default", { from: nameOf(wire.fromBotId), to: nameOf(wire.toBotId) })),
    [routeEdit, nameOf],
  );

  // ── nodes ──

  const dragOrigin = useRef<Record<string, Point>>({});
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const writePositions = useCallback((next: Record<string, Point>, persist: boolean) => {
    positionsRef.current = next;
    setPositions(next);
    if (persist) savePositions(next);
  }, []);
  const moveNode = useCallback(
    (botId: string, point: Point, commit: boolean) => {
      const current = positionsRef.current;
      if (!(botId in dragOrigin.current)) {
        const box = layout.nodes[botId];
        dragOrigin.current[botId] = current[botId] ?? (box ? { x: box.x, y: box.y } : point);
      }
      writePositions({ ...current, [botId]: point }, commit);
      if (!commit) return;
      const origin = dragOrigin.current[botId]!;
      delete dragOrigin.current[botId];
      const apply = (value: Point) => writePositions({ ...positionsRef.current, [botId]: value }, true);
      history.current.push({ label: t("Moved {name}", { name: nameOf(botId) }), undo: () => apply(origin), redo: () => apply(point) });
    },
    [layout.nodes, nameOf, writePositions],
  );

  const arrange = useCallback(() => {
    const previous = positionsRef.current;
    const apply = (value: Record<string, Point>) => writePositions(value, true);
    apply({});
    history.current.push({ label: t("Arranged automatically"), undo: () => apply(previous), redo: () => apply({}) });
    requestAnimationFrame(fit);
  }, [fit, writePositions]);

  const openChat = useCallback((botId: string) => dispatch({ type: "select", id: botId }), [dispatch]);

  const openSubtask = useCallback(
    (subtask: DispatchSubtask) => {
      dispatch({ type: "select", id: subtask.assigneeBotId });
      if (subtask.threadId) dispatch({ type: "switchTask", botId: subtask.assigneeBotId, threadId: subtask.threadId });
    },
    [dispatch],
  );

  const toggleChief = useCallback(
    (bot: Bot) => {
      dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } });
      say(bot.chiefOfStaff ? t("{name} is no longer a Chief", { name: bot.name }) : t("{name} is now the Chief of Staff", { name: bot.name }));
    },
    [dispatch, say],
  );

  const applyModel = useCallback(
    (bot: Bot, recommendation: Recommendation) => {
      if (bot.busy) {
        say(t("{name} is working — try again when it finishes", { name: bot.name }));
        return;
      }
      dispatch({
        type: "setModel",
        botId: bot.id,
        selection: { instanceId: recommendation.instanceId, model: recommendation.model, ...(recommendation.effort ? { effort: recommendation.effort } : {}) },
      });
      say(t("{name} now uses {model}", { name: bot.name, model: recommendation.modelLabel }));
    },
    [dispatch, say],
  );

  const sendTask = useCallback(
    (chiefId: string, text: string) => {
      dispatch({ type: "send", botId: chiefId, text });
      say(t("Sent to {name} — the plan will appear on the board", { name: nameOf(chiefId) }));
    },
    [dispatch, nameOf, say],
  );

  // ── runs and settings ──

  const runAction = useCallback(
    async (path: string, done: string) => {
      try {
        await api(path, { method: "POST", body: "{}" });
        say(done);
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
      }
      await refresh();
    },
    [refresh, say],
  );

  const patchSettings = useCallback(
    async (patch: Partial<DispatchSettings>) => {
      const next = { ...data.settings, ...patch };
      setData((current) => ({ ...current, settings: next }));
      try {
        await api("/api/config", { method: "PATCH", body: JSON.stringify({ dispatch: next }) });
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
      }
      await refresh();
    },
    [data.settings, refresh, say],
  );

  // ── context menus ──

  const contextMenu = useCallback(
    (target: CanvasTarget, x: number, y: number) => {
      let items: MacMenuItem[] = [];
      if (target.kind === "bot") {
        const bot = bots.find((candidate) => candidate.id === target.id);
        if (!bot) return;
        const best = recommendForText(`${bot.title}\n${bot.description}`, state.instances, data.settings.policy, {}, { limit: 1 }).recommendations[0];
        const incoming = wires.filter((wire) => wire.toBotId === bot.id);
        items = [
          { kind: "header", label: bot.name },
          { label: t("Open chat"), icon: <MessageSquare size={13} />, shortcut: "↩", onSelect: () => openChat(bot.id) },
          { label: bot.chiefOfStaff ? t("Remove Chief of Staff") : t("Make Chief of Staff"), icon: <Crown size={13} />, onSelect: () => toggleChief(bot) },
          ...(best && !(best.instanceId === bot.modelSelection.instanceId && best.model === bot.modelSelection.model)
            ? [{ label: t("Use recommended model: {model}", { model: best.modelLabel }), icon: <Sparkles size={13} />, onSelect: () => applyModel(bot, best) }]
            : []),
          { kind: "separator" },
          { label: t("Unplug from all Chiefs"), icon: <Unplug size={13} />, disabled: incoming.length === 0, danger: true, onSelect: () => incoming.forEach(unplug) },
          {
            label: t("Reset position"),
            icon: <LayoutGrid size={13} />,
            disabled: !(bot.id in positions),
            onSelect: () => {
              const next = { ...positionsRef.current };
              delete next[bot.id];
              writePositions(next, true);
            },
          },
        ];
      } else if (target.kind === "wire") {
        const wire = target.wire;
        items = [
          { kind: "header", label: `${nameOf(wire.fromBotId)} → ${nameOf(wire.toBotId)}` },
          { label: t("Unplug"), icon: <Unplug size={13} />, shortcut: "⌫", danger: true, onSelect: () => unplug(wire) },
          { label: t("Reset to default"), icon: <Undo2 size={13} />, disabled: wire.kind === "default", onSelect: () => resetWire(wire) },
          { kind: "separator" },
          { label: t("Open {name}'s chat", { name: nameOf(wire.toBotId) }), icon: <MessageSquare size={13} />, onSelect: () => openChat(wire.toBotId) },
        ];
      } else {
        const frame = layout.frames.find((candidate) => target.world.x >= candidate.x && target.world.x <= candidate.x + candidate.width && target.world.y >= candidate.y && target.world.y <= candidate.y + candidate.height);
        items = [
          { label: t("Arrange automatically"), icon: <LayoutGrid size={13} />, onSelect: arrange },
          { label: t("Fit to window"), icon: <Maximize2 size={13} />, shortcut: "⌘0", onSelect: fit },
          { kind: "separator" },
          { label: t("New bot"), icon: <Plus size={13} />, shortcut: "⌘N", onSelect: () => dispatch({ type: "newBot" }) },
          ...(frame && onEditSectionContext
            ? [{ label: t("Edit “{section}” shared context…", { section: frame.name }), icon: <Network size={13} />, onSelect: () => onEditSectionContext(frame.key, frame.name) }]
            : []),
        ];
      }
      setMenu({ x, y, items });
    },
    [bots, state.instances, data.settings.policy, wires, openChat, toggleChief, applyModel, unplug, positions, nameOf, resetWire, layout.frames, arrange, fit, dispatch, onEditSectionContext, writePositions],
  );

  // ── keyboard ──

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || menu) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? history.current.redo() : history.current.undo()).then((label) => {
          if (label) say(event.shiftKey ? t("Redo: {action}", { action: label }) : t("Undo: {action}", { action: label }));
        });
      } else if (mod && event.key === "0") {
        event.preventDefault();
        fit();
      } else if (mod && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        setView((current) => ({ ...current, zoom: Math.min(2, current.zoom * 1.2) }));
      } else if (mod && event.key === "-") {
        event.preventDefault();
        setView((current) => ({ ...current, zoom: Math.max(0.3, current.zoom / 1.2) }));
      } else if (mod && event.altKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setShowInspector((current) => !current);
      } else if ((event.key === "Backspace" || event.key === "Delete") && selection?.kind === "wire") {
        event.preventDefault();
        const wire = wires.find((candidate) => candidate.fromBotId === selection.from && candidate.toBotId === selection.to);
        if (wire) unplug(wire);
      } else if (event.key === "Enter" && selection?.kind === "bot") {
        event.preventDefault();
        openChat(selection.id);
      } else if (event.key === "Escape") {
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, fit, selection, wires, unplug, openChat, say]);

  const working = bots.filter((bot) => bot.busy || bot.activity === "working").length;
  const waiting = bots.filter((bot) => bot.activity === "waiting-on-you").length;
  const chiefs = bots.filter((bot) => bot.chiefOfStaff);

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline/40 bg-panel/70 px-4 backdrop-blur-xl max-md:pl-12">
        <div className="flex min-w-0 items-center gap-2">
          <Network size={17} className="text-accent" />
          <h1 className="text-[14.5px] font-semibold">{t("Workbench")}</h1>
          <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] font-medium text-success">
            <Radio size={10} /> {t("Live")}
          </span>
          <span className="hidden truncate text-[11.5px] text-ink-secondary md:inline">
            {t("{bots} bots · {working} working · {waiting} waiting for you", { bots: bots.length, working, waiting })}
          </span>
        </div>

        <div className="mx-auto flex items-center gap-1 rounded-lg border border-hairline/60 bg-inset p-0.5" role="radiogroup" aria-label={t("Model strategy")}>
          {RECOMMENDATION_POLICIES.map((policy: RecommendationPolicy) => (
            <button
              key={policy}
              type="button"
              role="radio"
              aria-checked={data.settings.policy === policy}
              onClick={() => void patchSettings({ policy })}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                data.settings.policy === policy ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
              title={t("How models are picked for the specialists a Chief creates")}
            >
              {policyLabel(policy)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised" title={t("Chiefs split multi-step requests into a plan and dispatch it automatically")}>
            <span>{t("Auto-dispatch")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={data.settings.enabled}
              onClick={() => void patchSettings({ enabled: !data.settings.enabled })}
              className={cn("relative h-[18px] w-[30px] rounded-full transition-colors", data.settings.enabled ? "bg-success" : "bg-control")}
            >
              <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-[left]", data.settings.enabled ? "left-[14px]" : "left-[2px]")} />
            </button>
          </label>
          <ToolbarButton label={t("Arrange automatically")} onClick={arrange}><LayoutGrid size={15} /></ToolbarButton>
          <ToolbarButton label={t("Refresh")} onClick={() => void refresh()}><RefreshCw size={14} /></ToolbarButton>
          <ToolbarButton label={t("Show dispatch board")} active={showBoard} onClick={() => setShowBoard((current) => !current)}><PanelBottom size={15} /></ToolbarButton>
          <ToolbarButton label={t("Show inspector (⌥⌘I)")} active={showInspector} onClick={() => setShowInspector((current) => !current)}><PanelRight size={15} /></ToolbarButton>
        </div>
      </header>

      {loadError && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[12px] text-danger">
          {t("Could not load dispatch data: {error}", { error: loadError })}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={canvasHost} className="relative flex min-w-0 flex-1 flex-col">
          {bots.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary">{t("No bots yet — press ⌘N to create one.")}</div>
          ) : (
            <WorkbenchCanvas
              bots={bots}
              layout={layout}
              wires={wires}
              view={view}
              onView={setView}
              onFit={fit}
              selection={selection}
              onSelect={setSelection}
              modelLabel={modelLabel}
              onConnect={connect}
              onMove={moveNode}
              onOpenChat={openChat}
              onContextMenu={contextMenu}
            />
          )}
          {chiefs.length === 0 && bots.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
              <div className="pointer-events-auto rounded-xl border border-warning/40 bg-panel/95 px-4 py-2.5 text-[12.5px] shadow-lg backdrop-blur">
                {t("No Chief of Staff yet — right-click a bot and choose “Make Chief of Staff” to start dispatching.")}
              </div>
            </div>
          )}
          {showBoard && (
            <DispatchBoard
              runs={data.runs}
              bots={state.bots}
              height={240}
              onApprove={(runId) => void runAction(`/api/dispatch/runs/${runId}/approve`, t("Dispatch started"))}
              onCancel={(runId) => void runAction(`/api/dispatch/runs/${runId}/cancel`, t("Dispatch canceled"))}
              onRetry={(runId, subtaskId) => void runAction(`/api/dispatch/runs/${runId}/subtasks/${encodeURIComponent(subtaskId)}/retry`, t("Retrying subtask"))}
              onOpenSubtask={openSubtask}
              onOpenChat={openChat}
            />
          )}
          {toast && (
            <div className="animate-pop-in pointer-events-none absolute bottom-[256px] left-1/2 z-20 -translate-x-1/2 rounded-full border border-hairline/60 bg-panel/95 px-3.5 py-1.5 text-[12px] shadow-lg backdrop-blur">
              {toast}
            </div>
          )}
        </div>
        {showInspector && (
          <WorkbenchInspector
            selection={selection}
            bots={state.bots}
            wires={wires}
            runs={data.runs}
            instances={state.instances}
            settings={data.settings}
            modelLabel={modelLabel}
            onOpenChat={openChat}
            onOpenSubtask={openSubtask}
            onToggleChief={toggleChief}
            onApplyModel={applyModel}
            onUnplug={unplug}
            onReset={resetWire}
            onSendTask={sendTask}
          />
        )}
      </div>
      {menu && <MacMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </main>
  );
}

function ToolbarButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised hover:text-ink",
        active && "bg-raised/70 text-ink",
      )}
    >
      {children}
    </button>
  );
}
