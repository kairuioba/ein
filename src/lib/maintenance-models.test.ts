import { describe, expect, it } from "vitest";

import {
  groupMaintenanceModels,
  isCloudGptModel,
  parseSelectionKey,
  preferredMaintenanceChoice,
  selectionKey,
} from "./maintenance-models";
import type { InstanceInfo } from "@/state/store";

function instance(
  instanceId: string,
  driverKind: string,
  displayName: string,
  options: Array<{ id: string; label: string }>,
  defaultModel = options[0]!.id,
): InstanceInfo {
  return {
    instanceId,
    driverKind,
    displayName,
    models: { default: defaultModel, options },
  } as unknown as InstanceInfo;
}

describe("maintenance desk model groups", () => {
  it("recognizes OpenAI / GPT-family model names", () => {
    expect(isCloudGptModel({ model: { id: "gpt-6.1-sol", label: "gpt-6.1-sol (OpenAI)" } })).toBe(true);
    expect(isCloudGptModel({ model: { id: "o3", label: "o3" } })).toBe(true);
    expect(isCloudGptModel({ model: { id: "deepseek-v4-pro", label: "Deepseek-V4-Pro" } })).toBe(false);
    expect(isCloudGptModel({ model: { id: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" } })).toBe(false);
  });

  it("puts every WorkBuddy model under WorkBuddy and GPT models under Cloud", () => {
    const groups = groupMaintenanceModels([
      instance("codex", "codex", "Codex", [
        { id: "gpt-6.1-sol", label: "gpt-6.1-sol (OpenAI)" },
        { id: "gpt-6.1-mini", label: "gpt-6.1-mini (OpenAI)" },
      ]),
      instance("workbuddy", "workbuddyAgent", "WorkBuddy", [
        { id: "default", label: "WorkBuddy default" },
        { id: "hy4-preview", label: "Hy4 preview" },
        { id: "glm-5.3", label: "GLM-5.3" },
      ]),
      instance("claude", "claudeAgent", "Claude", [{ id: "sonnet", label: "Claude Sonnet 5.5" }], "sonnet"),
    ]);

    expect(groups.cloud.map((choice) => choice.model.id)).toEqual(["gpt-6.1-sol", "gpt-6.1-mini"]);
    expect(groups.workbuddy.map((choice) => choice.model.id)).toEqual(["default", "hy4-preview", "glm-5.3"]);
    // engines in neither group keep one default row instead of listing every model
    expect(groups.engines.map((choice) => `${choice.instance.instanceId}:${choice.model.id}`)).toEqual(["claude:sonnet"]);
  });

  it("round-trips the select value", () => {
    const key = selectionKey("workbuddy", "glm-5.3");
    expect(parseSelectionKey(key)).toEqual({ instanceId: "workbuddy", modelId: "glm-5.3" });
    expect(parseSelectionKey("")).toBeNull();
    expect(parseSelectionKey("workbuddy")).toBeNull();
  });
});

describe("maintenance desk initial model", () => {
  const ready = [
    instance("grok", "grokAgent", "Grok", [{ id: "grok-4.7", label: "Grok 4.7" }]),
    instance("codex", "codex", "Codex", [{ id: "gpt-6.1-sol", label: "gpt-6.1-sol (OpenAI)" }]),
  ];

  it("starts on the maintenance bot's saved engine and model", () => {
    const choice = preferredMaintenanceChoice(ready, { instanceId: "codex", model: "gpt-6.1-sol" });
    expect(choice?.instance.instanceId).toBe("codex");
    expect(choice?.model.id).toBe("gpt-6.1-sol");
  });

  it("falls back to the first ready engine when nothing is saved", () => {
    expect(preferredMaintenanceChoice(ready)?.instance.instanceId).toBe("grok");
  });

  it("falls back when the saved engine or model is no longer ready", () => {
    expect(preferredMaintenanceChoice(ready, { instanceId: "claude", model: "sonnet" })?.instance.instanceId).toBe("grok");
    expect(preferredMaintenanceChoice(ready, { instanceId: "codex", model: "gone" })?.instance.instanceId).toBe("grok");
  });
});
