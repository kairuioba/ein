// Dispatch hub records and settings, shared by the harness (server/dispatch.ts)
// and the workbench UI. See server/dispatch.ts for how runs execute.
import type { Capability, Level } from "./model-profiles.ts";
import type { RecommendationPolicy } from "./model-recommender.ts";
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
  };
}

// ── records ────────────────────────────────────────────────────────────

export type SubtaskStatus = "pending" | "running" | "done" | "failed" | "skipped" | "canceled";
export type RunStatus = "awaiting-approval" | "running" | "synthesizing" | "done" | "failed" | "canceled";

export interface DispatchSubtask {
  id: string;
  title: string;
  brief: string;
  role: string;
  needs: Capability[];
  difficulty: Level;
  dependsOn: string[];
  acceptance?: string;
  assigneeBotId: string;
  /** The dispatcher created this bot for the run. */
  createdBot?: boolean;
  status: SubtaskStatus;
  attempts: number;
  threadId?: string;
  result?: string;
  error?: string;
  /** when the latest attempt started */
  startedAt?: number;
  /** when it settled (done, failed, skipped or canceled) */
  finishedAt?: number;
  /** A department lead handed this subtask to its own team: the run doing
   * it. The subtask stays "running" until that run finishes. */
  childRunId?: string;
  /** The squad it was moved to when people were added mid-run. */
  squad?: string;
  /** When an engine throttled this subtask (rate limited), newest last, at most 20. */
  rateLimitedAt?: number[];
  /** Attempts that ended because the engine was rate limited (not the worker's fault). */
  throttledAttempts?: number;
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
