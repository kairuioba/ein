// Group the maintenance desk's model choices: the "Cloud" label holds the
// OpenAI / GPT-family models every engine offers, "WorkBuddy" holds every
// model the WorkBuddy account may use, and the remaining engines stay one
// row each at their default model (the list must stay short).
import type { InstanceInfo } from "@/state/store";

export type ModelChoice = {
  instance: InstanceInfo;
  model: InstanceInfo["models"]["options"][number];
};

export interface MaintenanceModelGroups {
  cloud: ModelChoice[];
  workbuddy: ModelChoice[];
  /** one default-model row per engine that is in neither group above */
  engines: ModelChoice[];
}

const GPT_FAMILY = /\b(gpt|openai|o[1-9])\b/i;

/** True for an OpenAI / GPT-family model advertised by any engine. */
export function isCloudGptModel(choice: Pick<ModelChoice, "model">): boolean {
  return GPT_FAMILY.test(`${choice.model.id} ${choice.model.label}`.replace(/[_-]/g, " "));
}

function isWorkBuddy(instance: InstanceInfo): boolean {
  return instance.driverKind === "workbuddyAgent";
}

/** Split the ready instances into the picker groups. Cloud models keep their
 * engine in the label; every WorkBuddy model is listed (the account decides
 * which ones can actually run); other engines contribute one default row. */
export function groupMaintenanceModels(instances: InstanceInfo[]): MaintenanceModelGroups {
  const cloud: ModelChoice[] = [];
  const workbuddy: ModelChoice[] = [];
  const engines: ModelChoice[] = [];
  for (const instance of instances) {
    const options = instance.models.options;
    if (isWorkBuddy(instance)) {
      for (const model of options) workbuddy.push({ instance, model });
      continue;
    }
    let placed = false;
    for (const model of options) {
      const choice = { instance, model };
      if (isCloudGptModel(choice)) {
        cloud.push(choice);
        placed = true;
      }
    }
    if (!placed) {
      const fallback = options.find((model) => model.id === instance.models.default) ?? options[0];
      if (fallback) engines.push({ instance, model: fallback });
    }
  }
  return { cloud, workbuddy, engines };
}

/** A select value that round-trips instance + model. */
export function selectionKey(instanceId: string, modelId: string): string {
  return `${instanceId}\u0000${modelId}`;
}

export function parseSelectionKey(key: string): { instanceId: string; modelId: string } | null {
  const at = key.indexOf("\u0000");
  if (at <= 0) return null;
  const instanceId = key.slice(0, at);
  const modelId = key.slice(at + 1);
  return instanceId && modelId ? { instanceId, modelId } : null;
}
