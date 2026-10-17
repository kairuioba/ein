#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt, mcpConfig} as JSON,
//                      so the test can assert on argv shape and env hygiene.
//                      mcpConfig is read back from the --mcp-config file the
//                      way the real CLI reads it — the driver writes it to a
//                      private temp file and deletes it when the turn settles,
//                      so a test cannot open it after the fact.
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key | console | settings-auth-token |
//                      setup-token | helper | bedrock — what `auth status`
//                      reports (JSON, and the --text form's token line)
//   FAKE_CLAUDE_ARGV_LOG  path to APPEND one JSON line per turn: {argv,
//                      prompt} — for runs where several turns share one path
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

// Snapshot probes: both answer on argv alone and exit without reading stdin.
if (argv[0] === "--version") {
  process.stdout.write("2.1.232 (Claude Code)\n");
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  // the shapes the real CLI (2.1.302) prints for each way of being signed in
  const statuses: Record<string, { json: Record<string, unknown>; text: string }> = {
    in: { json: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }, text: "Login method: Claude Max account" },
    out: { json: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, text: "Not logged in. Run claude auth login to authenticate." },
    console: { json: { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "/login managed key" }, text: "API key: /login managed key" },
    "settings-auth-token": { json: { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, text: "Auth token: ANTHROPIC_AUTH_TOKEN" },
    "setup-token": { json: { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, text: "Auth token: CLAUDE_CODE_OAUTH_TOKEN" },
    helper: { json: { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }, text: "API key: apiKeyHelper" },
    bedrock: { json: { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, text: "API provider: AWS Bedrock" },
  };
  const status =
    auth === "inherited-api-key"
      ? process.env.ANTHROPIC_API_KEY
        ? { json: { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }, text: "API key: ANTHROPIC_API_KEY" }
        : statuses.out
      : (statuses[auth] ?? statuses.out);
  const text = argv.includes("--text");
  process.stdout.write(
    (text ? status.text : JSON.stringify(status.json)) + "\n",
    () => process.exit(status.json.loggedIn ? 0 : 1),
  );
}

// One-shot helper mode used by generateText/reviewPermission. The prompt is
// deliberately read from stdin so sensitive review text never appears in
// argv or process listings.
if (argAfter("--output-format") === "text") {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig: null }, null, 2),
    );
  }
  process.stdout.write("fake generated text\n");
  process.exit(0);
}

// Line-driven, like the real CLI under --input-format stream-json: each user
// message starts a turn; a message that arrives WHILE a turn is playing is
// folded into it (the real CLI delivers it before the next model call — the
// harness calls that a steer); the process stays alive with stdin open and
// exits only when stdin ends. `slow` leaves a gap between the tool result
// and the reply so a test can steer into it.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
const model = argAfter("--model") ?? "claude-fake";
let dumped = false;
let turnRunning = false;
let steered: string[] = [];
let stdinEnded = false;
let steerGateArmed = false;

// Ownership-race fixture: after accepting the first prompt, stop consuming
// stdin until the test creates this file. A large second write then leaves
// adapter.steer() genuinely pending while the first turn settles and another
// HTTP request deletes or switches the bot.
const armSteerGate = () => {
  const gate = process.env.FAKE_CLAUDE_STEER_GATE;
  if (!gate || steerGateArmed) return;
  steerGateArmed = true;
  process.stdin.pause();
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    process.stdin.resume();
  }, 10);
};

const promptText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  return typeof m?.content === "string" ? m.content : "";
};

const finishIfDone = () => {
  if (stdinEnded && !turnRunning) process.exit(0);
};

const playTurn = (prompt: JsonValue) => {
  turnRunning = true;
  steered = [];
  if (process.env.FAKE_CLAUDE_ARGV_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify({ argv, prompt: JSON.stringify(prompt).slice(0, 400) }) + "\n");
  }
  if (!dumped && process.env.FAKE_CLAUDE_DUMP) {
    dumped = true;
    const configPath = argAfter("--mcp-config");
    let mcpConfig: unknown = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        /* leave null — the test will see it */
      }
    }
    writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig }, null, 2));
  }

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }
  // transient-failure script for retry tests. FAKE_CLAUDE_TRANSIENTS is how
  // many launches fail transiently (503-shaped stderr, exit 5); the count of
  // launches so far lives in a state FILE because child processes cannot
  // mutate the parent's environment. When the quota is exhausted (or
  // FAKE_CLAUDE_STATE is unset) the turn completes normally.
  // FAKE_CLAUDE_PARTIAL_FAILS makes the FIRST launch emit a text delta
  // before failing — the partial-output guard must forbid retrying it.
  if (process.env.FAKE_CLAUDE_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
    let launched = 0;
    try {
      launched = Number(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) || 0;
    } catch {}
    const quota = Number(process.env.FAKE_CLAUDE_TRANSIENTS) || 0;
    writeFileSync(process.env.FAKE_CLAUDE_STATE, String(launched + 1));
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  // the real CLI re-announces init on every turn of a live process
  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello from fake claude" },
        { type: "tool_use", id: "tu-1", name: "Bash" },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });

  const finish = () => {
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
    turnRunning = false;
    finishIfDone();
  };
  if (mode === "slow") {
    // a gap a test can steer into; the closing reply carries anything that
    // was folded in, the way the real CLI includes a mid-turn message in
    // the same turn's next model call
    setTimeout(() => {
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      finish();
    }, 800);
  } else {
    finish();
  }
};

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let prompt: JsonValue = null;
    try {
      prompt = JSON.parse(line);
    } catch {
      continue;
    }
    // the model-list probe: an `initialize` control request answered with
    // the models this CLI offers (FAKE_CLAUDE_MODELS: JSON array of the real
    // CLI's model rows; "none" answers without a list, like an old CLI)
    const control = prompt as { type?: unknown; request_id?: unknown; request?: { subtype?: unknown } } | null;
    if (control && typeof control === "object" && control.type === "control_request") {
      if (control.request?.subtype === "initialize") {
        const raw = process.env.FAKE_CLAUDE_MODELS;
        const models = raw === "none" ? undefined : raw ? JSON.parse(raw) : [
          { value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default (recommended)", description: "Sonnet 5.5" },
          { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for everyday, complex tasks" },
          { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Efficient for routine tasks" },
          { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fastest for quick answers" },
        ];
        if (process.env.FAKE_CLAUDE_PROBE_LOG) appendFileSync(process.env.FAKE_CLAUDE_PROBE_LOG, JSON.stringify({ argv }) + "\n");
        out({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: control.request_id,
            response: { commands: [], ...(models ? { models } : {}), account: { subscriptionType: "max", apiProvider: "firstParty" } },
          },
        });
      }
      continue;
    }
    if (turnRunning) steered.push(promptText(prompt));
    else {
      playTurn(prompt);
      armSteerGate();
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  finishIfDone();
});
