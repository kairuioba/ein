// Dispatch hub records and settings, shared by the harness (server/dispatch.ts)
// and the workbench UI. See server/dispatch.ts for how runs execute.
import type { Capability, Level } from "./model-profiles.ts";
import type { Effort, RecommendationPolicy } from "./model-recommender.ts";
import type { RunDiagnosis } from "./org-types.ts";

// ── settings ───────────────────────────────────────────────────────────

export interface DispatchSettings {
  /** Chiefs get the submit_plan tool and are told to use it. */
  enabled: boolean;
  /** Create a specialist when no team member fits a subtask. */
  autoCreate: boolean;
  /** How models are picked for bots the dispatcher creates. */
  policy: RecommendationPolicy;
  /** Subtasks running at the same time, across one run. */
  maxConcurrent: number;
  /** Subtasks one plan may contain. */
  maxSubtasks: number;
  /** Specialists one run may create. */
  maxNewBots: number;
  /** Ask the Chief for a consolidated report when every subtask settles. */
  autoSynthesize: boolean;
  /** Hold a new plan until the user starts it from the workbench. */
  requireApproval: boolean;
  /** Attempts per subtask before it is marked failed. */
  maxAttempts: number;
  /** A subtask whose bot has no effort of its own thinks as hard as its
   * difficulty calls for (very hard → max, hard → xhigh …). */
  autoEffort: boolean;
}

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  enabled: true,
  autoCreate: true,
  policy: "balanced",
  maxConcurrent: 3,
  maxSubtasks: 8,
  maxNewBots: 4,
  autoSynthesize: true,
  requireApproval: false,
  maxAttempts: 2,
  autoEffort: true,
};

/** The largest plan a chief may submit (the org chief plans across departments). */
export const MAX_PLAN_SUBTASKS = 30;

const clampInt = (value: unknown, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;

/** Merge stored settings over the defaults, clamping every number. */
export function dispatchSettings(raw: Partial<DispatchSettings> | undefined): DispatchSettings {
  const d = DEFAULT_DISPATCH_SETTINGS;
  const policy = raw?.policy;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : d.enabled,
    autoCreate: typeof raw?.autoCreate === "boolean" ? raw.autoCreate : d.autoCreate,
    policy: policy === "quality" || policy === "economy" || policy === "balanced" ? policy : d.policy,
    maxConcurrent: clampInt(raw?.maxConcurrent, 1, 8, d.maxConcurrent),
    maxSubtasks: clampInt(raw?.maxSubtasks, 1, MAX_PLAN_SUBTASKS, d.maxSubtasks),
    maxNewBots: clampInt(raw?.maxNewBots, 0, 10, d.maxNewBots),
    autoSynthesize: typeof raw?.autoSynthesize === "boolean" ? raw.autoSynthesize : d.autoSynthesize,
    requireApproval: typeof raw?.requireApproval === "boolean" ? raw.requireApproval : d.requireApproval,
    maxAttempts: clampInt(raw?.maxAttempts, 1, 3, d.maxAttempts),
    autoEffort: typeof raw?.autoEffort === "boolean" ? raw.autoEffort : d.autoEffort,
  };
}

// ── records ────────────────────────────────────────────────────────────

export type SubtaskStatus = "pending" | "running" | "done" | "failed" | "skipped" | "canceled";
export type RunStatus = "awaiting-approval" | "running" | "synthesizing" | "done" | "failed" | "canceled";

/** The long-horizon plan's constitution: what success means and, above all,
 * what must NOT happen. Injected into every worker and the synthesis turn so a
 * week-long job never drifts. */
export interface DispatchCharter {
  successCriteria?: string;
  nonGoals?: string;
  constraints?: string;
  deadline?: string;
  budgetCny?: number;
}

/** A checkpoint note from the owner or the supervisor: where the run stands
 * and what happens next. Fed into every following planning/synthesis turn. */
export interface DispatchCheckpoint {
  at: number;
  note: string;
  nextStep?: string;
  by?: string;
}

/** What a worker sends back: the same envelope whatever model ran it. The
 * free-form result stays for reading; the handoff is what the chief and the
 * reviewer consume without re-reading the whole process. */
