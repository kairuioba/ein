import { describe, expect, it } from "vitest";

import {
  botsOnEngine,
  engineAction,
  engineRows,
  engineState,
  engineSummary,
  foldRows,
  foldedSummary,
  localModels,
  mascotForInstance,
  modelChips,
  onboardingEngines,
  onboardingEnginesWith,
  recommendedFor,
  strategyExamples,
  type EngineBot,
  type EngineInstance,
} from "./engine-model";

function engine(
  instanceId: string,
  driverKind: string,
  snapshot: EngineInstance["snapshot"] = { state: "available", authenticated: true },
  options: EngineInstance["models"]["options"] = [{ id: `${instanceId}-1`, label: `${instanceId} One` }],
  extra: Partial<EngineInstance> = {},
): EngineInstance {
  return { instanceId, driverKind, displayName: instanceId, snapshot, models: { default: options[0]?.id ?? "", options }, ...extra };
}

const bot = (id: string, instanceId: string, extra: Partial<EngineBot> = {}): EngineBot => ({ id, name: id, modelSelection: { instanceId, model: "m" }, ...extra });

describe("engine state", () => {
  it("reads sign-in, install and local-model states from the snapshot", () => {
    expect(engineState(engine("a", "claudeAgent"))).toBe("ready");
    expect(engineState(engine("a", "kimiAgent", { state: "available", authenticated: false }))).toBe("signin");
    expect(engineState(engine("a", "codex", { state: "unavailable" }))).toBe("missing");
    expect(engineState(engine("a", "hermesAgent", undefined, [], { access: "custom" }))).toBe("installed");
    expect(engineState(engine("a", "qwenAgent", undefined, [{ id: "qwen3:14b", label: "qwen3:14b", custom: true }], { access: "custom" }))).toBe("found");
  });

  it("maps states to the row's action", () => {
    expect(engineAction("ready")).toBe("settings");
    expect(engineAction("signin")).toBe("signin");
    expect(engineAction("missing")).toBe("install");
  });

  it("gives OpenAI-compatible servers the local chip mascot", () => {
    expect(mascotForInstance({ driverKind: "openai-compat" })).toBe("local");
    expect(mascotForInstance({ driverKind: "kimiAgent" })).toBe("kimi");
  });
});

describe("model chips", () => {
  it("shows the default model first", () => {
    const instance = engine("w", "workbuddyAgent", undefined, [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
    ]);
    instance.models.default = "c";
    expect(modelChips(instance)).toEqual({ labels: ["C", "A", "B"], mono: false });
  });

  it("shows local model ids in mono for an engine that only runs local models", () => {
    const instance = engine("h", "hermesAgent", undefined, [{ id: "qwen3:14b", label: "qwen3:14b", custom: true }], { access: "custom" });
    expect(modelChips(instance)).toEqual({ labels: ["qwen3:14b"], mono: true });
  });
});

describe("engine rows", () => {
  const instances = [
    engine("kimi", "kimiAgent", { state: "available", authenticated: false }),
    engine("box", "boxAgent"),
    engine("workbuddy", "workbuddyAgent"),
    engine("cursor", "cursorAgent"),
    engine("codex", "codex", { state: "unavailable" }),
  ];

  it("leaves out the cloud-computer runner and puts the recommended engine first", () => {
    const rows = engineRows(instances, []);
    expect(rows.map((row) => row.instance.instanceId)).toEqual(["workbuddy", "kimi", "cursor", "codex"]);
    expect(rows[0]!.recommended).toBe(true);
  });

  it("lists the bots on each engine, the chief first then oldest first, hidden ones left out", () => {
    const bots = [bot("b", "kimi", { createdAt: 2 }), bot("a", "kimi", { createdAt: 1 }), bot("c", "kimi", { createdAt: 3 }), bot("h", "kimi", { hidden: true })];
    expect(botsOnEngine(bots, "kimi", "c").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("always shows engines in use and folds quiet missing ones", () => {
    const rows = engineRows(instances, [bot("x", "kimi")]);
    const { shown, folded } = foldRows(rows, 3);
    expect(shown.map((row) => row.instance.instanceId)).toEqual(["workbuddy", "kimi", "cursor"]);
    expect(folded.map((row) => row.instance.instanceId)).toEqual(["codex"]);
    expect(foldedSummary(folded)).toEqual({ tone: "off", parts: [{ state: "missing", count: 1 }] });
  });

  it("never fills the list with engines that are not installed", () => {
    const rows = engineRows([engine("codex", "codex", { state: "unavailable" }), engine("pi", "piAgent", { state: "unavailable" })], []);
    expect(foldRows(rows).shown).toEqual([]);
  });

  it("summarises engines, usable ones and local models", () => {
    const local = engine("h", "hermesAgent", undefined, [{ id: "qwen3:14b", label: "qwen3:14b", custom: true }], { access: "custom" });
    const also = engine("q", "qwenAgent", undefined, [{ id: "qwen3:14b", label: "qwen3:14b", custom: true }, { id: "llama", label: "llama", custom: true }], { access: "custom" });
    expect(engineSummary([...instances, local, also])).toEqual({ total: 6, usable: 4, localModels: 2 });
    expect(localModels([local, also])).toEqual(["qwen3:14b", "llama"]);
  });
});

describe("onboarding grid", () => {
  it("orders the recommended engine first, then the well-known ones, and caps the grid", () => {
    const order = onboardingEngines(
      [{ driverKind: "piAgent" }, { driverKind: "codex" }, { driverKind: "boxAgent" }, { driverKind: "workbuddyAgent" }, { driverKind: "claudeAgent" }],
      3,
    ).map((instance) => instance.driverKind);
    expect(order).toEqual(["workbuddyAgent", "claudeAgent", "codex"]);
  });

  it("keeps the engine already chosen on the first-bot step, even when it ranks lower", () => {
    const all = [
      { instanceId: "pi", driverKind: "piAgent" },
      { instanceId: "codex", driverKind: "codex" },
      { instanceId: "box", driverKind: "boxAgent" },
      { instanceId: "wb", driverKind: "workbuddyAgent" },
      { instanceId: "claude", driverKind: "claudeAgent" },
    ];
    const ids = (chosen: string | null) => onboardingEnginesWith(all, chosen, 3).map((instance) => instance.instanceId);
    expect(ids(null)).toEqual(["wb", "claude", "codex"]);
    expect(ids("claude")).toEqual(["wb", "claude", "codex"]); // already shown: unchanged
    expect(ids("pi")).toEqual(["wb", "claude", "pi"]); // takes the last slot
    expect(ids("box")).toEqual(["wb", "claude", "codex"]); // never a cloud box
    expect(ids("gone")).toEqual(["wb", "claude", "codex"]);
  });
});

describe("recommendations", () => {
  const ready = [
    engine("cheap", "workbuddyAgent", { state: "available", authenticated: true, billing: "subscription" } as EngineInstance["snapshot"], [{ id: "hunyuan-t1", label: "Hunyuan T1" }]),
  ].map((instance) => ({ ...instance, capabilities: { agentsMcp: true, images: true } }));

  it("names an engine for each sample job it can do", () => {
    const examples = strategyExamples(ready, "balanced");
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((example) => example.instanceId === "cheap")).toBe(true);
  });

  it("returns nothing for an empty job description or when nothing can run", () => {
    expect(recommendedFor("", ready)).toBeNull();
    expect(recommendedFor("写代码", [])).toBeNull();
  });
});
