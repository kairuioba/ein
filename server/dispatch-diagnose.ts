// Adding people to a running job (中途加人), as pure functions over one run.
//
// The owner says "too slow, add people"; before anyone is created the chief
// answers four questions from the run's own numbers — is the work waiting on
// someone, can what is left run in parallel, is it a capability problem, is an
// engine throttling us — and only suggests people when that helps. People who
// join form a squad (the original team is "Squad A") and take only subtasks
// nobody has started: done work stays put, running work is not taken away,
// dependencies are kept. A schedule simulation turns observed subtask
// durations into "finishes at" before and after, and 30 minutes later the
// review compares the speed before and since.
//
// The Dispatcher (server/dispatch.ts) supplies the run, the bots, the org rules
// and the model recommender; nothing here touches disk or the harness.
import { t } from "../shared/i18n.ts";
import type {
  DispatchDiagnosis,
  DispatchRun,
  DispatchSquad,
  DispatchSquadReview,
  DispatchSubtask,
} from "../shared/dispatch-types.ts";
import type { OrgRules } from "../shared/org-types.ts";
import type { ModelSelection } from "./contracts.ts";

/** Throttling older than this no longer counts as "an engine is limiting us". */
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
/** When the speed review of an added squad is due. */
export const REVIEW_AFTER_MS = 30 * 60_000;
/** A run that ends sooner than this after a squad joined says nothing about its speed. */
export const MIN_REVIEW_WINDOW_MS = 5 * 60_000;
/** Engines report spend in US dollars; the company budget is in yuan. */
export const USD_TO_CNY = 7.2;
/** Reading the onboarding pack and a finished example costs a newcomer about
 * this share of one subtask's spend, per subtask it takes. */
export const ONBOARDING_SHARE = 0.1;
/** A run never runs more subtasks at once than this, however many join. */
export const MAX_RUN_CONCURRENCY = 16;
/** More than this share of attempts sent back means a capability problem. */
const REWORK_LIMIT = 0.25;
/** Take the smallest squad that gets this share of the best possible speed-up. */
const GAIN_SHARE = 0.9;

export interface DiagnoseBot {
  id: string;
  name: string;
  busy?: boolean;
  activity?: string;
  modelSelection: ModelSelection;
}

export interface NewcomerModel {
  selection: ModelSelection;
  label: string;
  /** price level 1–5 (shared/model-profiles.ts) */
  costLevel: number;
}

export interface DiagnoseContext {
  now: number;
  bot(id: string): DiagnoseBot | undefined;
  /** settings.maxConcurrent */
  maxConcurrent: number;
  rules: OrgRules;
  /** the daily budget line for this run (its department's, else the company's), CNY */
  budgetCny: number;
  /** how many more bots the workspace can hold */
  room: number;
  /** what groups subtasks into one kind of work ("前端工程师" and "前端" alike) */
  roleKey(role: string): string;
  /** the model a newcomer taking this subtask would get */
  modelFor(subtask: DispatchSubtask): NewcomerModel;
  /** price level (1–5) of the model a bot runs now */
  costLevel(botId: string): number;
  /** what a finished subtask cost, CNY; null when its engine reports no price */
  costCny(subtask: DispatchSubtask): number | null;
  /** a display name for an engine instance */
  engineName(instanceId: string): string;
  /** names already taken, so planned newcomers get unique ones */
  takenNames: string[];
  uniqueName(role: string, taken: string[]): string;
  /** the name of the squad that would be added */
  squadName: string;
  /** the lead who coordinates this run (the run's chief) */
  leadName: string;
  /** an explicit ask: how many more people */
  requested?: number;
  /** a not-started subtask that stays with whoever has it: a department
   * lead's share of the 主 Bot's plan, which the lead staffs with its own
   * team. Newcomers never take one. */
  keep?(subtask: DispatchSubtask): boolean;
}

// ── small maths ─────────────────────────────────────────────────────────