export interface DispatchHandoff {
  status: "done" | "partial" | "blocked";
  summary: string;
  evidence?: string[];
  artifacts?: string[];
  decisions?: Array<{ what: string; why?: string }>;
  assumptions?: string[];
  openQuestions?: string[];
  risks?: Array<{ risk: string; impact?: string; next?: string }>;
  nextStep?: string;
  /** the worker's own read of its acceptance criteria; the reviewer decides */
  acceptanceMet?: boolean;
}

/** One falsifiable acceptance criterion. New plans carry these; older plans
 * only had a single free-form `acceptance` string (mapped on read). */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  required: boolean;
  kind: "deterministic" | "subjective";
  /** a named deterministic check, when the planner can name one */
  check?: string;
}

export interface GateCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface GateCriterionVerdict {
  id: string;
  status: "pass" | "fail" | "unverifiable";
  evidence?: string;
}

/** The acceptance gate's verdict for one attempt. */
export interface SubtaskGate {
  attemptId?: string;
  status: "pass" | "fail" | "needs_human";
  criteria: GateCriterionVerdict[];
  deterministic: GateCheck[];
  reason?: string;
  at: number;
  /** gate has not been judged by a reviewer yet (deterministic proxy only) */
  provisional?: boolean;
}

/** One thing waiting on the owner. */
export interface InboxItem {
  id: string;
  kind: "gate_failed" | "signoff" | "question" | "failed_exhausted";
  taskId?: string;
  runId?: string;
  subtaskId?: string;
  attemptId?: string;
  title: string;
  reason: string;
  evidence?: string[];
  createdAt: number;
  seenAt?: number;
  resolvedAt?: number;
  resolution?: { action: "approve" | "reject" | "abandon"; note?: string; at: number };
}

export interface DispatchSubtask {
  id: string;
  title: string;
  brief: string;
  role: string;
  needs: Capability[];
  difficulty: Level;
  dependsOn: string[];
  acceptance?: string;
  /** what is explicitly out of scope / must not be touched */
  boundaries?: string;
  /** the exact output the subtask must hand back */
  deliverable?: string;
  /** who verifies the result (a role, a teammate's name, or the chief) */
  reviewer?: string;
  assigneeBotId: string;
  /** The dispatcher created this bot for the run. */
  createdBot?: boolean;
  status: SubtaskStatus;
  attempts: number;
  threadId?: string;
  result?: string;
  error?: string;
  /** the structured answer the worker sent back (parsed from its reply) */
  handoff?: DispatchHandoff;
  /** structured acceptance criteria (new plans; legacy uses `acceptance`) */
  criteria?: AcceptanceCriterion[];
  /** the acceptance gate's verdict for the latest attempt */
  gate?: SubtaskGate;
  /** audit of the read-only context injected into the worker prompt */
  injectedContext?: {
    sourceTaskIds?: string[];
    tokens?: number;
    textHash: string;
    at: number;
  };
  /** id of the attempt currently allowed to write this subtask's result;
   * a late event from an older attempt is dropped instead of overwriting */
  currentAttemptId?: string;
  /** the process boot that started that attempt (restart = stale) */
  currentAttemptBootId?: string;
  /** how many restarts interrupted this subtask; >=3 gives up */
  interruptCount?: number;
  /** when the latest attempt started */
  startedAt?: number;
  /** when it settled (done, failed, skipped or canceled) */
  finishedAt?: number;
  /** A department lead handed this subtask to its own team: the run doing
   * it. The subtask stays "running" until that run finishes. */
  childRunId?: string;
  /** The squad it was moved to when people were added mid-run. */
  squad?: string;
  /** the bot that originally held this subtask before a faster teammate took
   * it over mid-run (same task only) */
  reassignedFrom?: string;
  /** When an engine throttled this subtask (rate limited), newest last, at most 20. */
  rateLimitedAt?: number[];
  /** Attempts that ended because the engine was rate limited (not the worker's fault). */
  throttledAttempts?: number;
  /** The model and effort the recommender suggests for this subtask, made
   * with the plan. Advisory: the assignee keeps the model you chose for it. */
  recommended?: SubtaskModelPick;
  /** Your pick for this subtask before it starts: any model on any engine
   * you are signed in to (instanceId when it is not the assignee's own),
   * and/or an effort level. The assignee keeps its own settings. */
  choice?: { instanceId?: string; model?: string; effort?: Effort };
  /** What the latest attempt ran with; autoEffort when the effort came from
   * the difficulty rather than from you or the bot. */
  ranWith?: { instanceId: string; model: string; effort?: Effort; autoEffort?: boolean };
}

