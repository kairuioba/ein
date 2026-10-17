import type { Store } from "./store.ts";

interface ModelInstance {
  instanceId: string;
  driverKind: string;
  models: { default: string };
}

/** Replace the removed WorkBuddy placeholder with its real model selection. */
export function migrateWorkbuddyDefaults(store: Store, instances: readonly ModelInstance[]): void {
  const defaults = new Map(instances
    .filter((instance) => instance.driverKind === "workbuddyAgent")
    .map((instance) => [instance.instanceId, instance.models.default]));
  for (const bot of store.bots) {
    if (bot.modelSelection.model !== "default") continue;
    const model = defaults.get(bot.modelSelection.instanceId);
    if (!model || model === "default") continue;
    store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, model } });
  }
}
