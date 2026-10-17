#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_MODE   happy (default) | empty-reply | exit-early | fail-after-text | hang | no-auth | auth-required | permission
//                   | interleave (message → tool → message → tool → message)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                   | chief-delegate (delegates only for an ASSIGN_TO_PEER
//                     prompt; ordinary follow-ups stay responsive)
//                   | chief-plan (a Chief answers a DISPATCH_PLAN prompt by
//                     calling submit_plan with a two-step plan; every other
//                     prompt, including workers' briefs and the dispatcher's
//                     synthesis request, gets a short scripted reply that
//                     echoes the prompt's first line)
//                   | create-peer (a Chief creates a specialist, then delegates
//                     work to it through the returned id)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//   FAKE_ACP_PLAN   chief-plan only: a JSON array of subtasks to submit
//                   instead of the built-in two-step plan
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_MODELS      comma-separated model ids. Enables the opencode-shaped
//                        surface: session/new and session/load return
//                        configOptions, and session/set_config_option switches
//                        the model (rejecting an unadvertised one with -32602).
//   FAKE_ACP_MODEL_STICKS  session/set_config_option succeeds but leaves the
//                        model where it was, so the confirmation guard in
//                        core.ts has something to catch
//   FAKE_ACP_USAGE_ROOT  put the prompt result's usage at the root instead of
//                        under _meta (what opencode 1.18.18 actually does)
//   FAKE_ACP_STREAM      UI work: milliseconds between chunks. The happy turn's
//                        and chief-plan's plain reply text grows a long
//                        multi-paragraph markdown answer (lists, a table, a
//                        code block) sent as many small agent_message_chunk
//                        notifications, like a real model streaming.
//                        FAKE_ACP_STREAM_CHUNK sets the chunk size in
//                        characters (default 4). Unset, every mode is byte-
//                        identical to before.
//   FAKE_ACP_STEER       opt-in mid-turn steering scenarios (unset = byte-
//                        identical to before). The FIRST session/prompt plays
//                        "working" text and a tool call (tc-long, in_progress for
//                        FAKE_ACP_TOOL_MS, default 300) and then keeps thinking
//                        until something ends it; every LATER prompt answers
//                        "echo: <prompt text>" with end_turn at once.
//                          boundary — session/cancel ends the prompt with
//                                     stopReason "cancelled" (a running tool is
//                                     reported failed first, the way a real
//                                     agent aborts it)
//                          ignore-cancel — cancel is ignored; the prompt ends
//                                     on its own FAKE_ACP_FINISH_MS (default 500)
//                                     after the tool
//                          error-on-cancel — cancel fails the prompt with a
//                                     JSON-RPC error instead of "cancelled"
//                          native — initialize advertises _meta.steering.supported
//                                     and _session/steering injects into the
//                                     running prompt, which then ends with
//                                     "reply to: <first prompt> + steered: <texts>"
//                          native-idle — advertised, but every steer answers
//                                     promptRequired (the agent's prompt just ended)
//                        FAKE_ACP_GATE_FILE ends a thinking first prompt with
//                        end_turn once it exists. FAKE_ACP_STEER_PERMISSION asks
//                        a permission for tc-long before it runs. Every method
//                        is recorded in FAKE_ACP_RPC_DUMP; a session/cancel that
//                        lands while a tool runs is also recorded as
//                        "session/cancel:during-tool". FAKE_ACP_PROMPTS_DUMP
//                        records every prompt text and _session/steering call.
//   FAKE_ACP_LOAD_MS     delay the session/load answer (a slow history replay)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
// opencode-shaped surface: the session carries its own model catalog and the
// model is chosen with session/set_config_option, because `opencode acp` takes
// no -m. Off unless FAKE_ACP_MODELS is set, so every existing mode is byte-
// identical to before.
const models = (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean);
let currentModel: string | null = models[0] ?? null;
const configOptions = () =>
  models.length
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
      ]
    : null;
