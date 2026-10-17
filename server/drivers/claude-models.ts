// Claude's live model list: what the installed `claude` itself offers.
//
// Ein's Claude picker used to be a list written into the code (Fable 5,
// Opus 5, Sonnet 5, Haiku 4.5), so when Anthropic shipped Opus 5.5 the CLI's
// own /model menu had it and Ein did not. Claude Code answers an `initialize`
// control request (stream-json input) with exactly that menu: the aliases
// (opus, sonnet, haiku, fable) resolved to the models this account and CLI
// version use, plus the older models it still accepts. Asking costs no
// tokens and saves no session (--no-session-persistence); hooks, MCP servers
// and project settings are kept out of the probe.
//
// The answer is cached on disk per CLI and configuration, so the picker is
// right from the first launch after an upgrade, and refreshed in the
// background; claude.ts merges it with a static fallback that keeps every id
// a saved bot may hold.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { findCliCandidates } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";

export interface ClaudeModelRow {
  id: string;
  label: string;
}

export interface ClaudeModelProbe {
  /** The CLI's menu, current models first, in its own order. */
  models: ClaudeModelRow[];
  /** What "sonnet" resolves to — the catalog default (the tier Ein has always defaulted to). */
  sonnet: string | null;
  /** What the CLI itself recommends for this account ("default"). */
  recommended: string | null;
}

const CACHE_FILE = () => join(DATA_DIR, "claude-models.json");
/** A good answer is asked again rarely… */
const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** …a failed one soon: the CLI may be signing in or updating right now. */
const RETRY_INTERVAL_MS = 2 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_REMEMBERED = 4;

/** A model id the CLI accepts on --model: an Anthropic id, a cloud
 * provider's (Bedrock/Vertex ARNs and inference profiles), or a 1M-context
 * variant ("claude-sonnet-4-6[1m]"). */
export const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*(\[[a-z0-9]+\])?$/i;

/** "Opus 5.5" → "Claude Opus 5.5"; labels the CLI already brands stay as they are. */
function claudeLabel(displayName: string, id: string): string {
  const name = displayName.trim();
  if (!name) return id;
  return /^claude\b/i.test(name) ? name : `Claude ${name}`;
}

/** Turn the `models` of an initialize reply into picker rows. Aliases come
 * resolved (`opus` → claude-opus-5-5) so a saved bot keeps the exact model it
 * was given; the "default" row only says which model the CLI recommends. */
export function parseClaudeInitModels(models: unknown): ClaudeModelProbe {
  const rows: ClaudeModelRow[] = [];
  const seen = new Set<string>();
  let sonnet: string | null = null;
  let recommended: string | null = null;
  for (const raw of Array.isArray(models) ? models : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { value?: unknown; resolvedModel?: unknown; displayName?: unknown };
    const value = typeof row.value === "string" ? row.value.trim() : "";
    const resolved = typeof row.resolvedModel === "string" && row.resolvedModel.trim() ? row.resolvedModel.trim() : value;
    if (!resolved || !CLAUDE_MODEL_ID.test(resolved)) continue;
    if (value === "default") {
      recommended = resolved;
      continue;
    }
    if (value === "sonnet" && !sonnet) sonnet = resolved;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    rows.push({ id: resolved, label: claudeLabel(typeof row.displayName === "string" ? row.displayName : "", resolved) });
  }
  return { models: rows, sonnet, recommended };
}

/** argv for the probe: the stream-json control channel, nothing persisted,
 * no hooks or MCP servers, user settings only (cwd is a temp dir anyway). */
export const CLAUDE_PROBE_ARGS = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources", "user",
  "--strict-mcp-config",
  "--settings", JSON.stringify({ disableAllHooks: true }),
];

/** Ask the CLI for its model menu; null when it could not say (missing,
 * too old to list models, signed out and refusing to start, timed out). */
export function probeClaudeModels(
  cli: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ClaudeModelProbe | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, CLAUDE_PROBE_ARGS, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buffer = "";
    const requestId = `ein-models-${process.pid}-${Date.now()}`;
    const finish = (answer: ClaudeModelProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      killCliTree(child);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let message: { type?: unknown; response?: { request_id?: unknown; subtype?: unknown; response?: { models?: unknown } } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type !== "control_response" || message.response?.request_id !== requestId) continue;
        const parsed = message.response.subtype === "success" ? parseClaudeInitModels(message.response.response?.models) : null;
        return finish(parsed && parsed.models.length ? parsed : null);
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
  });
}

