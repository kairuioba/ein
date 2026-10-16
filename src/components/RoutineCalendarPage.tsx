// 日历 (U14): routines and scheduled calls on a week / month calendar beside
// the app sidebar. Recurring routines sit in a pinned 例行 lane; calls and
// one-off routines are cards on the grid; the selected entry opens in a right
// detail panel. Webhook triggers, paused routines, the bot filter and the
// drag-a-bot drawer live in the header's ⋯ menu.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  Loader2,
  Pause,
  Plus,
  UsersRound,
  Webhook,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { CalendarSidebar } from "@/components/routines/CalendarSidebar";
import { EventEditor, QuickComposer } from "@/components/routines/EventEditor";
import { EventPanel } from "@/components/routines/EventPanel";
import { MonthGrid } from "@/components/routines/MonthGrid";
import { WeekGrid, useNow } from "@/components/routines/WeekGrid";
import {
  nextHour,
  nextOccurrence,
  projectCalls,
  scheduleLabel,
  type CalendarEventItem,
  type CalendarSelection,
  type CalendarView,
  type EventKind,
  type EventSeed,
} from "@/components/routines/calendar-model";
import { Button, Dialog, Segmented } from "@/components/ui";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import type { CalendarCall } from "@/lib/calendar-calls";
import { CALENDAR_OPEN_EVENT, CALENDAR_OPEN_KEY, useHandOff, type CalendarOpen } from "@/lib/deep-links";
import { addMonths, isRecurringRoutine, monthGridDays, monthLabel, weekRangeLabel } from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { buildDepartments } from "@/lib/org";
import {
  addDays,
  atLocalTime,
  projectedRoutineItems,
  scheduleAt,
  startOfDay,
  startOfWeek,
} from "@/lib/routine-calendar";
import type { Routine, RoutineRunOn } from "@/lib/routines";
import { useOrg } from "@/state/org-api";
import { api, useStore, type Bot } from "@/state/store";

const DRAWER_KEY = "omb-calendar-bot-drawer";

function readDrawer(): boolean {
  try {
    return localStorage.getItem(DRAWER_KEY) === "1";
  } catch {
    return false;
  }
}

