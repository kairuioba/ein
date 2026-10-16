// WorkBuddy (codebuddy --acp) driver: argv, model discovery, sign-in check,
// and one full turn through the shared ACP runtime against the fake CLI.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  WORKBUDDY_DEFAULT_MODEL,
  WorkBuddyAgentDriver,
  classifyWorkBuddyError,
  parseAdvertisedModels,
  probeFingerprint,
  probeWorkBuddy,
  probeWorkBuddyModels,
  workbuddyCatalog,
  workbuddyEnvironment,
  workbuddyIsAuthenticated,
  workbuddySpawnArgs,
} from "./workbuddy.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("WorkBuddy argv", () => {
  it("enters ACP mode and leaves the CLI default model alone", () => {
    expect(workbuddySpawnArgs({ fullAuto: false }, undefined)).toEqual(["--acp"]);
    expect(workbuddySpawnArgs({ fullAuto: false }, WORKBUDDY_DEFAULT_MODEL)).toEqual(["--acp"]);
  });

  it("passes a picked model and auto-approval only on a full-auto instance", () => {
    expect(workbuddySpawnArgs({ fullAuto: false }, "deepseek-v4-pro")).toEqual(["--acp", "--model", "deepseek-v4-pro"]);
    expect(workbuddySpawnArgs({ fullAuto: true }, "deepseek-v4-pro")).toEqual([
      "--acp",
      "--model",
      "deepseek-v4-pro",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });
});

describe("WorkBuddy model discovery", () => {
  it("reads both ACP shapes and keeps the first label for a duplicate id", () => {
    const models = parseAdvertisedModels({
      models: { availableModels: [{ modelId: "hunyuan-t1", name: "Hunyuan T1" }, { modelId: " " }] },
      configOptions: [
        { id: "mode", options: [{ value: "plan" }] },
        { id: "model", options: [{ value: "hunyuan-t1", name: "dup" }, { value: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }] },
      ],
    });
    expect(models).toEqual([
      { id: "hunyuan-t1", label: "Hunyuan T1" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ]);
    expect(parseAdvertisedModels(null)).toEqual([]);
  });

  it("always offers the CLI default first", () => {
    const catalog = workbuddyCatalog([{ id: "glm-4.6", label: "GLM 4.6" }]);
    expect(catalog.default).toBe(WORKBUDDY_DEFAULT_MODEL);
    expect(catalog.options.map((option) => option.id)).toEqual([WORKBUDDY_DEFAULT_MODEL, "glm-4.6"]);
  });

  it("probes the models a session advertises without sending a prompt", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const models = await probeWorkBuddyModels(FAKE_CLI, { ...process.env, FAKE_ACP_MODELS: "hunyuan-t1,deepseek-v4-pro" }, 10_000);
    expect(models.map((model) => model.id)).toEqual(["hunyuan-t1", "deepseek-v4-pro"]);
  });

  it("gives up quietly when the CLI is missing", async () => {
    await expect(probeWorkBuddyModels(join(tmpdir(), "no-such-codebuddy"), process.env, 2_000)).resolves.toEqual([]);
  });
});

describe("WorkBuddy sign-in and settings", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-workbuddy-home-"));
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  it("trusts an API key, and assumes the keychain login until a probe says otherwise", () => {
    expect(workbuddyIsAuthenticated({ HOME: home, CODEBUDDY_API_KEY: "ck-test" })).toBe(true);
    expect(workbuddyIsAuthenticated({ HOME: home })).toBe(true);
    expect(workbuddyIsAuthenticated({ HOME: home }, { cli: join(home, "never-probed") })).toBe(true);
  });

  it("learns sign-in from the probe: a session proves it, an auth refusal disproves it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    await expect(probeWorkBuddy(FAKE_CLI, { ...process.env, FAKE_ACP_MODE: "auth-required" }, 10_000)).resolves.toEqual({
      models: [],
      signedIn: false,
    });
    await expect(probeWorkBuddy(FAKE_CLI, { ...process.env }, 10_000)).resolves.toMatchObject({ signedIn: true });
    await expect(probeWorkBuddy(join(home, "no-such-codebuddy"), process.env, 2_000)).resolves.toEqual({ models: [], signedIn: null });
  });

  it("turns auth-shaped failures into a sign-in prompt", () => {
    expect(classifyWorkBuddyError({ code: -32000, message: "Authentication required" })).toBe("invalid_credentials");
    expect(classifyWorkBuddyError(new Error("请先登录 CodeBuddy"))).toBe("invalid_credentials");
    expect(classifyWorkBuddyError(new Error("Invalid API key"))).toBe("invalid_credentials");
    expect(classifyWorkBuddyError(new Error("network unreachable"))).toBeUndefined();
  });

  it("keys probe answers by CLI, edition and key without keeping the key", () => {
    const withKey = probeFingerprint({ CODEBUDDY_API_KEY: "ck-secret" }, "codebuddy");
    expect(withKey).not.toContain("ck-secret");
    expect(withKey).not.toBe(probeFingerprint({ CODEBUDDY_API_KEY: "ck-other" }, "codebuddy"));
    expect(probeFingerprint({}, "codebuddy")).toBe("codebuddy|international|login");
    expect(probeFingerprint({ CODEBUDDY_INTERNET_ENVIRONMENT: "internal" }, "codebuddy")).toBe("codebuddy|internal|login");
  });

  it("maps App Settings to the variables the CLI reads", () => {
    expect(workbuddyEnvironment(undefined)).toEqual({});
    expect(workbuddyEnvironment({ apiKey: " ck-1 ", environment: "internal" })).toEqual({
      CODEBUDDY_API_KEY: "ck-1",
      CODEBUDDY_INTERNET_ENVIRONMENT: "internal",
    });
    expect(workbuddyEnvironment({ environment: "international" })).toEqual({});
  });
});

describe("WorkBuddy turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-workbuddy-test-"));
    instance = await WorkBuddyAgentDriver.create({
      instanceId: "workbuddy",
      displayName: "WorkBuddy",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs a turn through codebuddy --acp with the picked model", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-wb", text: "你好", model: "deepseek-v4-pro" });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, provider: "workbuddyAgent" });
    const text = recorder.events.find((event) => event.type === "item.completed" && (event as { itemType?: string }).itemType === "assistant_text");
    expect((text as { text: string }).text).toBe("hello from fake acp");
    const argv = (JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] }).argv;
    expect(argv.slice(-3)).toEqual(["--acp", "--model", "deepseek-v4-pro"]);
  });

  it("shows signed out once a background probe is refused for sign-in", async () => {
    const signedOut = await WorkBuddyAgentDriver.create({
      instanceId: "workbuddy-ioa",
      displayName: "WorkBuddy",
      environment: { FAKE_ACP_MODE: "auth-required", CODEBUDDY_INTERNET_ENVIRONMENT: "ioa" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      let snapshot = await signedOut.snapshot();
      for (let i = 0; i < 80 && !(snapshot.state === "available" && snapshot.authenticated === false); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = await signedOut.snapshot();
      }
      expect(snapshot).toMatchObject({ state: "available", authenticated: false });
    } finally {
      await signedOut.dispose();
    }
  });

  it("mounts the team tools so a WorkBuddy bot can be a Chief or a member", () => {
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
    expect(instance.models.options[0]?.id).toBe(WORKBUDDY_DEFAULT_MODEL);
  });
});
