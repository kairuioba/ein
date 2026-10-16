// 工作台 — the company at work. Two views of the same team:
//   看人 (PeopleView)       each bot a pixel figure in its department's room
//   看事 (WorkbenchCanvas)  the work tree with lenses and a detail drawer
// The header names the current project (the newest active dispatch) and its
// deadline, switches views, adds people to the running job (AddPeopleDialog)
// and shows what is waiting on you. Leaving the page marks everything seen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Crown, LayoutGrid, Maximize2, MessageSquare, Network, Plus, RotateCw, Sparkles, Unplug, Users, X, Zap } from "lucide-react";

import { Button, Empty } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDateTime, t } from "@/lib/i18n";
import { EditHistory, buildWires, clip, clock, type Wire } from "@/lib/workbench";
import { markSeen } from "@/state/org-api";
import { api, useStore, type Bot } from "@/state/store";
import { recommendForText, type Recommendation } from "../../../shared/model-recommender";

import { AddPeopleDialog } from "./AddPeopleDialog";
import type { TimelineMark } from "./DayTimeline";
import { MacMenu, type MacMenuItem } from "./MacMenu";
import { useWorkbenchModel, type WorkbenchModel } from "./model";
import { DiamondMark, useElementSize, useStoredState } from "./parts";
import { PeopleView } from "./PeopleView";
import { TreeDrawer } from "./TreeDrawer";
import { LENSES, WorkbenchCanvas, workOrders, type Lens, type TreeSelection } from "./WorkbenchCanvas";