function PausedList({ routines, bots, onClose, onEdit }: { routines: Routine[]; bots: Bot[]; onClose: () => void; onEdit: (routine: Routine) => void }) {
  const { dispatch } = useStore();
  return (
    <Dialog open onClose={onClose} label={t("Paused routines")} width={520}>
      <div className="flex items-start justify-between px-5 pb-2 pt-5">
        <div>
          <div className="text-[16px] font-bold text-ink">{t("Paused routines")}</div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">{t("History is kept; no new tasks will run.")}</div>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"><X size={16} /></button>
      </div>
      <div className="max-h-[55vh] space-y-1 overflow-y-auto px-3 pb-4">
        {routines.map((routine) => {
          const bot = bots.find((candidate) => candidate.id === routine.botId);
          return (
            <div key={routine.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-raised-hover">
              {bot && <BotAvatar bot={bot} size={32} />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{routine.name}</div>
                <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary">{scheduleLabel(routine.schedule)}</div>
              </div>
              <Button size="sm" variant="soft" onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })}>{t("Resume")}</Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(routine)}>{t("Edit")}</Button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

export function RoutineEditor({
  routine,
  bots,
  lockedBotId,
  defaultRunOn,
  onClose,
}: {
  routine?: Routine;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  onClose: () => void;
}) {
  const at = routine?.schedule.type === "once"
    ? routine.schedule.at
    : routine?.schedule.type === "daily"
      ? atLocalTime(Date.now(), routine.schedule.time)
      : nextHour();
  return <EventEditor seed={{ kind: "routine", at, durationMinutes: routine?.durationMinutes ?? 30, botIds: lockedBotId ? [lockedBotId] : routine ? [routine.botId] : [], routine }} bots={bots} lockedBotId={lockedBotId} defaultRunOn={defaultRunOn} onClose={onClose} onSavedCall={() => {}} />;
}

/** The ⋯ menu in the header: webhooks, paused routines, the bot filter and the
 * drawer of bots to drag onto the calendar. */
function HeaderMenu({
  webhookCount,
  pausedCount,
  drawerOpen,
  botFilter,
  bots,
  onWebhooks,
  onPaused,
  onDrawer,
  onFilter,
}: {
  webhookCount: number;
  pausedCount: number;
  drawerOpen: boolean;
  botFilter: string;
  bots: Bot[];
  onWebhooks: () => void;
  onPaused: () => void;
  onDrawer: () => void;
  onFilter: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const item = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-ink hover:bg-raised-hover";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("More calendar options")}
        className={cn("relative grid size-[30px] place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink", (open || botFilter !== "all") && "bg-control/70 text-ink")}
      >
        <Ellipsis size={18} />
        {botFilter !== "all" && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-select" />}
      </button>
      {open && (
        <div role="menu" className="animate-pop-in absolute right-0 top-[calc(100%+6px)] z-50 w-[264px] rounded-xl bg-raised p-1.5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent),0_18px_40px_-16px_rgb(16_24_40/0.35)]">
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onWebhooks(); }}>
            <Webhook size={15} className="text-ink-secondary" />
            <span className="flex-1">{t("Webhook triggers")}</span>
            {webhookCount > 0 && <span className="text-[12px] text-ink-secondary">{webhookCount}</span>}
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onPaused(); }} disabled={pausedCount === 0}>
            <Pause size={15} className="text-ink-secondary" />
            <span className={cn("flex-1", pausedCount === 0 && "text-ink-secondary")}>{t("Paused routines")}</span>
            <span className="text-[12px] text-ink-secondary">{pausedCount}</span>
          </button>
          <button role="menuitemcheckbox" aria-checked={drawerOpen} type="button" className={item} onClick={() => { setOpen(false); onDrawer(); }}>
            <UsersRound size={15} className="text-ink-secondary" />
            <span className="flex-1">{drawerOpen ? t("Hide bots to drag in") : t("Show bots to drag in")}</span>
          </button>
          <div className="my-1 h-px bg-hairline/30" />
          <label className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-ink-secondary">
            <span className="shrink-0">{t("Show")}</span>
            <select value={botFilter} onChange={(event) => onFilter(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-control/60 px-2 py-1.5 text-[12.5px] text-ink outline-none">
              <option value="all">{t("Everyone")}</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

export function RoutinesPage({ onOpenRoom }: { onBack?: () => void; onOpenRoom: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const { data: org } = useOrg();
  const now = useNow();
  const [section, setSection] = useState<"calendar" | "webhooks">("calendar");
  const [view, setView] = useState<CalendarView>(7);
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [botFilter, setBotFilter] = useState("all");
  const [calls, setCalls] = useState<CalendarCall[]>([]);
  const [quick, setQuick] = useState<EventSeed | null>(null);
  const [editor, setEditor] = useState<EventSeed | null>(null);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(readDrawer);
  const [error, setError] = useState("");
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const rangeStart = view === "month" ? monthGridDays(anchor)[0]! : view === 7 ? startOfWeek(anchor) : startOfDay(anchor);
  const rangeEnd = view === "month" ? addDays(rangeStart, 42) : addDays(rangeStart, view);
  const step = (direction: 1 | -1) => setAnchor((current) => view === "month" ? addMonths(current, direction) : addDays(current, direction * view));

  const loadCalls = useCallback(async () => {
    try {
      const response = await api("/api/calendar-calls");
      setCalls(response.calls ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => { void loadCalls(); }, [loadCalls]);

  // department colour per bot: the bar on its cards and lane rows
  const colors = useMemo(() => {
    const bySection = new Map(buildDepartments(visibleBots, org).map((department) => [department.section, department.color]));
    return new Map(state.bots.map((bot) => [bot.id, bySection.get(bot.section?.trim() ?? "") ?? "var(--color-ink-secondary)"]));
  }, [state.bots, visibleBots, org]);
  const colorFor = useCallback((botId: string | undefined) => (botId && colors.get(botId)) || "var(--color-ink-secondary)", [colors]);

  const matchesFilter = useCallback((item: CalendarEventItem) =>
    botFilter === "all" || (item.kind === "call" ? item.call.botIds.includes(botFilter) : (item.routine?.botId ?? item.run?.botId) === botFilter),
  [botFilter]);
  const items = useMemo<CalendarEventItem[]>(() => {
    const routineItems = projectedRoutineItems(state.routines, state.routineRuns, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "routine" as const }));
    const callItems = projectCalls(calls, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "call" as const }));
    return [...routineItems, ...callItems].filter(matchesFilter).sort((left, right) => left.at - right.at);
  }, [state.routines, state.routineRuns, calls, rangeStart, rangeEnd, matchesFilter]);
  // the week grid leaves recurring routines to the 例行 lane
  const gridItems = view === "month" ? items : items.filter((item) => item.kind === "call" || !isRecurringRoutine(item.routine));
  const laneRoutines = useMemo(
    () => state.routines
      .filter((routine) => routine.enabled && isRecurringRoutine(routine) && (botFilter === "all" || routine.botId === botFilter))
      .sort((a, b) => (a.schedule.type === "daily" ? a.schedule.time : "").localeCompare(b.schedule.type === "daily" ? b.schedule.time : "") || a.createdAt - b.createdAt),
    [state.routines, botFilter],
  );

  const paused = state.routines.filter((routine) => !routine.enabled && (routine.schedule.type === "daily" || routine.schedule.at > Date.now()));
  const running = state.routineRuns.filter((run) => ["queued", "running", "waiting"].includes(run.status)).length;
  const unseenFailures = state.routineRuns.filter((run) => ["failed", "missed"].includes(run.status) && !run.seenAt).length;
  const macInset = capabilities.windowChrome === "mac-inset";
  const dragStyle = macInset ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined;
  const noDragStyle = macInset ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;

  const goToday = useCallback(() => setAnchor(startOfDay(Date.now())), []);
  const openCreate = useCallback((seed?: Partial<EventSeed>) => {
    setQuick({ kind: "routine", at: nextHour(), durationMinutes: 30, botIds: botFilter === "all" ? [] : [botFilter], ...seed });
  }, [botFilter]);
  const changeView = (next: CalendarView) => {
    setView(next);
    setAnchor((current) => startOfDay(current));
  };
  const toggleDrawer = () => setDrawerOpen((open) => {
    try {
      localStorage.setItem(DRAWER_KEY, open ? "0" : "1");
    } catch {
      /* remembered for this session only */
    }
    return !open;
  });

  const open = (next: CalendarSelection) => {
    setSelection(next);
    const runId = next.kind === "routine" ? next.runId : next.kind === "run" ? next.runId : undefined;
    const run = runId ? state.routineRuns.find((candidate) => candidate.id === runId) : undefined;
    if (run && ["failed", "missed"].includes(run.status) && !run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: run.id });
  };
  const openRoutine = (routine: Routine) => {
    const at = nextOccurrence(routine.schedule) ?? (routine.schedule.type === "daily" ? atLocalTime(Date.now(), routine.schedule.time) : routine.schedule.at);
    const failed = state.routineRuns.find((run) => run.routineId === routine.id && ["failed", "missed"].includes(run.status) && !run.seenAt);
    setSelection({ kind: "routine", routineId: routine.id, at });
    if (failed) dispatch({ type: "markRoutineRunSeen", runId: failed.id });
  };

  // ⌘K (or another page) asked to show one routine: open its panel, on the
  // week it next runs, once the routine list has it
  const [linkedRoutineId, setLinkedRoutineId] = useState<string | null>(null);
  useHandOff<CalendarOpen>(CALENDAR_OPEN_KEY, CALENDAR_OPEN_EVENT, (detail) => {
    if (detail.routineId) setLinkedRoutineId(detail.routineId);
  });
  useEffect(() => {
    if (!linkedRoutineId) return;
    const routine = state.routines.find((candidate) => candidate.id === linkedRoutineId);
    if (!routine) return;
    setLinkedRoutineId(null);
    setSection("calendar");
    const at = nextOccurrence(routine.schedule) ?? (routine.schedule.type === "daily" ? atLocalTime(Date.now(), routine.schedule.time) : routine.schedule.at);
    setAnchor(startOfDay(at));
    openRoutine(routine);
    // openRoutine reads the latest state; it is not a dependency worth re-running for
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRoutineId, state.routines]);

  // a selection whose entry was deleted elsewhere closes the panel
  useEffect(() => {
    if (!selection) return;
    const exists = selection.kind === "routine"
      ? state.routines.some((routine) => routine.id === selection.routineId)
      : selection.kind === "call"
        ? calls.some((call) => call.id === selection.callId)
        : state.routineRuns.some((run) => run.id === selection.runId);
    if (!exists) setSelection(null);
  }, [selection, state.routines, state.routineRuns, calls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "Escape") { setQuick(null); setEditor(null); setSelection(null); return; }
      if (section !== "calendar" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "c") { event.preventDefault(); openCreate(); }
      if (event.key.toLowerCase() === "t") goToday();
      if (event.key === "1") changeView(1);
      if (event.key === "3") changeView(3);
      if (event.key.toLowerCase() === "w") changeView(7);
      if (event.key.toLowerCase() === "m") changeView("month");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, openCreate, goToday]);

  const upsertCall = (call: CalendarCall) => setCalls((current) => current.some((candidate) => candidate.id === call.id) ? current.map((candidate) => candidate.id === call.id ? call : candidate) : [call, ...current]);
  const moveEvent = async (dragged: { kind: EventKind; id: string; at: number }, nextAt: number) => {
    if (nextAt === dragged.at) return;
    try {
      if (dragged.kind === "routine") {
        const routine = state.routines.find((candidate) => candidate.id === dragged.id);
        if (!routine) return;
        if (routine.schedule.type === "daily" && !window.confirm(t("Move this entire recurring series?"))) return;
        const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(routine.schedule, dragged.at, nextAt) }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const call = calls.find((candidate) => candidate.id === dragged.id);
        if (!call) return;
        if (call.schedule.type === "daily" && !window.confirm(t("Move this entire recurring series?"))) return;
        const response = await api(`/api/calendar-calls/${call.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(call.schedule, dragged.at, nextAt) }) });
        upsertCall(response.call);
        if (selection?.kind === "call" && selection.callId === call.id) setSelection({ ...selection, at: nextAt });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const resizeEvent = async (item: CalendarEventItem, durationMinutes: number) => {
    try {
      if (item.kind === "routine" && item.routine) {
        const response = await api(`/api/routines/${item.routine.id}`, { method: "PATCH", body: JSON.stringify({ durationMinutes }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else if (item.kind === "call") {
        const response = await api(`/api/calendar-calls/${item.call.id}`, { method: "PATCH", body: JSON.stringify({ durationMinutes }) });
        upsertCall(response.call);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rangeLabel = view === "month" ? monthLabel(anchor) : weekRangeLabel(rangeStart, view, now);
  const viewOptions = [
    { value: "1" as const, label: t("Day") },
    { value: "3" as const, label: t("3 days") },
    { value: "7" as const, label: t("Week") },
    { value: "month" as const, label: t("Month view") },
  ];

  return (
    <main className="animate-workspace-in flex h-full min-w-0 flex-1 bg-stage">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-2 py-2 pl-6 pr-4" style={dragStyle}>
          <h1 className="text-[22px] font-bold tracking-[-0.2px] text-ink">{t("Calendar")}</h1>
          <span className="mx-1.5 h-[18px] w-px bg-hairline/50" aria-hidden />
          {section === "calendar" ? (
            <>
              <Button variant="soft" size="sm" onClick={goToday} style={noDragStyle}>{t("Today")}</Button>
              <span className="flex" style={noDragStyle}>
                <button type="button" onClick={() => step(-1)} className="grid size-7 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink" aria-label={t("Previous dates")}><ChevronLeft size={18} /></button>
                <button type="button" onClick={() => step(1)} className="grid size-7 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink" aria-label={t("Next dates")}><ChevronRight size={18} /></button>
              </span>
              <span className="ml-0.5 text-[16px] font-bold tracking-[-0.1px] whitespace-nowrap tabular-nums text-ink">{rangeLabel}</span>
              {running > 0 && <span className="ml-1 hidden h-6 items-center gap-1.5 rounded-full bg-select/10 px-2.5 text-[11.5px] font-semibold text-accent-text sm:inline-flex"><Loader2 size={11} className="animate-spin" />{t("{count} active", { count: running })}</span>}
              {unseenFailures > 0 && <span className="hidden h-6 items-center gap-1.5 rounded-full bg-danger/10 px-2.5 text-[11.5px] font-semibold text-danger sm:inline-flex"><CircleAlert size={11} />{t("{count} failed", { count: unseenFailures })}</span>}
            </>
          ) : (
            <span className="text-[16px] font-bold text-ink">{t("Webhook triggers")}</span>
          )}
          <span className="flex-1" />
          <span className="flex items-center gap-1.5" style={noDragStyle}>
            {section === "calendar" && (
              <Segmented
                label={t("Calendar view")}
                value={String(view) as "1" | "3" | "7" | "month"}
                onChange={(value) => changeView(value === "month" ? "month" : (Number(value) as 1 | 3 | 7))}
                options={viewOptions}
              />
            )}
            <HeaderMenu
              webhookCount={state.webhooks.length}
              pausedCount={paused.length}
              drawerOpen={drawerOpen}
              botFilter={botFilter}
              bots={visibleBots}
              onWebhooks={() => { setSection("webhooks"); setSelection(null); }}
              onPaused={() => setPausedOpen(true)}
              onDrawer={toggleDrawer}
              onFilter={setBotFilter}
            />
            <Button size="sm" onClick={() => openCreate()} disabled={!visibleBots.length} className="ml-0.5"><Plus size={15} strokeWidth={2.4} />{t("New")}</Button>
          </span>
        </header>
        {(section === "webhooks" || error) && (
          <div className="-mt-1 flex shrink-0 items-center gap-2 px-6 pb-2" style={noDragStyle}>
            {section === "webhooks" && (
              <Segmented
                size="sm"
                label={t("Calendar sections")}
                value={section}
                onChange={setSection}
                options={[
                  { value: "calendar", label: t("Calendar") },
                  { value: "webhooks", label: <>{t("Webhooks")}{state.webhooks.length > 0 && <span className="text-ink-secondary">{state.webhooks.length}</span>}</> },
                ]}
              />
            )}
            {error && <button type="button" onClick={() => setError("")} className="ml-auto flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11.5px] text-danger"><CircleAlert size={12} />{error}<X size={12} /></button>}
          </div>
        )}

        {section === "webhooks" ? (
          <WebhooksPanel bots={visibleBots} />
        ) : (
          <div className="flex min-h-0 flex-1 border-t border-hairline/45">
            {drawerOpen && (
              <div className="hidden shrink-0 md:block">
                <CalendarSidebar bots={visibleBots} anchor={anchor} onSelectDate={(at) => setAnchor(startOfDay(at))} />
              </div>
            )}
            {view === "month" ? (
              <MonthGrid
                anchor={anchor}
                items={gridItems}
                bots={state.bots}
                colorFor={colorFor}
                selection={selection}
                now={now}
                onOpen={open}
                onPickDay={(day) => { setAnchor(day); setView(1); }}
                onCreate={openCreate}
              />
            ) : (
              <WeekGrid
                rangeStart={rangeStart}
                days={view}
                items={gridItems}
                laneRoutines={laneRoutines}
                runs={state.routineRuns}
                bots={state.bots}
                colorFor={colorFor}
                selection={selection}
                now={now}
                onOpen={open}
                onOpenRoutine={openRoutine}
                onCreate={openCreate}
                onMove={(item, at) => void moveEvent(item, at)}
                onResize={(item, duration) => void resizeEvent(item, duration)}
              />
            )}
          </div>
        )}
      </div>

      {selection && section === "calendar" && (
        <EventPanel
          selection={selection}
          calls={calls}
          onClose={() => setSelection(null)}
          onEdit={(seed) => setEditor(seed)}
          onAddAnother={(seed) => setEditor(seed)}
          onCallDeleted={(id) => setCalls((current) => current.filter((call) => call.id !== id))}
          onOpenRoom={onOpenRoom}
        />
      )}

      {quick && <><div className="fixed inset-0 z-40 bg-[rgb(20_22_28/0.12)]" onMouseDown={() => setQuick(null)} /><QuickComposer seed={quick} bots={visibleBots} onClose={() => setQuick(null)} onMore={(seed) => { setQuick(null); setEditor(seed); }} onSavedRoutine={(routine) => dispatch({ type: "routinePatched", routine })} onSavedCall={upsertCall} /></>}
      {editor && <EventEditor seed={editor} bots={visibleBots} onClose={() => setEditor(null)} onSavedCall={upsertCall} />}
      {pausedOpen && <PausedList routines={paused} bots={state.bots} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); const at = routine.schedule.type === "once" ? routine.schedule.at : atLocalTime(Date.now(), routine.schedule.time); setEditor({ kind: "routine", at, durationMinutes: routine.durationMinutes, botIds: [routine.botId], routine }); }} />}
    </main>
  );
}
