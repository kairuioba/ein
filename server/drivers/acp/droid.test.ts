// Droid model catalog: the live list comes from the installed CLI's
// `droid.list_models` (the Droid SDK's no-session call), merged with the
// user's ~/.factory/settings.json, with the shipped slice as the fallback.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import {
  DroidAgentDriver,
  parseDroidModelList,
  probeDroidModels,
  settleDroidModels,
  STATIC_DROID_MODELS,
} from "./droid.ts";

const FAKE_DROID = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-droid-cli.ts");

const scratchDirs: string[] = [];
afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
});
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};

describe("parseDroidModelList", () => {
  it("keeps Factory's models official and BYOK models custom, using Factory's names", () => {
    expect(
      parseDroidModelList({
        models: [
          { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", isCustom: false },
          { id: "gpt-6.1-sol", shortDisplayName: "6.1 Sol" },
          { id: "custom:Azure-Opus-0", displayName: "Azure Opus", isCustom: true },
          { id: "custom:ein-omlx-qwen", displayName: "ours", isCustom: true },
          { id: "retired", displayName: "Retired", disabled: true, disabledReason: "org policy" },
          { displayName: "no id" },
          { id: "claude-opus-5-5", displayName: "duplicate" },
        ],
      }),
    ).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "gpt-6.1-sol", label: "6.1 Sol" },
      { id: "custom:Azure-Opus-0", label: "Azure Opus", custom: true },
    ]);
  });

  it("returns null for anything that is not a model list", () => {
    expect(parseDroidModelList(null)).toBeNull();
    expect(parseDroidModelList({ models: [] })).toBeNull();
    expect(parseDroidModelList({ sessions: [] })).toBeNull();
  });
});

describe("probeDroidModels (fake CLI)", () => {
  it("asks `droid exec` in SDK mode for droid.list_models", async () => {
    chmodSync(FAKE_DROID, 0o755);
    const dump = join(scratch("omb-droid-argv-"), "argv.json");
    const rows = await probeDroidModels(FAKE_DROID, { ...process.env, FAKE_DROID_DUMP: dump }, 10_000);
    expect(rows?.map((row) => row.id)).toEqual(["claude-opus-5-5", "gpt-6.1-sol", "grok-4.7", "custom:Azure-Opus-0"]);
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual([
      "exec",
      "--input-format",
      "stream-jsonrpc",
      "--output-format",
      "stream-jsonrpc",
    ]);
  });

  it("gives up quietly on an older droid, a signed-out one, a silent one, or none", async () => {
    chmodSync(FAKE_DROID, 0o755);
    await expect(probeDroidModels(FAKE_DROID, { ...process.env, FAKE_DROID_MODE: "no-method" }, 10_000)).resolves.toBeNull();
    await expect(probeDroidModels(FAKE_DROID, { ...process.env, FAKE_DROID_MODE: "auth" }, 10_000)).resolves.toBeNull();
    await expect(probeDroidModels(FAKE_DROID, { ...process.env, FAKE_DROID_MODE: "hang" }, 500)).resolves.toBeNull();
    await expect(probeDroidModels(join(tmpdir(), "no-such-droid"), process.env, 5_000)).resolves.toBeNull();
  });
});

describe("Droid catalog", () => {
  it("ships a current fallback that still names every id the earlier list had", () => {
    const ids = STATIC_DROID_MODELS.options.map((option) => option.id);
    for (const id of [
      "auto",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gemini-3.1-pro-preview",
      "glm-5.2",
      "kimi-k3",
      "grok-4.6",
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "gpt-6.1-sol", "grok-4.7"]));
    expect(STATIC_DROID_MODELS.default).toBe("claude-opus-5");
  });

  it("lists what the CLI reports, merged with settings.json, without waiting for it", async () => {
    chmodSync(FAKE_DROID, 0o755);
    const home = scratch("omb-droid-live-");
    mkdirSync(join(home, ".factory"), { recursive: true });
    writeFileSync(
      join(home, ".factory", "settings.json"),
      JSON.stringify({ customModels: [{ id: "custom:LMStudio-Qwen-0", displayName: "Qwen (local)" }] }),
    );
    const environment = { HOME: home, EIN_PROBE_LIVE_MODELS: "1" };
    const instance = await DroidAgentDriver.create({
      instanceId: "droid-live",
      displayName: undefined,
      environment,
      enabled: true,
      config: { cli: FAKE_DROID, fullAuto: false },
    });
    try {
      // first answer: the shipped slice (the probe is still running)
      expect(instance.models.default).toBe("claude-opus-5");
      await settleDroidModels(FAKE_DROID, { ...process.env, ...environment });
      await instance.refreshModels?.();
      const ids = instance.models.options.map((option) => option.id);
      expect(ids.slice(0, 2)).toEqual(["custom:LMStudio-Qwen-0", "custom:Azure-Opus-0"]);
      expect(ids.slice(2)).toEqual(["claude-opus-5-5", "gpt-6.1-sol", "grok-4.7"]);
      expect(instance.models.options.find((option) => option.id === "grok-4.7")).toEqual({ id: "grok-4.7", label: "Grok 4.7" });
      // no default in settings.json: the newest flagship the CLI confirms
      expect(instance.models.default).toBe("claude-opus-5-5");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps the shipped slice when the CLI cannot list models", async () => {
    chmodSync(FAKE_DROID, 0o755);
    const home = scratch("omb-droid-old-");
    const environment = { HOME: home, EIN_PROBE_LIVE_MODELS: "1", FAKE_DROID_MODE: "no-method" };
    const instance = await DroidAgentDriver.create({
      instanceId: "droid-old",
      displayName: undefined,
      environment,
      enabled: true,
      config: { cli: FAKE_DROID, fullAuto: false },
    });
    try {
      await settleDroidModels(FAKE_DROID, { ...process.env, ...environment });
      await instance.refreshModels?.();
      expect(instance.models.options.map((option) => option.id)).toEqual(
        STATIC_DROID_MODELS.options.map((option) => option.id),
      );
      expect(instance.models.default).toBe("claude-opus-5");
    } finally {
      await instance.dispose();
    }
  });
});
