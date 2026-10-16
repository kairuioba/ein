// Dispatch hub (调度中枢): a Chief of Staff hands in a structured plan, and
// the harness — not the model — runs it.
//
//   submit_plan (Chief) ─▶ validate the DAG ─▶ assign each subtask to a team
//   member, creating a specialist with a recommended model when nobody fits
//   ─▶ run ready subtasks in parallel, each in its own task conversation,
//   feeding finished results to the subtasks that depend on them ─▶ when
//   everything has settled, ask the Chief for one consolidated report.
//
// Upstream's delegate_bot stays available for ad-hoc single handoffs; this
// module is the deterministic path for multi-step work. Workers run at comms
// depth 1 (no team tools), so a dispatched subtask can never dispatch again.
//
// Dispatch routes (派发通道) are the workbench's wires: by default a Chief
// can dispatch to every visible member of its own section; an explicit route
// adds a bot from any section, and an unplugged route removes one.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { t } from "../shared/i18n.ts";
import type { Capability } from "../shared/model-profiles.ts";
import { assessTask, type Recommendation, type RecommendationPolicy, type TaskProfile } from "../shared/model-recommender.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId, type ModelSelection } from "./contracts.ts";

export {
  DEFAULT_DISPATCH_SETTINGS,
  dispatchSettings,
  type DispatchRoute,
  type DispatchRun,
  type DispatchSettings,
  type DispatchSubtask,
  type RunStatus,
  type SubtaskStatus,
} from "../shared/dispatch-types.ts";
import type { DispatchRoute, DispatchRun, DispatchSettings, DispatchSubtask, SubtaskStatus, RunStatus } from "../shared/dispatch-types.ts";

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
  hidden?: boolean;
  chiefOfStaff?: boolean;
  modelSelection: ModelSelection;
}

