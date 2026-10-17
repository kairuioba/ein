#!/usr/bin/env node
// Fake of the Factory `droid` CLI's SDK surface, for the model-catalog probe
// in drivers/acp/droid.ts: `droid exec --input-format stream-jsonrpc
// --output-format stream-jsonrpc` reads newline-delimited JSON-RPC requests
// in Factory's envelope ({jsonrpc, factoryApiVersion, type, id, method,
// params}) and answers `droid.list_models` without creating a session.
//
//   FAKE_DROID_MODE   happy (default) | no-method (an older droid: -32601)
//                     | hang (never answers) | auth (-32000, signed out)
//   FAKE_DROID_DUMP   path to write {argv} as JSON
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_DROID_MODE ?? "happy";
if (process.env.FAKE_DROID_DUMP) writeFileSync(process.env.FAKE_DROID_DUMP, JSON.stringify({ argv }));
if (argv.includes("--version")) {
  console.log("0.210.0");
  process.exit(0);
}

const MODELS = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", shortDisplayName: "Opus 5.5", modelProvider: "anthropic", isCustom: false },
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", shortDisplayName: "6.1 Sol", modelProvider: "openai", isCustom: false },
  { id: "grok-4.7", displayName: "Grok 4.7", shortDisplayName: "Grok 4.7", modelProvider: "xai", isCustom: false },
  { id: "custom:Azure-Opus-0", displayName: "Azure Opus", shortDisplayName: "Azure Opus", modelProvider: "anthropic", isCustom: true },
];

const reply = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const envelope = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", type: "response" };

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message: { id?: unknown; method?: unknown; type?: unknown } | null = null;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!message || message.type !== "request") continue;
    if (mode === "hang") continue;
    if (message.method !== "droid.list_models" || mode === "no-method") {
      reply({ ...envelope, id: message.id, error: { code: -32601, message: "Method not found" } });
      continue;
    }
    if (mode === "auth") {
      reply({ ...envelope, id: message.id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    // a notification first: the probe must match its own response by id
    reply({ jsonrpc: "2.0", factoryApiVersion: "1.0.0", type: "notification", method: "droid.status", params: {} });
    reply({ ...envelope, id: message.id, result: { models: MODELS } });
  }
});
setInterval(() => {}, 1_000);