/** Lines between n people who all talk to each other. */
export function pairs(n: number): number {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

/** Communication lines a lead's team carries: everyone who reports to the
 * lead directly talks to each other; inside a squad, members talk only to the
 * squad lead (who sits among the direct reports). 4 people → 6; adding a
 * squad of 4 → 10 + 3 = 13, where 8 people ungrouped would be 28. */
export function communicationLines(direct: number, squadSizes: readonly number[]): number {
  return pairs(direct) + squadSizes.reduce((sum, size) => sum + Math.max(0, size - 1), 0);
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** How long one subtask typically takes on this run: the median of finished ones. */
export function typicalDuration(run: DispatchRun): number | null {
  return median(
    run.subtasks
      .filter((subtask) => subtask.status === "done" && subtask.startedAt && subtask.finishedAt && subtask.finishedAt > subtask.startedAt)
      .map((subtask) => subtask.finishedAt! - subtask.startedAt!),
  );
}

/** Subtasks finished per hour between `from` and `to`. */
export function throughput(run: DispatchRun, from: number, to: number): number {
  const hours = (to - from) / 3_600_000;
  if (hours <= 0) return 0;
  const finished = run.subtasks.filter((subtask) => subtask.status === "done" && subtask.finishedAt !== undefined && subtask.finishedAt >= from && subtask.finishedAt < to).length;
  return round1(finished / hours);
}

/** When the run's work actually began: its first subtask start, else its creation. */
export function workStartedAt(run: DispatchRun): number {
  const starts = run.subtasks.map((subtask) => subtask.startedAt).filter((at): at is number => typeof at === "number");
  return starts.length ? Math.min(run.createdAt, ...starts) : run.createdAt;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

// ── schedule simulation ─────────────────────────────────────────────────

export interface SimTask {
  id: string;
  worker: string;
  deps: readonly string[];
  /** ms of work left */
  remaining: number;
  /** already in progress at time 0 */
  running?: boolean;
}

/** How long the unfinished part of a run takes when each worker does one
 * subtask at a time, at most `cap` run at once (work already running counts),
 * and a subtask starts only after everything it depends on is done. Waiting
 * subtasks start in plan order. Returns ms from now, or null when something
 * could never start. */
export function simulateMakespan(tasks: readonly SimTask[], doneIds: ReadonlySet<string>, cap: number): number | null {
  const done = new Set(doneIds);
  const active: Array<{ task: SimTask; endsAt: number }> = [];
  const busy = new Set<string>();
  for (const task of tasks) {
    if (!task.running) continue;
    active.push({ task, endsAt: Math.max(0, task.remaining) });
    busy.add(task.worker);
  }
  const waiting = tasks.filter((task) => !task.running);
  let now = 0;
  for (let guard = 0; guard <= tasks.length * 2 + 2; guard += 1) {
    for (let index = 0; index < waiting.length && active.length < cap; ) {
      const task = waiting[index]!;
      if (!busy.has(task.worker) && task.deps.every((dep) => done.has(dep))) {
        waiting.splice(index, 1);
        active.push({ task, endsAt: now + Math.max(0, task.remaining) });
        busy.add(task.worker);
      } else {
        index += 1;
      }
    }
    if (!active.length) return waiting.length ? null : now;
    active.sort((a, b) => a.endsAt - b.endsAt);
    now = active[0]!.endsAt;
    while (active.length && active[0]!.endsAt <= now) {
      const finished = active.shift()!;
      done.add(finished.task.id);
      busy.delete(finished.task.worker);
    }
  }
  return null;
}

export interface PoolWorker {
  id: string;
  /** a newcomer takes any ready subtask of its kinds of work (role keys);
   * someone already on the team takes only what is assigned to them */
  fresh: boolean;
  roles: ReadonlySet<string>;
}

/** Who would take which not-started subtask: every free newcomer picks the
 * next ready subtask of its kind of work, in plan order, while the original
 * team keeps doing what is assigned to it; workers listed first pick first.
 * Running work keeps its worker. Returns subtask id → worker id. */
export function poolSchedule(input: {
  running: ReadonlyArray<{ id: string; worker: string; remaining: number }>;
  /** `fixed`: stays with its owner, never taken by a newcomer */
  pending: ReadonlyArray<{ id: string; owner: string; role: string; deps: readonly string[]; fixed?: boolean }>;
  workers: readonly PoolWorker[];
  doneIds: ReadonlySet<string>;
  cap: number;
  duration: number;
}): Map<string, string> {
  const done = new Set(input.doneIds);
  const taken = new Map<string, string>();
  const active = input.running.map((entry) => ({ id: entry.id, worker: entry.worker, endsAt: Math.max(0, entry.remaining) }));
  const busy = new Set(active.map((entry) => entry.worker));
  const waiting = [...input.pending];
  const canTake = (worker: PoolWorker, task: (typeof waiting)[number]) =>
    (worker.fresh ? !task.fixed && worker.roles.has(task.role) : task.owner === worker.id) && task.deps.every((dep) => done.has(dep));
  let now = 0;
  for (let guard = 0; guard <= (input.pending.length + input.running.length) * 2 + 2; guard += 1) {
    for (const worker of input.workers) {
      if (active.length >= input.cap) break;
      if (busy.has(worker.id)) continue;
      const index = waiting.findIndex((task) => canTake(worker, task));
      if (index < 0) continue;
      const [task] = waiting.splice(index, 1);
      taken.set(task!.id, worker.id);
      active.push({ id: task!.id, worker: worker.id, endsAt: now + input.duration });
      busy.add(worker.id);
    }
    if (!active.length) break;
    active.sort((a, b) => a.endsAt - b.endsAt);
    now = active[0]!.endsAt;
    while (active.length && active[0]!.endsAt <= now) {
      const finished = active.shift()!;
      done.add(finished.id);
      busy.delete(finished.worker);
    }
  }
  return taken;
}

/** Spread `count` newcomers over the kinds of work with the most not-started
 * subtasks per worker; never more newcomers on a kind than it has subtasks. */
export function chooseRoles(count: number, pendingByRole: ReadonlyMap<string, number>, workersByRole: ReadonlyMap<string, number>): string[] {
  const added = new Map<string, number>();
  const chosen: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let best: string | undefined;
    let bestLoad = 0;
    let bestPeople = Infinity;
    for (const [role, pending] of pendingByRole) {
      const joined = added.get(role) ?? 0;
      if (joined >= pending) continue;
      const people = (workersByRole.get(role) ?? 0) + joined;
      const load = pending / (people + 1);
      // equal load: the kind of work with fewer hands gets the newcomer
      if (load > bestLoad || (load === bestLoad && people < bestPeople)) {
        best = role;
        bestLoad = load;
        bestPeople = people;
      }
    }
    if (!best) break;
    added.set(best, (added.get(best) ?? 0) + 1);
    chosen.push(best);
  }
  return chosen;
}

// ── the plan for one squad ─────────────────────────────────────────────

export interface SquadPlan {
  people: Array<{ role: string; roleLabel: string; subtaskIds: string[] }>;
  /** subtask id → index into people */
  moves: Map<string, number>;
  /** concurrency the run gets after adding */
  cap: number;
  /** ms from now until everything is done, when durations are known */
  makespanBefore: number | null;
  makespanAfter: number | null;
}

/** Subtasks that will never start: something they depend on failed. */
function doomed(run: DispatchRun): Set<string> {
  const dead = new Set(run.subtasks.filter((subtask) => subtask.status === "failed" || subtask.status === "skipped" || subtask.status === "canceled").map((subtask) => subtask.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const subtask of run.subtasks) {
      if (subtask.status === "pending" && !dead.has(subtask.id) && subtask.dependsOn.some((dep) => dead.has(dep))) {
        dead.add(subtask.id);
        changed = true;
      }
    }
  }
  return dead;
}

/** The run's current concurrency. */
export function runConcurrency(run: DispatchRun, settingsCap: number): number {
  return Math.max(1, settingsCap, run.maxConcurrent ?? 0);
}

/** Plan a squad of up to `count` newcomers for `run`: which kinds of work they
 * do, which not-started subtasks they take, and the finish time before/after.
 * Pass `duration` = typicalDuration(run) (null when nothing finished yet). */
export function planSquad(run: DispatchRun, count: number, ctx: Pick<DiagnoseContext, "now" | "maxConcurrent" | "roleKey" | "keep">, duration: number | null): SquadPlan {
  const dead = doomed(run);
  const doneIds = new Set(run.subtasks.filter((subtask) => subtask.status === "done").map((subtask) => subtask.id));
  const running = run.subtasks.filter((subtask) => subtask.status === "running");
  const pending = run.subtasks.filter((subtask) => subtask.status === "pending" && !dead.has(subtask.id));
  const stays = (subtask: DispatchSubtask) => Boolean(ctx.keep?.(subtask));
  const unit = duration ?? 60_000;
  const remainingOf = (subtask: DispatchSubtask) => Math.max(unit - (ctx.now - (subtask.startedAt ?? ctx.now)), unit * 0.2);
  const capBefore = runConcurrency(run, ctx.maxConcurrent);

  // who is on the team, and which kinds of work each one does
  const rolesOf = new Map<string, Set<string>>();
  for (const subtask of run.subtasks) {
    const roles = rolesOf.get(subtask.assigneeBotId) ?? new Set<string>();
    roles.add(ctx.roleKey(subtask.role));
    rolesOf.set(subtask.assigneeBotId, roles);
  }
  // newcomers come for the kinds of work they may take
  const pendingByRole = new Map<string, number>();
  const roleLabel = new Map<string, string>();
  for (const subtask of pending) {
    if (stays(subtask)) continue;
    const key = ctx.roleKey(subtask.role);
    pendingByRole.set(key, (pendingByRole.get(key) ?? 0) + 1);
    if (!roleLabel.has(key)) roleLabel.set(key, subtask.role);
  }
  const workersByRole = new Map<string, number>();
  for (const [botId, roles] of rolesOf) {
    if (!run.subtasks.some((subtask) => subtask.assigneeBotId === botId && (subtask.status === "running" || subtask.status === "pending"))) continue;
    for (const role of roles) workersByRole.set(role, (workersByRole.get(role) ?? 0) + 1);
  }

  const roles = chooseRoles(Math.max(0, Math.trunc(count)), pendingByRole, workersByRole);
  const newcomerId = (index: number) => `\u0000new:${index}`;
  const assignedWorkers = new Set<string>(run.subtasks.filter((subtask) => subtask.status === "running" || subtask.status === "pending").map((subtask) => subtask.assigneeBotId));
  const workers: PoolWorker[] = [
    ...roles.map((role, index) => ({ id: newcomerId(index), fresh: true, roles: new Set([role]) })),
    ...[...assignedWorkers].map((id) => ({ id, fresh: false, roles: rolesOf.get(id) ?? new Set<string>() })),
  ];
  const capAfter = Math.min(MAX_RUN_CONCURRENCY, Math.max(capBefore, assignedWorkers.size + roles.length));
  const taken = poolSchedule({
    running: running.map((subtask) => ({ id: subtask.id, worker: subtask.assigneeBotId, remaining: remainingOf(subtask) })),
    pending: pending.map((subtask) => ({ id: subtask.id, owner: subtask.assigneeBotId, role: ctx.roleKey(subtask.role), deps: subtask.dependsOn, ...(stays(subtask) ? { fixed: true } : {}) })),
    workers,
    doneIds,
    cap: capAfter,
    duration: unit,
  });

  // only what newcomers take moves; the original team keeps the rest as assigned
  const people = roles.map((role) => ({ role, roleLabel: roleLabel.get(role) ?? role, subtaskIds: [] as string[] }));
  const moves = new Map<string, number>();
  for (const subtask of pending) {
    const worker = taken.get(subtask.id);
    if (!worker?.startsWith("\u0000new:")) continue;
    const index = Number(worker.slice("\u0000new:".length));
    people[index]!.subtaskIds.push(subtask.id);
  }
  // newcomers the pool left without work are not added
  const kept = people.filter((person) => person.subtaskIds.length);
  kept.forEach((person, index) => person.subtaskIds.forEach((id) => moves.set(id, index)));
  const cap = Math.min(MAX_RUN_CONCURRENCY, Math.max(capBefore, assignedWorkers.size + kept.length));

  const simulate = (workerOf: (subtask: DispatchSubtask) => string, simCap: number) =>
    simulateMakespan(
      [
        ...running.map((subtask) => ({ id: subtask.id, worker: subtask.assigneeBotId, deps: subtask.dependsOn, remaining: remainingOf(subtask), running: true })),
        ...pending.map((subtask) => ({ id: subtask.id, worker: workerOf(subtask), deps: subtask.dependsOn, remaining: unit })),
      ],
      doneIds,
      simCap,
    );
  const makespanBefore = duration === null ? null : simulate((subtask) => subtask.assigneeBotId, capBefore);
  const makespanAfter =
    duration === null
      ? null
      : simulate((subtask) => (moves.has(subtask.id) ? newcomerId(moves.get(subtask.id)!) : subtask.assigneeBotId), cap);
  return { people: kept, moves, cap, makespanBefore, makespanAfter };
}

// ── the diagnosis ───────────────────────────────────────────────────────

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** "P14–P24" for a run of titles, the title alone for one. */
function titleRange(subtasks: readonly DispatchSubtask[]): string {
  if (!subtasks.length) return "";
  const first = clip(subtasks[0]!.title, 14);
  if (subtasks.length === 1) return first;
  return `${first}–${clip(subtasks[subtasks.length - 1]!.title, 14)}`;
}

function listNames(names: readonly string[]): string {
  const unique = [...new Set(names)].filter(Boolean);
  const shown = unique.slice(0, 3).join(t(", "));
  return unique.length > 3 ? t("{names} and {count} more", { names: shown, count: unique.length - 3 }) : shown;
}

/** Spend of finished work on this run, CNY, and the average per subtask (null when unknown). */
function spend(run: DispatchRun, ctx: Pick<DiagnoseContext, "costCny">): { total: number; average: number | null } {
  const costs = run.subtasks
    .filter((subtask) => subtask.status === "done" || subtask.status === "failed")
    .map((subtask) => ctx.costCny(subtask))
    .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost >= 0);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const doneCosts = run.subtasks
    .filter((subtask) => subtask.status === "done")
    .map((subtask) => ctx.costCny(subtask))
    .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost >= 0);
  return { total, average: doneCosts.length ? doneCosts.reduce((sum, cost) => sum + cost, 0) / doneCosts.length : null };
}

