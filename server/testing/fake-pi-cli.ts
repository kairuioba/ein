#!/usr/bin/env node
// Fake of the pi coding agent's `--mode rpc --no-session` stdio surface, for
// driver contract tests of server/drivers/pi.ts. Speaks pi's JSON-RPC-over-
// stdio protocol: answers get_available_models / new_session / switch_session
// / set_model, and streams a scripted turn in response to `prompt`. Failure
// modes mirror how the real CLI misbehaves:
//
//   FAKE_PI_MODE   happy (default) | tooluse | permission | interleave | steer | turn-error | no-models | exit-early
//   FAKE_PI_MODELS comma-separated provider/model pairs (default "ollama-cloud/glm-5.2,openai/gpt-4o")
//   FAKE_PI_DUMP   path to append {argv, env} JSON, so a test can assert argv shape
//                  and env hygiene (no leaked secrets into the pi child).
//   FAKE_PI_STEER_DUMP path to append {prompt} / {steer} lines, so a test can
//                  assert where an early steer was folded and that a live steer
//                  reached pi's own `steer` command.

import { appendFileSync, readFileSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "happy";
const modelPairs = (process.env.FAKE_PI_MODELS ?? "ollama-cloud/glm-5.2,openai/gpt-4o")
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const [provider, id] = pair.split("/");
    return { provider: provider ?? "x", id: id ?? "m", name: id ?? "m" };
  });

const argv = process.argv.slice(2);

// The driver probes `<cli> --version` for snapshot(); answer and exit clean.
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("pi 0.84.2 (fake)\n");
  process.exit(0);
}

if (process.env.FAKE_PI_DUMP) {
  try {
    // When the driver mounts integrations it hands the MCP config through
    // OMB_MCP_CONFIG; read it here so a test can assert the mount contract
    // (servers, proxy wrap, credential hygiene) without racing the temp file
    // cleanup the driver runs at turn settle.
    let mcpConfig: unknown = null;
    if (process.env.OMB_MCP_CONFIG) {
      try {
        mcpConfig = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8"));
      } catch {
        /* unreadable config dumps as null */
      }
    }
    appendFileSync(
      process.env.FAKE_PI_DUMP,
      JSON.stringify({
        argv,
        envConfigured: ["PATH", "HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "BOX_TOKEN"].filter(
          (k) => process.env[k] !== undefined,
        ),
        mcpConfig,
      }) + "\n",
    );
  } catch {
    /* never let dumping break a run */
  }
}

// exit-early: die before saying anything — a failed spawn surfaces as a
// runtime.error + failed turn, never a hang.
if (mode === "exit-early") {
  process.exit(1);
}

const send = (obj: any) => process.stdout.write(JSON.stringify(obj) + "\n");
const steerDump = (row: Record<string, unknown>) => {
  if (!process.env.FAKE_PI_STEER_DUMP) return;
  try {
    appendFileSync(process.env.FAKE_PI_STEER_DUMP, JSON.stringify(row) + "\n");
  } catch {
    /* never let dumping break a run */
  }
};
let sessionCounter = 0;
let currentSessionFile: string | null = null;

// A faithful happy turn: a couple of text deltas then a terminal turn_end.
const streamTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const delta of ["Hello", " from", " pi"]) {
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

const streamErrorTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "turn_end",
    message: {
      stopReason: "error",
      errorMessage: "Invalid schema for function 'computer_browser_prepare'",
      usage: { input: 0, output: 0 },
    },
    usage: { input: 0, output: 0 },
  });
  send({ type: "agent_end" });
};

// tooluse: one tool turn (stopReason toolUse, pi auto-continues) then a text
// turn — exactly the sequence that broke the settle-on-toolUse bug.
const streamToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
  // pi auto-continues within the same prompt to synthesize the reply
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 2 } }, usage: { input: 12, output: 2 } });
  send({ type: "agent_end" });
};

// permission: open a select ask, hold the turn until extension_ui_response
// arrives, then stream the reply.
const streamPermissionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Run bash: echo hi?", options: ["Allow once", "Deny"] });
  // wait for the answer before finishing
};

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
const streamInterleaveTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before one" } });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo one" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before two" } });
  send({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "echo two" } });
  send({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

// steer: a tool turn runs, then the turn HOLDS after the tool batch — exactly
// where pi delivers a steer — until the driver sends pi's `steer` command. The
// continuation is part of the SAME turn: the next model call produces the
// reply, so no new prompt is sent.
const streamSteerTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  // pi auto-continues after a tool batch; the turn stays open for a steer
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
};

const finishSteerTurn = (steered: string) => {
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `working + steered: ${steered}` } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

const finishPermissionTurn = () => {
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 8, output: 1 } }, usage: { input: 8, output: 1 } });
  send({ type: "agent_end" });
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd: any) {
  switch (cmd.type) {
    case "get_available_models":
      send({
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: mode === "no-models" ? [] : modelPairs },
      });
      return;
    case "new_session":
      sessionCounter += 1;
      currentSessionFile = `/fake/pi-session-${sessionCounter}.json`;
      send({ type: "response", command: "new_session", success: true, data: { sessionId: `s-${sessionCounter}`, sessionFile: currentSessionFile } });
      return;
    case "switch_session":
      currentSessionFile = cmd.sessionPath ?? currentSessionFile;
      send({ type: "response", command: "switch_session", success: true, data: { sessionId: "s-resumed", sessionFile: currentSessionFile } });
      return;
    case "set_model": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ setModel: { provider: cmd.provider, modelId: cmd.modelId } }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      send({ type: "response", command: "set_model", success: true, data: { id: cmd.modelId, provider: cmd.provider } });
      return;
    }
    case "set_thinking_level":
      // record the level so a test can assert what the driver pinned
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ thinkingLevel: cmd.level }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      send({ type: "response", command: "set_thinking_level", success: true });
      return;
    case "prompt":
      steerDump({ prompt: cmd.message });
      // acknowledge acceptance; the completion comes via events
      send({ type: "response", command: "prompt", success: true });
      if (mode === "steer") streamSteerTurn();
      else if (mode === "tooluse") streamToolTurn();
      else if (mode === "permission") streamPermissionTurn();
      else if (mode === "interleave") streamInterleaveTurn();
      else if (mode === "turn-error") streamErrorTurn();
      else streamTurn();
      return;
    case "steer":
      steerDump({ steer: cmd.message });
      // pi answers the command; then the message reaches the model inside the
      // still-running turn
      send({ type: "response", command: "steer", success: true });
      if (mode === "steer" && typeof cmd.message === "string") {
        // A real pi does not end the turn in the same tick as the ack: it
        // still has a model call to run. Leaving a little room here lets the
        // harness record the accepted steer while the turn is still open
        // (ending it synchronously made the server-side ownership re-check
        // race on slower CI hosts and answer 409).
        setTimeout(() => finishSteerTurn(cmd.message as string), 120);
      }
      return;
    case "extension_ui_response":
      if (cmd.id === "ask-1") finishPermissionTurn();
      return;
    case "abort":
      send({ type: "turn_end", message: { stopReason: "cancelled", usage: { input: 0, output: 0 } }, usage: { input: 0, output: 0 } });
      return;
    default:
      return;
  }
}