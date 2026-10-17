import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../../config.ts";
import {
  GrokAgentDriver,
  grokModelLabel,
  learnedGrokModels,
  readGrokModelCatalog,
  rememberGrokModels,
  resetLearnedGrokModels,
  STATIC_GROK_MODELS,
} from "./grok.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-grok-catalog-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, ".grok"), { recursive: true });
  writeFileSync(join(dir, ".grok", "config.toml"), toml);
  return dir;
}

describe("readGrokModelCatalog", () => {
  it("returns the fallback cloud list when there is no config", () => {
    expect(readGrokModelCatalog({ HOME: join(tmpdir(), "omb-grok-missing-home") })).toEqual(STATIC_GROK_MODELS);
  });

  it("appends local slugs from config.toml and prefers their display names", () => {
    const home = scratchConfig(`
[models]
default = "ollama-ornith-35b-bf16"

[model."grok-4.6"]
name = "should not replace the cloud label"

[model."ollama-ornith-35b-bf16"]
model = "ornith:35b-bf16"
name = "ornith:35b-bf16 (Ollama)"
api_key = "must-not-leak"

[model.omlx-minimax-m3]
name = "MiniMax M3 4bit (oMLX)"
`);

    expect(readGrokModelCatalog({ HOME: home })).toEqual({
      default: "ollama-ornith-35b-bf16",
      options: [
        { id: "grok-4.7", label: "Grok 4.7" },
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5" },
        { id: "ollama-ornith-35b-bf16", label: "ornith:35b-bf16 (Ollama)", custom: true },
        { id: "omlx-minimax-m3", label: "MiniMax M3 4bit (oMLX)", custom: true },
      ],
    });
  });

  it("ignores invalid slugs and a default that is not in the catalog", () => {
    const home = scratchConfig(`
[models]
default = "not-installed"

[model."bad slug"]
name = "nope"

[model.ok-model]
name = "OK"
`);
    const catalog = readGrokModelCatalog({ HOME: home });
    expect(catalog.default).toBe(STATIC_GROK_MODELS.default);
    expect(catalog.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-4.6", "grok-4.5", "ok-model"]);
  });

  it("honors GROK_HOME over HOME", () => {
    const ignored = scratchConfig(`[model.ignored]\nname = "Ignored"\n`);
    const grokHomeParent = mkdtempSync(join(tmpdir(), "omb-grok-home-"));
    const grokHome = join(grokHomeParent, "grok");
    scratchDirs.push(grokHomeParent);
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "config.toml"), `[model.from-grok-home]\nname = "From GROK_HOME"\n`);
    const catalog = readGrokModelCatalog({ HOME: ignored, GROK_HOME: grokHome });
    expect(catalog.options.map((o) => o.id)).toContain("from-grok-home");
    expect(catalog.options.map((o) => o.id)).not.toContain("ignored");
  });

  it("ignores default keys outside the [models] table", () => {
    const home = scratchConfig(`
[cli]
default = "grok-4.5"

[model.ok-model]
name = "OK"
`);
    expect(readGrokModelCatalog({ HOME: home }).default).toBe(STATIC_GROK_MODELS.default);
  });
});

// Regression: the picker was written into the code (Grok 4.6 and 4.5), so
// Grok 4.7 never appeared although the CLI offered it.
describe("the list Grok Build advertises", () => {
  afterEach(() => resetLearnedGrokModels());

  it("names slugs the way xAI does", () => {
    expect(grokModelLabel("grok-4.7")).toBe("Grok 4.7");
    expect(grokModelLabel("grok-4.7-fast")).toBe("Grok 4.7 Fast");
    expect(grokModelLabel("grok-build")).toBe("Grok Build");
    expect(grokModelLabel("my-local")).toBe("my-local");
  });

  it("leads the picker with the advertised models, keeps saved ids, and marks the user's own slugs custom", () => {
    const home = scratchConfig(`[model.local-glm]\nname = "GLM local"\n`);
    const catalog = readGrokModelCatalog({ HOME: home }, [
      { id: "grok-4.8", label: "Grok 4.8" },
      { id: "grok-4.7", label: "Grok 4.7" },
      { id: "local-glm", label: "GLM local" },
    ]);
    expect(catalog.options.map((o) => o.id)).toEqual(["grok-4.8", "grok-4.7", "local-glm", "grok-4.6", "grok-4.5"]);
    expect(catalog.options.find((o) => o.id === "local-glm")?.custom).toBe(true);
    expect(catalog.options.find((o) => o.id === "grok-4.8")?.custom).toBeUndefined();
    expect(catalog.default).toBe("grok-4.7");
  });

  it("remembers what a session advertised, on disk, until the list changes", () => {
    const advertised = [{ modelId: "grok-4.7", name: "Grok 4.7" }, { modelId: "grok-4.7-fast" }, { modelId: "bad slug" }];
    expect(rememberGrokModels("grok", advertised)).toBe(true);
    expect(rememberGrokModels("grok", advertised)).toBe(false);
    expect(learnedGrokModels("grok")).toEqual([
      { id: "grok-4.7", label: "Grok 4.7" },
      { id: "grok-4.7-fast", label: "Grok 4.7 Fast" },
    ]);
    resetLearnedGrokModels();
    expect(learnedGrokModels("grok").map((row) => row.id)).toEqual(["grok-4.7", "grok-4.7-fast"]);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "grok-models.json"), "utf8")).entries[0].cli).toBe("grok");
    expect(learnedGrokModels("/other/grok")).toEqual([]);
  });
});

describe("GrokAgentDriver catalog", () => {
  it("loads the config catalog when the instance is created", async () => {
    const home = scratchConfig(`[model.local-glm]\nname = "GLM local"\n`);
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-catalog",
      displayName: "Grok",
      environment: { HOME: home },
      enabled: true,
      config: GrokAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((o) => o.id === "local-glm" && o.label === "GLM local")).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});
