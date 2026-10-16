// Dispatch hub records and settings, shared by the harness (server/dispatch.ts)
// and the workbench UI. See server/dispatch.ts for how runs execute.
import type { Capability, Level } from "./model-profiles.ts";
import type { RecommendationPolicy } from "./model-recommender.ts";

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
    maxSubtasks: clampInt(raw?.maxSubtasks, 1, 20, d.maxSubtasks),
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
  startedAt?: number;
  finishedAt?: number;
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
}

export interface DispatchRoute {
  fromBotId: string;
  toBotId: string;
  /** false = unplugged: removes a default same-section member. */
  enabled: boolean;
  updatedAt: number;
}
