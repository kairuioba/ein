// Exercise the HTTP paths used by first-run onboarding and New bot.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const model = "deepseek-v4.1-flash";
let child: ChildProcess | undefined;
let home: string;
let base: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ein-workbuddy-onboarding-"));
  const data = join(home, ".ein");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      workbuddy: {
        driver: "workbuddyAgent",
        config: { cli: join(serverDir, "testing", "fake-acp-cli.ts"), fullAuto: false },
        environment: { FAKE_ACP_SESSION_MODELS: "hy4-preview,deepseek-v4.1-flash,glm-5.3" },
      },
    },
  }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([{
    id: "legacy-bot", threadId: "legacy-thread", name: "Legacy", title: "", description: "",
    notifications: true, color: "blue", unread: false, createdAt: 1, resumeCursors: {},
    modelSelection: { instanceId: "workbuddy", model: "default" },
  }]));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(serverDir, "index.ts")], {
    cwd: join(serverDir, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_LOCALE: "zh-CN",
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child?.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // The isolated server is still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("WorkBuddy onboarding and New bot", () => {
  it("offers DeepSeek first and as default without the old placeholder", async () => {
    const response = await fetch(`${base}/api/instances`);
    const { instances } = await response.json() as { instances: Array<{ instanceId: string; models: { default: string; options: Array<{ id: string; label: string }> } }> };
    const workbuddy = instances.find((instance) => instance.instanceId === "workbuddy")!;
    expect(workbuddy.models.default).toBe(model);
    expect(workbuddy.models.options[0].id).toBe(model);
    expect(workbuddy.models.options.some((option) => option.id === "default")).toBe(false);
  });

  it.each([
    { path: "New bot", body: {} },
    { path: "first-run engine selection", body: { modelSelection: { instanceId: "workbuddy", model } } },
    { path: "cached old default selection", body: { modelSelection: { instanceId: "workbuddy", model: "default" }, requireAvailableModel: true } },
  ])("creates $path with the real DeepSeek selection", async ({ body }) => {
    const response = await fetch(`${base}/api/bots`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json() as { bot?: { modelSelection: { instanceId: string; model: string } } };
    expect(response.status).toBe(201);
    expect(result.bot?.modelSelection).toEqual({ instanceId: "workbuddy", model });
  });

  it("shows existing bots with DeepSeek instead of the removed default placeholder", async () => {
    const response = await fetch(`${base}/api/bots?messages=0`);
    const { bots } = await response.json() as { bots: Array<{ id: string; modelSelection: { model: string } }> };
    expect(bots.find((bot) => bot.id === "legacy-bot")?.modelSelection.model).toBe(model);
  });
});
