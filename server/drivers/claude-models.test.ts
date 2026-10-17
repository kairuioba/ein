// Asking the installed `claude` for its model menu. The fake CLI answers the
// initialize control request the way Claude Code 2.1.302 does.
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import { ClaudeDriver } from "./claude.ts";
import {
  CLAUDE_PROBE_ARGS,
  claudeLiveModels,
  claudeProbeFingerprint,
  probeClaudeModels,
  resetClaudeModelState,
} from "./claude-models.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

async function until<T>(read: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("probeClaudeModels", () => {
  let scratch: string;
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-models-"));
    resetClaudeModelState();
  });
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_MODELS;
    delete process.env.FAKE_CLAUDE_PROBE_LOG;
    delete process.env.EIN_CLAUDE_MODEL_PROBE;
    resetClaudeModelState();
  });

  it("reads the menu without sending a prompt, persisting a session, or running hooks and MCP servers", async () => {
    const log = join(scratch, "probe.log");
    process.env.FAKE_CLAUDE_PROBE_LOG = log;
    const probe = await probeClaudeModels(FAKE_CLI, { ...process.env });
    expect(probe?.models.map((row) => row.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(probe?.sonnet).toBe("claude-sonnet-5-5");
    const { argv } = JSON.parse(readFileSync(log, "utf8").trim());
    expect(argv).toEqual(CLAUDE_PROBE_ARGS);
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
  });

  it("gives up cleanly on a CLI too old to list models, and on a missing binary", async () => {
    process.env.FAKE_CLAUDE_MODELS = "none";
    expect(await probeClaudeModels(FAKE_CLI, { ...process.env })).toBeNull();
    expect(await probeClaudeModels(join(scratch, "no-such-claude"), { ...process.env }, 2_000)).toBeNull();
  });

  it("answers from memory and disk, probing in the background", async () => {
    const env = { ...process.env };
    expect(claudeLiveModels(FAKE_CLI, env)).toBeNull(); // first call only starts the probe
    const live = await until(() => claudeLiveModels(FAKE_CLI, env));
    expect(live.models[0]).toEqual({ id: "claude-opus-5-5", label: "Claude Opus 5.5" });
    const cache = JSON.parse(readFileSync(join(DATA_DIR, "claude-models.json"), "utf8"));
    expect(cache.entries[0].fingerprint).toBe(claudeProbeFingerprint(FAKE_CLI, env));

    // a new process reads the disk cache before any probe answers
    resetClaudeModelState();
    expect(claudeLiveModels(FAKE_CLI, env)?.models[0]?.id).toBe("claude-opus-5-5");
  });

  it("puts the CLI's menu in the instance's picker once the probe lands", async () => {
    process.env.EIN_CLAUDE_MODEL_PROBE = "1";
    process.env.FAKE_CLAUDE_MODELS = JSON.stringify([
      { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6" },
      { value: "sonnet", resolvedModel: "claude-sonnet-6", displayName: "Sonnet 6" },
    ]);
    const instance = await ClaudeDriver.create({
      instanceId: "claude-live",
      displayName: "Claude",
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    try {
      // a model this code has never heard of shows up, and Sonnet stays the default
      await until(() => instance.models.options.some((option) => option.id === "claude-opus-6"));
      expect(instance.models.default).toBe("claude-sonnet-6");
      expect(instance.models.options[0]).toEqual({ id: "claude-opus-6", label: "Claude Opus 6" });
      // older ids saved bots hold stay listed
      expect(instance.models.options.some((option) => option.id === "claude-sonnet-5")).toBe(true);
      expect(existsSync(join(scratch, ".claude", "projects"))).toBe(false);
    } finally {
      await instance.dispose();
    }
  });
});