// cursor-shaped surface: the session advertises `models.availableModels` with
// parameterised ids (`default[]`) that differ from the argv `--model` slugs
// (`auto`). Off unless FAKE_ACP_SESSION_MODELS is set, so every existing mode
// stays byte-identical. Format: "id|Name,id|Name" — the name is optional.
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [modelId, name] = entry.split("|");
    return name ? { modelId, name } : { modelId };
  });
const sessionModels = () =>
  acpModels.length ? { currentModelId: acpModels[0].modelId, availableModels: acpModels } : null;

const argv = process.argv.slice(2);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "TEST_POLICY",
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "BOX_TOKEN",
    "OMB_TTS_KEY",
    "FACTORY_API_KEY",
    "UNSLOTH_STUDIO_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
const dumpState: Record<string, unknown> = { argv, env: dumpEnv };
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: dumpEnv }, null, 2));
}
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
// Cursor's driver probes `agent status` / `agent models` on the same binary
// it later spawns for ACP. Answer those without entering the JSON-RPC loop
// so catalog/auth tests do not hang on stdin.
if (argv[0] === "status" || argv[0] === "whoami") {
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  console.log(JSON.stringify({ isAuthenticated: authenticated }));
  process.exit(0);
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  if (models.length) {
    const verbose = argv.includes("--verbose");
    console.log(
      models.flatMap((slug) => verbose
        ? [
            slug,
            JSON.stringify({
              id: slug.slice(slug.indexOf("/") + 1),
              providerID: slug.slice(0, slug.indexOf("/")),
              name: slug,
              status: "active",
              limit: { context: 200_000 },
            }, null, 2),
          ]
        : [slug]).join("\n"),
    );
    process.exit(0);
  }
  console.log(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "gpt-5.3-codex - Codex 5.3",
      "cursor-live - Cursor Live",
    ].join("\n"),
  );
  process.exit(0);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
};

// session/set_mode + session/set_model calls seen this run
const configCalls: Array<{ method: string; params: unknown }> = [];

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: (() => void) | null = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

// FAKE_ACP_STREAM: a slow, realistic answer for chat-window work. Off (NaN)
// unless the variable is set, which keeps every scripted mode unchanged.
const streamDelayMs = Number(process.env.FAKE_ACP_STREAM ?? "");
const streaming = Number.isFinite(streamDelayMs) && streamDelayMs >= 0 && process.env.FAKE_ACP_STREAM !== undefined;
const STREAM_REPLY = [
  "## 发布会准备进度",
  "",
  "我把手上的事情过了一遍，下面是目前的状态和接下来要做的事。整体节奏没有问题，但有两处需要你拍板，我放在最后。",
  "",
  "### 已经完成",
  "",
  "1. **竞品价格表**：五家竞品的旗舰款价格、上新节奏和渠道折扣都整理好了，放在资料库的「市场部 / 竞品」目录下。",
  "2. **主视觉初稿**：设计部交了两版 KV，一版偏科技感，一版偏生活方式，配色都按品牌规范走。",
  "3. **落地页框架**：前端把首屏、卖点区和预约表单搭起来了，移动端也适配过一轮。",
  "",
  "### 正在进行",
  "",
  "- 新闻稿写手在改第二稿，重点补充了续航和售后政策，预计今晚交。",
  "- 社媒写手准备了小红书和微博各三条预热文案，等主视觉定稿后配图。",
  "- 测试在跑落地页的表单提交和埋点，目前发现一个预约按钮在窄屏下被遮挡的问题，已经派给前端 3。",
  "",
  "| 事项 | 负责人 | 状态 | 截止 |",
  "| --- | --- | --- | --- |",
  "| 新闻稿第二稿 | 新闻稿写手 | 进行中 | 今晚 22:00 |",
  "| 预热文案配图 | 设计师 | 等主视觉 | 周三 |",
  "| 落地页上线 | 阿杰 | 测试中 | 周四 |",
  "| 嘉宾合同 | 合同审查 | 待审 | 周四 |",
  "",
  "落地页预约接口的调用方式如下，前端和测试都按这个对齐：",
  "",
  "```ts",
  "const res = await fetch(\"/api/reserve\", {",
  "  method: \"POST\",",
  "  headers: { \"content-type\": \"application/json\" },",
  "  body: JSON.stringify({ phone, sku: \"flagship-2026\", channel }),",
  "});",
  "if (!res.ok) throw new Error(`reserve failed: ${res.status}`);",
  "```",
  "",
  "### 需要你决定",
  "",
  "第一，旗舰款定价是 699 还是 799。市场分析师的建议是 799，理由是竞品均价在 780 左右，而且我们的续航优势明显；但小文担心 799 会影响首发转化。第二，发布会当天是否开放直播回放，这会影响合规官对嘉宾合同的审查口径。",
  "",
  "最后一句：以上就是完整的进度，两件事你定了之后我马上安排下去。",
].join("\n");