/** A model on one engine, with how hard to think. */
export interface SubtaskModelPick {
  instanceId: string;
  engineName: string;
  model: string;
  modelLabel: string;
  effort?: Effort;
}

/** The 30-minute check after people were added: did the run speed up? */
export interface DispatchSquadReview {
  at: number;
  /** subtasks finished per hour before the squad joined, and since */
  speedBefore: number;
  speedAfter: number;
  faster: boolean;
}

/** People added to a running job (中途加人): one squad per addition. The
 * original team is implicitly "Squad A"; added squads are B, C, … */
export interface DispatchSquad {
  /** "Squad B", already in the app's language */
  name: string;
  /** the first new person: works too, and is who the others ask */
  leadBotId: string;
  botIds: string[];
  /** not-started subtasks handed to the squad */
  subtaskIds: string[];
  addedAt: number;
  /** the owner from the workbench, or the run's chief within its rules */
  by: "owner" | "chief";
  /** when the speed review is due (addedAt + 30 minutes) */
  reviewAt: number;
  /** the estimate shown when they were added, epoch ms */
  etaBefore?: number;
  etaAfter?: number;
  /** filled once reviewAt has passed (or the run finished first) */
  review?: DispatchSquadReview;
  /** the run finished and the squad dissolved; its bots stay on the team */
  endedAt?: number;
}

export interface DispatchRun {
  id: string;
  chiefBotId: string;
  sourceThreadId: string;
  goal: string;
  /** the constitution this run must stay inside (long-horizon tasks) */
  charter?: DispatchCharter;
  /** owner/supervisor checkpoints, oldest first; max 100 */
  checkpoints?: DispatchCheckpoint[];
  policy: RecommendationPolicy;
  status: RunStatus;
  subtasks: DispatchSubtask[];
  createdAt: number;
  updatedAt: number;
  /** The Chief's synthesis turn has been asked for. */
  synthesisStarted?: boolean;
  /** When the run reached done, failed or canceled. */
  finishedAt?: number;
  /** The Chief's consolidated report, once its synthesis turn completed. */
  report?: string;
  /** A department lead's plan for one subtask of the org chief's run. */
  parentRunId?: string;
  parentSubtaskId?: string;
  /** Squads added while the run was going. */
  squads?: DispatchSquad[];
  /** This run's own concurrency once people were added (else the setting). */
  maxConcurrent?: number;
}

export interface DispatchRoute {
  fromBotId: string;
  toBotId: string;
  /** false = unplugged: removes a default same-section member. */
  enabled: boolean;
  updatedAt: number;
}

// ── adding people mid-run ───────────────────────────────────────────────

/** POST /api/dispatch/runs/:id/diagnose answers a RunDiagnosis (see
 * shared/org-types.ts) plus what the add-people sheet draws. */
export interface DispatchDiagnosis extends RunDiagnosis {
  at: number;
  /** every subtask that is done, running or not started, in plan order */
  remaining: Array<
    RunDiagnosis["remaining"][number] & {
      assigneeBotId: string;
      /** who would do it after the suggestion: the original team is "Squad A" */
      squad: string;
      /** a not-started subtask the suggestion hands to the new squad */
      moved: boolean;
    }
  >;
  suggestion?: NonNullable<RunDiagnosis["suggestion"]> & {
    /** lines if everyone reported to the lead directly (不分组) */
    linesUngrouped: number;
    /** the new people, squad lead first */
    people: Array<{
      name: string;
      role: string;
      modelSelection: { instanceId: string; model: string; effort?: string };
      modelLabel: string;
      subtaskIds: string[];
    }>;
    /** the onboarding pack (入职包) the squad reads instead of the history */
    pack: Array<{ id: "acceptance" | "examples" | "scope" | "goal" | "contact"; text: string }>;
    /** subtasks running at once after adding */
    concurrency: number;
  };
  /** finished subtasks per hour so far; absent before anything finished */
  speedPerHour?: number;
  /** what is left belongs to a department's own plan: the owner adds people
   * to that plan from the workbench instead of the company plan */
  departmentWork?: boolean;
}

/** POST /api/dispatch/runs/:id/amend → this. */
export interface DispatchAmendResult {
  ok: true;
  /** ids of the bots created, squad lead first */
  added: string[];
  squad: DispatchSquad;
  /** the subtasks handed to the new squad */
  moved: string[];
  run: DispatchRun;
}