type View = "people" | "work";
const VIEWS = ["people", "work"] as const;
const LENS_IDS = LENSES.map((lens) => lens.id);

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function WorkbenchPage({ onEditSectionContext }: { onEditSectionContext?: (section: string, label: string) => void }) {
  const { state, dispatch } = useStore();
  const model = useWorkbenchModel();
  const [view, setView] = useStoredState<View>("omb.workbench.view", "people", VIEWS);
  const [lens, setLens] = useStoredState<Lens>("omb.workbench.lens", "tree", LENS_IDS);
  const [selection, setSelection] = useState<TreeSelection>(null);
  const [drawerDismissed, setDrawerDismissed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MacMenuItem[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [fitToken, setFitToken] = useState(0);
  const [sinceDismissed, setSinceDismissed] = useState(false);
  const history = useRef(new EditHistory());
  const [pageRef, pageSize] = useElementSize<HTMLElement>();

  // everything on screen counts as seen once you leave
  useEffect(() => () => markSeen(), []);
  useEffect(() => setDrawerDismissed(false), [lens]);

  const say = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2600);
  }, []);

  // ── navigation ──
  const openChat = useCallback(
    (botId: string, threadId?: string) => {
      dispatch({ type: "select", id: botId });
      const bot = state.bots.find((candidate) => candidate.id === botId);
      if (threadId && bot?.tasks?.some((task) => task.threadId === threadId)) dispatch({ type: "switchTask", botId, threadId });
    },
    [dispatch, state.bots],
  );
  const openGroup = useCallback((groupId: string) => dispatch({ type: "select", id: groupId }), [dispatch]);
  const openPage = useCallback((page: "brief" | "library" | "settings") => dispatch({ type: "showPage", page }), [dispatch]);

  // ── actions on the work ──
  const runAction = useCallback(
    async (path: string, done: string) => {
      try {
        await api(path, { method: "POST", body: "{}" });
        say(done);
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
      }
      await model.dispatch.refresh();
    },
    [model.dispatch, say],
  );
  const nudge = useCallback(
    (botId: string, text?: string) => {
      const bot = state.bots.find((candidate) => candidate.id === botId);
      dispatch({
        type: "send",
        botId,
        text: text ?? t("How is it going? Please report in the usual format: what you did, result and evidence, blocker, next step, who you need, sources."),
      });
      say(t("Nudged {name}", { name: bot?.name ?? "?" }));
    },
    [dispatch, say, state.bots],
  );
  const retry = useCallback((runId: string, subtaskId: string) => void runAction(`/api/dispatch/runs/${runId}/subtasks/${encodeURIComponent(subtaskId)}/retry`, t("Retrying subtask")), [runAction]);
  const approve = useCallback((runId: string) => void runAction(`/api/dispatch/runs/${runId}/approve`, t("Dispatch started")), [runAction]);
  const cancel = useCallback((runId: string) => void runAction(`/api/dispatch/runs/${runId}/cancel`, t("Dispatch canceled")), [runAction]);

  // ── routes: who a chief may hand work to (kept from the cable workbench) ──
  const wires = useMemo(() => buildWires(model.bots, model.dispatch.routes, model.dispatch.runs, model.dispatch.snapshot), [model.bots, model.dispatch.routes, model.dispatch.runs, model.dispatch.snapshot]);
  const putRoute = useCallback(
    async (fromBotId: string, toBotId: string, enabled: boolean | null) => {
      if (enabled === null) await api(`/api/dispatch/routes?from=${encodeURIComponent(fromBotId)}&to=${encodeURIComponent(toBotId)}`, { method: "DELETE" });
      else await api("/api/dispatch/routes", { method: "PUT", body: JSON.stringify({ fromBotId, toBotId, enabled }) });
      await model.dispatch.refresh();
    },
    [model.dispatch],
  );
  const unplugAll = useCallback(
    async (bot: Bot) => {
      const incoming = wires.filter((wire: Wire) => wire.toBotId === bot.id);
      try {
        for (const wire of incoming) {
          const from = state.bots.find((candidate) => candidate.id === wire.fromBotId);
          const sameSection = (from?.section?.trim() || "") === (bot.section?.trim() || "");
          const before = model.dispatch.routes.find((route) => route.fromBotId === wire.fromBotId && route.toBotId === bot.id);
          await putRoute(wire.fromBotId, bot.id, sameSection ? false : null);
          history.current.push({
            label: t("Unplugged {from} → {to}", { from: from?.name ?? "?", to: bot.name }),
            undo: () => putRoute(wire.fromBotId, bot.id, before ? before.enabled : null),
            redo: () => putRoute(wire.fromBotId, bot.id, sameSection ? false : null),
          });
        }
        say(t("{name} no longer gets work from the chiefs", { name: bot.name }));
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
      }
    },
    [wires, state.bots, model.dispatch.routes, putRoute, say],
  );
  const toggleLead = useCallback(
    (bot: Bot) => {
      dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } });
      say(bot.chiefOfStaff ? t("{name} no longer leads the department", { name: bot.name }) : t("{name} now leads the department", { name: bot.name }));
    },
    [dispatch, say],
  );
  const applyModel = useCallback(
    (bot: Bot, recommendation: Recommendation) => {
      if (bot.busy) {
        say(t("{name} is working — try again when it finishes", { name: bot.name }));
        return;
      }
      dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: recommendation.instanceId, model: recommendation.model, ...(recommendation.effort ? { effort: recommendation.effort } : {}) } });
      say(t("{name} now uses {model}", { name: bot.name, model: recommendation.modelLabel }));
    },
    [dispatch, say],
  );

  const contextMenu = useCallback(
    (target: { kind: "bot"; id: string } | { kind: "dept"; section: string } | { kind: "canvas" }, x: number, y: number) => {
      let items: MacMenuItem[] = [];
      if (target.kind === "bot") {
        const bot = state.bots.find((candidate) => candidate.id === target.id);
        if (!bot) return;
        const best = recommendForText(`${bot.title}\n${bot.description}`, state.instances, model.dispatch.settings.policy, {}, { limit: 1 }).recommendations[0];
        items = [
          { kind: "header", label: bot.name },
          { label: t("Open chat"), icon: <MessageSquare size={13} />, shortcut: "↩", onSelect: () => openChat(bot.id) },
          { label: t("Nudge for a report"), icon: <Zap size={13} />, onSelect: () => nudge(bot.id) },
          { label: bot.chiefOfStaff ? t("Remove as department lead") : t("Make department lead"), icon: <Crown size={13} />, onSelect: () => toggleLead(bot) },
          ...(best && !(best.instanceId === bot.modelSelection.instanceId && best.model === bot.modelSelection.model)
            ? [{ label: t("Use recommended model: {model}", { model: best.modelLabel }), icon: <Sparkles size={13} />, onSelect: () => applyModel(bot, best) }]
            : []),
          { kind: "separator" },
          { label: t("Stop the leads from assigning to it"), icon: <Unplug size={13} />, danger: true, disabled: !wires.some((wire) => wire.toBotId === bot.id), onSelect: () => void unplugAll(bot) },
        ];
      } else if (target.kind === "dept") {
        const room = model.rooms.find((candidate) => candidate.section === target.section);
        items = [
          { kind: "header", label: room?.label || t("No department") },
          ...(room?.lead ? [{ label: t("Open {name}'s chat", { name: room.lead.name }), icon: <MessageSquare size={13} />, onSelect: () => openChat(room.lead!.id) }] : []),
          ...(onEditSectionContext && room && !room.unassigned
            ? [{ label: t("Edit “{section}” shared context…", { section: room.label }), icon: <Network size={13} />, onSelect: () => onEditSectionContext(room.section, room.label) }]
            : []),
        ];
      } else {
        items = [
          { label: t("Arrange afresh"), icon: <LayoutGrid size={13} />, onSelect: () => setResetToken((n) => n + 1) },
          { label: t("Fit to window"), icon: <Maximize2 size={13} />, onSelect: () => setFitToken((n) => n + 1) },
          { kind: "separator" },
          { label: t("New bot"), icon: <Plus size={13} />, shortcut: "⌘N", onSelect: () => dispatch({ type: "newBot" }) },
        ];
      }
      setMenu({ x, y, items });
    },
    [state.bots, state.instances, model.dispatch.settings.policy, model.rooms, wires, openChat, nudge, toggleLead, applyModel, unplugAll, onEditSectionContext, dispatch],
  );

  // ⌘Z / ⇧⌘Z for route edits, Esc clears the selection
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || menu || addOpen) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? history.current.redo() : history.current.undo()).then((label) => {
          if (label) say(event.shiftKey ? t("Redo: {action}", { action: label }) : t("Undo: {action}", { action: label }));
        });
      } else if (event.key === "Escape") {
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, addOpen, say]);

  const marks = useMemo(() => timelineMarks(model), [model]);
  const orders = useMemo(() => workOrders(model), [model]);
  const drawerSelection = selection ?? (drawerDismissed ? null : defaultSelection(model, lens, orders));
  const drawerWidth = pageSize.width >= 1240 ? 430 : 380;
  const pending = model.dispatch.runs.filter((run) => run.status === "awaiting-approval");
  const needs = model.needsYou.length;
  const waitingLive = model.bots.filter((bot) => bot.activity === "waiting-on-you").length;

  if (!model.bots.length) {
    return (
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center bg-stage text-ink">
        <Empty title={t("No bots yet")} detail={t("Create a bot and make it the chief — it splits your requests and assigns them to departments.")} action={<Button onClick={() => dispatch({ type: "newBot" })}>{t("New bot")}</Button>} />
      </main>
    );
  }

  return (
    <main ref={pageRef} className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-stage text-ink">
      <Header
        model={model}
        view={view}
        onView={(next) => {
          setView(next);
          setSelection(null);
        }}
        lens={lens}
        onLens={(next) => {
          setLens(next);
          setSelection(null);
        }}
        width={pageSize.width}
        needs={needs || waitingLive}
        onNeeds={() => openPage("brief")}
        onAdd={() => setAddOpen(true)}
      />
      {model.dispatch.error && (
        <div className="border-b border-danger/25 bg-danger/[0.06] px-4 py-1.5 text-[12px] text-danger">{t("Could not load dispatch data: {error}", { error: model.dispatch.error })}</div>
      )}
      {pending.length > 0 && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-warning/25 bg-warning/[0.07] px-4 py-2 text-[12.5px]">
          <DiamondMark size={10} />
          <span className="min-w-0 truncate text-ink">{t("The chief's plan is waiting for you to start: {goal}", { goal: clip(pending[0]!.goal, 30) })}</span>
          <span className="flex-1" />
          <Button size="sm" onClick={() => approve(pending[0]!.id)}>
            {t("Start")}
          </Button>
          <Button size="sm" variant="soft" onClick={() => cancel(pending[0]!.id)}>
            {t("Cancel")}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {view === "people" ? (
          <PeopleView model={model} marks={marks} onOpenChat={openChat} onOpenGroup={openGroup} onOpenLibrary={() => openPage("library")} />
        ) : (
          <>
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {!sinceDismissed && model.brief.changes.length > 0 && (
                <SinceBanner
                  model={model}
                  onPeople={() => setView("people")}
                  onDismiss={() => {
                    markSeen();
                    setSinceDismissed(true);
                  }}
                />
              )}
              <WorkbenchCanvas
                model={model}
                lens={lens}
                marks={marks}
                selection={drawerSelection}
                onSelect={(next) => {
                  setSelection(next);
                  if (!next) setDrawerDismissed(true);
                }}
                onOpenChat={openChat}
                onNudge={(botId) => nudge(botId)}
                onContextMenu={contextMenu}
                resetToken={resetToken}
                fitToken={fitToken}
              />
            </div>
            {drawerSelection && (
              <TreeDrawer
                model={model}
                selection={drawerSelection}
                orders={orders}
                width={drawerWidth}
                actions={{
                  onClose: () => {
                    setSelection(null);
                    setDrawerDismissed(true);
                  },
                  onOpenChat: openChat,
                  onOpenGroup: openGroup,
                  onNudge: nudge,
                  onRetry: retry,
                  onApprove: approve,
                  onCancel: cancel,
                  onEditRules: () => openPage("settings"),
                  onSelect: setSelection,
                }}
              />
            )}
          </>
        )}
      </div>
      {toast && (
        <div className="animate-pop-in pointer-events-none absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-[#14161C] px-3.5 py-1.5 text-[12.5px] text-white shadow-lg">{toast}</div>
      )}
      <AddPeopleDialog
        open={addOpen}
        run={model.activeRun}
        model={model}
        onClose={() => setAddOpen(false)}
        onDone={(message) => {
          setAddOpen(false);
          say(message);
        }}
        onOpenChief={() => {
          setAddOpen(false);
          if (model.chief) openChat(model.chief.id);
        }}
      />
      {menu && <MacMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </main>
  );
}

/** What the drawer shows when nothing is selected: the report lens opens the
 * department that most needs a look; the collaboration lens the newest
 * decision (or a work order). Other lenses keep the canvas wide. */
function defaultSelection(model: WorkbenchModel, lens: Lens, orders: ReturnType<typeof workOrders>): TreeSelection {
  if (lens === "report") {
    const rank = { red: 0, yellow: 1, green: 2 } as const;
    const rooms = model.rooms.filter((room) => !room.unassigned);
    const worst = [...rooms].sort((a, b) => {
      const ha = model.stats.get(a.section)?.health;
      const hb = model.stats.get(b.section)?.health;
      return (ha ? rank[ha] : 3) - (hb ? rank[hb] : 3);
    })[0];
    return worst ? { kind: "dept", section: worst.section } : null;
  }
  if (lens === "collab") {
    if (model.decisions[0]) return { kind: "decision", id: model.decisions[0].id };
    if (orders[0]) return { kind: "order", key: orders[0].key };
  }
  return null;
}

/** Today's events for the timeline: the brief's when the server has them,
 * else what the dispatch runs tell (started, finished, failed), plus the
 * next daily brief as a mark ahead of "now". */
export function timelineMarks(model: WorkbenchModel): TimelineMark[] {
  const today = new Date(model.now).toDateString();
  const isToday = (at: number) => new Date(at).toDateString() === today;
  let marks: TimelineMark[] = model.brief.timeline.map((event) => ({ id: event.id, at: event.at, title: event.title, kind: event.kind, severity: event.severity }));
  if (!marks.length) {
    for (const run of model.dispatch.runs) {
      if (isToday(run.createdAt)) marks.push({ id: `run:${run.id}`, at: run.createdAt, title: clip(run.goal, 12), kind: "run.started" });
      for (const subtask of run.subtasks) {
        if (subtask.finishedAt && isToday(subtask.finishedAt) && (subtask.status === "done" || subtask.status === "failed")) {
          marks.push({
            id: `sub:${run.id}:${subtask.id}`,
            at: subtask.finishedAt,
            title: subtask.status === "done" ? t("{title} done", { title: clip(subtask.title, 8) }) : t("{title} failed", { title: clip(subtask.title, 8) }),
            kind: subtask.status === "done" ? "run.done" : "subtask.failed",
          });
        }
      }
    }
  }
  const [hour, minute] = (model.org.rules.reportCadence.dailyBriefAt || "18:00").split(":").map(Number);
  const brief = new Date(model.now);
  brief.setHours(hour || 18, minute || 0, 0, 0);
  if (brief.getTime() > model.now) marks.push({ id: "daily-brief", at: brief.getTime(), title: t("Daily brief"), kind: "scheduled" });
  return marks.filter((mark) => isToday(mark.at)).sort((a, b) => a.at - b.at);
}

// ── header ───────────────────────────────────────────────────────────────────
function Header({
  model,
  view,
  onView,
  lens,
  onLens,
  width,
  needs,
  onNeeds,
  onAdd,
}: {
  model: WorkbenchModel;
  view: View;
  onView: (view: View) => void;
  lens: Lens;
  onLens: (lens: Lens) => void;
  width: number;
  needs: number;
  onNeeds: () => void;
  onAdd: () => void;
}) {
  const title = model.title ?? t("Workbench");
  const hoursLeft = model.deadline ? Math.max(0, Math.floor((model.deadline - model.now) / 3_600_000)) : null;
  const deadlineDay = model.deadline ? deadlineLabel(model.deadline, model.now) : null;
  const work = view === "work";
  const narrow = width > 0 && width < (work ? 1260 : 980);
  const tight = width > 0 && width < (work ? 1120 : 820);
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-hairline/30 px-5 max-md:pl-12">
      <Network size={18} className="shrink-0 text-select" aria-hidden />
      <h1 className="min-w-0 truncate text-[15.5px] font-bold" title={model.activeRun?.goal}>
        {title}
      </h1>
      {deadlineDay && hoursLeft !== null && !tight && (
        <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] whitespace-nowrap text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_70%,transparent)]">
          <Clock size={12} className="text-ink-secondary" />
          {narrow ? t("{hours} h left", { hours: hoursLeft }) : t("Due {when} · {hours} h left", { when: deadlineDay, hours: hoursLeft })}
        </span>
      )}
      {!model.title && model.dispatch.runs.length === 0 && !tight && <span className="truncate text-[12.5px] text-ink-secondary">{t("No job running")}</span>}
      <span className="flex-1" />
      {work && (
        <>
          {!narrow && <span className="text-[12px] text-ink-secondary">{t("Lens")}</span>}
          <LensSwitch lens={lens} onLens={onLens} compact={tight} />
        </>
      )}
      <div role="radiogroup" aria-label={t("Workbench view")} className="inline-flex shrink-0 items-center gap-0.5 rounded-[10px] bg-control p-0.5">
        {(
          [
            { id: "people", label: t("Look at people"), icon: <Users size={14} /> },
            { id: "work", label: t("Look at work"), icon: <Network size={14} /> },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={view === option.id}
            onClick={() => onView(option.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-[13px] whitespace-nowrap transition-colors",
              view === option.id ? "bg-raised font-bold text-ink shadow-[0_1px_2px_rgb(16_24_40/0.1)]" : "font-medium text-ink-secondary hover:text-ink",
            )}
          >
            {option.icon}
            {(!tight || view === option.id) && option.label}
          </button>
        ))}
      </div>
      <Button variant="ghost" size="sm" onClick={onAdd} className="gap-[5px]" title={model.activeRun ? t("Add people to the running job") : t("Nothing is running right now")}>
        <Plus size={13} />
        {t("Add people")}
      </Button>
      {needs > 0 ? (
        <Button variant="warn" size="sm" onClick={onNeeds} className="gap-[7px]">
          <DiamondMark size={11} color="#FFFFFF" />
          {t("Needs you {count}", { count: needs })}
        </Button>
      ) : (
        <Button variant="soft" size="sm" onClick={onNeeds}>
          {t("Brief")}
        </Button>
      )}
    </header>
  );
}

