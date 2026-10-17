// The Claude API engine: the Claude driver with `auth: "apiKey"`.
//
// What these tests pin down, against the scripted fake CLI:
//   - the engine's only credential is the key the user saved for it — never
//     a shell ANTHROPIC_API_KEY, the CLI's own login, or a key saved for the
//     subscription engine;
//   - that key reaches the CLI child as ANTHROPIC_API_KEY (env, never argv);
//   - a turn without a key stops before spawning and says what to do;
//   - billing is reported as metered (pay-as-you-go), and the snapshot tells
//     the setup UI to ask for a key instead of a sign-in;
//   - the subscription engine's behavior is untouched.
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { EventRecorder } from "../testing/events.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver, STATIC_CLAUDE_MODELS, type ClaudeConfig } from "./claude.ts";
import {
  CLAUDE_API_CREDENTIAL_TARGET,
  CLAUDE_API_KEY_ENV,
  claudeApiKeyFrom,
} from "./claude-api.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const SAVED_KEY = "sk-ant-test-saved";

describe("Claude API config", () => {
  it("defaults to the subscription engine (saved configs keep working)", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig({ auth: "subscription" })).toMatchObject({ auth: "subscription" });
    expect(ClaudeDriver.decodeConfig({ auth: "apiKey" })).toMatchObject({ auth: "apiKey" });
    expect(ClaudeDriver.defaultConfig()).not.toHaveProperty("auth");
  });

  it("rejects an unknown auth mode (the registry downgrades it to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ auth: "console" })).toThrow(/auth/);
  });

  it("reads only the saved-key variable, never a shell API key", () => {
    expect(claudeApiKeyFrom({ [CLAUDE_API_KEY_ENV]: "  sk-ant-x  " })).toBe("sk-ant-x");
    expect(claudeApiKeyFrom({ ANTHROPIC_API_KEY: "sk-ant-machine" })).toBe("");
    expect(claudeApiKeyFrom({})).toBe("");
  });
});

describe("Claude API snapshot (fake CLI)", () => {
  let instance: ProviderInstance;

  const create = async (
    environment: Record<string, string> = {},
    config: Partial<ClaudeConfig> = {},
  ) => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-api-test",
      displayName: "Claude API",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits", auth: "apiKey", ...config },
    });
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env[CLAUDE_API_KEY_ENV];
    await instance?.dispose();
  });

  it("reports a saved key as authenticated and billed per use", async () => {
    await create({ [CLAUDE_API_KEY_ENV]: SAVED_KEY });
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      authenticated: true,
      billing: "metered",
      credential: { target: CLAUDE_API_CREDENTIAL_TARGET, configured: true },
    });
    expect((await instance.snapshot()).reason).toBeUndefined();
  });

  it("asks for a key instead of offering a sign-in when none is saved", async () => {
    // even a signed-in CLI must not make the API-key engine look ready: its
    // spending identity is the saved key, not whatever login the CLI holds
    process.env.FAKE_CLAUDE_AUTH = "in";
    await create();
    const snapshot = await instance.snapshot();
    expect(snapshot).toMatchObject({
      state: "available",
      authenticated: false,
      billing: "metered",
      credential: { target: CLAUDE_API_CREDENTIAL_TARGET, configured: false },
    });
    expect(snapshot.reason).toContain("API key");
  });

  it("never detects an API key already present on the machine", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-machine";
    process.env[CLAUDE_API_KEY_ENV] = "sk-ant-shell-export";
    process.env.FAKE_CLAUDE_AUTH = "inherited-api-key";
    await create();
    expect(await instance.snapshot()).toMatchObject({
      authenticated: false,
      credential: { configured: false },
    });
  });

  it("is unavailable when the Claude Code CLI itself is absent", async () => {
    await create({ [CLAUDE_API_KEY_ENV]: SAVED_KEY }, { cli: join(tmpdir(), "missing-claude-cli") });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("keeps the Claude model catalog (the CLI's own menu with the static fallback)", async () => {
    await create({ [CLAUDE_API_KEY_ENV]: SAVED_KEY });
    expect(instance.models).toEqual(STATIC_CLAUDE_MODELS);
    expect(instance.refreshModels).toEqual(expect.any(Function));
  });
});