interface ProbeState {
  fingerprint: string;
  at: number;
  /** null: the last probe got no answer (keep what was known before) */
  probe: ClaudeModelProbe | null;
}

const states = new Map<string, ProbeState>();
const probing = new Set<string>();
let cacheLoaded = false;

function readCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE(), "utf8")) as { entries?: Array<Partial<ProbeState>> };
    for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
      if (typeof entry?.fingerprint !== "string" || states.has(entry.fingerprint)) continue;
      const probe = entry.probe && Array.isArray(entry.probe.models)
        ? {
            models: entry.probe.models.filter(
              (row): row is ClaudeModelRow =>
                typeof row?.id === "string" && CLAUDE_MODEL_ID.test(row.id) && typeof row?.label === "string",
            ),
            sonnet: typeof entry.probe.sonnet === "string" ? entry.probe.sonnet : null,
            recommended: typeof entry.probe.recommended === "string" ? entry.probe.recommended : null,
          }
        : null;
      states.set(entry.fingerprint, { fingerprint: entry.fingerprint, at: Number(entry.at) || 0, probe });
    }
  } catch {
    // first launch, or an older cache shape: probe afresh
  }
}

function remember(next: ProbeState): void {
  states.delete(next.fingerprint);
  states.set(next.fingerprint, next);
  while (states.size > MAX_REMEMBERED) states.delete(states.keys().next().value!);
  try {
    mkdirSync(dirname(CACHE_FILE()), { recursive: true });
    writeFileSync(CACHE_FILE(), JSON.stringify({ entries: [...states.values()] }, null, 2), { mode: 0o600 });
  } catch {
    // a read-only data dir only costs the next launch a fresh probe
  }
}

/** Which CLI binary (and which build of it) with which configuration the
 * answer belongs to. An upgraded CLI has a new mtime, so it is asked again
 * at once instead of after the refresh interval. */
export function claudeProbeFingerprint(cli: string, env: Record<string, string | undefined>): string {
  const binary = /[\\/]/.test(cli) ? cli : (findCliCandidates(cli)[0] ?? cli);
  let built = "";
  try {
    built = String(Math.round(statSync(binary).mtimeMs));
  } catch {
    // not on disk (yet): the path alone keys it
  }
  const scope = [
    binary,
    built,
    env.CLAUDE_CONFIG_DIR ?? env.HOME ?? env.USERPROFILE ?? "",
    env.ANTHROPIC_BASE_URL ?? "",
    env.CLAUDE_CODE_USE_BEDROCK ?? "",
    env.CLAUDE_CODE_USE_VERTEX ?? "",
    env.CLAUDE_CODE_USE_FOUNDRY ?? "",
  ].join("\n");
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

function probeDue(known: ProbeState | undefined): boolean {
  if (!known) return true;
  const age = Date.now() - known.at;
  return known.probe ? age >= PROBE_INTERVAL_MS : age >= RETRY_INTERVAL_MS;
}

/** The last known menu for this CLI and configuration (memory, then disk),
 * starting a background probe when it is missing or stale. Never blocks:
 * the picker shows the fallback until the first answer lands. `onUpdate`
 * runs when a probe brings a new answer. */
export function claudeLiveModels(
  cli: string,
  env: NodeJS.ProcessEnv,
  onUpdate?: () => void,
): ClaudeModelProbe | null {
  readCache();
  const fingerprint = claudeProbeFingerprint(cli, env);
  const known = states.get(fingerprint);
  if (!probing.has(fingerprint) && probeDue(known)) {
    probing.add(fingerprint);
    void probeClaudeModels(cli, env)
      .then((probe) => {
        // a failed probe keeps the last good menu, but is retried soon
        remember({ fingerprint, at: Date.now(), probe: probe ?? known?.probe ?? null });
        if (probe) onUpdate?.();
      })
      .finally(() => probing.delete(fingerprint));
  }
  return known?.probe ?? null;
}

/** Tests: forget everything this process learned (the disk cache stays). */
export function resetClaudeModelState(): void {
  states.clear();
  probing.clear();
  cacheLoaded = false;
}
