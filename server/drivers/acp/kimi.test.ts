// Kimi model catalog: `/login` provisions the subscription's models into
// ~/.kimi-code/config.toml under a managed provider; those are the official
// list (and follow Kimi's releases), user providers are Custom.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { readKimiModelCatalog, STATIC_KIMI_MODELS } from "./kimi.ts";

const scratchDirs: string[] = [];
afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
});

function kimiHome(config: string): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "omb-kimi-catalog-"));
  scratchDirs.push(home);
  mkdirSync(join(home, ".kimi-code"), { recursive: true });
  writeFileSync(join(home, ".kimi-code", "config.toml"), config);
  return { HOME: home };
}

// The shape `/login` writes (kimi.com/code/docs, Configuration files).
const PROVISIONED = `default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
display_name = "K3"
capabilities = ["thinking", "always_thinking", "image_in", "video_in", "tool_use"]

[models."kimi-code/k3".overrides]
display_name = "not a model"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262_144

[providers.anthropic]
type = "anthropic"
api_key_env = "ANTHROPIC_API_KEY"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
upgrade = { model = "claude-opus-5" }

[providers.omlx]
type = "openai_legacy"

[models."omlx/GLM-5.2-fp8"]
provider = "omlx"
model = "GLM-5.2-fp8"
max_context_size = 262144
`;

describe("readKimiModelCatalog", () => {
  it("falls back to the shipped subscription list when there is no config", () => {
    expect(readKimiModelCatalog({ HOME: join(tmpdir(), "omb-kimi-missing-home") })).toEqual(STATIC_KIMI_MODELS);
  });

  it("offers what /login provisioned, with Kimi's names, and user providers as Custom", () => {
    const catalog = readKimiModelCatalog(kimiHome(PROVISIONED));
    expect(catalog.options).toEqual([
      { id: "kimi-code/k3", label: "K3", contextWindow: 1_048_576 },
      { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding", contextWindow: 262_144 },
      { id: "kimi-code/kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed", contextWindow: 262_144 },
      // a provider the user added; our own local-host aliases come from the
      // live inject probe instead, so they are not listed twice
      { id: "claude-opus-4-7", label: "claude-opus-4-7", custom: true, contextWindow: 200_000 },
    ]);
    expect(catalog.default).toBe("kimi-code/kimi-for-coding");
  });

  it("lists a model Kimi provisions tomorrow without an Ein release", () => {
    const catalog = readKimiModelCatalog(
      kimiHome(`${PROVISIONED}
[models."kimi-code/k3.5"]
provider = "managed:kimi-code"
model = "k3.5"
max_context_size = 2097152
display_name = "K3.5"
migration_markdown = """
[models."not-a-model"]
provider = "managed:kimi-code"
"""
`),
    );
    const official = catalog.options.filter((option) => !option.custom).map((option) => option.id);
    expect(official).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
      "kimi-code/k3.5",
    ]);
    expect(catalog.options.find((option) => option.id === "kimi-code/k3.5")).toEqual({
      id: "kimi-code/k3.5",
      label: "K3.5",
      contextWindow: 2_097_152,
    });
  });

  it("keeps the shipped list when only user providers are configured", () => {
    const catalog = readKimiModelCatalog(
      kimiHome(`[models."my-model"]
provider = "custom"
model = "my-model"
max_context_size = 8192
display_name = "Mine"
`),
    );
    expect(catalog.options.slice(0, STATIC_KIMI_MODELS.options.length)).toEqual(STATIC_KIMI_MODELS.options);
    expect(catalog.options.at(-1)).toEqual({ id: "my-model", label: "Mine", custom: true, contextWindow: 8192 });
    expect(catalog.default).toBe(STATIC_KIMI_MODELS.default);
  });

  it("treats kimi-code/* aliases from an older config without a provider as official", () => {
    const catalog = readKimiModelCatalog(kimiHome(`[models."kimi-code/k3"]\nmodel = "k3"\nname = "Kimi K3"\n`));
    expect(catalog.options).toEqual([{ id: "kimi-code/k3", label: "Kimi K3" }]);
    expect(catalog.default).toBe("kimi-code/k3");
  });
});
