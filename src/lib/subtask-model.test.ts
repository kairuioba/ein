import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types";
import { canChooseModel, engineReady, followsRecommendation, modelName, recommendationPick, subtaskModel } from "./subtask-model";

const engine = (instanceId: string, models: string[], effortLevels: string[], extra: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo =>
  ({
    instanceId,
    driverKind: instanceId,
    displayName: instanceId[0]!.toUpperCase() + instanceId.slice(1),
    snapshot: { state: "available", authenticated: true, ...extra },
    models: { default: models[0]!, options: models.map((id) => ({ id, label: id.toUpperCase() })) },
    capabilities: { effortLevels: effortLevels as never },
  }) as InstanceInfo;

const instances = [
  engine("claude", ["sonnet", "opus"], ["low", "medium", "high", "xhigh", "max"]),
  engine("gemini", ["flash", "pro"], ["low", "medium", "high"]),
  engine("codex", ["gpt"], []),
  engine("grok", ["grok-4"], ["low"], { authenticated: false }),
];

const subtask = (patch: Partial<DispatchSubtask> = {}): DispatchSubtask =>
  ({ id: "a", title: "x", brief: "x", needs: [], difficulty: 3, dependsOn: [], assigneeBotId: "w", status: "pending", attempts: 0, ...patch }) as DispatchSubtask;

const bot = { modelSelection: { instanceId: "claude", model: "sonnet" } };

describe("what a subtask runs with", () => {
  it("plans the bot's own model at the effort the difficulty calls for", () => {
    expect(subtaskModel(subtask({ difficulty: 5 }), bot, instances, {})).toEqual({ instanceId: "claude", model: "sonnet", effort: "max", auto: true, borrowed: false, ran: false });
    expect(subtaskModel(subtask({ difficulty: 1 }), bot, instances, { policy: "quality" })).toMatchObject({ effort: "medium", auto: true });
    // automatic effort off: nothing is sent
    expect(subtaskModel(subtask(), bot, instances, { autoEffort: false })).toEqual({ instanceId: "claude", model: "sonnet", borrowed: false, ran: false });
    // the bot's own level beats the automatic one
    expect(subtaskModel(subtask({ difficulty: 5 }), { modelSelection: { ...bot.modelSelection, effort: "low" } }, instances, {})).toMatchObject({ effort: "low" });
  });

  it("follows your pick, on another engine too, within that engine's levels", () => {
    expect(subtaskModel(subtask({ choice: { instanceId: "gemini", model: "pro" }, difficulty: 5 }), bot, instances, {})).toEqual({
      instanceId: "gemini",
      model: "pro",
      effort: "high",
      auto: true,
      borrowed: true,
      ran: false,
    });
    expect(subtaskModel(subtask({ choice: { model: "opus", effort: "xhigh" } }), bot, instances, {})).toMatchObject({ instanceId: "claude", model: "opus", effort: "xhigh" });
    // a signed-out engine falls back to the bot's own
    expect(subtaskModel(subtask({ choice: { instanceId: "grok", model: "grok-4" } }), bot, instances, {})).toMatchObject({ instanceId: "claude", borrowed: false });
    // once it runs, it shows what it ran with
    const ran = subtask({ status: "running", ranWith: { instanceId: "codex", model: "gpt" } });
    expect(subtaskModel(ran, bot, instances, {})).toEqual({ instanceId: "codex", model: "gpt", effort: undefined, auto: undefined, borrowed: true, ran: true });
  });

  it("knows when a pick can still change, and when it already follows the recommendation", () => {
    const run = { status: "running" } as DispatchRun;
    expect(canChooseModel(run, subtask())).toBe(true);
    expect(canChooseModel(run, subtask({ status: "running" }))).toBe(false);
    expect(canChooseModel(run, subtask({ status: "failed" }))).toBe(true);
    expect(canChooseModel({ status: "canceled" } as DispatchRun, subtask({ status: "failed" }))).toBe(false);
    expect(canChooseModel({ status: "done" } as DispatchRun, subtask())).toBe(false);
    const recommended = { instanceId: "claude", engineName: "Claude", model: "sonnet", modelLabel: "Sonnet", effort: "high" as const };
    expect(followsRecommendation(subtaskModel(subtask({ difficulty: 3 }), bot, instances, {}), recommended)).toBe(true);
    expect(followsRecommendation(subtaskModel(subtask({ difficulty: 5 }), bot, instances, {}), recommended)).toBe(false);
    expect(recommendationPick({ ...recommended, effort: undefined })).toEqual({ instanceId: "claude", model: "sonnet", effort: null });
  });

  it("names models and tells ready engines apart", () => {
    expect(modelName(instances, "claude", "opus")).toBe("OPUS");
    expect(modelName(instances, "claude", "gone")).toBe("gone");
    expect(engineReady(instances[0])).toBe(true);
    expect(engineReady(instances[3])).toBe(false);
  });
});
