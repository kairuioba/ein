// Model recommendation: difficulty assessment, capability gates, and policy
// trade-offs over the instance descriptions /api/instances serves.
import { describe, expect, it } from "vitest";

import { profileFor } from "../shared/model-profiles.ts";
import {
  assessTask,
  candidatesFromInstances,
  effortFor,
  recommendForText,
  recommendModels,
  type InstanceLike,
} from "../shared/model-recommender.ts";

const INSTANCES: InstanceLike[] = [
  {
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true, billing: "subscription" },
    models: { default: "sonnet", options: [{ id: "opus", label: "Claude Opus" }, { id: "sonnet", label: "Claude Sonnet" }, { id: "haiku", label: "Claude Haiku" }] },
    capabilities: { agentsMcp: true, computerMcp: true, images: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    instanceId: "deepseek-api",
    driverKind: "openai-compat",
    displayName: "DeepSeek API",
    snapshot: { state: "available", billing: "metered" },
    models: { default: "deepseek-chat", options: [{ id: "deepseek-chat", label: "DeepSeek Chat" }] },
    capabilities: { agentsMcp: false, computerMcp: false, images: false },
    access: "custom",
  },
  {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "unavailable" },
    models: { default: "gpt-5.5", options: [{ id: "gpt-5.5", label: "GPT-5.5" }] },
    capabilities: { agentsMcp: true },
  },
];

describe("task assessment", () => {
  it("rates a multi-step coding job harder than a quick translation", () => {
    const coding = assessTask("从零实现一个完整的用户登录系统，包括前端、后端接口和数据库，并写单元测试");
    const translate = assessTask("简单翻译一句话成英文");
    expect(coding.difficulty).toBeGreaterThan(translate.difficulty);
    expect(coding.needs).toContain("coding");
    expect(coding.requiresTools).toBe(true);
    expect(translate.requiresTools).toBe(false);
    expect(translate.needs).toContain("writing");
  });

  it("lets the planner's estimate pull the difficulty", () => {
    expect(assessTask("整理会议纪要", { difficulty: 5 }).difficulty).toBeGreaterThanOrEqual(4);
    expect(assessTask("整理会议纪要", { needs: ["vision"] }).needs).toContain("vision");
  });

  it("flags work that needs a desktop", () => {
    const task = assessTask("打开浏览器登录网站，填写表单并截图");
    expect(task.requiresComputer).toBe(true);
    expect(task.requiresTools).toBe(true);
  });
});

describe("candidates", () => {
  it("only offers engines that can run right now", () => {
    const candidates = candidatesFromInstances(INSTANCES);
    expect(candidates.map((candidate) => `${candidate.instanceId}/${candidate.model}`)).toEqual([
      "claude/opus",
      "claude/sonnet",
      "claude/haiku",
      "deepseek-api/deepseek-chat",
    ]);
    expect(candidates.find((candidate) => candidate.instanceId === "deepseek-api")?.tools).toBe(false);
  });
});

describe("recommendations", () => {
  const candidates = candidatesFromInstances(INSTANCES);

  it("never recommends a plain chat API for work that needs tools", () => {
    const task = assessTask("修复仓库里的登录 bug 并运行测试");
    const picks = recommendModels(task, candidates, "economy", { limit: 5 });
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((pick) => pick.instanceId === "claude")).toBe(true);
  });

  it("prefers the strongest model under the quality policy for hard work", () => {
    const task = assessTask("设计并实现一个复杂的分布式任务调度系统架构，端到端完成", { difficulty: 5 });
    const [best] = recommendModels(task, candidates, "quality");
    expect(best?.model).toBe("opus");
    expect(best?.effort).toBe("xhigh");
  });

  it("prefers a fast, inexpensive model for easy writing under the economy policy", () => {
    const task = assessTask("简单写一句生日祝福");
    const [best] = recommendModels(task, candidates, "economy");
    expect(["haiku", "deepseek-chat"]).toContain(best?.model);
    expect(best?.reasons.length).toBeGreaterThan(0);
  });

  it("explains each pick and orders best first", () => {
    const { task, recommendations } = recommendForText("分析竞品并写一份对比报告", INSTANCES, "balanced");
    expect(task.needs).toContain("reasoning");
    expect(recommendations.length).toBeGreaterThan(1);
    for (let i = 1; i < recommendations.length; i += 1) {
      expect(recommendations[i - 1]!.score).toBeGreaterThanOrEqual(recommendations[i]!.score);
    }
  });
});

describe("profiles and effort", () => {
  it("matches specific families before broad ones", () => {
    expect(profileFor("deepseek-v4-flash").id).toBe("deepseek-fast");
    expect(profileFor("deepseek-v4-pro").id).toBe("deepseek");
    expect(profileFor("gpt-4o-mini").id).toBe("gpt-small");
    expect(profileFor("gpt-5.5").id).toBe("gpt-frontier");
    expect(profileFor("default", "WorkBuddy default").id).toBe("engine-default");
    expect(profileFor("totally-new-model").id).toBe("unknown");
  });

  it("applies a team override to a family", () => {
    expect(profileFor("hunyuan-t1", "", { hunyuan: { tier: 5 } }).tier).toBe(5);
  });

  it("picks the nearest effort the engine supports", () => {
    expect(effortFor(5, ["low", "medium", "high"])).toBe("high");
    expect(effortFor(1, ["medium", "high"])).toBe("medium");
    expect(effortFor(3, [])).toBeUndefined();
  });
});