function LensSwitch({ lens, onLens, compact }: { lens: Lens; onLens: (lens: Lens) => void; compact: boolean }) {
  return (
    <div role="radiogroup" aria-label={t("Lens")} className="inline-flex shrink-0 items-center gap-0.5 rounded-[10px] bg-control p-0.5">
      {LENSES.map((item) => {
        // 树 is always on; the other lenses add their layer on top of it
        const on = item.id === "tree" || item.id === lens;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item.id === lens}
            onClick={() => onLens(item.id === lens && item.id !== "tree" ? "tree" : item.id)}
            className={cn(
              "inline-flex h-7 items-center gap-[5px] rounded-lg text-[13px] whitespace-nowrap transition-colors",
              compact ? "px-2" : "px-[11px]",
              on ? "bg-raised font-bold text-ink shadow-[0_1px_2px_rgb(16_24_40/0.1)]" : "font-medium text-ink-secondary hover:text-ink",
            )}
          >
            <i className="size-2 rounded-[2px]" style={{ background: item.color }} />
            {t(item.label)}
          </button>
        );
      })}
    </div>
  );
}

/** "周五 19:30" for a deadline within the week, "今天 18:00" today, else the date. */
function deadlineLabel(at: number, now: number): string {
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? t("today") : days > 0 && days < 7 ? formatDateTime(at, { weekday: "short" }) : formatDateTime(at, { month: "numeric", day: "numeric" });
  return `${day} ${clock(at)}`;
}