/** Answer the four questions, suggest a squad (or say why not), and list the
 * subtasks with where each would go. */
export function diagnoseRun(run: DispatchRun, ctx: DiagnoseContext): DispatchDiagnosis {
  const now = ctx.now;
  const dead = doomed(run);
  const doneIds = new Set(run.subtasks.filter((subtask) => subtask.status === "done").map((subtask) => subtask.id));
  const running = run.subtasks.filter((subtask) => subtask.status === "running");
  const pending = run.subtasks.filter((subtask) => subtask.status === "pending" && !dead.has(subtask.id));
  const unsettled = [...running, ...pending];
  const counted = run.subtasks.filter((subtask) => subtask.status === "done" || subtask.status === "running" || subtask.status === "pending");

  // 1 · waiting on someone: earlier results, or the owner's approval
  const blocked = pending.filter((subtask) => !subtask.dependsOn.every((dep) => doneIds.has(dep)));
  const approvals = running.filter((subtask) => ctx.bot(subtask.assigneeBotId)?.activity === "waiting-on-you");
  const waitingCount = blocked.length + approvals.length;
  const waitingOk = unsettled.length === 0 || waitingCount * 2 < unsettled.length;
  const waiting = {
    id: "waiting" as const,
    ok: waitingOk,
    finding: waitingCount === 0
      ? t("No, nothing is waiting")
      : waitingOk
        ? t("Only {count} waiting on others", { count: waitingCount })
        : t("{count} of {total} are waiting on others", { count: waitingCount, total: unsettled.length }),
    evidence: approvals.length && !blocked.length
      ? t("{count} waiting for your approval", { count: approvals.length })
      : t("The other {count} don't wait", { count: Math.max(0, counted.length - waitingCount) }),
  };

  // 2 · can what is left run side by side
  const ready = pending.filter((subtask) => subtask.dependsOn.every((dep) => doneIds.has(dep)));
  const parallel = {
    id: "parallel" as const,
    ok: ready.length > 0,
    finding: ready.length > 0
      ? t("Yes, {count} don't depend on each other", { count: ready.length })
      : pending.length
        ? t("No, nothing left can start yet")
        : t("No, nothing is left to start"),
    evidence: ready.length > 0
      ? t("{range} not started yet", { range: titleRange(ready) })
      : pending.length
        ? t("{count} wait on earlier work", { count: pending.length })
        : t("{count} running, the rest done", { count: running.length }),
  };

  // 3 · capability: how much work is sent back (throttling excluded)
  const attempted = run.subtasks.filter((subtask) => subtask.attempts > 0);
  const reworks = run.subtasks.reduce(
    (sum, subtask) => sum + Math.max(0, Math.max(0, subtask.attempts - 1) + (subtask.status === "failed" ? 1 : 0) - (subtask.throttledAttempts ?? 0)),
    0,
  );
  const reworkRate = attempted.length ? reworks / attempted.length : 0;
  const reworkPercent = Math.round(reworkRate * 100);
  const capabilityOk = reworkRate <= REWORK_LIMIT;
  const capability = {
    id: "capability" as const,
    ok: capabilityOk,
    finding: capabilityOk ? t("Rework rate {rate}%, normal", { rate: reworkPercent }) : t("Rework rate {rate}%, too high", { rate: reworkPercent }),
    evidence: t("{count} started, sent back {reworks} times", { count: attempted.length, reworks }),
  };

  // 4 · is an engine throttling us
  const throttled = run.subtasks.filter((subtask) => (subtask.rateLimitedAt ?? []).some((at) => now - at <= RATE_LIMIT_WINDOW_MS));
  const hits = throttled.reduce((sum, subtask) => sum + (subtask.rateLimitedAt ?? []).filter((at) => now - at <= RATE_LIMIT_WINDOW_MS).length, 0);
  const engineOf = (subtask: DispatchSubtask) => {
    const selection = ctx.bot(subtask.assigneeBotId)?.modelSelection;
    return selection ? ctx.engineName(selection.instanceId) : "";
  };
  const rateLimit = {
    id: "rateLimit" as const,
    ok: hits === 0,
    finding: hits === 0
      ? t("No, no engine is throttling")
      : t("Yes, {count} rate-limit hits in the last {minutes} minutes", { count: hits, minutes: Math.round(RATE_LIMIT_WINDOW_MS / 60_000) }),
    evidence: hits === 0
      ? (unsettled.length || counted.length ? t("{engines} all normal", { engines: listNames(counted.map(engineOf)) || t("Engines") }) : undefined)
      : t("Throttled: {engines}", { engines: listNames(throttled.map(engineOf)) }),
  };
  const checks = [waiting, parallel, capability, rateLimit];

  const duration = typicalDuration(run);
  const started = workStartedAt(run);
  const speedPerHour = doneIds.size ? throughput(run, started, now + 1) : undefined;
  const base: DispatchDiagnosis = {
    runId: run.id,
    at: now,
    checks,
    verdict: "add-wont-help",
    remaining: [],
    ...(speedPerHour !== undefined ? { speedPerHour } : {}),
  };
  const squadOf = new Map<string, string>();
  for (const squad of run.squads ?? []) for (const botId of squad.botIds) squadOf.set(botId, squad.name);
  const teamSquad = t("Squad {letter}", { letter: "A" });
  const listRemaining = (moves: ReadonlyMap<string, number>) =>
    run.subtasks
      .filter((subtask) => subtask.status === "done" || subtask.status === "running" || (subtask.status === "pending" && !dead.has(subtask.id)))
      .map((subtask) => ({
        subtaskId: subtask.id,
        title: subtask.title,
        status: subtask.status as "done" | "running" | "pending",
        assigneeBotId: subtask.assigneeBotId,
        squad: moves.has(subtask.id) ? ctx.squadName : squadOf.get(subtask.assigneeBotId) ?? teamSquad,
        moved: moves.has(subtask.id),
      }));

  const refuse = (reason: string): DispatchDiagnosis => ({ ...base, verdict: "add-wont-help", reason, remaining: listRemaining(new Map()) });
  if (run.status !== "running" && run.status !== "awaiting-approval") return refuse(t("This run is no longer in progress."));
  if (!pending.length) return refuse(t("Nothing is left to hand out: everything is running or done."));
  if (!rateLimit.ok) return refuse(t("An engine is rate limiting this work; more people would only hit the limit harder. Wait a few minutes or switch engines."));
  if (!waiting.ok) return refuse(t("Most of what is left is waiting on earlier results or your approval; new people would sit idle."));
  if (!parallel.ok) return refuse(t("Nothing left can run side by side yet; new people would wait until earlier work finishes."));
  if (!capability.ok) return refuse(t("Too much work is being sent back; a stronger model helps more than more people."));

  // a department lead's share of the 主 Bot's plan is staffed by that lead
  const takeable = ready.filter((subtask) => !ctx.keep?.(subtask));
  if (!takeable.length) return refuse(t("What is left is departments' own work, which their leads staff: ask a lead to add people to its team."));

  // how many: never more than the independent work there is to take, one
  // squad (span) at a time, and only as many bots as the workspace holds
  const span = Math.max(2, Math.trunc(ctx.rules.spanOfControl) || 5);
  const maxCount = Math.min(takeable.length, span, Math.max(0, ctx.room));
  if (maxCount < 1) return refuse(t("The workspace has no room for more bots."));
  const plans = new Map<number, SquadPlan>();
  const planFor = (count: number) => {
    let plan = plans.get(count);
    if (!plan) {
      plan = planSquad(run, count, ctx, duration);
      plans.set(count, plan);
    }
    return plan;
  };
  let count: number;
  const asked = ctx.requested !== undefined && Number.isFinite(ctx.requested) ? Math.max(1, Math.trunc(ctx.requested)) : undefined;
  if (duration !== null) {
    const before = planFor(1).makespanBefore;
    let best = before ?? Infinity;
    for (let k = 1; k <= maxCount; k += 1) best = Math.min(best, planFor(k).makespanAfter ?? Infinity);
    if (before === null || !(best < before)) {
      return refuse(t("The team already covers what is left; more people would not finish sooner."));
    }
    const target = before - GAIN_SHARE * (before - best);
    count = maxCount;
    for (let k = 1; k <= maxCount; k += 1) {
      const after = planFor(k).makespanAfter;
      if (after !== null && after <= target) {
        count = k;
        break;
      }
    }
    if (asked !== undefined) count = Math.min(asked, maxCount);
  } else {
    // nothing finished yet: no durations, so one newcomer per ready subtask
    count = Math.min(asked ?? ready.length, maxCount);
  }

  // what it costs: newcomers read the pack, and pricier models cost more
  const money = spend(run, ctx);
  const costFor = (plan: SquadPlan) => {
    if (money.average === null) return 0;
    let extra = 0;
    plan.people.forEach((person) => {
      const model = ctx.modelFor(run.subtasks.find((subtask) => subtask.id === person.subtaskIds[0])!);
      for (const id of person.subtaskIds) {
        const subtask = run.subtasks.find((entry) => entry.id === id)!;
        const ratio = model.costLevel / Math.max(1, ctx.costLevel(subtask.assigneeBotId));
        extra += money.average! * (ratio - 1 + ONBOARDING_SHARE);
      }
    });
    return Math.max(0, round1(extra));
  };
  // the budget line left once the work already planned is paid for (unknown prices → unlimited)
  const budgetLeft = money.average === null ? Infinity : ctx.budgetCny - (money.total + money.average * (running.length + pending.length));
  let plan = planFor(count);
  // over the budget line: try a smaller squad before suggesting this one
  while (count > 1 && costFor(plan) > budgetLeft) {
    count -= 1;
    plan = planFor(count);
  }
  if (!plan.people.length) return refuse(t("The team already covers what is left; more people would not finish sooner."));

  const costCny = costFor(plan);
  const withinBudget = costCny <= budgetLeft;
  const taken = [...ctx.takenNames];
  const people = plan.people.map((person) => {
    const first = run.subtasks.find((subtask) => subtask.id === person.subtaskIds[0])!;
    const model = ctx.modelFor(first);
    const name = ctx.uniqueName(person.roleLabel, taken);
    taken.push(name);
    return { name, role: person.roleLabel, modelSelection: model.selection, modelLabel: model.label, subtaskIds: person.subtaskIds };
  });

  // communication lines: the original team plus existing squad leads report to the lead directly
  const squads = run.squads ?? [];
  const inSquads = new Set(squads.flatMap((squad) => squad.botIds));
  const team = new Set(run.subtasks.map((subtask) => subtask.assigneeBotId).filter((id) => !inSquads.has(id)));
  const squadSizes = squads.filter((squad) => !squad.endedAt).map((squad) => squad.botIds.length);
  const direct = team.size + squadSizes.length;
  const linesBefore = communicationLines(direct, squadSizes);
  const linesAfter = communicationLines(direct + 1, [...squadSizes, people.length]);
  const linesUngrouped = pairs(team.size + squadSizes.reduce((sum, size) => sum + size, 0) + people.length);

  const moved = run.subtasks.filter((subtask) => plan.moves.has(subtask.id));
  const examples = run.subtasks.filter((subtask) => subtask.status === "done" && moved.some((entry) => ctx.roleKey(entry.role) === ctx.roleKey(subtask.role)));
  const acceptance = [...new Set(moved.map((subtask) => subtask.acceptance?.trim()).filter((value): value is string => Boolean(value)))];
  const pack: NonNullable<DispatchDiagnosis["suggestion"]>["pack"] = [
    { id: "acceptance", text: acceptance.length ? clip(acceptance.join("; "), 240) : t("Same bar as the finished subtasks") },
    ...(examples.length ? [{ id: "examples" as const, text: t("{range} finished samples", { range: titleRange(examples) }) }] : []),
    { id: "scope", text: t("{count} subtasks nobody has started: {titles}", { count: moved.length, titles: listNames(moved.map((subtask) => clip(subtask.title, 14))) }) },
    { id: "goal", text: clip(run.goal, 160) },
    { id: "contact", text: t("Squad lead @{lead}; above them @{chief}", { lead: people[0]!.name, chief: ctx.leadName }) },
  ];

  return {
    ...base,
    verdict: "add-helps",
    remaining: listRemaining(plan.moves),
    suggestion: {
      add: people.length,
      squad: ctx.squadName,
      models: people.map((person) => person.modelLabel),
      ...(plan.makespanBefore !== null ? { etaBefore: now + plan.makespanBefore } : {}),
      ...(plan.makespanAfter !== null ? { etaAfter: now + plan.makespanAfter } : {}),
      costCny,
      withinBudget,
      linesBefore,
      linesAfter,
      linesUngrouped,
      people,
      pack,
      concurrency: plan.cap,
    },
  };
}

// ── the 30-minute review ─────────────────────────────────────────────────

/** Speed before the squad joined (from when work began) and since (up to the
 * review time, or the run's end if that came first). */
export function reviewSquad(run: DispatchRun, squad: DispatchSquad, now: number): DispatchSquadReview {
  const end = Math.min(squad.reviewAt, run.finishedAt ?? now, now);
  const speedBefore = throughput(run, workStartedAt(run), squad.addedAt);
  const speedAfter = throughput(run, squad.addedAt, Math.max(end, squad.addedAt + 1));
  return { at: now, speedBefore, speedAfter, faster: speedAfter > speedBefore };
}
