import { describe, expect, it } from "vitest";

import { MASCOT_BODY, MASCOT_BRAND, MASCOT_KINDS, mascotForBot, mascotForDriver, poseForStatus, tint } from "./engine-mascots";

describe("mascotForDriver", () => {
  it("maps every known driver to its engine's character", () => {
    expect(mascotForDriver("claudeAgent")).toBe("claude");
    expect(mascotForDriver("codex")).toBe("codex");
    expect(mascotForDriver("kimiAgent")).toBe("kimi");
    expect(mascotForDriver("grok")).toBe("grok");
    expect(mascotForDriver("opencodeGo")).toBe("opencode");
    expect(mascotForDriver("boxAgent")).toBe("pc");
  });

  it("gives local-model runtimes the chip", () => {
    expect(mascotForDriver("ollama")).toBe("local");
    expect(mascotForDriver("lmstudio")).toBe("local");
    expect(mascotForDriver("openai-compat")).toBe("local");
  });

  it("guesses from an instance id before the engine list loads", () => {
    expect(mascotForDriver("claude-work")).toBe("claude");
    expect(mascotForDriver("kimi")).toBe("kimi");
    expect(mascotForDriver("box-2")).toBe("pc");
  });

  it("falls back to the toolbox", () => {
    expect(mascotForDriver(undefined)).toBe("workbuddy");
    expect(mascotForDriver("")).toBe("workbuddy");
    expect(mascotForDriver("somethingNew")).toBe("workbuddy");
  });
});

describe("mascotForBot", () => {
  const instances = [
    { instanceId: "claude", driverKind: "claudeAgent", models: { options: [{ id: "opus" }] } },
    { instanceId: "hermes", driverKind: "hermesAgent", models: { options: [{ id: "glm" }, { id: "qwen3:8b", custom: true }] } },
    { instanceId: "lan", driverKind: "openai-compat" },
  ];

  it("follows the instance the bot runs on", () => {
    expect(mascotForBot({ modelSelection: { instanceId: "claude", model: "opus" } }, instances)).toBe("claude");
    expect(mascotForBot({ modelSelection: { instanceId: "hermes", model: "glm" } }, instances)).toBe("hermes");
  });

  it("shows the chip for a local model, whatever the driver", () => {
    expect(mascotForBot({ modelSelection: { instanceId: "hermes", model: "qwen3:8b" } }, instances)).toBe("local");
    expect(mascotForBot({ modelSelection: { instanceId: "lan", model: "x" } }, instances)).toBe("local");
  });

  it("guesses from the instance id when the instance is unknown, and defaults to the toolbox", () => {
    expect(mascotForBot({ modelSelection: { instanceId: "codex" } }, [])).toBe("codex");
    expect(mascotForBot({ modelSelection: null }, instances)).toBe("workbuddy");
    expect(mascotForBot({}, instances)).toBe("workbuddy");
  });
});

describe("poses and colours", () => {
  it("maps statuses to the pose that shows them", () => {
    expect(poseForStatus("working")).toBe("work");
    expect(poseForStatus("waiting")).toBe("wave");
    expect(poseForStatus("done")).toBe("cheer");
    expect(poseForStatus("failed")).toBe("scared");
    expect(poseForStatus("stuck")).toBe("scared");
    expect(poseForStatus("disagree")).toBe("think");
    expect(poseForStatus("leading")).toBe("point");
    expect(poseForStatus("rushing")).toBe("run");
    expect(poseForStatus("queued")).toBe("idle");
  });

  it("has a colour and a body for every character", () => {
    for (const kind of MASCOT_KINDS) {
      expect(MASCOT_BRAND[kind]).toMatch(/^#[0-9A-F]{6}$/i);
      expect(MASCOT_BODY[kind]).toBeTruthy();
    }
  });

  it("tints toward white", () => {
    expect(tint("#000000", 0)).toBe("#000000");
    expect(tint("#000000", 1)).toBe("#ffffff");
    expect(tint("#3B82F6", 0.5)).toBe("#9dc1fb");
  });
});
