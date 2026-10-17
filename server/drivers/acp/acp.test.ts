// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, skipSubscriptionAuthForLocalInject, type AcpSupport } from "./core.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { DroidAgentDriver } from "./droid.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { steerContinuationPrompt } from "../steer.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** A harness that exists only in tests: it exercises the opt-in session-config
 *  model hook so PR 1 can prove the core capability without shipping a visible
 *  engine. Real harnesses live in their own file. */
const SELECT_MODEL_SUPPORT: AcpSupport = {
  driverKind: "selectModelTest",
  displayName: "Select Model Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }, { id: "m-two", label: "Two" }] },
  defaultCli: "fake-select-model",
  nativeSource: "test.acp",
  loginNote: "never reached",
  selectModel: { configId: "model" },
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const SelectModelDriver = createAcpDriver(SELECT_MODEL_SUPPORT);

/** Proves transformEnv can vary with the instance config, which is how the
 *  opencode driver picks its permission policy from `fullAuto`. */
const EnvPolicyDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "envPolicyTest",
  selectModel: undefined,
  transformEnv: (env, config) => {
    env.TEST_POLICY = config.fullAuto ? "auto" : "ask";
  },
});

/** Proves snapshot() awaits an async isAuthenticated, which is how the
 *  opencode driver answers from a discovered catalog. */
const AsyncAuthDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "asyncAuthTest",
  selectModel: undefined,
  isAuthenticated: async () => true,
});

const ClassifiedErrorDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "classifiedErrorTest",
  selectModel: undefined,
  classifyError: (error) =>
    error && typeof error === "object" && (error as { code?: unknown }).code === -32000
      ? "invalid_credentials"
      : undefined,
});

describe("skipSubscriptionAuthForLocalInject", () => {
  it("is true only for a host:: inject id", () => {
    expect(skipSubscriptionAuthForLocalInject("omlx::MiniMax-M3-4bit")).toBe(true);
    expect(skipSubscriptionAuthForLocalInject("unsloth::orcarouter/Qwen3.8-27B-Uncensored-GGUF")).toBe(true);
    expect(skipSubscriptionAuthForLocalInject("grok-4.6")).toBe(false);
    expect(skipSubscriptionAuthForLocalInject(undefined)).toBe(false);
  });
});

