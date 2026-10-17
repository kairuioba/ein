// Qwen Code catalog: the picker offers what Qwen Code's own /model offers —
// the modelProviders in ~/.qwen/settings.json — plus live local hosts.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { QwenAgentDriver, readQwenModelCatalog } from "./qwen.ts";

const scratchDirs: string[] = [];
afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
});

function qwenHome(settings: string): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "omb-qwen-catalog-"));
  scratchDirs.push(home);
  mkdirSync(join(home, ".qwen"), { recursive: true });
  writeFileSync(join(home, ".qwen", "settings.json"), settings);
  return { HOME: home };
}

const SETTINGS = `{
  // written by /auth → Alibaba ModelStudio → Coding Plan
  "modelProviders": {
    "openai": [
      { "id": "qwen3.7-plus", "name": "Qwen3.7 Plus", "envKey": "BAILIAN_CODING_PLAN_API_KEY",
        "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1" },
      { "id": "glm-5", "envKey": "BAILIAN_CODING_PLAN_API_KEY" },
      { "id": "gemma-4", "name": "gemma-4 (oMLX)", "baseUrl": "http://127.0.0.1:8080/v1", "envKey": "EIN_QWEN_OMLX_API_KEY" },
      { "name": "no id" }
    ],
    "anthropic": [{ "id": "claude-sonnet-5", "name": "Claude Sonnet 5 // via proxy" }],
    "broken": { "id": "not-an-array" }
  },
  /* the model Qwen Code starts on */
  "model": { "name": "glm-5" }
}`;

describe("readQwenModelCatalog", () => {
  it("is empty without settings — Qwen has no first-party catalog any more", () => {
    expect(readQwenModelCatalog({ HOME: join(tmpdir(), "omb-qwen-missing") })).toEqual({ default: "", options: [] });
  });

  it("lists every configured provider model as Custom, with Qwen's default", () => {
    expect(readQwenModelCatalog(qwenHome(SETTINGS))).toEqual({
      default: "glm-5",
      options: [
        { id: "qwen3.7-plus", label: "Qwen3.7 Plus", custom: true },
        { id: "glm-5", label: "glm-5", custom: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5 // via proxy", custom: true },
      ],
    });
  });

  it("tolerates a malformed file", () => {
    expect(readQwenModelCatalog(qwenHome("{ not json"))).toEqual({ default: "", options: [] });
  });
});

describe("QwenAgentDriver catalog", () => {
  it("offers the configured models as soon as the instance exists", async () => {
    const instance = await QwenAgentDriver.create({
      instanceId: "qwen-catalog",
      displayName: "Qwen",
      environment: qwenHome(SETTINGS),
      enabled: true,
      config: QwenAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.default).toBe("glm-5");
      expect(instance.models.options.map((option) => option.id)).toEqual(
        expect.arrayContaining(["qwen3.7-plus", "glm-5", "claude-sonnet-5"]),
      );
      expect(instance.models.options.every((option) => option.custom)).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});
