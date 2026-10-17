// What a dispatched subtask runs with — engine, model, how hard it thinks —
// and what the recommender suggested for it. server/dispatch.ts turnPick
// decides at start time; planned() mirrors it so a subtask that has not
// started shows what it will run with, and the pickers can offer every
// engine you are signed in to.
import { effortFor, type Effort } from "../../shared/model-recommender";
import { dispatchSettings, type DispatchRun, type DispatchSettings, type DispatchSubtask } from "../../shared/dispatch-types";
import type { Bot, InstanceInfo } from "@/state/store";

export interface SubtaskModel {
  instanceId: string;
  model: string;
  effort?: Effort;
  /** the effort comes from the subtask's difficulty, not from you or the bot */
  auto?: boolean;
  /** runs on an engine that is not the assignee's own */
  borrowed: boolean;
  /** already running or done with this (not just planned) */
  ran: boolean;
}

/** Signed in and running: the engines a subtask can be moved to. */
export function engineReady(instance: InstanceInfo | undefined): instance is InstanceInfo {
  return Boolean(
    instance &&
      instance.driverKind !== "boxAgent" &&
      instance.snapshot.state === "available" &&
      instance.snapshot.authenticated !== false &&
      instance.models.options.length > 0,
  );
}

/** Your pick can still change: the subtask has not run yet, or failed and
 * will be retried. */
export function canChooseModel(run: DispatchRun, subtask: DispatchSubtask): boolean {
  const finished = run.status === "done" || run.status === "failed" || run.status === "canceled";
  if (subtask.status === "pending") return !finished;
  return (subtask.status === "failed" || subtask.status === "canceled") && run.status !== "canceled";
}

/** What the subtask runs with: what it ran with once it started, else what
 * it will run with — your pick, else the bot's own, with the effort its
 * difficulty calls for when neither names one (autoEffort). */
export function subtaskModel(
  subtask: DispatchSubtask,
  bot: Pick<Bot, "modelSelection"> | undefined,
  instances: readonly InstanceInfo[],
  settings: Partial<DispatchSettings> | undefined,
): SubtaskModel | null {
  if (subtask.ranWith && (subtask.status === "running" || subtask.status === "done")) {
    const { instanceId, model, effort, autoEffort } = subtask.ranWith;
    return { instanceId, model, effort, auto: autoEffort, borrowed: Boolean(bot && instanceId !== bot.modelSelection.instanceId), ran: true };
  }
  if (!bot) return null;
  const own = bot.modelSelection;
  const find = (id: string) => instances.find((instance) => instance.instanceId === id);
  const choice = subtask.choice;
  const wanted = choice?.instanceId && choice.instanceId !== own.instanceId ? choice.instanceId : undefined;
  const borrowedEngine = wanted ? find(wanted) : undefined;
  const usable = engineReady(borrowedEngine) ? borrowedEngine : undefined;
  const instanceId = usable ? wanted! : own.instanceId;
  const engine = usable ?? find(own.instanceId);
  const models = engine?.models.options.map((option) => option.id) ?? [];
  const levels = (engine?.capabilities?.effortLevels ?? []) as readonly string[];
  const chosenModel = choice?.model && (!choice.instanceId || choice.instanceId === instanceId) ? choice.model : undefined;
  const model =
    chosenModel && models.includes(chosenModel)
      ? chosenModel
      : usable
        ? (models.includes(usable.models.default) ? usable.models.default : models[0]!)
        : own.model;
  const base = { instanceId, model, borrowed: Boolean(usable), ran: false };
  if (choice?.effort && levels.includes(choice.effort)) return { ...base, effort: choice.effort };
  if (own.effort && levels.includes(own.effort)) return { ...base, effort: own.effort };
  const prefs = dispatchSettings(settings);
  const auto = prefs.autoEffort ? effortFor(subtask.difficulty, levels, prefs.policy) : undefined;
  return auto ? { ...base, effort: auto, auto: true } : base;
}

/** The subtask already runs with what the recommender suggested. */
export function followsRecommendation(current: SubtaskModel | null, recommended: DispatchSubtask["recommended"]): boolean {
  if (!current || !recommended) return false;
  return current.instanceId === recommended.instanceId && current.model === recommended.model && (current.effort ?? null) === (recommended.effort ?? null);
}

/** The request body that applies a recommendation to a subtask. */
export function recommendationPick(recommended: NonNullable<DispatchSubtask["recommended"]>): { instanceId: string; model: string; effort: Effort | null } {
  return { instanceId: recommended.instanceId, model: recommended.model, effort: recommended.effort ?? null };
}

/** A model's label on its engine ("Opus 4.1"), else its id. */
export function modelName(instances: readonly InstanceInfo[], instanceId: string, model: string): string {
  return instances.find((instance) => instance.instanceId === instanceId)?.models.options.find((option) => option.id === model)?.label ?? model;
}

/** An engine's display name, else its id. */
export function engineName(instances: readonly InstanceInfo[], instanceId: string): string {
  return instances.find((instance) => instance.instanceId === instanceId)?.displayName ?? instanceId;
}