describe("ACP decodeConfig", () => {
  it("resolves a dynamic model catalog when a support provides one", async () => {
    const support: AcpSupport = {
      driverKind: "dynamic-test",
      displayName: "Dynamic Test",
      models: { default: "fallback", options: [{ id: "fallback", label: "Fallback" }] },
      defaultCli: FAKE_CLI,
      nativeSource: "dynamic-test.acp",
      loginNote: "not authenticated",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
      resolveModels: async () => ({
        default: "dynamic-model",
        options: [{ id: "dynamic-model", label: "Dynamic model" }],
      }),
    };
    const driver = createAcpDriver(support);
    const instance = await driver.create({
      instanceId: "dynamic-test",
      displayName: "Dynamic Test",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });
    expect(instance.models).toEqual({
      default: "dynamic-model",
      options: [{ id: "dynamic-model", label: "Dynamic model" }],
    });
    await instance.dispose();
  });
  it("grok defaults to the grok binary", () => {
    expect(GrokAgentDriver.decodeConfig({})).toEqual({ cli: "grok", fullAuto: false, workspace: undefined });
  });
  it("gemini defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
  });
  it("kimi defaults to the kimi binary and declares cross-platform setup", () => {
    expect(KimiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "kimi", fullAuto: false, workspace: undefined });
    expect(KimiAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("install.sh"),
      linux: expect.stringContaining("install.sh"),
      win32: expect.stringContaining("install.ps1"),
    });
    expect(KimiAgentDriver.install?.signInCommand).toBe("kimi login");
  });
  it("droid defaults to the droid binary and declares cross-platform setup", () => {
    expect(DroidAgentDriver.decodeConfig(undefined)).toEqual({ cli: "droid", fullAuto: false, workspace: undefined });
    expect(DroidAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("factory.ai/cli"),
      linux: expect.stringContaining("factory.ai/cli"),
      win32: expect.stringContaining("factory.ai/cli"),
    });
    expect(DroidAgentDriver.install?.signInCommand).toBe("droid");
  });
  it("cursor defaults to its unambiguous binary and declares cross-platform setup", () => {
    expect(CursorAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "cursor-agent",
      fullAuto: false,
      workspace: undefined,
    });
    expect(CursorAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("cursor.com/install"),
      linux: expect.stringContaining("cursor.com/install"),
      win32: expect.stringContaining("cursor.com/install"),
    });
    expect(CursorAgentDriver.install?.signInCommand).toBe("cursor-agent login");
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });

  it("does not advertise or accept local CUA in full-auto mode", async () => {
    const fullAuto = await GrokAgentDriver.create({
      instanceId: "grok-full-auto",
      displayName: "Grok Full Auto",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    expect(fullAuto.adapter.capabilities.localComputerMcp).toBe(false);
    await expect(
      fullAuto.adapter.sendTurn({
        threadId: "t-full-auto-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive provider approvals/);
    await fullAuto.dispose();
  });
});

describe("ACP turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_MODEL_STICKS;
    delete process.env.FAKE_ACP_USAGE_ROOT;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text before the tool, not summed on settle
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grokAgent")).toBe(true);
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("emits each assistant text block before the tool that follows it", async () => {
    await create(GrokAgentDriver, "interleave");
    await instance.adapter.sendTurn({ threadId: "t-interleave", text: "go", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before one
      "item.started", // tc-1
      "item.completed", // tc-1
      "content.delta",
      "item.completed", // before two
      "item.started", // tc-2
      "item.completed", // tc-2
      "content.delta",
      "thread.token-usage.updated",
      "item.completed", // after — no following tool, so settle flushes
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before one", "before two", "after"]);
  });

  it("reads token usage from the root of the prompt result", async () => {
    process.env.FAKE_ACP_USAGE_ROOT = "1";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-root", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated");
    expect(usage).toMatchObject({ input: 10, output: 5 });
  });

  it("passes ACP stdio flags and strips foreign provider keys from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.OPENCODE_API_KEY = "opencode-should-not-leak";
    process.env.CURSOR_API_KEY = "cursor-should-not-leak";
    process.env.CURSOR_AUTH_TOKEN = "cursor-token-should-not-leak";
    // workspace credentials with no CLI consumer at all — held by the
    // harness (env-injected at boot by the desktop shell), used in-process
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.OPENCODE_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
  });

  // ACP session/new accepts stdio MCP entries, so connected apps use the
  // same harness-owned bridge as Claude and Codex.
  it("mounts connected apps as a stdio MCP server", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_ACP_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "go",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toContainEqual({
      name: "composio",
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: [{ name: "OMB_CONNECTOR_UPSTREAM_URL", value: "http://127.0.0.1:8799/api/internal/connectors/mcp" }],
    });
  });

  it("droid takes model and autonomy over the wire, never through argv", async () => {
    // `droid exec -m <id> -o acp` ignores the flag (verified against 0.196.0),
    // so a model that only reached argv would silently run the CLI's own pick.
    instance = await DroidAgentDriver.create({
      instanceId: "droid-test",
      displayName: "Droid Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-dump.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid", text: "go", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["exec", "-o", "acp"]);
    expect(seen.argv).not.toContain("-m");

    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(applied).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "auto-high" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-sonnet-5" } },
    ]);
  });

  it("droid pins read-only mode when fullAuto is off", async () => {
    instance = await DroidAgentDriver.create({
      instanceId: "droid-safe",
      displayName: "Droid Safe",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-safe.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid-safe", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    // Both settings are explicit even with nothing on the turn: whatever
    // ~/.factory/settings.json pinned (including a `custom:` provider with its
    // own endpoint) must never be what the session silently runs on.
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "normal" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-opus-5" } },
    ]);
  });

  it("droid names the rejected setting when the agent predates session config", async () => {
    // The realistic failure is version skew: an older droid answers -32601 to
    // session/set_mode, and core surfaces the RPC message verbatim. A bare
    // "method not found" tells the user nothing, so the driver wraps it.
    process.env.FAKE_ACP_MODE = "no-session-config";
    instance = await DroidAgentDriver.create({
      instanceId: "droid-old-cli",
      displayName: "Droid Old CLI",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-droid-skew", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("session/set_mode");
    expect(err.message).toContain('autonomy mode "normal"');
    expect(err.message).toMatch(/`droid` is current/);
    // The session id still reached the client, so the thread can resume rather
    // than orphaning the session droid just created.
    expect(recorder.events.some((e) => e.type === "session.started")).toBe(true);
  });

  it("mounts local CUA only on an approval-capable ACP instance", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers).toContainEqual({
      name: "computer",
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
    });
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({
      threadId: "t-perm",
      text: "go",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "shell",
      approvalScope: "local-computer",
    });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({
      behavior: "allow",
      source: "user",
      approvalScope: "local-computer",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("grok local inject does not require grok.com login", async () => {
    process.env.FAKE_ACP_MODE = "no-auth";
    mkdirSync(join(scratch, ".grok"), { recursive: true });
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: { HOME: scratch, GROK_HOME: join(scratch, ".grok") },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "t-local-auth",
      text: "go",
      model: "omlx::MiniMax-M3-4bit",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it("starts Gemini CLI on its stable ACP surface", async () => {
    const dump = join(scratch, "gemini-acp.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GeminiAgentDriver);
    await instance.adapter.sendTurn({ threadId: "t-gemini-acp", text: "go", model: "gemini-test" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    expect(argv).toEqual(["--acp", "-m", "gemini-test"]);
    expect(argv).not.toContain("--experimental-acp");
  });

  it("rejects a second turn while one is in flight", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt settles a hung turn as cancelled", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  it("preserves ACP error codes for provider setup classification", async () => {
    await create(ClassifiedErrorDriver, "auth-required");
    await instance.adapter.sendTurn({ threadId: "t-auth-required", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ setup: true });
  });

  it("selectModel confirms the requested model before prompting", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-model", text: "go", model: "m-two" });

    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a model the session does not advertise fails the turn instead of running another", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-bad-model", text: "go", model: "m-nope" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/model not found/);
    // nothing was generated: the prompt is never sent
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  // The unadvertised-model test above rides the fake's -32602, so it settles in
  // `request()` and never reaches the guard. This one is the silent case the
  // guard was written for: the agent acknowledges the switch and keeps its old
  // model, which no error surfaces.
  it("a model switch acknowledged but not applied fails the turn", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    process.env.FAKE_ACP_MODEL_STICKS = "1";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-stuck-model", text: "go", model: "m-two" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/did not switch to m-two \(still m-one\)/);
    // the whole point: no paid turn is spent on the wrong model
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  it("selects the model on a resumed session too, not just a new one", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({
      threadId: "t-resume-model",
      text: "go",
      model: "m-two",
      // deliberately NOT "fake-acp-session", the id session/new returns: with
      // that cursor a session/load that threw and fell back to session/new
      // would emit the same sessionId and this test could not fail
      resumeCursor: "resumed-thread-1",
    });

    // session/load feeds the same sessionResult as session/new, so the model
    // hook must fire on a resumed thread as well
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "resumed-thread-1", model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("applyTurnEnv sees the picker model after resolveTurnModel", async () => {
    const dump = join(scratch, "turn-env.json");
    process.env.FAKE_ACP_DUMP = dump;
    const TurnEnvDriver = createAcpDriver({
      ...SELECT_MODEL_SUPPORT,
      driverKind: "turnEnvTest",
      selectModel: undefined,
      resolveTurnModel: (model) => (model ? `resolved/${model}` : model),
      applyTurnEnv: (env, { model, requestedModel }) => {
        env.TEST_TURN_MODEL = `${model ?? ""}|${requestedModel ?? ""}`;
      },
    });
    instance = await TurnEnvDriver.create({
      instanceId: "turn-env-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "t-turn-env",
      text: "go",
      model: "ollama::ornith:35b-bf16",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_TURN_MODEL).toBe(
      "resolved/ollama::ornith:35b-bf16|ollama::ornith:35b-bf16",
    );
  });

  it("transformEnv sees the instance config", async () => {
    const dump = join(scratch, "policy.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await EnvPolicyDriver.create({
      instanceId: "policy-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-policy", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_POLICY).toBe("auto");
  });

  it("declares effort levels for Grok only", async () => {
    await create(GrokAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["low", "medium", "high"]);

    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();

    await create(KimiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
  });

  it("passes effort to Grok, and omits the flag when unset", async () => {
    const withEffort = join(scratch, "grok-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = withEffort;
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(withEffort, "utf8"));
    expect(seen.argv).toContain("--reasoning-effort");
    expect(seen.argv[seen.argv.indexOf("--reasoning-effort") + 1]).toBe("high");

    const without = join(scratch, "grok-no-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = without;
    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(without, "utf8")).argv).not.toContain("--reasoning-effort");
  });

  it("puts Grok -m after agent so ACP stdio binds the local slug", async () => {
    const dump = join(scratch, "grok-argv-order.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-argv", text: "hi", model: "grok-4.5", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    const agent = argv.indexOf("agent");
    const modelFlag = argv.indexOf("-m");
    const stdio = argv.indexOf("stdio");
    expect(agent).toBeGreaterThan(-1);
    expect(modelFlag).toBeGreaterThan(agent);
    expect(stdio).toBeGreaterThan(modelFlag);
    expect(argv[modelFlag + 1]).toBe("grok-4.5");
    expect(argv.indexOf("--reasoning-effort")).toBeGreaterThan(agent);
    expect(argv.indexOf("--permission-mode")).toBeLessThan(agent);
  });
});

describe("ACP snapshot", () => {
  it("a missing binary is unavailable", async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-grok-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("kimi checks KIMI_CODE_HOME before the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-auth-"));
    const kimiHome = join(scratch, "custom-kimi-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(childHome, ".kimi-code", "credentials", "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-custom-home",
      displayName: undefined,
      environment: { KIMI_CODE_HOME: kimiHome, HOME: childHome },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(join(kimiHome, "credentials", "kimi-code.json"), "{}");
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid resolves the signed-in CLI before falling back to FACTORY_API_KEY", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-auth-"));
    // FACTORY_HOME_OVERRIDE replaces the CLI's HOME, not its data root: droid
    // writes <home>/.factory/auth.v2.file either way (verified against 0.196.0).
    const overrideHome = join(scratch, "custom-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".factory"), { recursive: true });
    writeFileSync(join(childHome, ".factory", "auth.v2.file"), "{}");

    // The child env inherits process.env (core.ts childEnv), so a developer
    // machine with a real FACTORY_API_KEY exported would otherwise satisfy
    // every case here and prove nothing about the on-disk lookup.
    const make = (environment: Record<string, string>) =>
      DroidAgentDriver.create({
        instanceId: "droid-auth",
        displayName: undefined,
        environment: { FACTORY_API_KEY: "", ...environment },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });

    const instances: ProviderInstance[] = [];
    try {
      // FACTORY_HOME_OVERRIDE wins: the child HOME's credential must not count.
      const overridden = await make({ FACTORY_HOME_OVERRIDE: overrideHome, HOME: childHome });
      instances.push(overridden);
      expect((await overridden.snapshot()).authenticated).toBe(false);
      mkdirSync(join(overrideHome, ".factory"), { recursive: true });
      writeFileSync(join(overrideHome, ".factory", "auth.v2.file"), "{}");
      expect((await overridden.snapshot()).authenticated).toBe(true);

      // A logged-out override is not rescued by a key on the way past it, but
      // the key alone still authenticates when nothing is signed in on disk.
      const loggedOutWithKey = await make({
        FACTORY_HOME_OVERRIDE: join(scratch, "empty-home"),
        HOME: childHome,
        FACTORY_API_KEY: "fk-test",
      });
      instances.push(loggedOutWithKey);
      expect((await loggedOutWithKey.snapshot()).authenticated).toBe(true);

      const fromHome = await make({ HOME: childHome });
      instances.push(fromHome);
      expect((await fromHome.snapshot()).authenticated).toBe(true);

      // secure_auth_storage writes the keychain/keyring variant instead of
      // auth.v2.file, so a fresh macOS login has only this one.
      const keychainHome = join(scratch, "keychain-home");
      mkdirSync(join(keychainHome, ".factory"), { recursive: true });
      writeFileSync(join(keychainHome, ".factory", "auth.v2.loginkeychain"), "{}");
      const fromKeychain = await make({ HOME: keychainHome });
      instances.push(fromKeychain);
      expect((await fromKeychain.snapshot()).authenticated).toBe(true);

      const neither = await make({ HOME: join(scratch, "empty") });
      instances.push(neither);
      expect((await neither.snapshot()).authenticated).toBe(false);
    } finally {
      for (const i of instances) await i.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid reads custom models, favourites order, and the configured default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-models-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(
      join(scratch, ".factory", "settings.json"),
      JSON.stringify({
        customModels: [
          { id: "custom:LMStudio-Qwen-0", displayName: "Qwen (local)" },
          { id: "custom:Azure-Opus-0", displayName: "Azure Opus" },
        ],
        modelFavorites: ["custom:Azure-Opus-0", "custom:LMStudio-Qwen-0"],
        sessionDefaultSettings: { model: "custom:LMStudio-Qwen-0" },
      }),
    );

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // favourites first in the user's own order, then the built-in slice
      expect(instance.models.options.slice(0, 2)).toEqual([
        { id: "custom:Azure-Opus-0", label: "Azure Opus", custom: true },
        { id: "custom:LMStudio-Qwen-0", label: "Qwen (local)", custom: true },
      ]);
      expect(instance.models.options.some((o) => o.id === "claude-opus-5")).toBe(true);
      expect(instance.models.default).toBe("custom:LMStudio-Qwen-0");
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid falls back to the built-in catalog when settings.json is unreadable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-nosettings-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(join(scratch, ".factory", "settings.json"), "{ not json");

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models-fallback",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.default).toBe("claude-opus-5");
      expect(instance.models.options.every((o) => !o.id.startsWith("custom:"))).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("kimi resolves default credentials from the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-home-"));
    const credentialDir = join(scratch, ".kimi-code", "credentials");
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-child-home",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("awaits an async isAuthenticated", async () => {
    const instance = await AsyncAuthDriver.create({
      instanceId: "async-auth",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // without the await this is a Promise: truthy, but not `true`
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});

// ── steer: messages into a running ACP turn ──────────────────────────────
// The fake's FAKE_ACP_STEER scenarios script the agent side: a first prompt
// that runs a tool and then keeps thinking, follow-up prompts that echo, and
// the cancel/steering behaviours of real agents (honour, ignore, error,
// native injection, "no running turn").
describe("ACP steering (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let rpcDump: string;
  let promptsDump: string;

  const KNOBS = [
    "FAKE_ACP_STEER",
    "FAKE_ACP_TOOL_MS",
    "FAKE_ACP_FINISH_MS",
    "FAKE_ACP_GATE_FILE",
    "FAKE_ACP_STEER_PERMISSION",
    "FAKE_ACP_LOAD_MS",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_PROMPTS_DUMP",
  ];

  const start = async (scenario: string, env: Record<string, string> = {}, fullAuto = true) => {
    process.env.FAKE_ACP_STEER = scenario;
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_PROMPTS_DUMP = promptsDump;
    Object.assign(process.env, env);
    instance = await GrokAgentDriver.create({
      instanceId: "acp-steer",
      displayName: "ACP Steer",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };
  const rpc = (): string[] => {
    try {
      return JSON.parse(readFileSync(rpcDump, "utf8"));
    } catch {
      return [];
    }
  };
  const prompts = (): { prompts: string[]; steers: any[] } => {
    try {
      return JSON.parse(readFileSync(promptsDump, "utf8"));
    } catch {
      return { prompts: [], steers: [] };
    }
  };
  const waitFor = async (probe: () => boolean, what: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; rpc: ${rpc().join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const texts = () =>
    recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
  const oneTurn = () => {
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-steer-"));
    rpcDump = join(scratch, "rpc.json");
    promptsDump = join(scratch, "prompts.json");
  });

  afterEach(async () => {
    for (const key of KNOBS) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("every ACP engine advertises steering", async () => {
    await start("boundary");
    expect(instance.adapter.capabilities.queueing).toBe(true);
    expect(typeof instance.adapter.steer).toBe("function");
  });

  it("waits for a running tool, then cancels at the boundary and continues in the SAME turn", async () => {
    await start("boundary", { FAKE_ACP_TOOL_MS: "400" });
    await instance.adapter.sendTurn({ threadId: "t-steer-tool", text: "build it" });
    await recorder.until((e) => e.type === "item.started");
    // the tool is executing: the message is taken, nothing is cancelled yet
    expect(await instance.adapter.steer!("t-steer-tool", "use the release profile", { steerId: "s1" })).toBe(true);
    expect(rpc()).not.toContain("session/cancel");
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: true, stopReason: null });
    expect((done as { undeliveredSteers?: string[] }).undeliveredSteers).toBeUndefined();
    oneTurn();
    // the cancel came after the tool finished — never during it
    expect(rpc()).toContain("session/cancel");
    expect(rpc()).not.toContain("session/cancel:during-tool");
    const follow = steerContinuationPrompt([{ text: "use the release profile" }]);
    expect(prompts().prompts).toEqual(["build it", follow]);
    expect(texts()).toEqual(["working", `echo: ${follow}`]);
    // the steer-induced cancel is neither an error nor an interruption
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    expect(tool).toMatchObject({ ok: true });
  });

  it("cancels at once when the agent is only thinking", async () => {
    await start("boundary", { FAKE_ACP_TOOL_MS: "50" });
    await instance.adapter.sendTurn({ threadId: "t-steer-think", text: "build it" });
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    expect(await instance.adapter.steer!("t-steer-think", "also lint")).toBe(true);
    await recorder.until((e) => e.type === "turn.completed");
    oneTurn();
    expect(prompts().prompts[1]).toBe(steerContinuationPrompt([{ text: "also lint" }]));
  });

  it("delivers several messages sent close together in ONE follow-up, in order", async () => {
    await start("boundary", { FAKE_ACP_TOOL_MS: "300" });
    await instance.adapter.sendTurn({ threadId: "t-steer-burst", text: "build it" });
    await recorder.until((e) => e.type === "item.started");
    expect(await instance.adapter.steer!("t-steer-burst", "first")).toBe(true);
    expect(await instance.adapter.steer!("t-steer-burst", "second")).toBe(true);
    expect(await instance.adapter.steer!("t-steer-burst", "third")).toBe(true);
    await recorder.until((e) => e.type === "turn.completed");
    oneTurn();
    expect(prompts().prompts).toEqual([
      "build it",
      steerContinuationPrompt([{ text: "first" }, { text: "second" }, { text: "third" }]),
    ]);
    expect(rpc().filter((m) => m.startsWith("session/cancel"))).toHaveLength(1);
  });

  it("an agent that ignores cancel finishes on its own, then gets the message in the same turn", async () => {
    await start("ignore-cancel", { FAKE_ACP_TOOL_MS: "50", FAKE_ACP_FINISH_MS: "300" });
    await instance.adapter.sendTurn({ threadId: "t-steer-ignore", text: "build it" });
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    expect(await instance.adapter.steer!("t-steer-ignore", "and this")).toBe(true);
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: null });
    oneTurn();
    expect(texts()).toEqual(["working", "finished on my own", `echo: ${steerContinuationPrompt([{ text: "and this" }])}`]);
    // one cancel only: an agent that ignores it is never asked twice
    expect(rpc().filter((m) => m.startsWith("session/cancel"))).toHaveLength(1);
  });

  it("an agent that answers the boundary cancel with an error still continues", async () => {
    await start("error-on-cancel", { FAKE_ACP_TOOL_MS: "50" });
    await instance.adapter.sendTurn({ threadId: "t-steer-error", text: "build it" });
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    expect(await instance.adapter.steer!("t-steer-error", "keep going")).toBe(true);
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    oneTurn();
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(prompts().prompts).toHaveLength(2);
  });

  it("never cancels while a permission card is open", async () => {
    await start("boundary", { FAKE_ACP_STEER_PERMISSION: "1", FAKE_ACP_TOOL_MS: "200" }, false);
    await instance.adapter.sendTurn({ threadId: "t-steer-perm", text: "build it" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.steer!("t-steer-perm", "and then deploy")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(rpc().some((m) => m.startsWith("session/cancel"))).toBe(false);

    await instance.adapter.respondToRequest("t-steer-perm", opened.requestId!, { behavior: "allow" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    oneTurn();
    // the approved tool ran to completion before the boundary cancel
    expect(rpc()).toContain("session/cancel");
    expect(rpc()).not.toContain("session/cancel:during-tool");
    expect(prompts().prompts[1]).toBe(steerContinuationPrompt([{ text: "and then deploy" }]));
  });

  it("a message sent during session/load joins the first prompt", async () => {
    await start("boundary", { FAKE_ACP_LOAD_MS: "400", FAKE_ACP_GATE_FILE: join(scratch, "load.gate"), FAKE_ACP_TOOL_MS: "20" });
    await instance.adapter.sendTurn({ threadId: "t-steer-load", text: "build it", resumeCursor: "fake-acp-session" });
    await waitFor(() => rpc().includes("session/load"), "session/load");
    expect(await instance.adapter.steer!("t-steer-load", "with the new flags")).toBe(true);
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    writeFileSync(join(scratch, "load.gate"), "open");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    oneTurn();
    expect(prompts().prompts).toEqual(["build it\n\nwith the new flags"]);
    expect(rpc().some((m) => m.startsWith("session/cancel"))).toBe(false);
  });

  it("uses the agent's own _session/steering when initialize advertises it", async () => {
    await start("native", { FAKE_ACP_TOOL_MS: "300" });
    await instance.adapter.sendTurn({ threadId: "t-steer-native", text: "build it" });
    await recorder.until((e) => e.type === "item.started");
    // mid-tool is fine for native steering: the agent decides when it lands
    expect(await instance.adapter.steer!("t-steer-native", "skip the docs")).toBe(true);
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    oneTurn();
    expect(prompts().steers).toEqual([
      {
        sessionId: "fake-acp-session",
        prompt: [{ type: "text", text: "skip the docs" }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      },
    ]);
    expect(prompts().prompts).toEqual(["build it"]);
    expect(rpc().some((m) => m.startsWith("session/cancel"))).toBe(false);
    expect(texts()).toContain("reply to: build it + steered: skip the docs");
  });

  it("native promptRequired holds the message for a follow-up prompt in the same turn", async () => {
    await start("native-idle", { FAKE_ACP_TOOL_MS: "20", FAKE_ACP_GATE_FILE: join(scratch, "idle.gate") });
    await instance.adapter.sendTurn({ threadId: "t-steer-idle", text: "build it" });
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    expect(await instance.adapter.steer!("t-steer-idle", "one more thing")).toBe(true);
    await waitFor(() => prompts().steers.length === 1, "the native steer");
    writeFileSync(join(scratch, "idle.gate"), "open");
    await recorder.until((e) => e.type === "turn.completed");
    oneTurn();
    // asked once, never re-injected in a loop, and delivered by the follow-up
    expect(prompts().steers).toHaveLength(1);
    expect(prompts().prompts).toEqual(["build it", steerContinuationPrompt([{ text: "one more thing" }])]);
  });

  it("a Stop outranks a waiting steer: no follow-up, and the message is handed back", async () => {
    await start("boundary", { FAKE_ACP_TOOL_MS: "5000" });
    await instance.adapter.sendTurn({ threadId: "t-steer-stop", text: "build it" });
    await recorder.until((e) => e.type === "item.started");
    expect(await instance.adapter.steer!("t-steer-stop", "after the build", { steerId: "keep-1" })).toBe(true);
    await instance.adapter.interruptTurn("t-steer-stop");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled", undeliveredSteers: ["keep-1"] });
    oneTurn();
    expect(prompts().prompts).toEqual(["build it"]);
    await expect(instance.adapter.steer!("t-steer-stop", "too late")).resolves.toBe(false);
  });

  it("a Stop against an agent that ignores cancel still ends the turn and hands the message back", async () => {
    await start("ignore-cancel", { FAKE_ACP_TOOL_MS: "50", FAKE_ACP_FINISH_MS: "20000" });
    await instance.adapter.sendTurn({ threadId: "t-steer-stop-ignore", text: "build it" });
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    expect(await instance.adapter.steer!("t-steer-stop-ignore", "queued words", { steerId: "keep-2" })).toBe(true);
    await waitFor(() => rpc().includes("session/cancel"), "the boundary cancel");
    // refused while stopping: the harness queues it instead
    await instance.adapter.interruptTurn("t-steer-stop-ignore");
    await expect(instance.adapter.steer!("t-steer-stop-ignore", "while stopping")).resolves.toBe(false);
    const done = await recorder.until((e) => e.type === "turn.completed", 10_000);
    expect(done).toMatchObject({ stopReason: "cancelled", undeliveredSteers: ["keep-2"] });
    oneTurn();
    expect(prompts().prompts).toEqual(["build it"]);
  }, 15_000);

  it("steering a thread with no running turn answers false", async () => {
    await start("boundary");
    await expect(instance.adapter.steer!("t-nothing", "hello")).resolves.toBe(false);
  });

  it("a steered turn reports the usage of all its prompts", async () => {
    await start("boundary", { FAKE_ACP_TOOL_MS: "20" });
    await instance.adapter.sendTurn({ threadId: "t-steer-usage", text: "build it" });
    await recorder.until((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    await instance.adapter.steer!("t-steer-usage", "more");
    await recorder.until((e) => e.type === "turn.completed");
    const usage = recorder.events.filter((e) => e.type === "thread.token-usage.updated");
    expect(usage.at(-1)).toMatchObject({ input: 20, output: 10 });
  });
});