/** "Since you last looked": a strip over the tree (the people view has its card). */
function SinceBanner({ model, onPeople, onDismiss }: { model: WorkbenchModel; onPeople: () => void; onDismiss: () => void }) {
  const changes = model.brief.changes;
  const first = changes[changes.length - 1] ?? changes[0];
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline/30 bg-select/[0.04] pr-2 pl-4 text-[12.5px] whitespace-nowrap">
      <RotateCw size={13} className="shrink-0 text-accent-text" />
      <b className="text-ink">{model.lastSeen ? t("Since {time}", { time: clock(model.lastSeen) }) : t("Today")}</b>
      <span className="min-w-0 truncate text-ink-secondary">
        {first?.title}
        {changes.length > 1 ? t(" and {count} more", { count: changes.length - 1 }) : ""}
      </span>
      <Button variant="link" size="sm" className="shrink-0 text-[12.5px]" onClick={onPeople}>
        {t("See who changed")}
      </Button>
      <span className="flex-1" />
      <button type="button" onClick={onDismiss} aria-label={t("Mark as seen")} title={t("Mark as seen")} className="grid size-6 shrink-0 place-items-center rounded-md text-ink-secondary hover:bg-control hover:text-ink">
        <X size={12} />
      </button>
    </div>
  );
}
