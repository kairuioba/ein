// Dispatch hub (调度中枢): a Chief of Staff hands in a structured plan, and
// the harness — not the model — runs it.
//
//   submit_plan (Chief) ─▶ validate the DAG ─▶ assign each subtask to a team
//   member, creating a specialist with a recommended model when nobody fits
//   ─▶ run ready subtasks in parallel, each in its own task conversation,
//   feeding finished results to the subtasks that depend on them ─▶ when
//   everything has settled, ask the Chief for one consolidated report; the
//   run is done when that report turn completes.
//
// The company layer (shared/org-types.ts, DATA_DIR/org.json) adds two things:
//   · The org's chief (主 Bot) plans across departments: its team is every
//     department lead, the unsectioned bots and its explicit routes. A lead
//     given such a subtask may plan it for its own section with submit_plan —
//     a child run — and the subtask finishes when that run's report does.
//     That is the only second level: the lead's own workers cannot plan.
//   · People can be added to a running job (server/dispatch-diagnose.ts):
//     diagnose first, then a squad takes only subtasks nobody has started.
//
// Upstream's delegate_bot stays available for ad-hoc single handoffs; this
// module is the deterministic path for multi-step work. Workers run at comms
// depth 1 (no team tools), so a dispatched subtask can never dispatch again —
// except for the department lead above, who gets submit_plan alone.
//
// Dispatch routes (派发通道) are the workbench's wires: by default a Chief
// can dispatch to every visible member of its own section; an explicit route
// adds a bot from any section, and an unplugged route removes one.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { t } from "../shared/i18n.ts";
import { reasonLabel } from "./reason-labels.ts";
import { profileFor, type Capability } from "../shared/model-profiles.ts";
import { assessTask, effortFor, type Effort, type Recommendation, type RecommendationPolicy, type TaskProfile } from "../shared/model-recommender.ts";
import { DEFAULT_ORG_RULES, type OrgEventKind, type OrgRules } from "../shared/org-types.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId, type ModelSelection } from "./contracts.ts";
import {
  diagnoseRun,
  MIN_REVIEW_WINDOW_MS,
  planSquad,
  REVIEW_AFTER_MS,
  reviewSquad,
  typicalDuration,
  USD_TO_CNY,
  type DiagnoseContext,
  type NewcomerModel,
} from "./dispatch-diagnose.ts";

export {
  DEFAULT_DISPATCH_SETTINGS,
  dispatchSettings,
  type DispatchAmendResult,
  type DispatchDiagnosis,
  type DispatchRoute,
  type DispatchRun,
  type DispatchSettings,
  type DispatchSquad,
  type DispatchSubtask,
  type RunStatus,
  type SubtaskStatus,
} from "../shared/dispatch-types.ts";
import type {
  DispatchAmendResult,
  DispatchDiagnosis,
  DispatchRoute,
  DispatchRun,
  DispatchSettings,
  DispatchSquad,
  DispatchSubtask,
  RunStatus,
  SubtaskStatus,
} from "../shared/dispatch-types.ts";

/** What the planner sends, before validation. */
export interface PlanInput {
  goal?: unknown;
  subtasks?: unknown;
}

// ── host: everything the dispatcher needs from the harness ──────────────

export interface DispatchBot {
  id: string;
  name: string;
  title: string;
  description: string;
  section?: string;
  busy?: boolean;
  /** the store's activity ("working", "waiting-on-you", …) */
  activity?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  modelSelection: ModelSelection;
}

export interface DispatchTurnOptions {
  threadId: string;
  /** a control-plane continuation in the chief's own conversation (the report) */
  continuation?: boolean;
  /** the conversation the work came from: the turn inherits its bot's unattended window */
  sourceThreadId?: string;
  /** a department lead working for the org chief may plan its own section (submit_plan only) */
  mayPlan?: boolean;
  /** startTurn resolves before its asynchronous setup; a setup failure is
   * reported here instead (it never emits turn.completed). "interrupted"
   * when the owner stopped the turn during setup. */
  onError?: (message: string) => void;
  /** this turn only: another engine you are signed in to (absent = the
   * bot's own), a model on it, and how hard to think */
  instanceId?: string;
  model?: string;
  effort?: Effort;
}

/** What one engine offers a subtask: its models and effort levels. */
export interface EngineKnobs {
  models: string[];
  /** the model a pick on this engine falls back to */
  defaultModel?: string;
  effortLevels: readonly string[];
  /** signed in and running; false when it needs setup */
  ready?: boolean;
  /** can coordinate teammates (a department lead's plan needs this) */
  coordinates?: boolean;
}

const NO_KNOBS: EngineKnobs = { models: [], effortLevels: [] };

/** An entry for the company timeline (shared/org-types.ts OrgEvent). */
export interface DispatchOrgEvent {
  kind: OrgEventKind;
  title: string;
  botId?: string;
  section?: string;
  runId?: string;
  threadId?: string;
  severity?: "info" | "warn" | "error";
}

export interface DispatchHost {
  bots(): DispatchBot[];
  bot(id: string): DispatchBot | undefined;
  /** Create a specialist with safe defaults (no connected apps, no auto-approval). */
  createBot(input: { name: string; title: string; description: string; section?: string; modelSelection: ModelSelection }): DispatchBot;
  /** A detached task conversation for one subtask. */
  createTask(botId: string, title: string): { threadId: string } | null;
  /** Start a turn; rejects when the bot cannot start (busy, missing, no engine). */
  startTurn(botId: string, text: string, opts: DispatchTurnOptions): Promise<void>;
  interrupt(botId: string, threadId: string): Promise<void>;
  /** A status chip in a conversation. */
  activity(threadId: string, label: string, ok?: boolean): void;
  recommend(task: TaskProfile, policy: RecommendationPolicy): Recommendation | null;
  /** an engine's models and effort levels (empty when it has none, or is gone) */
  engineKnobs?(instanceId: string): EngineKnobs;
  broadcast(run: DispatchRun): void;
  broadcastRoutes(routes: DispatchRoute[]): void;
  settings(): DispatchSettings;
  maxBots: number;
  /** What a task conversation has spent so far (for cost estimates). */
  usage?(botId: string, threadId: string): { costUsd?: number | null } | null | undefined;
  /** An engine instance's display name. */
  engineName?(instanceId: string): string;
  /** "Engine · Model" for a model selection. */
  modelLabel?(selection: ModelSelection): string;
  /** Record a company event (people added, squad reviews). */
  event?(event: DispatchOrgEvent): void;
}

// ── plan validation ────────────────────────────────────────────────────

const ID_PATTERN = /^[\w-]{1,32}$/;
const CAPABILITY_SET = new Set<string>(["coding", "reasoning", "writing", "chinese", "vision", "computer", "longContext", "speed"]);
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

export interface ValidPlanSubtask {
  id: string;
  title: string;
  brief: string;
  role: string;
  needs: Capability[];
  difficulty?: number;
  dependsOn: string[];
  acceptance?: string;
  assignee?: string;
}

/** Normalize and validate a plan. Errors are written for the planning model:
 * each says exactly what to send instead. */
export function validatePlan(input: PlanInput, maxSubtasks: number): { goal: string; subtasks: ValidPlanSubtask[] } | { error: string } {
  const goal = text(input.goal, 2_000);
  if (!goal) return { error: "submit_plan needs `goal`: one sentence describing the overall outcome." };
  let raw = input.subtasks;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: "`subtasks` must be a JSON array of objects, not text." };
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return { error: "`subtasks` must be a non-empty array." };
  if (raw.length > maxSubtasks) {
    return { error: `This plan has ${raw.length} subtasks; the limit is ${maxSubtasks}. Merge related steps and submit again.` };
  }
  const subtasks: ValidPlanSubtask[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: `subtasks[${index}] must be an object.` };
    const item = entry as Record<string, unknown>;
    const id = text(item.id, 32) || `s${index + 1}`;
    if (!ID_PATTERN.test(id)) return { error: `subtasks[${index}].id "${id}" may only contain letters, digits, "_" and "-".` };
    if (ids.has(id)) return { error: `Duplicate subtask id "${id}". Give every subtask a unique id.` };
    ids.add(id);
    const title = text(item.title, 120);
    const brief = text(item.brief ?? item.instructions ?? item.description, 6_000);
    if (!title || !brief) return { error: `subtasks[${index}] needs a short "title" and a self-contained "brief".` };
    const role = text(item.role, 80) || title;
    const needs = (Array.isArray(item.needs) ? item.needs : [])
      .map((need) => String(need).trim())
      .filter((need): need is Capability => CAPABILITY_SET.has(need));
    const difficulty = Number(item.difficulty);
    const dependsOnRaw = item.depends_on ?? item.dependsOn ?? [];
    const dependsOn = (Array.isArray(dependsOnRaw) ? dependsOnRaw : [dependsOnRaw])
      .map((dep) => String(dep).trim())
      .filter(Boolean);
    const subtask: ValidPlanSubtask = { id, title, brief, role, needs, dependsOn };
    if (Number.isFinite(difficulty)) subtask.difficulty = Math.min(5, Math.max(1, Math.round(difficulty)));
    const acceptance = text(item.acceptance, 1_000);
    if (acceptance) subtask.acceptance = acceptance;
    const assignee = text(item.assignee ?? item.bot_id ?? item.botId, 80);
    if (assignee) subtask.assignee = assignee;
    subtasks.push(subtask);
  }
  for (const subtask of subtasks) {
    for (const dep of subtask.dependsOn) {
      if (!ids.has(dep)) return { error: `Subtask "${subtask.id}" depends on unknown id "${dep}".` };
      if (dep === subtask.id) return { error: `Subtask "${subtask.id}" cannot depend on itself.` };
    }
  }
  const cycle = findCycle(subtasks);
  if (cycle) return { error: `The dependencies form a cycle (${cycle.join(" → ")}). Remove one dependency and submit again.` };
  return { goal, subtasks };
}

