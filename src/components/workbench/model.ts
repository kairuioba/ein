// Everything the workbench draws, gathered once per render: bots and groups
// from the store, dispatch runs (polled), and the company layer (org, brief,
// spend, library, decisions — each falls back to empty while the server
// routes are missing). Views get plain data and stay renderers.
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildDepartments, chiefBot, squads, unassignedBots, type DepartmentView } from "@/lib/org";
import { mascotForBot, type MascotKind } from "@/lib/engine-mascots";
import { EMPTY_TEAM_MAP_SNAPSHOT, type TeamMapSnapshot } from "@/lib/team-map";
import {
  activeRun,
  departmentStats,
  isActiveRun,
  peopleStates,
  projectTitle,
  runDeadline,
  type DeptStats,
  type PersonState,
} from "@/lib/workbench";
import { EMPTY_BRIEF, EMPTY_ORG, EMPTY_USAGE, getLastSeen, useBrief, useDecisions, useLibrary, useOrg, useUsageSummary } from "@/state/org-api";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { DEFAULT_DISPATCH_SETTINGS, type DispatchRoute, type DispatchRun, type DispatchSettings } from "../../../shared/dispatch-types";
import { DEFAULT_ORG_RULES, type Brief, type InboxItem, type LibraryDoc, type OrgConfig, type OrgDecision, type UsageSummary } from "../../../shared/org-types";

import { useNow } from "./parts";

export interface DispatchState {
  runs: DispatchRun[];
  routes: DispatchRoute[];
  settings: DispatchSettings;
  snapshot: TeamMapSnapshot;
}

const EMPTY_STATE: DispatchState = { runs: [], routes: [], settings: DEFAULT_DISPATCH_SETTINGS, snapshot: EMPTY_TEAM_MAP_SNAPSHOT };