/** FAKE_ACP_STREAM: `text` as many small chunks, `streamDelayMs` apart. */
function streamText(text: string, done: () => void) {
  const size = Math.max(1, Number(process.env.FAKE_ACP_STREAM_CHUNK) || 4);
  let at = 0;
  const tick = () => {
    if (at >= text.length) return done();
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: text.slice(at, at + size) } } } });
    at += size;
    setTimeout(tick, streamDelayMs);
  };
  tick();
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
}

// ── FAKE_ACP_STEER: a turn that can be steered ─────────────────────────────
const steerMode = process.env.FAKE_ACP_STEER ?? "";
const steerLog: { prompts: string[]; steers: unknown[] } = { prompts: [], steers: [] };
const writeSteerLog = () => {
  if (process.env.FAKE_ACP_PROMPTS_DUMP) writeFileSync(process.env.FAKE_ACP_PROMPTS_DUMP, JSON.stringify(steerLog));
};
const chunk = (text: string) =>
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
const toolUpdate = (status: string) =>
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-long", status } } });
let steerPrompt: {
  id: unknown;
  first: string;
  toolRunning: boolean;
  finish: (stopReason: string) => void;
  fail: (message: string) => void;
} | null = null;
const injected: string[] = [];

function startSteerPrompt(msg: any) {
  const text = String(msg.params?.prompt?.[0]?.text ?? "");
  steerLog.prompts.push(text);
  writeSteerLog();
  let done = false;
  const prompt = {
    id: msg.id,
    first: text,
    toolRunning: false,
    finish: (stopReason: string) => {
      if (done) return;
      done = true;
      if (steerPrompt === prompt) steerPrompt = null;
      recordMethod(`session/prompt.${stopReason}`);
      result(msg.id, { stopReason, _meta: { inputTokens: 10, outputTokens: 5 } });
    },
    fail: (message: string) => {
      if (done) return;
      done = true;
      if (steerPrompt === prompt) steerPrompt = null;
      recordMethod("session/prompt.error");
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32800, message } });
    },
  };
  steerPrompt = prompt;
  if (steerLog.prompts.length > 1) {
    // a follow-up: answer it straight away
    chunk(`echo: ${text}`);
    prompt.finish("end_turn");
    return;
  }
  chunk("working");
  const runTool = (announced = false) => {
    if (done) return;
    prompt.toolRunning = true;
    // a tool announced as pending (before its permission card) moves on
    // with an update, the way real agents report it
    if (announced) toolUpdate("in_progress");
    else out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-long", title: "make build", status: "in_progress" } } });
    setTimeout(() => {
      if (done) return;
      prompt.toolRunning = false;
      toolUpdate("completed");
      // now "thinking" until a cancel, an injected steer, or the gate
      if (steerMode === "ignore-cancel") {
        setTimeout(() => {
          chunk("finished on my own");
          prompt.finish("end_turn");
        }, Number(process.env.FAKE_ACP_FINISH_MS ?? "500"));
      }
      const gate = process.env.FAKE_ACP_GATE_FILE;
      if (gate) {
        const poll = setInterval(() => {
          if (done) return clearInterval(poll);
          if (!existsSync(gate)) return;
          clearInterval(poll);
          chunk("finished at the gate");
          prompt.finish("end_turn");
        }, 50);
      }
    }, Number(process.env.FAKE_ACP_TOOL_MS ?? "300"));
  };
  if (process.env.FAKE_ACP_STEER_PERMISSION) {
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-long", title: "make build", status: "pending" } } });
    pendingPermissionId = 9002;
    onPermissionAnswered = () => runTool(true);
    out({
      jsonrpc: "2.0",
      id: pendingPermissionId,
      method: "session/request_permission",
      params: {
        toolCall: { toolCallId: "tc-long", kind: "execute", rawInput: { command: "make build" }, title: "make build" },
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  runTool();
}

function cancelSteerPrompt() {
  const prompt = steerPrompt;
  // handle() already recorded "session/cancel"; flag one that hit a tool
  if (prompt?.toolRunning) recordMethod("session/cancel:during-tool");
  if (!prompt || steerMode === "ignore-cancel") return;
  if (prompt.toolRunning) {
    prompt.toolRunning = false;
    toolUpdate("failed");
  }
  if (steerMode === "error-on-cancel") prompt.fail("request cancelled");
  else prompt.finish("cancelled");
}

function answerSteering(msg: any) {
  const params = msg.params ?? {};
  steerLog.steers.push(params);
  writeSteerLog();
  const text = Array.isArray(params.prompt) ? params.prompt.map((block: any) => block?.text ?? "").join("") : "";
  if (typeof params.sessionId !== "string" || !text) {
    return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "steer params require a sessionId and a non-empty prompt array" } });
  }
  const prompt = steerPrompt;
  if (steerMode === "native-idle" || !prompt) {
    return result(msg.id, { outcome: "promptRequired", reason: "noRunningTurn" });
  }
  injected.push(text);
  result(msg.id, { outcome: "injected" });
  // the model takes it before its next step, then wraps up
  setTimeout(() => {
    chunk(`reply to: ${prompt.first} + steered: ${injected.join(" | ")}`);
    prompt.finish("end_turn");
  }, 30);
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    onPermissionAnswered?.();
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);

  if (steerMode) {
    if (msg.method === "session/prompt") return startSteerPrompt(msg);
    if (msg.method === "session/cancel") return cancelSteerPrompt();
    if (msg.method === "_session/steering" && steerMode.startsWith("native")) return answerSteering(msg);
  }

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: "cached_token" }];
      result(msg.id, {
        protocolVersion: 1,
        authMethods,
        _meta: {
          modelState: { currentModelId: "fake-acp-model" },
          ...(steerMode.startsWith("native") ? { steering: { supported: true } } : {}),
        },
      });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new": {
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.mcpServers = servers;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      result(msg.id, {
        sessionId: "fake-acp-session",
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      });
      break;
    }
    case "session/load": {
      // a resumed session gets its MCP servers again, like a new one
      const loaded: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = loaded.find((s: any) => s?.name === "agents") ?? agentsMcp;
      const opts = configOptions();
      const mdls = sessionModels();
      const loadedResult = { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) };
      const loadDelay = Number(process.env.FAKE_ACP_LOAD_MS ?? "0");
      if (loadDelay > 0) setTimeout(() => result(msg.id, loadedResult), loadDelay);
      else result(msg.id, loadedResult);
      break;
    }
    // per-session settings (droid sets model/autonomy here, not via argv).
    // Recorded next to FAKE_ACP_DUMP so a test can assert what was applied.
    // NOTE: last writer wins — each turn spawns a fresh child, so a two-turn
    // test would only ever see the final turn's calls.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        // an older agent that predates these methods
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (mode === "set-model-invalid-params" && msg.method === "session/set_model") {
        // an agent whose ACP model namespace does not contain the id it was
        // sent — Cursor's answer when handed an argv slug like `auto`.
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (typeof msg.params?.sessionId !== "string" || typeof msg.params?.[settingId] !== "string") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      // FAKE_ACP_MODEL_STICKS: answer OK and keep the old model anyway. Nothing
      // in the protocol forbids it, and it is the shape core.ts's confirmation
      // guard exists for — an error is loud, this is silent.
      if (!process.env.FAKE_ACP_MODEL_STICKS) currentModel = value;
      result(msg.id, { configOptions: configOptions() });
      break;
    }
    case "session/prompt": {
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "fail-after-text") {
        // Stream real text, THEN fail the turn — the shape of a crash
        // mid-answer. This is the one case where the routine-failed/done
        // notification dedup is load-bearing: the reply is non-empty, so
        // nothing else suppresses the generic done.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        recordMethod("session/prompt.result");
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      if (mode === "chief-delegate" && promptText.includes("CHIEF_RESULT_CONTEXT")) {
        const sawDelegatedResult =
          promptText.includes("@LongWorker replied to the delegated task")
          && promptText.includes("long delegated task");
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: sawDelegatedResult
                  ? "chief saw delegated result: long delegated task"
                  : "chief did not see delegated result",
              },
            },
          },
        });
        complete();
        return;
      }
      if (
        mode === "chief-delegate"
        && agentsMcp
        && promptText.includes("ASSIGN_TO_PEER")
        && !promptText.includes("CHIEF_FOLLOW_UP")
      ) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "long delegated task",
              reason: "background assignment",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `assigned: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "chief-plan") {
        const firstLine = promptText.split("\n").find((line) => line.trim() && !line.startsWith("You are")) ?? "";
        if (agentsMcp && promptText.includes("DISPATCH_PLAN")) {
          void driveMcp(agentsMcp, [
            {
              name: "submit_plan",
              args: () => ({
                goal: "Prepare the launch kit",
                subtasks: process.env.FAKE_ACP_PLAN
                  ? JSON.parse(process.env.FAKE_ACP_PLAN)
                  : [
                      { id: "research", title: "Competitor research", brief: "List three competitor prices.", role: "Market analyst", needs: ["reasoning"], difficulty: 2 },
                      { id: "copy", title: "Launch copy", brief: "Write the launch post from the research.", role: "Copywriter", needs: ["writing"], difficulty: 2, depends_on: ["research"] },
                    ],
              }),
            },
          ])
            .then((reply) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `plan submitted: ${reply}` } } } });
              complete();
            })
            .catch((e) => {
              const message = e instanceof Error ? e.message : String(e);
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `plan error: ${message}` } } } });
              complete();
            });
          return;
        }
        const reply = promptText.includes("[Ein dispatch finished]")
          ? `SYNTHESIS: ${promptText.includes("RESULT:Competitor research") && promptText.includes("RESULT:Launch copy") ? "both results present" : "missing results"}`
          : `RESULT:${/Your subtask: (.+)/.exec(promptText)?.[1] ?? firstLine.slice(0, 60)}`;
        if (streaming) {
          streamText(`${reply}\n\n${STREAM_REPLY}`, complete);
          return;
        }
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: reply } } } });
        complete();
        return;
      }
      if (mode === "create-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          {
            name: "create_bot",
            args: () => ({
              name: "Pixel",
              role: "Product designer",
              instructions: "Design and review the user experience.",
            }),
          },
          {
            name: "delegate_bot",
            args: (created) => ({
              bot_id: /id: ([\w-]+)/.exec(created)?.[1] ?? "",
              message: "Review the new onboarding flow.",
              reason: "design review",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `team created: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated") {
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        // async peer-handoff e2e: queue the delegation and return
        // immediately; the harness fires the peer's depth-1 turn after our
        // turn settles. We don't need the peer's reply in our text — the
        // comms e2e verifies the channel mirroring on its own.
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "delegated task",
              reason: "followup",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (streaming && mode === "happy") {
        streamText(STREAM_REPLY, complete);
        return;
      }
      if (mode === "interleave") playInterleaveTurn();
      else if (mode !== "empty-reply") playTurn();
      if (mode === "permission") {
        // ask the client to approve a tool, then complete once answered.
        // FAKE_ACP_PERMISSION_COMMAND swaps the command asked about (the
        // company-layer e2e asks to publish outside).
        const command = process.env.FAKE_ACP_PERMISSION_COMMAND || "echo hi";
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: { kind: "execute", rawInput: { command }, title: command },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      // the interrupted prompt resolves as cancelled
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