/** Return one dependency cycle as a list of ids, or null for a DAG. */
export function findCycle(subtasks: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>): string[] | null {
  const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const subtask of subtasks) {
    const cycle = visit(subtask.id);
    if (cycle) return cycle;
  }
  return null;
}

// ── matching ───────────────────────────────────────────────────────────

/** Tokens for fuzzy role matching: lower-cased Latin words plus CJK bigrams,
 * so "前端工程师" and "资深前端开发" share "前端". */
export function roleTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  const lower = value.toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) if (word.length > 1) tokens.add(word);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

// Seniority words and generic job suffixes carry no signal about WHAT a
// specialist does: "资深前端开发" and "前端工程师" are the same role.
const ROLE_NOISE = /资深|高级|初级|首席|专职|兼职|senior|junior|lead|principal|staff|(开发)?工程师|开发者|开发|专员|专家|顾问|经理|主管|助理|负责人|(?<=设计|分析|规划|咨询)师|engineer|developer|specialist|expert|manager|assistant|consultant|\bthe\b|\ba\b/g;

/** The part of a role that says what the person does. */
export function roleCore(role: string): string {
  const core = role.toLowerCase().replace(ROLE_NOISE, " ").replace(/\s+/g, " ").trim();
  return core || role.toLowerCase().trim();
}

/** How well `profile` (a bot's title, description and name) fits `role`:
 * 0.85 when the role's core appears verbatim, otherwise the share of the
 * core's tokens the profile contains. */
export function roleSimilarity(role: string, profile: string): number {
  const core = roleCore(role);
  const haystack = profile.toLowerCase();
  const parts = core.split(" ").filter((part) => part.length >= 2);
  if (parts.length && parts.every((part) => haystack.includes(part))) return 0.85;
  const left = roleTokens(core);
  const right = roleTokens(haystack);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / left.size;
}

const REUSE_THRESHOLD = 0.34;

// ── the org config (written by the company layer) ───────────────────────

/** The part of DATA_DIR/org.json dispatch reads. */
export interface OrgSnapshot {
  /** the 主 Bot; null = no org chief (dispatch behaves per section) */
  chiefBotId: string | null;
  rules: OrgRules;
  departments: Array<{ section: string; budgetPerDay?: number; headcount?: number }>;
}

const finiteNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Read an org config defensively: anything missing or malformed falls back
 * to the defaults (shared/org-types.ts), so a half-written file never breaks dispatch. */