describe("Claude API turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-api-turn",
      displayName: "Claude API",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits", auth: "apiKey" },
    });
    recorder = recordEvents(instance.adapter);
  };

  const dumpPath = () => join(scratch, "dump.json");
  const dump = () => JSON.parse(readFileSync(dumpPath(), "utf8")) as { argv: string[]; env: Record<string, string>; prompt: unknown };
  const dumpNextTurn = () => {
    process.env.FAKE_CLAUDE_DUMP = dumpPath();
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-api-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env[CLAUDE_API_KEY_ENV];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs on the saved key even when the CLI itself is signed out", async () => {
    process.env.FAKE_CLAUDE_AUTH = "out";
    await create({ [CLAUDE_API_KEY_ENV]: SAVED_KEY });
    dumpNextTurn();

    await instance.adapter.sendTurn({ threadId: "t-api-key", text: "hello", model: "claude-sonnet-5-5" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });

    const seen = dump();
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "hello" } });
    // the saved key becomes the CLI's ANTHROPIC_API_KEY, and the env it came
    // from is stripped; the key never appears in argv
    expect(seen.env.ANTHROPIC_API_KEY).toBe(SAVED_KEY);
    expect(seen.env[CLAUDE_API_KEY_ENV]).toBeUndefined();
    expect(JSON.stringify(seen.argv)).not.toContain(SAVED_KEY);
    expect(JSON.stringify(seen.argv)).not.toContain("hello");
  });

  it("stops before spawning and says to add a key when none is saved", async () => {
    await create();
    dumpNextTurn();

    await instance.adapter.sendTurn({ threadId: "t-no-key", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const error = recorder.events.find((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    expect((error as { message: string }).message).toContain("Settings › Engines");
    // nothing was spawned to run the turn
    expect(existsSync(dumpPath())).toBe(false);
    expect(instance.adapter.hasSession("t-no-key")).toBe(false);
  });

  it("reports the CLI's per-turn cost as metered", async () => {
    await create({ [CLAUDE_API_KEY_ENV]: SAVED_KEY });
    await instance.adapter.sendTurn({ threadId: "t-cost", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, cost: 0.01 });
    expect(await instance.snapshot()).toMatchObject({ billing: "metered" });
  });

  it("uses the saved key for the isolated review call too", async () => {
    await create({ [CLAUDE_API_KEY_ENV]: SAVED_KEY });
    dumpNextTurn();
    await expect(instance.reviewPermission?.("review this request")).resolves.toBe("fake generated text");
    const seen = dump();
    expect(seen.env.ANTHROPIC_API_KEY).toBe(SAVED_KEY);
    expect(seen.env[CLAUDE_API_KEY_ENV]).toBeUndefined();
    expect(seen.prompt).toBe("review this request");
  });
});

// The subscription engine is deliberately unchanged: it still runs only on
// the CLI's own subscription login, and the API-key engine's secret never
// rides along into it.
describe("the subscription engine ignores the API-key engine's secret", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-sub-test-"));
    process.env.FAKE_CLAUDE_AUTH = "in";
    instance = await ClaudeDriver.create({
      instanceId: "claude-sub",
      displayName: "Claude",
      environment: { [CLAUDE_API_KEY_ENV]: SAVED_KEY },
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env[CLAUDE_API_KEY_ENV];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("spawns turns with no per-use credential at all", async () => {
    const dumpPath = join(scratch, "subscription-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    await instance.adapter.sendTurn({ threadId: "t-sub", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env[CLAUDE_API_KEY_ENV]).toBeUndefined();
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});
