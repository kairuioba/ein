import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { migrateWorkbuddyDefaults } from "./workbuddy-defaults.ts";

const selection = () => ({ instanceId: "my-workbuddy", model: "default" });

describe("WorkBuddy default selection migration", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each(["deepseek-v4.1-flash", "hunyuan-t1"])("persists the real default %s without changing explicit models or other engines", (model) => {
    const store = new Store(selection);
    const legacy = store.createBot({ modelSelection: { ...selection(), effort: "high" } });
    const explicit = store.createBot({ modelSelection: { ...selection(), model: "glm-5.2" } });
    const other = store.createBot({ modelSelection: { instanceId: "other-engine", model: "default" } });
    const instances = [
      { instanceId: "my-workbuddy", driverKind: "workbuddyAgent", models: { default: model } },
      { instanceId: "other-engine", driverKind: "other", models: { default: "other-model" } },
    ];
    migrateWorkbuddyDefaults(store, instances);
    const reloaded = new Store(selection);
    expect(reloaded.bot(legacy.id)?.modelSelection).toEqual({ ...selection(), model, effort: "high" });
    expect(reloaded.bot(explicit.id)?.modelSelection.model).toBe("glm-5.2");
    expect(reloaded.bot(other.id)?.modelSelection.model).toBe("default");
    migrateWorkbuddyDefaults(reloaded, instances);
    expect(reloaded.bot(legacy.id)?.modelSelection.model).toBe(model);
  });

  it("keeps a saved selection while its engine is unavailable", () => {
    const store = new Store(selection);
    const legacy = store.createBot();
    migrateWorkbuddyDefaults(store, []);
    expect(new Store(selection).bot(legacy.id)?.modelSelection).toEqual(selection());
  });
});
