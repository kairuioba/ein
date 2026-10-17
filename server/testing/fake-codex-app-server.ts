#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
//   FAKE_CODEX_MODE   happy (default) | approval | resume | stream | windows-command |
//                     mcp-elicitation | question | logged-in-stdout | logged-out | unauthorized
//                     (question: asks the user to pick a price through
//                     item/tool/requestUserInput, then finishes the turn)
//   FAKE_CODEX_DUMP   path to write {argv, env, calls, decision} as JSON
//   FAKE_CODEX_STEER  opt-in mid-turn steering surface (unset = byte-identical
//                     to before). turn/start answers {turn:{id:"turn-1"}} and
//                     sends turn/started; the turn then stays open, and
//                     turn/steer is checked the way the real app-server checks
//                     it (-32600 "no active turn to steer" / "expected active
//                     turn id …"). Values:
//                       hold — the turn finishes right after the first steer
//                       gate — the turn finishes once FAKE_CODEX_GATE_FILE
//                              exists; every steer before that is folded in
//                       ended — the codex turn ends at once but turn/completed
//                              lags 400ms: a steer in that gap is refused
//                              ("no active turn to steer")
//                     Either way the final agentMessage is
//                     "reply to: <turn input> + steered: <steer texts | joined>".
//   FAKE_CODEX_GATE_FILE  gate mode only: the file whose existence ends the turn
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CODEX_MODE ?? "happy";
const steerMode = process.env.FAKE_CODEX_STEER ?? "";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.147.0\n");
  process.exit(0);
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  // Codex 0.147.0 reports a successful login on stderr; retain a mode for
  // older versions that wrote the same status on stdout.
  const statusStream = mode === "logged-in-stdout" ? process.stdout : process.stderr;
  statusStream.write("Logged in using ChatGPT\n");
  process.exit(0);
}
const calls: Array<{ method: string; params: unknown }> = [];
let decision: unknown = null;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method: string, params: unknown) => out({ jsonrpc: "2.0", method, params });

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileSync(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ argv: process.argv.slice(2), env: process.env, calls, decision }, null, 2),
    );
  }
};

const finishTurn = () => {
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
  notify("item/completed", { item: { id: "w1", type: "webSearch", status: "completed" } });
  if (mode === "stream") {
    // token deltas, then the whole message — the driver must not double-emit
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 } } });
  dump();
  notify("turn/completed", { turn: { status: "completed" } });
};

