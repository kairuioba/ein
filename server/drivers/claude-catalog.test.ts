import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeDriver, readClaudeModelCatalog, STATIC_CLAUDE_MODELS } from "./claude.ts";
import { parseClaudeInitModels } from "./claude-models.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readClaudeModelCatalog", () => {
  it("returns the fallback catalog when settings are missing", () => {
    expect(readClaudeModelCatalog({ HOME: join(tmpdir(), "omb-claude-missing-home") })).toEqual(STATIC_CLAUDE_MODELS);
  });

  it("tags extra settings models as custom and leaves official rows untagged", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        model: "claude-sonnet-5",
        availableModels: [{ id: "my-local-opus", name: "Local Opus" }],
        env: { ANTHROPIC_MODEL: "hosted-qwen" },
      }),
    );

    expect(readClaudeModelCatalog({ HOME: home })).toEqual({
      default: STATIC_CLAUDE_MODELS.default,
      options: [
        ...STATIC_CLAUDE_MODELS.options,
        { id: "my-local-opus", label: "Local Opus", custom: true },
        { id: "hosted-qwen", label: "hosted-qwen", custom: true },
      ],
    });
  });

  it("does not list settings.model as a Custom leftover", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-leftover-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }),
    );

    expect(readClaudeModelCatalog({ HOME: home })).toEqual(STATIC_CLAUDE_MODELS);
  });
});

// What Claude Code 2.1.302 answers to an initialize control request (trimmed
// to the fields the catalog reads): its own /model menu.
const CLI_MENU = [
  { value: "default", resolvedModel: "claude-fable-5-1", displayName: "Default (recommended)", description: "Fable 5.1" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
  { value: "sonnet[1m]", resolvedModel: "claude-sonnet-4-6[1m]", displayName: "Sonnet 4.6 (1M context)" },
];

// Regression: the picker was a list written into the code, so Opus 5.5 and
// every later model never showed up although the installed CLI had them.
describe("the live Claude menu", () => {
  it("lists what the CLI offers, aliases resolved, current models first", () => {
    const live = parseClaudeInitModels(CLI_MENU);
    expect(live.recommended).toBe("claude-fable-5-1");
    expect(live.sonnet).toBe("claude-sonnet-5-5");
    expect(live.models.slice(0, 4)).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ]);
    expect(live.models.some((row) => row.id === "claude-sonnet-4-6[1m]" && row.label === "Claude Sonnet 4.6 (1M context)")).toBe(true);
    // the "default" row only names the recommendation; it is not a second Fable
    expect(live.models.filter((row) => row.id === "claude-fable-5-1")).toHaveLength(1);
  });

  it("drops rows that are not model ids and survives a CLI that lists none", () => {
    expect(parseClaudeInitModels([{ value: "x y", displayName: "Bad" }, null, 3]).models).toEqual([]);
    expect(parseClaudeInitModels(undefined)).toEqual({ models: [], sonnet: null, recommended: null });
  });

  it("merges the live menu with every fallback id and keeps Sonnet as the default", () => {
    const catalog = readClaudeModelCatalog({ HOME: join(tmpdir(), "omb-claude-live-home") }, parseClaudeInitModels(CLI_MENU));
    const ids = catalog.options.map((option) => option.id);
    expect(catalog.default).toBe("claude-sonnet-5-5");
    expect(ids.slice(0, 4)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    // newer than this code: still listed, because the CLI said so
    expect(ids).toContain("claude-opus-4-8");
    // the dated Haiku 4.5 is the undated id saved bots hold — one row, not two
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).not.toContain("claude-haiku-4-5-20251001");
    expect(catalog.options.filter((option) => option.label === "Claude Haiku 4.5")).toHaveLength(1);
    // every fallback id stays resolvable
    for (const option of STATIC_CLAUDE_MODELS.options) expect(ids).toContain(option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not list a settings alias as a custom model", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-alias-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ availableModels: ["sonnet", "haiku", "local-glm"] }));
    const catalog = readClaudeModelCatalog({ HOME: home }, parseClaudeInitModels(CLI_MENU));
    expect(catalog.options.filter((option) => option.custom).map((option) => option.id)).toEqual(["local-glm"]);
  });
});

describe("ClaudeDriver catalog", () => {
  it("loads extras when the instance is created", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-instance-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ customModels: ["local-glm"] }));
    const instance = await ClaudeDriver.create({
      instanceId: "claude-catalog",
      displayName: "Claude",
      environment: { HOME: home },
      enabled: true,
      config: ClaudeDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((option) => option.id === "local-glm" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});