export function readOrgSnapshot(raw: unknown): OrgSnapshot {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rulesRaw = record.rules && typeof record.rules === "object" ? (record.rules as Record<string, unknown>) : {};
  const chiefMayRaw = rulesRaw.chiefMay && typeof rulesRaw.chiefMay === "object" ? (rulesRaw.chiefMay as Record<string, unknown>) : {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const d = DEFAULT_ORG_RULES;
  const span = finiteNumber(rulesRaw.spanOfControl);
  const budget = finiteNumber(rulesRaw.budgetPerDay);
  const rules: OrgRules = {
    ...d,
    spanOfControl: span !== undefined && span >= 2 ? Math.trunc(span) : d.spanOfControl,
    budgetPerDay: budget !== undefined && budget >= 0 ? budget : d.budgetPerDay,
    chiefMay: {
      addPeople: flag(chiefMayRaw.addPeople, d.chiefMay.addPeople),
      newSpecialist: flag(chiefMayRaw.newSpecialist, d.chiefMay.newSpecialist),
      switchModel: flag(chiefMayRaw.switchModel, d.chiefMay.switchModel),
    },
  };
  const departments: OrgSnapshot["departments"] = [];
  for (const entry of Array.isArray(record.departments) ? record.departments : []) {
    if (!entry || typeof entry !== "object" || typeof (entry as { section?: unknown }).section !== "string") continue;
    const department = entry as Record<string, unknown>;
    const section = String(department.section).trim();
    if (!section) continue;
    const budgetPerDay = finiteNumber(department.budgetPerDay);
    const headcount = finiteNumber(department.headcount);
    departments.push({ section, ...(budgetPerDay !== undefined ? { budgetPerDay } : {}), ...(headcount !== undefined ? { headcount } : {}) });
  }
  const chief = record.chiefBotId;
  return { chiefBotId: typeof chief === "string" && chief.trim() ? chief.trim() : null, rules, departments };
}

// ── the dispatcher ─────────────────────────────────────────────────────

const RESULT_KEEP_CHARS = 6_000;
const RESULT_CONTEXT_CHARS = 3_000;
const EXAMPLE_CHARS = 1_500;
const MAX_RUNS = 60;
const FINISHED_RUN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Unfinished runs one chief (or department lead) may have at once. */
const MAX_ACTIVE_RUNS_PER_CHIEF = 2;
const RATE_LIMIT_MEMORY = 20;

const sectionKey = (section?: string): string => section?.trim() || "";

/** A turn's stop reason that means a person stopped it. */
function isStopReason(reason: string | undefined): boolean {
  const code = reason?.trim();
  return code === "interrupted" || code === "cancelled" || code === "canceled";
}

export class Dispatcher {
  private runs: DispatchRun[] = [];
  private routeList: DispatchRoute[] = [];
  /** worker thread → the subtask its turn is doing */
  private readonly watch = new Map<string, { runId: string; subtaskId: string }>();
  /** chief's thread → the run whose consolidated-report turn runs there */
  private readonly synthesisWatch = new Map<string, string>();
  private readonly host: DispatchHost;
  private readonly runsFile: string;
  private readonly routesFile: string;
  private readonly orgFile: string;
  private orgCache: { mtimeMs: number; size: number; value: OrgSnapshot } | null = null;

  constructor(host: DispatchHost, dataDir = DATA_DIR) {
    this.host = host;
    this.runsFile = join(dataDir, "dispatch-runs.json");
    this.routesFile = join(dataDir, "dispatch-routes.json");
    this.orgFile = join(dataDir, "org.json");
  }

  // ── persistence ──

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.runsFile, "utf8")) as DispatchRun[];
      this.runs = Array.isArray(raw) ? raw.filter((run) => run && typeof run.id === "string" && Array.isArray(run.subtasks)) : [];
    } catch {
      this.runs = [];
    }
    try {
      const raw = JSON.parse(readFileSync(this.routesFile, "utf8")) as DispatchRoute[];
      this.routeList = Array.isArray(raw) ? raw.filter((route) => typeof route?.fromBotId === "string" && typeof route?.toBotId === "string") : [];
    } catch {
      this.routeList = [];
    }
    const now = Date.now();
    // A report turn does not survive a restart: the run is done without it.
    for (const run of this.runs) {
      if (run.status === "synthesizing" && run.synthesisStarted) {
        run.status = "done";
        run.finishedAt ??= now;
      }
    }
    // No worker turn survives either: running work goes back to pending
    // (keeping its attempt count) and the scheduler picks it up — except a
    // lead's subtask whose team's run is still going (that run persists).
    for (const run of this.runs) {
      for (const subtask of run.subtasks) {
        if (subtask.status !== "running") continue;
        const child = subtask.childRunId ? this.get(subtask.childRunId) : undefined;
        if (child && !isFinished(child.status)) continue;
        if (child) {
          this.settleFromChild(run, subtask, child, true);
          continue;
        }
        subtask.status = "pending";
        subtask.error = t("Interrupted by a restart");
      }
    }
    this.saveRuns();
  }

  private saveRuns(): void {
    const now = Date.now();
    // the cap trims finished runs only, oldest first: a run still in progress
    // (waiting for approval, or a company plan whose departments still work)
    // is never forgotten
    const kept = this.runs.filter((run) => !isFinished(run.status) || now - run.updatedAt < FINISHED_RUN_MAX_AGE_MS);
    let room = MAX_RUNS - kept.filter((run) => !isFinished(run.status)).length;
    this.runs = kept.filter((run) => !isFinished(run.status) || room-- > 0);
    try {
      writeFileAtomic(this.runsFile, JSON.stringify(this.runs, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("dispatch: could not persist runs", error);
    }
  }

  private saveRoutes(): void {
    try {
      writeFileAtomic(this.routesFile, JSON.stringify(this.routeList, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("dispatch: could not persist routes", error);
    }
  }

  // ── reads ──

  list(): DispatchRun[] {
    return this.runs;
  }

  get(runId: string): DispatchRun | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  routes(): DispatchRoute[] {
    return this.routeList;
  }

  /** The org config, re-read when the file changes; defaults when absent. */
  org(): OrgSnapshot {
    try {
      const stat = statSync(this.orgFile);
      if (this.orgCache && this.orgCache.mtimeMs === stat.mtimeMs && this.orgCache.size === stat.size) return this.orgCache.value;
      const value = readOrgSnapshot(JSON.parse(readFileSync(this.orgFile, "utf8")));
      this.orgCache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
      return value;
    } catch {
      this.orgCache = null;
      return readOrgSnapshot(undefined);
    }
  }

  /** The org's chief (主 Bot), when one is set and exists. */
  isOrgChief(botId: string): boolean {
    const chiefId = this.org().chiefBotId;
    return Boolean(chiefId) && chiefId === botId && Boolean(this.host.bot(botId));
  }

  /** A department lead: a section's chief of staff (the org chief is not one). */
  private isLead(bot: DispatchBot): boolean {
    return Boolean(bot.chiefOfStaff) && sectionKey(bot.section) !== "" && !this.isOrgChief(bot.id);
  }

  /** Bots this Chief may dispatch to: its section's visible members unless
   * unplugged, plus anyone wired to it explicitly. The org's chief also
   * reaches every department lead and every unsectioned bot. */
  team(chiefId: string): DispatchBot[] {
    const chief = this.host.bot(chiefId);
    if (!chief) return [];
    const section = sectionKey(chief.section);
    const orgChief = this.isOrgChief(chiefId);
    const disabled = new Set(this.routeList.filter((r) => r.fromBotId === chiefId && !r.enabled).map((r) => r.toBotId));
    const wired = new Set(this.routeList.filter((r) => r.fromBotId === chiefId && r.enabled).map((r) => r.toBotId));
    return this.host
      .bots()
      .filter((bot) => bot.id !== chiefId && !bot.hidden)
      .filter((bot) => {
        if (wired.has(bot.id)) return true;
        if (disabled.has(bot.id)) return false;
        const own = sectionKey(bot.section);
        if (own === section) return true;
        return orgChief && (own === "" || this.isLead(bot));
      });
  }

  /** What a chief's system prompt should know about its dispatch team: for
   * the org chief, the departments it plans through. */
  chiefContext(botId: string): { departments?: Array<{ section: string; leadId: string; leadName: string; leadTitle?: string; people: number }> } {
    if (!this.isOrgChief(botId)) return {};
    const visible = this.host.bots().filter((bot) => !bot.hidden);
    const departments = this.team(botId)
      .filter((bot) => this.isLead(bot))
      .map((lead) => ({
        section: sectionKey(lead.section),
        leadId: lead.id,
        leadName: lead.name,
        ...(lead.title ? { leadTitle: lead.title } : {}),
        people: visible.filter((bot) => sectionKey(bot.section) === sectionKey(lead.section)).length,
      }));
    return { departments };
  }

  /** May this subtask's assignee plan it for its own section? Only a
   * department lead doing a subtask of the org chief's own (top-level) run. */
  private mayPlan(run: DispatchRun, subtask: DispatchSubtask): boolean {
    if (run.parentRunId || !this.isOrgChief(run.chiefBotId)) return false;
    const bot = this.host.bot(subtask.assigneeBotId);
    return Boolean(bot && this.isLead(bot));
  }

  // ── routes (workbench wires) ──

  setRoute(fromBotId: string, toBotId: string, enabled: boolean): DispatchRoute | { error: string } {
    if (fromBotId === toBotId) return { error: t("A bot cannot be wired to itself") };
    if (!this.host.bot(fromBotId) || !this.host.bot(toBotId)) return { error: t("No such bot") };
    const now = Date.now();
    const existing = this.routeList.find((route) => route.fromBotId === fromBotId && route.toBotId === toBotId);
    const route: DispatchRoute = { fromBotId, toBotId, enabled, updatedAt: now };
    if (existing) Object.assign(existing, route);
    else this.routeList.push(route);
    this.saveRoutes();
    this.host.broadcastRoutes(this.routeList);
    return route;
  }

  /** Forget the explicit route, falling back to the section default. */
  resetRoute(fromBotId: string, toBotId: string): void {
    this.routeList = this.routeList.filter((route) => !(route.fromBotId === fromBotId && route.toBotId === toBotId));
    this.saveRoutes();
    this.host.broadcastRoutes(this.routeList);
  }

  /** Drop routes that point at deleted bots. */
  pruneRoutes(): void {
    const alive = new Set(this.host.bots().map((bot) => bot.id));
    const before = this.routeList.length;
    this.routeList = this.routeList.filter((route) => alive.has(route.fromBotId) && alive.has(route.toBotId));
    if (this.routeList.length !== before) {
      this.saveRoutes();
      this.host.broadcastRoutes(this.routeList);
    }
  }

  // ── plan intake ──

  submitPlan(chiefId: string, sourceThreadId: string, input: PlanInput): { run: DispatchRun; created: string[] } | { error: string } {
    const settings = this.host.settings();
    if (!settings.enabled) return { error: "Dispatch is turned off in App Settings. Use delegate_bot for single handoffs." };
    const chief = this.host.bot(chiefId);
    if (!chief) return { error: "unknown sender" };
    const orgChief = this.isOrgChief(chiefId);
    if (!chief.chiefOfStaff && !orgChief) return { error: "Only a section's Chief of Staff can submit a dispatch plan." };
    // A plan sent from inside a dispatched subtask: only a department lead
    // doing a subtask of the org chief's run may hand it to its own team.
    let parent: { run: DispatchRun; subtask: DispatchSubtask } | undefined;
    const ticket = this.watch.get(sourceThreadId);
    if (ticket) {
      const parentRun = this.get(ticket.runId);
      const parentSubtask = parentRun?.subtasks.find((entry) => entry.id === ticket.subtaskId);
      if (!parentRun || !parentSubtask || parentSubtask.assigneeBotId !== chiefId || !this.mayPlan(parentRun, parentSubtask)) {
        return {
          error: "You are doing a dispatched subtask: do it yourself and reply with the finished result. Only a department lead working for the company's chief can hand a subtask to its own team.",
        };
      }
      const existing = parentSubtask.childRunId ? this.get(parentSubtask.childRunId) : undefined;
      if (existing && !isFinished(existing.status)) {
        return { error: `You already handed this subtask to your team (run ${existing.id}). End your turn; you will be asked for the consolidated result when they finish.` };
      }
      parent = { run: parentRun, subtask: parentSubtask };
    }
    const active = this.runs.filter((run) => run.chiefBotId === chiefId && !isFinished(run.status));
    if (active.length >= MAX_ACTIVE_RUNS_PER_CHIEF) {
      return { error: "Two dispatch runs are already in progress for you. Wait for one to finish, or ask the user to cancel one on the workbench." };
    }
    const plan = validatePlan(input, settings.maxSubtasks);
    if ("error" in plan) return plan;

    const team = this.team(chiefId);
    const created: DispatchBot[] = [];
    const subtasks: DispatchSubtask[] = [];
    const policy = settings.policy;
    for (const item of plan.subtasks) {
      const task = assessTask(`${item.title}\n${item.brief}`, { difficulty: item.difficulty, needs: item.needs });
      let assignee = item.assignee ? this.findAssignee(item.assignee, team.concat(created), orgChief) : undefined;
      if (item.assignee && !assignee) {
        return { error: `Subtask "${item.id}" names assignee "${item.assignee}", who is not on your team. Use list_bots for names and ids, or leave assignee empty.` };
      }
      if (assignee?.id === chiefId) return { error: `Do not assign subtask "${item.id}" to yourself; you coordinate and synthesize.` };
      assignee ??= this.bestMember(item, team.concat(created), subtasks, orgChief);
      if (!assignee) {
        if (!settings.autoCreate) {
          return { error: `Nobody on your team fits subtask "${item.id}" (${item.role}) and creating specialists is turned off. Name an assignee from list_bots.` };
        }
        // the company's rules can keep the 主 Bot from hiring on its own
        if (orgChief && !this.org().rules.chiefMay.newSpecialist) {
          return {
            error: `Nobody on your team fits subtask "${item.id}" (${item.role}), and your company rules do not let you create specialists on your own. Name an assignee from list_bots, or ask the user to add one.`,
          };
        }
        if (created.length >= settings.maxNewBots || this.host.bots().length + created.length >= this.host.maxBots) {
          // out of room for new bots: share the work among who we have
          assignee = this.leastLoaded(team.concat(created), subtasks, orgChief);
          if (!assignee) return { error: "No team member is available and no more bots can be created. Ask the user to add a bot." };
        } else {
          // Planned, not created: a later subtask can still reject the whole
          // plan, and a rejected plan must not leave specialists behind (the
          // Chief would resubmit and create duplicates). Later subtasks may
          // reuse this planned specialist exactly like an existing member.
          const recommendation = this.host.recommend(task, policy);
          const takenNames = [...this.host.bots().map((b) => b.name), ...created.map((b) => b.name)];
          // the model is the recommender's; the effort is left open so each
          // task it gets thinks as hard as that task needs (autoEffort)
          const bot: DispatchBot = {
            id: `${PLANNED_PREFIX}${created.length}`,
            name: uniqueName(item.role, takenNames),
            title: item.role,
            description: t("{role} — created by @{chief} for dispatched work.", { role: item.role, chief: chief.name }),
            section: chief.section,
            modelSelection: recommendation
              ? { instanceId: recommendation.instanceId, model: recommendation.model }
              : { ...chief.modelSelection },
          };
          created.push(bot);
          assignee = bot;
        }
      }
      // what this machine's best fit would be, model and effort, for you to take or leave
      const suggested = this.host.recommend(task, policy);
      subtasks.push({
        id: item.id,
        title: item.title,
        brief: item.brief,
        role: item.role,
        needs: task.needs,
        difficulty: task.difficulty,
        dependsOn: item.dependsOn,
        ...(suggested
          ? {
              recommended: {
                instanceId: suggested.instanceId,
                engineName: suggested.engineName,
                model: suggested.model,
                modelLabel: suggested.modelLabel,
                ...(suggested.effort ? { effort: suggested.effort } : {}),
              },
            }
          : {}),
        ...(item.acceptance ? { acceptance: item.acceptance } : {}),
        assigneeBotId: assignee.id,
        ...(created.some((bot) => bot.id === assignee!.id) ? { createdBot: true } : {}),
        status: "pending",
        attempts: 0,
      });
    }
    // The whole plan is valid: now the planned specialists become real bots,
    // and each is wired to its Chief on the workbench.
    const realIds = new Map<string, string>();
    for (const planned of created) {
      const { id: plannedId, ...input } = planned;
      const bot = this.host.createBot({
        name: input.name,
        title: input.title,
        description: input.description,
        section: input.section,
        modelSelection: input.modelSelection,
      });
      realIds.set(plannedId, bot.id);
      planned.id = bot.id;
      this.setRoute(chiefId, bot.id, true);
    }
    for (const subtask of subtasks) subtask.assigneeBotId = realIds.get(subtask.assigneeBotId) ?? subtask.assigneeBotId;

    const now = Date.now();
    const run: DispatchRun = {
      id: newId(),
      chiefBotId: chiefId,
      sourceThreadId,
      goal: plan.goal,
      policy,
      status: settings.requireApproval ? "awaiting-approval" : "running",
      subtasks,
      createdAt: now,
      updatedAt: now,
      ...(parent ? { parentRunId: parent.run.id, parentSubtaskId: parent.subtask.id } : {}),
    };
    this.runs.unshift(run);
    this.saveRuns();
    this.host.activity(
      sourceThreadId,
      t("Dispatch plan accepted: {count} subtasks for “{goal}”", { count: subtasks.length, goal: clip(plan.goal, 60) }),
    );
    this.host.broadcast(run);
    if (parent) {
      parent.subtask.childRunId = run.id;
      this.touch(parent.run);
    }
    if (run.status === "running") queueMicrotask(() => this.pump(run.id));
    return { run, created: created.map((bot) => bot.id) };
  }

  private findAssignee(nameOrId: string, team: DispatchBot[], orgChief: boolean): DispatchBot | undefined {
    const wanted = nameOrId.replace(/^@/, "").trim().toLowerCase();
    const direct = team.find((bot) => bot.id === nameOrId || bot.name.trim().toLowerCase() === wanted);
    if (direct || !orgChief) return direct;
    // the org chief may name a department instead of its lead
    return team.find((bot) => this.isLead(bot) && sectionKey(bot.section).toLowerCase() === wanted);
  }

  /** How well a department fits a subtask: its lead's profile and section
   * name, or any of its members' profiles. */
  private departmentFit(item: ValidPlanSubtask, lead: DispatchBot): number {
    const leadProfile = `${lead.title} ${lead.description} ${lead.name} ${sectionKey(lead.section)}`;
    let score = Math.max(roleSimilarity(item.role, leadProfile), 0.8 * roleSimilarity(`${item.title} ${item.role}`, leadProfile));
    for (const member of this.host.bots()) {
      if (member.id === lead.id || member.hidden || sectionKey(member.section) !== sectionKey(lead.section)) continue;
      const profile = `${member.title} ${member.description} ${member.name}`;
      score = Math.max(score, 0.95 * roleSimilarity(item.role, profile), 0.75 * roleSimilarity(`${item.title} ${item.role}`, profile));
    }
    return score;
  }

  /** The member whose role best fits the subtask, if any fits well enough.
   * Busy members and those already holding work in this plan rank lower.
   * For the org chief, department leads compete on their department's fit. */
  private bestMember(item: ValidPlanSubtask, team: DispatchBot[], assigned: DispatchSubtask[], orgChief: boolean): DispatchBot | undefined {
    let best: { bot: DispatchBot; score: number } | undefined;
    for (const bot of team) {
      let score: number;
      if (orgChief && this.isLead(bot)) {
        score = this.departmentFit(item, bot);
      } else if (bot.chiefOfStaff) {
        continue;
      } else {
        const profile = `${bot.title} ${bot.description} ${bot.name}`;
        score = Math.max(roleSimilarity(item.role, profile), 0.8 * roleSimilarity(`${item.title} ${item.role}`, profile));
      }
      if (score < REUSE_THRESHOLD) continue;
      if (bot.busy) score -= 0.1;
      score -= 0.05 * assigned.filter((subtask) => subtask.assigneeBotId === bot.id).length;
      if (!best || score > best.score) best = { bot, score };
    }
    return best?.bot;
  }

  private leastLoaded(team: DispatchBot[], assigned: DispatchSubtask[], orgChief: boolean): DispatchBot | undefined {
    const workers = team.filter((bot) => !bot.chiefOfStaff || (orgChief && this.isLead(bot)));
    return workers
      .map((bot) => ({ bot, load: assigned.filter((subtask) => subtask.assigneeBotId === bot.id).length }))
      .sort((a, b) => a.load - b.load)[0]?.bot;
  }

  // ── lifecycle ──

  approve(runId: string): DispatchRun | { error: string } {
    const run = this.get(runId);
    if (!run) return { error: t("No such dispatch run") };
    if (run.status !== "awaiting-approval") return { error: t("This dispatch run is not waiting for approval") };
    run.status = "running";
    this.touch(run);
    queueMicrotask(() => this.pump(run.id));
    return run;
  }

  async cancel(runId: string): Promise<DispatchRun | { error: string }> {
    const run = this.get(runId);
    if (!run) return { error: t("No such dispatch run") };
    if (isFinished(run.status)) return run;
    const now = Date.now();
    const turns: Array<{ botId: string; threadId: string }> = [];
    for (const subtask of run.subtasks) {
      if (subtask.status === "running" && subtask.threadId && this.watch.has(subtask.threadId)) {
        this.watch.delete(subtask.threadId);
        turns.push({ botId: subtask.assigneeBotId, threadId: subtask.threadId });
      }
      if (subtask.status === "pending" || subtask.status === "running") {
        subtask.status = "canceled";
        subtask.finishedAt = now;
      }
    }
    // a report turn in flight just finishes; nobody waits for it any more
    if (this.synthesisWatch.get(run.sourceThreadId) === run.id) this.synthesisWatch.delete(run.sourceThreadId);
    // canceling is something you did, not a failure: a plain system line
    this.host.activity(run.sourceThreadId, t("Dispatch canceled: “{goal}”", { goal: clip(run.goal, 60) }));
    this.finishRun(run, "canceled");
    // the department teams working on its subtasks stop too
    for (const child of this.runs.filter((entry) => entry.parentRunId === run.id && !isFinished(entry.status))) void this.cancel(child.id);
    for (const turn of turns) await this.host.interrupt(turn.botId, turn.threadId).catch(() => undefined);
    return run;
  }

  /** Retry a failed or canceled subtask (and let its dependents run again). */
  retry(runId: string, subtaskId: string): DispatchRun | { error: string } {
    const run = this.get(runId);
    const subtask = run?.subtasks.find((entry) => entry.id === subtaskId);
    if (!run || !subtask) return { error: t("No such subtask") };
    if (subtask.status !== "failed" && subtask.status !== "canceled") return { error: t("Only a failed or canceled subtask can be retried") };
    subtask.status = "pending";
    subtask.attempts = 0;
    delete subtask.error;
    delete subtask.finishedAt;
    delete subtask.childRunId;
    for (const other of run.subtasks) {
      if (other.status !== "skipped") continue;
      other.status = "pending";
      delete other.error;
      delete other.finishedAt;
    }
    run.status = "running";
    run.synthesisStarted = false;
    delete run.finishedAt;
    // a department's reopened plan: the subtask above waits for it again
    const parent = run.parentRunId ? this.get(run.parentRunId) : undefined;
    const parentSubtask = parent?.subtasks.find((entry) => entry.id === run.parentSubtaskId);
    if (parent && parentSubtask && parent.status === "running" && parentSubtask.status !== "running") {
      parentSubtask.status = "running";
      parentSubtask.childRunId = run.id;
      delete parentSubtask.error;
      delete parentSubtask.finishedAt;
      this.touch(parent);
    }
    this.touch(run);
    queueMicrotask(() => this.pump(run.id));
    return run;
  }

  /** A turn settled (turn.completed or a harness-side stop): a worker's, or
   * a chief's consolidated report. `reason` is the turn's stop reason. */
  onTurnSettled(threadId: string, ok: boolean, reply: string, reason?: string): void {
    const synthesisRunId = this.synthesisWatch.get(threadId);
    if (synthesisRunId !== undefined) {
      this.synthesisWatch.delete(threadId);
      this.onSynthesisSettled(synthesisRunId, ok, reply, reason);
      return;
    }
    const ticket = this.watch.get(threadId);
    if (!ticket) return;
    this.watch.delete(threadId);
    const run = this.get(ticket.runId);
    const subtask = run?.subtasks.find((entry) => entry.id === ticket.subtaskId);
    if (!run || !subtask || subtask.status !== "running") return;
    if (reason?.trim() === "rate_limited") {
      this.noteRateLimit(subtask);
      subtask.throttledAttempts = (subtask.throttledAttempts ?? 0) + 1;
    }
    const stopped = isStopReason(reason);
    const bot = this.host.bot(subtask.assigneeBotId);
    // A department lead handed this subtask to its own team: it finishes
    // when that run's consolidated report does.
    const child = subtask.childRunId ? this.get(subtask.childRunId) : undefined;
    if (child) {
      if (isFinished(child.status)) {
        this.settleFromChild(run, subtask, child);
      } else if (stopped) {
        // the owner stopped the lead: its team stops too, and nothing retries
        this.stopSubtask(run, subtask);
        void this.cancel(child.id);
        this.pump(run.id);
      } else {
        this.host.activity(
          run.sourceThreadId,
          t("@{name} handed “{title}” to its team ({count} subtasks)", { name: bot?.name ?? "?", title: subtask.title, count: child.subtasks.length }),
        );
        this.touch(run);
      }
      return;
    }
    if (stopped) {
      // the owner stopped it: never retried behind their back
      this.stopSubtask(run, subtask);
      this.pump(run.id);
      return;
    }
    const finishedCount = () => run.subtasks.filter((entry) => entry.status === "done").length;
    if (ok && reply.trim()) {
      subtask.status = "done";
      subtask.result = reply.trim().slice(0, RESULT_KEEP_CHARS);
      subtask.finishedAt = Date.now();
      delete subtask.error;
      this.host.activity(
        run.sourceThreadId,
        t("@{name} finished “{title}” ({done}/{total})", { name: bot?.name ?? "?", title: subtask.title, done: finishedCount(), total: run.subtasks.length }),
      );
    } else {
      // an ok turn's reason is just how it ended ("end_turn"), not a failure
      const why = ok ? t("finished without a reply") : reason?.trim() ? reasonLabel(reason) : t("did not finish");
      if (subtask.attempts < this.host.settings().maxAttempts && run.status === "running") {
        subtask.status = "pending";
        subtask.error = why;
        this.host.activity(run.sourceThreadId, t("@{name} will retry “{title}” — {reason}", { name: bot?.name ?? "?", title: subtask.title, reason: clip(why, 80) }), false);
      } else {
        subtask.status = "failed";
        subtask.error = why;
        subtask.finishedAt = Date.now();
        this.host.activity(run.sourceThreadId, t("“{title}” failed — {reason}", { title: subtask.title, reason: clip(why, 80) }), false);
      }
    }
    this.touch(run);
    this.pump(run.id);
  }

  /** A driver is about to relaunch a worker's turn after a transient error. */
  onTurnRetrying(threadId: string, reason: string): void {
    if (reason !== "rate_limited") return;
    const ticket = this.watch.get(threadId);
    const subtask = ticket ? this.get(ticket.runId)?.subtasks.find((entry) => entry.id === ticket.subtaskId) : undefined;
    if (!subtask) return;
    this.noteRateLimit(subtask);
    this.saveRuns();
  }

  private noteRateLimit(subtask: DispatchSubtask): void {
    subtask.rateLimitedAt = [...(subtask.rateLimitedAt ?? []), Date.now()].slice(-RATE_LIMIT_MEMORY);
  }

  /** The owner stopped this subtask's turn. */
  private stopSubtask(run: DispatchRun, subtask: DispatchSubtask): void {
    subtask.status = "canceled";
    subtask.error = t("Stopped by you");
    subtask.finishedAt = Date.now();
    this.host.activity(run.sourceThreadId, t("“{title}” was stopped — it will not be retried", { title: subtask.title }), false);
    this.touch(run);
  }

  /** Pick unfinished runs back up after a restart (call once the harness can
   * start turns). */
  resumeAll(): void {
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "synthesizing") this.pump(run.id);
    }
    this.checkReviews();
  }

  /** A bot was deleted: its pending work fails now rather than waiting forever. */
  onBotDeleted(botId: string): void {
    for (const run of this.runs) {
      if (isFinished(run.status)) continue;
      if (run.chiefBotId === botId) {
        void this.cancel(run.id);
        continue;
      }
      let touched = false;
      for (const subtask of run.subtasks) {
        if (subtask.assigneeBotId !== botId || isSettled(subtask.status)) continue;
        if (subtask.threadId) this.watch.delete(subtask.threadId);
        subtask.status = "failed";
        subtask.error = t("The assigned bot no longer exists");
        subtask.finishedAt = Date.now();
        touched = true;
      }
      if (touched) this.pump(run.id);
    }
    this.pruneRoutes();
  }

  /** A bot became idle: work waiting on it, or a report waiting on its
   * Chief, may start now. A turn we were still watching on an idle bot ended
   * without a turn.completed (a provider reload, a lost setup): settle it. */
  onBotIdle(botId: string): void {
    const bot = this.host.bot(botId);
    if (bot && !bot.busy) {
      for (const [threadId, ticket] of [...this.watch]) {
        const subtask = this.get(ticket.runId)?.subtasks.find((entry) => entry.id === ticket.subtaskId);
        if (subtask?.assigneeBotId === botId && subtask.status === "running") this.onTurnSettled(threadId, false, "");
      }
      for (const [threadId, runId] of [...this.synthesisWatch]) {
        if (this.get(runId)?.chiefBotId === botId) this.onSynthesisFailed(runId, threadId, "");
      }
    }
    for (const run of this.runs) {
      if (run.status !== "running" && run.status !== "synthesizing") continue;
      if (run.chiefBotId === botId || run.subtasks.some((subtask) => subtask.assigneeBotId === botId && subtask.status === "pending")) {
        this.pump(run.id);
      }
    }
  }

  /** Is this subtask in a live turn (not merely waiting on its team's run)? */
  private inTurn(subtask: DispatchSubtask): boolean {
    if (subtask.status !== "running") return false;
    const child = subtask.childRunId ? this.get(subtask.childRunId) : undefined;
    return !child || isFinished(child.status);
  }

  /** Start every runnable subtask, and the synthesis once all have settled. */
  pump(runId: string): void {
    const run = this.get(runId);
    if (!run) return;
    if (run.status === "running") {
      skipBlocked(run);
      const settings = this.host.settings();
      const cap = Math.max(settings.maxConcurrent, run.maxConcurrent ?? 0);
      let running = run.subtasks.filter((subtask) => this.inTurn(subtask)).length;
      for (const subtask of run.subtasks) {
        if (running >= cap) break;
        if (subtask.status !== "pending") continue;
        const ready = subtask.dependsOn.every((dep) => run.subtasks.find((entry) => entry.id === dep)?.status === "done");
        if (!ready) continue;
        const bot = this.host.bot(subtask.assigneeBotId);
        if (!bot) {
          subtask.status = "failed";
          subtask.error = t("The assigned bot no longer exists");
          subtask.finishedAt = Date.now();
          continue;
        }
        if (bot.busy || run.subtasks.some((other) => other.assigneeBotId === bot.id && this.inTurn(other))) continue;
        this.startSubtask(run, subtask, bot);
        running += 1;
      }
      // one that could not even start just now (its bot is gone) fails its
      // dependents in this pass too, or the run would wait on them forever
      skipBlocked(run);
      if (run.subtasks.every((subtask) => isSettled(subtask.status))) {
        const anyDone = run.subtasks.some((subtask) => subtask.status === "done");
        if (anyDone && settings.autoSynthesize) {
          run.status = "synthesizing";
        } else if (anyDone) {
          this.finishRun(run, "done");
          return;
        } else {
          this.host.activity(run.sourceThreadId, t("Dispatch finished without results: “{goal}”", { goal: clip(run.goal, 60) }), false);
          this.finishRun(run, "failed");
          return;
        }
      }
      this.touch(run);
    }
    if (run.status === "synthesizing" && !run.synthesisStarted) this.startSynthesis(run);
  }

  private startSubtask(run: DispatchRun, subtask: DispatchSubtask, bot: DispatchBot): void {
    const task = this.host.createTask(bot.id, t("[Dispatch] {title}", { title: subtask.title }));
    if (!task) {
      subtask.status = "failed";
      subtask.error = t("Could not open a conversation for this subtask");
      subtask.finishedAt = Date.now();
      return;
    }
    const threadId = task.threadId;
    subtask.status = "running";
    subtask.attempts += 1;
    subtask.threadId = threadId;
    subtask.startedAt = Date.now();
    delete subtask.finishedAt;
    delete subtask.childRunId;
    this.watch.set(threadId, { runId: run.id, subtaskId: subtask.id });
    const chief = this.host.bot(run.chiefBotId);
    const lead = this.mayPlan(run, subtask);
    this.host.activity(run.sourceThreadId, t("Dispatched “{title}” to @{name}", { title: subtask.title, name: bot.name }));
    // could not even start, now or during setup: settle through the normal
    // path so retry and dependent-skipping rules apply (the watch makes the
    // second report of the same failure a no-op)
    const settle = (message: string) => this.onTurnSettled(threadId, false, "", message);
    const pick = this.turnPick(subtask, bot);
    subtask.ranWith = pick;
    this.host
      .startTurn(
        bot.id,
        workerPrompt(run, subtask, {
          chiefName: chief?.name ?? "Chief",
          ...(lead ? { leadOf: sectionKey(bot.section) } : {}),
          ...(subtask.squad ? { squad: this.squadBrief(run, subtask) } : {}),
        }),
        {
          threadId,
          sourceThreadId: run.sourceThreadId,
          ...(lead ? { mayPlan: true } : {}),
          ...turnOverrides(pick, bot.modelSelection),
          onError: settle,
        },
      )
      .catch((error: unknown) => settle(error instanceof Error ? error.message : String(error)));
  }

  /** The engine, model and effort a subtask runs with. Your pick for it
   * comes first — any model on any engine you are signed in to — else the
   * bot's own. Effort: your pick, else the bot's own level, else the one the
   * subtask's difficulty calls for (autoEffort, when the engine has the knob). */
  turnPick(subtask: DispatchSubtask, bot: DispatchBot): NonNullable<DispatchSubtask["ranWith"]> {
    const own = bot.modelSelection;
    const knobsOf = (instanceId: string) => this.host.engineKnobs?.(instanceId) ?? NO_KNOBS;
    // borrow the chosen engine only while it is still there and signed in
    const wanted = subtask.choice?.instanceId && subtask.choice.instanceId !== own.instanceId ? subtask.choice.instanceId : undefined;
    const borrowed = wanted ? knobsOf(wanted) : undefined;
    const usable = borrowed && borrowed.ready !== false && borrowed.models.length > 0 ? borrowed : undefined;
    const instanceId = usable ? wanted! : own.instanceId;
    const knobs = usable ?? knobsOf(own.instanceId);
    const chosenModel = subtask.choice?.model && (!subtask.choice.instanceId || subtask.choice.instanceId === instanceId) ? subtask.choice.model : undefined;
    const model =
      chosenModel && knobs.models.includes(chosenModel)
        ? chosenModel
        : usable
          ? (usable.defaultModel && usable.models.includes(usable.defaultModel) ? usable.defaultModel : usable.models[0]!)
          : own.model;
    const offered = (level: string | undefined): level is Effort => Boolean(level && knobs.effortLevels.includes(level));
    if (offered(subtask.choice?.effort)) return { instanceId, model, effort: subtask.choice!.effort };
    if (offered(own.effort)) return { instanceId, model, effort: own.effort };
    const settings = this.host.settings();
    const auto = settings.autoEffort ? effortFor(subtask.difficulty, knobs.effortLevels, settings.policy) : undefined;
    return auto ? { instanceId, model, effort: auto, autoEffort: true } : { instanceId, model };
  }

  /** Your pick for a subtask that has not run yet (or failed and will be
   * retried): `instanceId` + `model` — any model on any engine you are
   * signed in to — and/or `effort`, one of that engine's levels. null clears
   * that part of the pick: back to the bot's own engine and model, or to the
   * bot's own / automatic effort. */
  chooseModel(
    runId: string,
    subtaskId: string,
    input: { instanceId?: string | null; model?: string | null; effort?: string | null },
  ): DispatchRun | { error: string } {
    const run = this.get(runId);
    if (!run) return { error: t("No such dispatch run") };
    const subtask = run.subtasks.find((entry) => entry.id === subtaskId);
    if (!subtask) return { error: t("No such subtask") };
    const waiting = subtask.status === "pending" && !isFinished(run.status);
    const retryable = (subtask.status === "failed" || subtask.status === "canceled") && run.status !== "canceled";
    if (!waiting && !retryable) return { error: t("Only a subtask that has not started yet (or failed) can change its model") };
    const bot = this.host.bot(subtask.assigneeBotId);
    if (!bot) return { error: t("No such bot") };
    const own = bot.modelSelection;
    const knobsOf = (instanceId: string) => this.host.engineKnobs?.(instanceId) ?? NO_KNOBS;
    const choice = { ...(subtask.choice ?? {}) };
    const previousInstance = choice.instanceId ?? own.instanceId;
    // which engine: null or the bot's own engine clears a borrowed one
    let instanceId = previousInstance;
    if (input.instanceId !== undefined) instanceId = input.instanceId === null ? own.instanceId : input.instanceId;
    const knobs = knobsOf(instanceId);
    if (instanceId !== own.instanceId) {
      if (!knobs.models.length) return { error: t("That engine is not available") };
      if (knobs.ready === false) return { error: t("Sign in to that engine first") };
      if (this.mayPlan(run, subtask) && knobs.coordinates === false) {
        return { error: t("{name} plans its department's share, and that engine cannot coordinate teammates", { name: bot.name }) };
      }
    }
    if (instanceId === own.instanceId) delete choice.instanceId;
    else choice.instanceId = instanceId;
    // which model: a new engine without one starts on its default
    if (input.model !== undefined && input.model !== null) {
      if (!knobs.models.includes(input.model)) return { error: t("That engine does not offer this model") };
      choice.model = input.model;
    } else if (input.model === null || instanceId !== previousInstance) {
      if (instanceId === own.instanceId) delete choice.model;
      else choice.model = knobs.defaultModel && knobs.models.includes(knobs.defaultModel) ? knobs.defaultModel : knobs.models[0]!;
    }
    if (instanceId === own.instanceId && choice.model === own.model) delete choice.model;
    // which effort: one the chosen engine offers; a switch drops one it lacks
    if (input.effort !== undefined && input.effort !== null) {
      if (!knobs.effortLevels.includes(input.effort)) return { error: t("That engine does not offer this effort level") };
      choice.effort = input.effort as Effort;
    } else if (input.effort === null || (choice.effort && !knobs.effortLevels.includes(choice.effort))) {
      delete choice.effort;
    }
    if (choice.instanceId || choice.model || choice.effort) subtask.choice = choice;
    else delete subtask.choice;
    this.touch(run);
    return run;
  }

  private startSynthesis(run: DispatchRun): void {
    const chief = this.host.bot(run.chiefBotId);
    if (!chief) {
      this.finishRun(run, "done");
      return;
    }
    if (chief.busy) return; // onBotIdle retries when the Chief is free
    const threadId = run.sourceThreadId;
    run.synthesisStarted = true;
    this.synthesisWatch.set(threadId, run.id);
    this.touch(run);
    const fail = (message: string) => this.onSynthesisFailed(run.id, threadId, message);
    this.host
      .startTurn(chief.id, this.synthesisPrompt(run), { threadId, continuation: true, sourceThreadId: threadId, onError: fail })
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  }

  /** The chief's report turn could not start (or vanished): the run is done
   * without it and the chief's conversation says where the results are. */
  private onSynthesisFailed(runId: string, threadId: string, message: string): void {
    if (this.synthesisWatch.get(threadId) !== runId) return;
    this.synthesisWatch.delete(threadId);
    const run = this.get(runId);
    if (!run || run.status !== "synthesizing") return;
    run.synthesisStarted = false;
    if (!isStopReason(message)) this.host.activity(run.sourceThreadId, t("All subtasks finished — open the workbench to read the results"));
    this.finishRun(run, "done");
  }

  /** The chief's report turn completed: now the run is done. */
  private onSynthesisSettled(runId: string, ok: boolean, reply: string, reason?: string): void {
    const run = this.get(runId);
    if (!run || run.status !== "synthesizing") return;
    const stopped = isStopReason(reason);
    const report = reply.trim();
    if (ok && report && !stopped) run.report = report.slice(0, RESULT_KEEP_CHARS);
    else if (!stopped) this.host.activity(run.sourceThreadId, t("All subtasks finished — open the workbench to read the results"));
    this.finishRun(run, "done");
  }

  /** Close a run: record when, dissolve its squads, and hand a department's
   * outcome back to the subtask it was doing. */
  private finishRun(run: DispatchRun, status: "done" | "failed" | "canceled"): void {
    const now = Date.now();
    run.status = status;
    run.finishedAt = now;
    for (const squad of run.squads ?? []) {
      // the run ended before the review was due: review what there is, if it is enough to tell
      if (!squad.review && now - squad.addedAt >= MIN_REVIEW_WINDOW_MS) squad.review = reviewSquad(run, squad, now);
      squad.endedAt ??= now;
    }
    this.touch(run);
    if (!run.parentRunId) return;
    const parent = this.get(run.parentRunId);
    const subtask = parent?.subtasks.find((entry) => entry.id === run.parentSubtaskId);
    if (parent && subtask && subtask.status === "running" && subtask.childRunId === run.id) this.settleFromChild(parent, subtask, run);
  }

  /** A lead's subtask takes its team's outcome: the lead's report (or the
   * team's results when there was none), a failure, or a cancellation. */
  private settleFromChild(run: DispatchRun, subtask: DispatchSubtask, child: DispatchRun, quiet = false): void {
    if (subtask.threadId) this.watch.delete(subtask.threadId);
    const bot = this.host.bot(subtask.assigneeBotId);
    subtask.finishedAt = Date.now();
    if (child.status === "done") {
      subtask.status = "done";
      subtask.result = (child.report?.trim() || teamDigest(child)).slice(0, RESULT_KEEP_CHARS);
      delete subtask.error;
      if (!quiet) {
        const done = run.subtasks.filter((entry) => entry.status === "done").length;
        this.host.activity(
          run.sourceThreadId,
          t("@{name} finished “{title}” ({done}/{total})", { name: bot?.name ?? "?", title: subtask.title, done, total: run.subtasks.length }),
        );
      }
    } else if (child.status === "canceled") {
      subtask.status = "canceled";
      subtask.error = t("The team's plan was canceled");
      if (!quiet) this.host.activity(run.sourceThreadId, t("“{title}” failed — {reason}", { title: subtask.title, reason: subtask.error }), false);
    } else {
      subtask.status = "failed";
      subtask.error = t("The team's plan finished without results");
      if (!quiet) this.host.activity(run.sourceThreadId, t("“{title}” failed — {reason}", { title: subtask.title, reason: subtask.error }), false);
    }
    if (quiet) return;
    this.touch(run);
    this.pump(run.id);
  }

  // ── adding people mid-run (中途加人) ──

  /** The four questions and a suggestion for one run. `add` is an explicit
   * ask ("add 4"); `total` asks for a headcount ("up to 8 people"). */
  diagnose(runId: string, ask: { add?: number; total?: number } = {}): DispatchDiagnosis | { error: string } {
    const run = this.get(runId);
    if (!run) return { error: t("No such dispatch run") };
    return diagnoseRun(run, this.diagnoseContext(run, ask));
  }

  private diagnoseContext(run: DispatchRun, ask: { add?: number; total?: number }): DiagnoseContext {
    const org = this.org();
    const chief = this.host.bot(run.chiefBotId);
    const section = sectionKey(chief?.section);
    const department = section ? org.departments.find((entry) => sectionKey(entry.section) === section) : undefined;
    const people = new Set(run.subtasks.map((subtask) => subtask.assigneeBotId)).size;
    const requested = ask.add !== undefined && Number.isFinite(ask.add) && ask.add > 0
      ? Math.trunc(ask.add)
      : ask.total !== undefined && Number.isFinite(ask.total) && ask.total - people > 0
        ? Math.trunc(ask.total - people)
        : undefined;
    return {
      now: Date.now(),
      bot: (id) => this.host.bot(id),
      maxConcurrent: this.host.settings().maxConcurrent,
      rules: org.rules,
      budgetCny: department?.budgetPerDay ?? org.rules.budgetPerDay,
      room: this.host.maxBots - this.host.bots().length,
      roleKey: roleCore,
      modelFor: (subtask) => this.newcomerModel(run, subtask),
      costLevel: (botId) => {
        const bot = this.host.bot(botId);
        return bot ? profileFor(bot.modelSelection.model).cost : 3;
      },
      costCny: (subtask) => {
        if (!subtask.threadId || !this.host.usage) return null;
        const cost = this.host.usage(subtask.assigneeBotId, subtask.threadId)?.costUsd;
        return typeof cost === "number" && Number.isFinite(cost) ? cost * USD_TO_CNY : null;
      },
      engineName: (instanceId) => this.host.engineName?.(instanceId) ?? instanceId,
      takenNames: this.host.bots().map((bot) => bot.name),
      uniqueName,
      squadName: nextSquadName(run),
      leadName: chief?.name ?? "?",
      ...(requested !== undefined ? { requested } : {}),
    };
  }

  /** The model a newcomer doing this subtask gets: the recommender's pick,
   * else the chief's own model (the same rule as auto-created specialists). */
  private newcomerModel(run: DispatchRun, subtask: DispatchSubtask): NewcomerModel {
    const task = assessTask(`${subtask.title}\n${subtask.brief}`, { difficulty: subtask.difficulty, needs: subtask.needs });
    const recommendation = this.host.recommend(task, run.policy);
    if (recommendation) {
      return {
        // like a specialist: the effort follows each task it takes (autoEffort)
        selection: { instanceId: recommendation.instanceId, model: recommendation.model },
        label: recommendation.modelLabel,
        costLevel: recommendation.profile.cost,
      };
    }
    const selection = { ...(this.host.bot(run.chiefBotId)?.modelSelection ?? { instanceId: "", model: "" }) };
    return { selection, label: this.host.modelLabel?.(selection) ?? selection.model, costLevel: profileFor(selection.model).cost };
  }

  /** Add people to a running job. The owner's call always goes through (as
   * many people as there are not-started subtasks to hand out); the chief's
   * only when the diagnosis says it helps and the org rules and budget allow. */
  amend(runId: string, add: number, by: { by: "owner" | "chief"; botId?: string } = { by: "owner" }): DispatchAmendResult | { error: string } {
    const run = this.get(runId);
    if (!run) return { error: t("No such dispatch run") };
    if (run.status !== "running" && run.status !== "awaiting-approval") return { error: t("People can only be added while a run is in progress") };
    let count = Math.trunc(Number(add));
    if (!Number.isFinite(count) || count < 1) return { error: t("Say how many people to add (at least 1)") };
    const org = this.org();
    if (by.by === "chief") {
      if (by.botId !== run.chiefBotId) return { error: "Only this run's chief can add people to it." };
      if (!org.rules.chiefMay.addPeople) {
        return { error: "Your company rules do not let you add people on your own. Tell the user why it is slow; they can add people from the workbench." };
      }
      const diagnosis = diagnoseRun(run, this.diagnoseContext(run, { add: count }));
      if (diagnosis.verdict !== "add-helps" || !diagnosis.suggestion) return { error: `Adding people would not help: ${diagnosis.reason ?? ""}`.trim() };
      if (!diagnosis.suggestion.withinBudget) {
        return { error: "That would go over the budget line, which only the user can approve. Tell the user the numbers; they can add people from the workbench." };
      }
      count = Math.min(count, diagnosis.suggestion.add);
    }
    count = Math.min(count, Math.max(0, this.host.maxBots - this.host.bots().length));
    if (count < 1) return { error: t("The workspace has no room for more bots.") };
    const now = Date.now();
    const plan = planSquad(run, count, { now, maxConcurrent: this.host.settings().maxConcurrent, roleKey: roleCore }, typicalDuration(run));
    if (!plan.people.length) return { error: t("Nothing is left to hand out: every remaining subtask is running or waits on earlier work.") };

    // the new people, made like the dispatcher's own specialists
    const chief = this.host.bot(run.chiefBotId);
    const taken = this.host.bots().map((bot) => bot.name);
    const span = Math.max(2, org.rules.spanOfControl);
    const created: DispatchBot[] = [];
    const squadIndex: number[] = [];
    const firstSquad = (run.squads ?? []).length;
    plan.people.forEach((person, index) => {
      const first = run.subtasks.find((subtask) => subtask.id === person.subtaskIds[0])!;
      const model = this.newcomerModel(run, first);
      const name = uniqueName(person.roleLabel, taken);
      taken.push(name);
      const group = Math.floor(index / span);
      squadIndex.push(group);
      const bot = this.host.createBot({
        name,
        title: person.roleLabel,
        description: t("{role} — joined {squad} to speed up “{goal}”.", { role: person.roleLabel, squad: squadLetterName(firstSquad + group), goal: clip(run.goal, 60) }),
        // a newcomer joins the department whose work it takes over (the org
        // chief has none of its own), else its chief's
        section: this.host.bot(first.assigneeBotId)?.section || chief?.section,
        modelSelection: model.selection,
      });
      created.push(bot);
      this.setRoute(run.chiefBotId, bot.id, true);
    });
    // one squad per span of people; only not-started subtasks move
    const squads: DispatchSquad[] = [];
    const groups = Math.max(...squadIndex) + 1;
    for (let group = 0; group < groups; group += 1) {
      const members = plan.people.map((person, index) => ({ person, bot: created[index]! })).filter((_, index) => squadIndex[index] === group);
      squads.push({
        name: squadLetterName(firstSquad + group),
        leadBotId: members[0]!.bot.id,
        botIds: members.map((member) => member.bot.id),
        subtaskIds: members.flatMap((member) => member.person.subtaskIds),
        addedAt: now,
        by: by.by,
        reviewAt: now + REVIEW_AFTER_MS,
        ...(plan.makespanBefore !== null ? { etaBefore: now + plan.makespanBefore } : {}),
        ...(plan.makespanAfter !== null ? { etaAfter: now + plan.makespanAfter } : {}),
      });
    }
    const moved: string[] = [];
    plan.people.forEach((person, index) => {
      for (const id of person.subtaskIds) {
        const subtask = run.subtasks.find((entry) => entry.id === id);
        if (!subtask || subtask.status !== "pending") continue;
        subtask.assigneeBotId = created[index]!.id;
        subtask.squad = squads[squadIndex[index]!]!.name;
        subtask.createdBot = true;
        moved.push(id);
      }
    });
    run.squads = [...(run.squads ?? []), ...squads];
    if (plan.cap > this.host.settings().maxConcurrent) run.maxConcurrent = Math.max(plan.cap, run.maxConcurrent ?? 0);
    const names = squads.map((squad) => squad.name).join(t(", "));
    this.host.activity(
      run.sourceThreadId,
      t("{squad} joined “{goal}”: {count} new people take {tasks} subtasks nobody had started", { squad: names, goal: clip(run.goal, 40), count: created.length, tasks: moved.length }),
    );
    this.host.event?.({
      kind: "people.added",
      title: t("Added {count} people to “{goal}” ({squad})", { count: created.length, goal: clip(run.goal, 40), squad: names }),
      botId: run.chiefBotId,
      ...(sectionKey(chief?.section) ? { section: sectionKey(chief?.section) } : {}),
      runId: run.id,
      threadId: run.sourceThreadId,
      severity: "info",
    });
    this.touch(run);
    if (run.status === "running") this.pump(run.id);
    const timer = setTimeout(() => this.checkReviews(), REVIEW_AFTER_MS + 1_000);
    timer.unref?.();
    return { ok: true, added: created.map((bot) => bot.id), squad: squads[0]!, moved, run };
  }

  /** Review squads whose 30 minutes are up: did the run speed up? */
  checkReviews(now = Date.now()): void {
    for (const run of this.runs) {
      let changed = false;
      for (const squad of run.squads ?? []) {
        // a dissolved squad was reviewed when its run ended (if there was enough to tell)
        if (squad.review || squad.endedAt || now < squad.reviewAt) continue;
        const review = reviewSquad(run, squad, now);
        squad.review = review;
        changed = true;
        const values = { squad: squad.name, before: review.speedBefore, after: review.speedAfter };
        const label = review.faster
          ? t("Review of {squad}: {before} → {after} subtasks an hour — faster, they stay", values)
          : t("Review of {squad}: {before} → {after} subtasks an hour — not faster; consider withdrawing them", values);
        this.host.activity(run.sourceThreadId, label, review.faster ? undefined : false);
        this.host.event?.({ kind: "report", title: label, botId: run.chiefBotId, runId: run.id, threadId: run.sourceThreadId, severity: review.faster ? "info" : "warn" });
      }
      if (changed) this.touch(run);
    }
  }

  /** What a squad member reads instead of the whole history. */
  private squadBrief(run: DispatchRun, subtask: DispatchSubtask): SquadBrief | undefined {
    const squad = run.squads?.find((entry) => entry.name === subtask.squad);
    if (!squad) return undefined;
    const lead = this.host.bot(squad.leadBotId);
    const scope = run.subtasks.filter((entry) => entry.assigneeBotId === subtask.assigneeBotId && squad.subtaskIds.includes(entry.id)).map((entry) => entry.title);
    const example = [...run.subtasks]
      .filter((entry) => entry.status === "done" && entry.result && roleCore(entry.role) === roleCore(subtask.role))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    return {
      name: squad.name,
      leadName: lead && lead.id !== subtask.assigneeBotId ? lead.name : undefined,
      scope,
      ...(example ? { example: { title: example.title, result: example.result! } } : {}),
    };
  }

  /** The chief's prompt for its consolidated report. */
  private synthesisPrompt(run: DispatchRun): string {
    const lines = run.subtasks.map((subtask) => {
      const who = this.host.bot(subtask.assigneeBotId)?.name ?? "?";
      if (subtask.status === "done") return `### ${subtask.title} (@${who})\n${clip(subtask.result ?? "", RESULT_CONTEXT_CHARS)}`;
      return `### ${subtask.title} (@${who}) — ${subtask.status}${subtask.error ? `: ${subtask.error}` : ""}`;
    });
    const parent = run.parentRunId ? this.get(run.parentRunId) : undefined;
    const parentSubtask = parent?.subtasks.find((entry) => entry.id === run.parentSubtaskId);
    if (parent && parentSubtask) {
      const boss = this.host.bot(parent.chiefBotId)?.name ?? "the company's chief";
      return [
        `[Ein dispatch finished] Your team has finished your plan "${run.goal}" for the subtask “${parentSubtask.title}”, which @${boss} assigned to your department. Their results follow.`,
        `Reply with the finished deliverable for that subtask: merge the results into one coherent result for @${boss}, and say what failed or needs a decision. It goes back to @${boss} automatically. Do not dispatch or delegate again in this turn.`,
        "",
        ...lines,
      ].join("\n");
    }
    return [
      `[Ein dispatch finished] Every subtask of your plan "${run.goal}" has settled. Their results follow.`,
      "Write the user one consolidated answer: what was done, the key outputs merged into a single coherent deliverable, and anything that failed or needs the user's decision. Do not dispatch or delegate again in this turn.",
      "",
      ...lines,
    ].join("\n");
  }

  private touch(run: DispatchRun): void {
    run.updatedAt = Date.now();
    this.saveRuns();
    this.host.broadcast(run);
  }

  /** Test helper: the worker threads being watched. */
  _watching(): string[] {
    return [...this.watch.keys()];
  }
}

// ── prompts (model-facing, English) ─────────────────────────────────────

interface SquadBrief {
  name: string;
  /** absent when this worker is the squad lead */
  leadName?: string;
  scope: string[];
  example?: { title: string; result: string };
}

function workerPrompt(run: DispatchRun, subtask: DispatchSubtask, context: { chiefName: string; leadOf?: string; squad?: SquadBrief }): string {
  const { chiefName, leadOf, squad } = context;
  const deps = subtask.dependsOn
    .map((dep) => run.subtasks.find((entry) => entry.id === dep))
    .filter((dep): dep is DispatchSubtask => Boolean(dep?.result));
  const header = leadOf
    ? `[Assigned by @${chiefName}, the company's chief, through Ein dispatch. You lead the ${leadOf} department; this subtask is your department's part of a larger plan.]`
    : `[Assigned by @${chiefName} through Ein dispatch. You are one specialist on a team; do this subtask yourself and reply with the finished deliverable.]`;
  return [
    header,
    "",
    `Overall goal: ${run.goal}`,
    `Your subtask: ${subtask.title}`,
    "",
    subtask.brief,
    subtask.acceptance ? `\nAcceptance criteria: ${subtask.acceptance}` : "",
    deps.length ? "\nResults from earlier subtasks you build on:" : "",
    ...deps.map((dep) => `\n### ${dep.title}\n${clip(dep.result ?? "", RESULT_CONTEXT_CHARS)}`),
    ...(squad
      ? [
          "",
          `You joined ${squad.name} to speed this job up. Your onboarding, instead of the whole history:`,
          `- Your scope: ${squad.scope.join("; ") || subtask.title}. Leave everything else to the rest of the team.`,
          squad.example ? `- Match the standard of this finished subtask, “${squad.example.title}”:\n${clip(squad.example.result, EXAMPLE_CHARS)}` : "",
          squad.leadName ? `- Questions go to your squad lead @${squad.leadName}, then @${chiefName}.` : `- You lead ${squad.name}; questions go to @${chiefName}.`,
        ]
      : []),
    "",
    leadOf
      ? `If this needs several pieces of work from your department, call submit_plan once with a plan for your own team: they run it, then you are asked for one consolidated result, which goes back to @${chiefName} automatically. After submit_plan, say the plan in a line and end your turn. If you can do it well yourself, reply with the finished deliverable instead.`
      : "Reply with the complete result. If something blocks you, say exactly what is missing.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** A department's results when its lead wrote no report. */
function teamDigest(run: DispatchRun): string {
  const done = run.subtasks.filter((subtask) => subtask.status === "done" && subtask.result);
  if (!done.length) return run.goal;
  return done.map((subtask) => `### ${subtask.title}\n${clip(subtask.result ?? "", RESULT_CONTEXT_CHARS)}`).join("\n\n");
}

// ── helpers ────────────────────────────────────────────────────────────

function isSettled(status: SubtaskStatus): boolean {
  return status === "done" || status === "failed" || status === "skipped" || status === "canceled";
}

function isFinished(status: RunStatus): boolean {
  return status === "done" || status === "failed" || status === "canceled";
}

/** Dependents of a failed, canceled or skipped subtask can never run. */
function skipBlocked(run: DispatchRun): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const subtask of run.subtasks) {
      if (subtask.status !== "pending") continue;
      const blocked = subtask.dependsOn.some((dep) => {
        const status = run.subtasks.find((entry) => entry.id === dep)?.status;
        return status === "failed" || status === "canceled" || status === "skipped";
      });
      if (blocked) {
        subtask.status = "skipped";
        subtask.error = t("Skipped because a subtask it depends on did not finish");
        subtask.finishedAt = Date.now();
        changed = true;
      }
    }
  }
}