export interface DispatchHost {
  bots(): DispatchBot[];
  bot(id: string): DispatchBot | undefined;
  /** Create a specialist with safe defaults (no connected apps, no auto-approval). */
  createBot(input: { name: string; title: string; description: string; section?: string; modelSelection: ModelSelection }): DispatchBot;
  /** A detached task conversation for one subtask. */
  createTask(botId: string, title: string): { threadId: string } | null;
  /** Start a turn; rejects when the bot cannot start (busy, missing, no engine). */
  startTurn(botId: string, text: string, opts: { threadId: string; continuation?: boolean }): Promise<void>;
  interrupt(botId: string, threadId: string): Promise<void>;
  /** A status chip in a conversation. */
  activity(threadId: string, label: string, ok?: boolean): void;
  recommend(task: TaskProfile, policy: RecommendationPolicy): Recommendation | null;
  broadcast(run: DispatchRun): void;
  broadcastRoutes(routes: DispatchRoute[]): void;
  settings(): DispatchSettings;
  maxBots: number;
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
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
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

// ── the dispatcher ─────────────────────────────────────────────────────

const RESULT_KEEP_CHARS = 6_000;
const RESULT_CONTEXT_CHARS = 3_000;
const MAX_RUNS = 60;
const FINISHED_RUN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export class Dispatcher {
  private runs: DispatchRun[] = [];
  private routeList: DispatchRoute[] = [];
  /** worker thread → run/subtask it belongs to */
  private readonly watch = new Map<string, { runId: string; subtaskId: string }>();
  private readonly host: DispatchHost;
  private readonly runsFile: string;
  private readonly routesFile: string;

  constructor(host: DispatchHost, dataDir = DATA_DIR) {
    this.host = host;
    this.runsFile = join(dataDir, "dispatch-runs.json");
    this.routesFile = join(dataDir, "dispatch-routes.json");
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
    // No turn survives a restart: anything that was running goes back to
    // pending (keeping its attempt count) and the scheduler picks it up.
    for (const run of this.runs) {
      for (const subtask of run.subtasks) {
        if (subtask.status === "running") {
          subtask.status = "pending";
          subtask.error = t("Interrupted by a restart");
        }
      }
      if (run.status === "synthesizing" && run.synthesisStarted) run.status = "done";
    }
    this.saveRuns();
  }

  private saveRuns(): void {
    const now = Date.now();
    this.runs = this.runs
      .filter((run) => !isFinished(run.status) || now - run.updatedAt < FINISHED_RUN_MAX_AGE_MS)
      .slice(0, MAX_RUNS);
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

  /** Bots this Chief may dispatch to: its section's visible members unless
   * unplugged, plus anyone wired to it explicitly. */
  team(chiefId: string): DispatchBot[] {
    const chief = this.host.bot(chiefId);
    if (!chief) return [];
    const section = chief.section?.trim() || "";
    const disabled = new Set(this.routeList.filter((r) => r.fromBotId === chiefId && !r.enabled).map((r) => r.toBotId));
    const wired = new Set(this.routeList.filter((r) => r.fromBotId === chiefId && r.enabled).map((r) => r.toBotId));
    return this.host
      .bots()
      .filter((bot) => bot.id !== chiefId && !bot.hidden)
      .filter((bot) => wired.has(bot.id) || ((bot.section?.trim() || "") === section && !disabled.has(bot.id)));
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
    if (!chief.chiefOfStaff) return { error: "Only a section's Chief of Staff can submit a dispatch plan." };
    const active = this.runs.filter((run) => run.chiefBotId === chiefId && !isFinished(run.status));
    if (active.length >= 2) {
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
      let assignee = item.assignee ? this.findAssignee(item.assignee, team.concat(created)) : undefined;
      if (item.assignee && !assignee) {
        return { error: `Subtask "${item.id}" names assignee "${item.assignee}", who is not on your team. Use list_bots for names and ids, or leave assignee empty.` };
      }
      if (assignee?.id === chiefId) return { error: `Do not assign subtask "${item.id}" to yourself; you coordinate and synthesize.` };
      assignee ??= this.bestMember(item, team.concat(created), subtasks);
      if (!assignee) {
        if (!settings.autoCreate) {
          return { error: `Nobody on your team fits subtask "${item.id}" (${item.role}) and creating specialists is turned off. Name an assignee from list_bots.` };
        }
        if (created.length >= settings.maxNewBots || this.host.bots().length + created.length >= this.host.maxBots) {
          // out of room for new bots: share the work among who we have
          assignee = this.leastLoaded(team.concat(created), subtasks);
          if (!assignee) return { error: "No team member is available and no more bots can be created. Ask the user to add a bot." };
        } else {
          const recommendation = this.host.recommend(task, policy);
          const bot = this.host.createBot({
            name: uniqueName(item.role, this.host.bots().map((b) => b.name)),
            title: item.role,
            description: t("{role} — created by @{chief} for dispatched work.", { role: item.role, chief: chief.name }),
            section: chief.section,
            modelSelection: recommendation
              ? { instanceId: recommendation.instanceId, model: recommendation.model, ...(recommendation.effort ? { effort: recommendation.effort } : {}) }
              : { ...chief.modelSelection },
          });
          created.push(bot);
          assignee = bot;
        }
      }
      subtasks.push({
        id: item.id,
        title: item.title,
        brief: item.brief,
        role: item.role,
        needs: task.needs,
        difficulty: task.difficulty,
        dependsOn: item.dependsOn,
        ...(item.acceptance ? { acceptance: item.acceptance } : {}),
        assigneeBotId: assignee.id,
        ...(created.some((bot) => bot.id === assignee!.id) ? { createdBot: true } : {}),
        status: "pending",
        attempts: 0,
      });
    }
    // new specialists are wired to their Chief on the workbench
    for (const bot of created) this.setRoute(chiefId, bot.id, true);

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
    };
    this.runs.unshift(run);
    this.saveRuns();
    this.host.activity(
      sourceThreadId,
      t("Dispatch plan accepted: {count} subtasks for “{goal}”", { count: subtasks.length, goal: clip(plan.goal, 60) }),
    );
    this.host.broadcast(run);
    if (run.status === "running") queueMicrotask(() => this.pump(run.id));
    return { run, created: created.map((bot) => bot.id) };
  }

  private findAssignee(nameOrId: string, team: DispatchBot[]): DispatchBot | undefined {
    const wanted = nameOrId.replace(/^@/, "").trim().toLowerCase();
    return team.find((bot) => bot.id === nameOrId || bot.name.trim().toLowerCase() === wanted);
  }

  /** The member whose role best fits the subtask, if any fits well enough.
   * Busy members and those already holding work in this plan rank lower. */
  private bestMember(item: ValidPlanSubtask, team: DispatchBot[], assigned: DispatchSubtask[]): DispatchBot | undefined {
    let best: { bot: DispatchBot; score: number } | undefined;
    for (const bot of team) {
      if (bot.chiefOfStaff) continue;
      const profile = `${bot.title} ${bot.description} ${bot.name}`;
      let score = Math.max(roleSimilarity(item.role, profile), 0.8 * roleSimilarity(`${item.title} ${item.role}`, profile));
      if (score < REUSE_THRESHOLD) continue;
      if (bot.busy) score -= 0.1;
      score -= 0.05 * assigned.filter((subtask) => subtask.assigneeBotId === bot.id).length;
      if (!best || score > best.score) best = { bot, score };
    }
    return best?.bot;
  }

  private leastLoaded(team: DispatchBot[], assigned: DispatchSubtask[]): DispatchBot | undefined {
    const workers = team.filter((bot) => !bot.chiefOfStaff);
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
    run.status = "canceled";
    for (const subtask of run.subtasks) {
      if (subtask.status === "running" && subtask.threadId) {
        this.watch.delete(subtask.threadId);
        await this.host.interrupt(subtask.assigneeBotId, subtask.threadId).catch(() => undefined);
      }
      if (subtask.status === "pending" || subtask.status === "running") {
        subtask.status = "canceled";
        subtask.finishedAt = Date.now();
      }
    }
    this.host.activity(run.sourceThreadId, t("Dispatch canceled: “{goal}”", { goal: clip(run.goal, 60) }), false);
    this.touch(run);
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
    for (const other of run.subtasks) {
      if (other.status === "skipped") other.status = "pending";
    }
    run.status = "running";
    run.synthesisStarted = false;
    this.touch(run);
    queueMicrotask(() => this.pump(run.id));
    return run;
  }

  /** A worker's turn settled (turn.completed or a harness-side stop). */
  onTurnSettled(threadId: string, ok: boolean, reply: string, reason?: string): void {
    const ticket = this.watch.get(threadId);
    if (!ticket) return;
    this.watch.delete(threadId);
    const run = this.get(ticket.runId);
    const subtask = run?.subtasks.find((entry) => entry.id === ticket.subtaskId);
    if (!run || !subtask || subtask.status !== "running") return;
    const bot = this.host.bot(subtask.assigneeBotId);
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
      const why = reason?.trim() || (ok ? t("finished without a reply") : t("did not finish"));
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

  /** Pick unfinished runs back up after a restart (call once the harness can
   * start turns). */
  resumeAll(): void {
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "synthesizing") this.pump(run.id);
    }
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

  /** A bot became idle: work waiting on it, or a synthesis waiting on its
   * Chief, may start now. */
  onBotIdle(botId: string): void {
    for (const run of this.runs) {
      if (run.status !== "running" && run.status !== "synthesizing") continue;
      if (run.chiefBotId === botId || run.subtasks.some((subtask) => subtask.assigneeBotId === botId && subtask.status === "pending")) {
        this.pump(run.id);
      }
    }
  }

  /** Start every runnable subtask, and the synthesis once all have settled. */
  pump(runId: string): void {
    const run = this.get(runId);
    if (!run) return;
    if (run.status === "running") {
      // dependents of a failed/canceled subtask can never run
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
      const settings = this.host.settings();
      let running = run.subtasks.filter((subtask) => subtask.status === "running").length;
      for (const subtask of run.subtasks) {
        if (running >= settings.maxConcurrent) break;
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
        if (bot.busy || run.subtasks.some((other) => other.status === "running" && other.assigneeBotId === bot.id)) continue;
        this.startSubtask(run, subtask, bot);
        running += 1;
      }
      if (run.subtasks.every((subtask) => isSettled(subtask.status))) {
        const anyDone = run.subtasks.some((subtask) => subtask.status === "done");
        run.status = anyDone && this.host.settings().autoSynthesize ? "synthesizing" : anyDone ? "done" : "failed";
        if (run.status === "failed") {
          this.host.activity(run.sourceThreadId, t("Dispatch finished without results: “{goal}”", { goal: clip(run.goal, 60) }), false);
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
      return;
    }
    subtask.status = "running";
    subtask.attempts += 1;
    subtask.threadId = task.threadId;
    subtask.startedAt = Date.now();
    this.watch.set(task.threadId, { runId: run.id, subtaskId: subtask.id });
    const chief = this.host.bot(run.chiefBotId);
    this.host.activity(run.sourceThreadId, t("Dispatched “{title}” to @{name}", { title: subtask.title, name: bot.name }));
    this.host
      .startTurn(bot.id, workerPrompt(run, subtask, chief?.name ?? "Chief"), { threadId: task.threadId })
      .catch((error: unknown) => {
        // could not even start: settle through the normal path so retry and
        // dependent-skipping rules apply
        this.onTurnSettled(task.threadId, false, "", error instanceof Error ? error.message : String(error));
      });
  }

  private startSynthesis(run: DispatchRun): void {
    const chief = this.host.bot(run.chiefBotId);
    if (!chief) {
      run.status = "done";
      this.touch(run);
      return;
    }
    if (chief.busy) return; // onBotIdle retries when the Chief is free
    run.synthesisStarted = true;
    this.touch(run);
    this.host
      .startTurn(chief.id, synthesisPrompt(run, this.host), { threadId: run.sourceThreadId, continuation: true })
      .then(() => {
        run.status = "done";
        this.touch(run);
      })
      .catch(() => {
        run.synthesisStarted = false;
        run.status = "done";
        this.host.activity(run.sourceThreadId, t("All subtasks finished — open the workbench to read the results"));
        this.touch(run);
      });
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

function workerPrompt(run: DispatchRun, subtask: DispatchSubtask, chiefName: string): string {
  const deps = subtask.dependsOn
    .map((dep) => run.subtasks.find((entry) => entry.id === dep))
    .filter((dep): dep is DispatchSubtask => Boolean(dep?.result));
  return [
    `[Assigned by @${chiefName} through OpenMausBot dispatch. You are one specialist on a team; do this subtask yourself and reply with the finished deliverable.]`,
    "",
    `Overall goal: ${run.goal}`,
    `Your subtask: ${subtask.title}`,
    "",
    subtask.brief,
    subtask.acceptance ? `\nAcceptance criteria: ${subtask.acceptance}` : "",
    deps.length ? "\nResults from earlier subtasks you build on:" : "",
    ...deps.map((dep) => `\n### ${dep.title}\n${clip(dep.result ?? "", RESULT_CONTEXT_CHARS)}`),
    "",
    "Reply with the complete result. If something blocks you, say exactly what is missing.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function synthesisPrompt(run: DispatchRun, host: DispatchHost): string {
  const lines = run.subtasks.map((subtask) => {
    const who = host.bot(subtask.assigneeBotId)?.name ?? "?";
    if (subtask.status === "done") return `### ${subtask.title} (@${who})\n${clip(subtask.result ?? "", RESULT_CONTEXT_CHARS)}`;
    return `### ${subtask.title} (@${who}) — ${subtask.status}${subtask.error ? `: ${subtask.error}` : ""}`;
  });
  return [
    `[OpenMausBot dispatch finished] Every subtask of your plan "${run.goal}" has settled. Their results follow.`,
    "Write the user one consolidated answer: what was done, the key outputs merged into a single coherent deliverable, and anything that failed or needs the user's decision. Do not dispatch or delegate again in this turn.",
    "",
    ...lines,
  ].join("\n");
}

// ── helpers ────────────────────────────────────────────────────────────

function isSettled(status: SubtaskStatus): boolean {
  return status === "done" || status === "failed" || status === "skipped" || status === "canceled";
}

function isFinished(status: RunStatus): boolean {
  return status === "done" || status === "failed" || status === "canceled";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

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