// ── FAKE_CODEX_STEER: an in-flight turn that takes turn/steer ────────────
const STEER_TURN_ID = "turn-1";
let steerTurnActive = false;
let steerTurnInput = "";
let steerTurnThread = "";
const steerTexts: string[] = [];
const finishSteerTurn = () => {
  if (!steerTurnActive) return;
  steerTurnActive = false;
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
  notify("item/completed", {
    item: { id: "m1", type: "agentMessage", text: `reply to: ${steerTurnInput} + steered: ${steerTexts.join(" | ")}` },
  });
  dump();
  notify("turn/completed", { turn: { id: STEER_TURN_ID, status: "completed" } });
};
const startSteerTurn = (msg: any) => {
  steerTurnActive = true;
  steerTurnInput = String(msg.params?.input?.[0]?.text ?? "");
  steerTurnThread = String(msg.params?.threadId ?? "");
  out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: STEER_TURN_ID, status: "inProgress", items: [], error: null } } });
  notify("turn/started", { turn: { id: STEER_TURN_ID, status: "inProgress", items: [], error: null } });
  notify("item/started", { item: { id: "i1", type: "commandExecution", command: "make build" } });
  if (steerMode === "ended") {
    steerTurnActive = false;
    setTimeout(() => {
      steerTurnActive = true;
      finishSteerTurn();
    }, 400);
    return;
  }
  if (steerMode === "gate") {
    const gate = process.env.FAKE_CODEX_GATE_FILE ?? "";
    const poll = setInterval(() => {
      if (!gate || !existsSync(gate)) return;
      clearInterval(poll);
      finishSteerTurn();
    }, 50);
  }
};
const answerSteer = (msg: any) => {
  const params = msg.params ?? {};
  if (!steerTurnActive) {
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "no active turn to steer" } });
    return;
  }
  if (params.expectedTurnId !== STEER_TURN_ID) {
    out({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32600, message: `expected active turn id \`${params.expectedTurnId}\` but found \`${STEER_TURN_ID}\`` },
    });
    return;
  }
  const text = Array.isArray(params.input) ? params.input.map((item: any) => item?.text ?? "").join("") : "";
  if (params.threadId !== steerTurnThread) {
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `thread not found: ${params.threadId}` } });
    return;
  }
  if (!text) {
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "input must not be empty" } });
    return;
  }
  steerTexts.push(text);
  out({ jsonrpc: "2.0", id: msg.id, result: { turnId: STEER_TURN_ID } });
  if (steerMode === "hold") setTimeout(finishSteerTurn, 20);
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
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

    // response to our own server->client request (approval decision)
    if ((msg.id === 100 || msg.id === 101) && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      finishTurn();
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });

    if (steerMode && msg.method === "turn/steer") {
      answerSteer(msg);
      continue;
    }
    if (steerMode && msg.method === "turn/start" && mode !== "unauthorized" && !process.env.FAKE_CODEX_TRANSIENTS) {
      startSteerTurn(msg);
      continue;
    }

    switch (msg.method) {
      case "initialize":
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "model/list":
        if (msg.params?.cursor === "page-2") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
                { id: "gpt-page-two", displayName: "GPT Page Two", hidden: false, isDefault: false },
              ],
              nextCursor: null,
            },
          });
        } else {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-fake-default", displayName: "GPT Fake Default", hidden: false, isDefault: true },
              ],
              nextCursor: "page-2",
            },
          });
        }
        break;
      case "thread/resume":
        if (mode === "resume") {
          out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such thread" } });
        }
        break;
      case "thread/start":
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        break;
      case "turn/start": {
        if (mode === "unauthorized") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            },
          });
          break;
        }
        // transient-failure script for retry tests. FAKE_CODEX_TRANSIENTS is
        // how many launches fail transiently; the launch count lives in a
        // state FILE because child processes cannot mutate the parent's env.
        // FAKE_CODEX_PARTIAL_FAILS makes the FIRST failing turn stream a text
        // delta first, so the partial-output guard has something to see.
        if (process.env.FAKE_CODEX_TRANSIENTS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const quota = Number(process.env.FAKE_CODEX_TRANSIENTS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < quota) {
            if (process.env.FAKE_CODEX_PARTIAL_FAILS) {
              out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
              notify("item/agentMessage/delta", { itemId: "m1", delta: "half an answer" });
              notify("turn/completed", { turn: { status: "failed", error: { message: "provider overloaded, try again" } } });
              break;
            }
            out({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" },
            });
            break;
          }
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        const command = mode === "windows-command"
          ? [
              "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
              "-Command",
              `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
            ].join(" ")
          : "ls -la";
        notify("item/started", { item: { id: "i1", type: "commandExecution", command } });
        notify("item/started", { item: { id: "w1", type: "webSearch", query: "OpenMausBot" } });
        if (mode === "mcp-elicitation") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
              message: 'Allow the agents MCP server to run tool "list_bots"?',
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "question") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "item/tool/requestUserInput",
            params: {
              questions: [{ id: "price", header: "Price", question: "Flagship price: 699 or 799?", options: [{ label: "699" }, { label: "799" }] }],
            },
          });
          // turn continues from the response handler above
        } else if (mode === "approval" || mode === "windows-command") {
          const approvalCommand = mode === "windows-command" ? command : "rm -rf scratch";
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: approvalCommand } });
          // turn continues from the approval response handler above
        } else {
          finishTurn();
        }
        break;
      }
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// match the real app-server: stay alive until killed
setInterval(() => {}, 1_000);