/** The parts of a subtask's pick that differ from the bot's own settings,
 * as turn options (a borrowed engine always names its model and effort). */
function turnOverrides(
  pick: NonNullable<DispatchSubtask["ranWith"]>,
  own: ModelSelection,
): Pick<DispatchTurnOptions, "instanceId" | "model" | "effort"> {
  const borrowed = pick.instanceId !== own.instanceId;
  return {
    ...(borrowed ? { instanceId: pick.instanceId } : {}),
    ...(borrowed || pick.model !== own.model ? { model: pick.model } : {}),
    ...(pick.effort && (borrowed || pick.effort !== own.effort) ? { effort: pick.effort } : {}),
  };
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** "Squad B", "Squad C", … — the original team is Squad A. */
function squadLetterName(index: number): string {
  const letter = index < 25 ? String.fromCharCode(66 + index) : String(index + 2);
  return t("Squad {letter}", { letter });
}

/** The name the next squad added to `run` gets. */
export function nextSquadName(run: DispatchRun): string {
  return squadLetterName((run.squads ?? []).length);
}

/** Id of a specialist a plan will create, before the plan is accepted. */
const PLANNED_PREFIX = "planned:";

/** A display name for a new specialist, unique among existing bots. */
export function uniqueName(role: string, taken: string[]): string {
  const base = clip(role.replace(/[@\n]/g, " ").trim() || "Specialist", 24);
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