/** Poll the dispatch hub while the workbench is open. */
export function useDispatchState(intervalMs = 2_000) {
  const [data, setData] = useState<DispatchState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = (await api("/api/dispatch/state")) as Partial<DispatchState>;
      setData({
        runs: next.runs ?? [],
        routes: next.routes ?? [],
        settings: { ...DEFAULT_DISPATCH_SETTINGS, ...next.settings },
        snapshot: { ...EMPTY_TEAM_MAP_SNAPSHOT, ...next.snapshot },
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);
  return { ...data, error, refresh };
}

export type BotWithMeta = Bot & { createdAt?: number };

export interface Room {
  key: string;
  section: string;
  label: string;
  color: string;
  isolated: boolean;
  lead?: BotWithMeta;
  /** the lead plus the first squad: one group, no box */
  main: BotWithMeta[];
  /** squads after the first, drawn as dashed sub-rooms (组 B …) */
  squads: BotWithMeta[][];
  /** every bot in the room, lead first */
  everyone: BotWithMeta[];
  unassigned?: boolean;
}

export interface WorkbenchModel {
  now: number;
  lastSeen: number;
  bots: BotWithMeta[];
  botById: Map<string, BotWithMeta>;
  groups: Group[];
  org: OrgConfig;
  chief?: BotWithMeta;
  rooms: Room[];
  roomOf: Map<string, Room>;
  span: number;
  dispatch: DispatchState & { error: string | null; refresh: () => Promise<void> };
  activeRun?: DispatchRun;
  title: string | null;
  deadline: number | null;
  states: Map<string, PersonState>;
  stats: Map<string, DeptStats>;
  brief: Brief;
  briefLoaded: boolean;
  needsYou: InboxItem[];
  usage: UsageSummary;
  library: LibraryDoc[];
  decisions: OrgDecision[];
  mascotOf: (bot: Pick<Bot, "modelSelection">) => MascotKind;
  driverOf: (bot: Pick<Bot, "modelSelection">) => string | undefined;
}

export const UNASSIGNED = "__unassigned__";

export function useWorkbenchModel(): WorkbenchModel {
  const { state } = useStore();
  const now = useNow(20_000);
  // "since you last looked" is the moment this visit started from
  const [lastSeen] = useState(getLastSeen);
  const dispatch = useDispatchState();
  const { data: orgData } = useOrg();
  const { data: briefData, loaded: briefLoaded, error: briefError } = useBrief(lastSeen);
  const { data: usageData } = useUsageSummary();
  const { data: libraryData } = useLibrary();
  const { data: decisionData } = useDecisions();
  // a server still growing its routes may send partial objects
  const org = useMemo<OrgConfig>(() => ({ ...EMPTY_ORG, ...orgData, rules: { ...DEFAULT_ORG_RULES, ...orgData?.rules } }), [orgData]);
  const brief = useMemo<Brief>(() => ({ ...EMPTY_BRIEF, ...briefData }), [briefData]);
  const usageSummary = useMemo<UsageSummary>(() => ({ ...EMPTY_USAGE, ...usageData }), [usageData]);

  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden) as BotWithMeta[], [state.bots]);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const chief = useMemo(() => chiefBot(bots, org), [bots, org]);
  const span = Math.max(2, org.rules?.spanOfControl || 5);

  const rooms = useMemo(() => {
    const out: Room[] = buildDepartments(bots, org).map((dept: DepartmentView<BotWithMeta>) => {
      const groups = squads(dept.members, span);
      const main = [...(dept.lead ? [dept.lead] : []), ...(groups[0] ?? [])];
      return {
        key: dept.section,
        section: dept.section,
        label: dept.section,
        color: dept.color,
        isolated: Boolean(dept.settings?.isolated),
        lead: dept.lead,
        main,
        squads: groups.slice(1),
        everyone: [...main, ...groups.slice(1).flat()],
      };
    });
    const loose = unassignedBots(bots, org);
    if (loose.length) {
      const groups = squads(loose, Math.max(span, 6));
      out.push({ key: UNASSIGNED, section: "", label: "", color: "#9AA0AC", isolated: false, main: groups[0] ?? [], squads: groups.slice(1), everyone: loose, unassigned: true });
    }
    // isolated rooms close the first row, so the glass room sits at the edge
    return [...out.filter((room) => !room.isolated && !room.unassigned), ...out.filter((room) => room.isolated), ...out.filter((room) => room.unassigned)];
  }, [bots, org, span]);

  const roomOf = useMemo(() => {
    const map = new Map<string, Room>();
    for (const room of rooms) for (const bot of room.everyone) map.set(bot.id, room);
    return map;
  }, [rooms]);

  const runs = dispatch.runs;
  // the inbox comes from the brief; a live "waiting on you" flag also counts
  const needsYou = brief.needsYou;
  const states = useMemo(() => {
    const leads = new Set(rooms.map((room) => room.lead?.id).filter((id): id is string => Boolean(id)));
    const busySections = new Map<string, { done: number; total: number }>();
    for (const room of rooms) {
      const ids = new Set(room.everyone.map((bot) => bot.id));
      const subtasks = runs.filter(isActiveRun).flatMap((run) => run.subtasks.filter((subtask) => ids.has(subtask.assigneeBotId)));
      if (subtasks.some((subtask) => subtask.status === "running" || subtask.status === "pending")) {
        busySections.set(room.section, { done: subtasks.filter((subtask) => subtask.status === "done").length, total: subtasks.length });
      }
    }
    return peopleStates({
      bots,
      runs,
      inbox: needsYou,
      risks: brief.risks,
      chiefId: chief?.id,
      leads,
      busySections,
      taskTitle: (botId) => {
        const bot = botById.get(botId);
        return bot?.tasks?.find((task) => task.threadId === bot.threadId)?.title;
      },
      maxAttempts: dispatch.settings.maxAttempts,
      lastSeen,
      now,
    });
  }, [bots, runs, needsYou, brief.risks, chief?.id, rooms, botById, dispatch.settings.maxAttempts, lastSeen, now]);

  const stats = useMemo(
    () => departmentStats(rooms.filter((room) => !room.unassigned).map((room) => ({ section: room.section, botIds: room.everyone.map((bot) => bot.id) })), runs, states, brief.departments),
    [rooms, runs, states, brief.departments],
  );

  const library = useMemo(() => libraryData?.docs ?? [], [libraryData]);
  const decisions = useMemo(() => [...(decisionData?.decisions ?? [])].sort((a, b) => b.at - a.at), [decisionData]);
  const current = activeRun(runs);
  const mascotOf = useCallback((bot: Pick<Bot, "modelSelection">) => mascotForBot(bot, state.instances), [state.instances]);
  const driverOf = useCallback(
    (bot: Pick<Bot, "modelSelection">) => state.instances.find((instance) => instance.instanceId === bot.modelSelection?.instanceId)?.driverKind,
    [state.instances],
  );

  return {
    now,
    lastSeen,
    bots,
    botById,
    groups: state.groups,
    org,
    chief,
    rooms,
    roomOf,
    span,
    dispatch,
    activeRun: current,
    title: projectTitle(runs),
    deadline: runDeadline(current, now),
    states,
    stats,
    brief,
    briefLoaded: briefLoaded && !briefError,
    needsYou,
    usage: usageSummary.budgetPerDay || usageSummary.todayCost ? usageSummary : brief.spend,
    library,
    decisions,
    mascotOf,
    driverOf,
  };
}
