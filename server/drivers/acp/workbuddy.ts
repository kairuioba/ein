// WorkBuddy (Tencent) — the `codebuddy` CLI from @tencent-ai/codebuddy-code,
// which is the command-line agent behind the WorkBuddy desktop workbench.
// `codebuddy --acp` speaks the Agent Client Protocol over stdio, so it rides
// the shared runtime in acp/core.ts like Gemini, Qwen and Kimi.
//
// Sign-in: either the CLI's own interactive login (run `codebuddy` once in a
// terminal) or an API key in CODEBUDDY_API_KEY. The China edition also needs
// CODEBUDDY_INTERNET_ENVIRONMENT=internal (iOA: `ioa`; international: unset);
// App Settings → WorkBuddy writes both into this instance's environment.
// The CLI keeps an interactive login in the OS credential store (macOS
// Keychain, Windows Credential Manager, a Linux keyring), so there is no file
// to look for: the model probe below doubles as the sign-in check — a
// `session/new` that succeeds proves the login, one refused for auth disproves it.
//
// Models: WorkBuddy decides which models an account can use, and the CLI has
// no list command, so the catalog is discovered from what `session/new`
// advertises (ACP `models.availableModels` or a `model` config option). The
// probe runs in the background, its result is cached on disk, and the picker
// defaults to DeepSeek V4.1 Flash, even before the first probe lands. The old
// "default" placeholder is accepted on input but never shown. The user's own
// ~/.codebuddy/models.json is read on every refresh, as the CLI itself merges
// it (workbuddy.ai/docs/cli/models): its added models appear as Custom at
// once, and its `availableModels` allow-list trims the picker like the CLI's
// own dropdown.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { t } from "../../../shared/i18n.ts";
import { DATA_DIR } from "../../config.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { resolveCli } from "../../procs.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

export const WORKBUDDY_DEFAULT_MODEL = "deepseek-v4.1-flash";
const LEGACY_DEFAULT_MODEL = "default";
export const WORKBUDDY_ENVIRONMENTS = ["international", "internal", "ioa"] as const;
export type WorkBuddyEnvironment = (typeof WORKBUDDY_ENVIRONMENTS)[number];

// Getter so the label follows the active language, like the probed catalog.
const STATIC_MODELS: ModelCatalog = {
  default: WORKBUDDY_DEFAULT_MODEL,
  get options() {
    return workbuddyCatalog([]).options;
  },
};

const CACHE_FILE = () => join(DATA_DIR, "workbuddy-models.json");
/** A signed-in account with a known model list is looked at again rarely… */
const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** …anything else soon: the user may be logging in at this very moment. */
const RETRY_INTERVAL_MS = 2 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

export interface WorkBuddyProbe {
  models: Array<{ id: string; label: string }>;
  /** true: `session/new` succeeded; false: it was refused for sign-in; null: unknown. */
  signedIn: boolean | null;
}

interface ProbeState extends WorkBuddyProbe {
  /** Which CLI, edition and key the answer belongs to (see probeFingerprint). */
  fingerprint: string;
  at: number;
}

/** One answer per fingerprint, so two WorkBuddy instances (say, the China
 * and the international edition) never overwrite each other's answer. */
const states = new Map<string, ProbeState>();
const probing = new Set<string>();
const MAX_REMEMBERED = 4;

/** Auth-shaped CLI failures (English or Chinese) become a sign-in prompt
 * instead of a retryable error. */
export function classifyWorkBuddyError(error: unknown): ProviderErrorCode | undefined {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === -32000 ||
    /unauthoriz|unauthenticated|not signed in|not logged in|login required|authentication required|invalid api key|api key (is )?invalid|token (has )?expired|未登录|请先登录|登录已过期|登录失效|认证失败|鉴权失败/.test(
      blob,
    )
  ) {
    return "invalid_credentials";
  }
  return undefined;
}

/** The probe answer is only valid for the CLI, edition and key it ran with;
 * a change in Settings starts over. The key enters as a short one-way hash. */
export function probeFingerprint(env: Record<string, string | undefined>, cli: string): string {
  const key = env.CODEBUDDY_API_KEY?.trim();
  const keyId = key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : "login";
  return [cli, env.CODEBUDDY_INTERNET_ENVIRONMENT || "international", keyId].join("|");
}

/** Turn whatever `session/new` advertised into picker options. Both ACP
 * shapes are accepted: `models.availableModels[{modelId,name}]` and a select
 * config option whose id or category is "model". */
export function parseAdvertisedModels(sessionResult: unknown): Array<{ id: string; label: string }> {
  const result = (sessionResult ?? {}) as {
    models?: { availableModels?: Array<{ modelId?: unknown; name?: unknown }> };
    configOptions?: Array<{
      id?: unknown;
      category?: unknown;
      options?: Array<{ value?: unknown; name?: unknown }>;
    }>;
  };
  const seen = new Map<string, string>();
  for (const model of Array.isArray(result.models?.availableModels) ? result.models.availableModels : []) {
    if (typeof model?.modelId !== "string" || !model.modelId.trim()) continue;
    const id = model.modelId.trim();
    seen.set(id, typeof model.name === "string" && model.name.trim() ? model.name.trim() : id);
  }
  for (const option of Array.isArray(result.configOptions) ? result.configOptions : []) {
    if (option?.id !== "model" && option?.category !== "model") continue;
    for (const choice of Array.isArray(option.options) ? option.options : []) {
      if (typeof choice?.value !== "string" || !choice.value.trim()) continue;
      const id = choice.value.trim();
      if (!seen.has(id)) seen.set(id, typeof choice.name === "string" && choice.name.trim() ? choice.name.trim() : id);
    }
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

export interface CodeBuddyModelsFile {
  /** `models[]`: models the user added, or built-ins they re-pointed or renamed. */
  models: Array<{ id: string; name?: string; endpoint: boolean }>;
  /** `availableModels`: when non-empty, the only ids the CLI's dropdown shows. */
  available: string[] | null;
}

/** The user-level ~/.codebuddy/models.json. A missing or malformed file is
 * simply empty — the CLI keeps working without one. */
export function readCodeBuddyModels(env: Record<string, string | undefined>): CodeBuddyModelsFile {
  const empty: CodeBuddyModelsFile = { models: [], available: null };
  let raw: { models?: unknown; availableModels?: unknown };
  try {
    raw = JSON.parse(readFileSync(join(env.HOME || env.USERPROFILE || homedir(), ".codebuddy", "models.json"), "utf8"));
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== "object") return empty;
  const models: CodeBuddyModelsFile["models"] = [];
  for (const entry of Array.isArray(raw.models) ? raw.models : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { id?: unknown; name?: unknown; url?: unknown };
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || models.some((model) => model.id === id)) continue;
    models.push({
      id,
      ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim() } : {}),
      endpoint: typeof row.url === "string" && row.url.trim().length > 0,
    });
  }
  const available = Array.isArray(raw.availableModels)
    ? raw.availableModels.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
    : [];
  return { models, available: available.length ? available : null };
}

/** The picker catalog: DeepSeek first, then the account's models,
 *  then the user's own models.json models (Custom), trimmed to the
 *  `availableModels` allow-list when there is one — the CLI applies it after
 *  merging, and so does this. */
export function workbuddyCatalog(
  advertised: Array<{ id: string; label: string }>,
  local: CodeBuddyModelsFile = { models: [], available: null },
): ModelCatalog {
  const own = new Map(local.models.map((model) => [model.id, model]));
  const rows: ModelCatalog["options"] = [];
  const models = advertised.some((model) => model.id === WORKBUDDY_DEFAULT_MODEL)
    ? advertised
    : [{ id: WORKBUDDY_DEFAULT_MODEL, label: "DeepSeek V4.1 Flash" }, ...advertised];
  for (const model of models) {
    if (model.id === LEGACY_DEFAULT_MODEL || rows.some((row) => row.id === model.id)) continue;
    const mine = own.get(model.id);
    rows.push({
      id: model.id,
      label: mine?.name ?? model.label,
      // a built-in re-pointed at the user's own endpoint is their model now
      ...(mine?.endpoint ? { custom: true as const } : {}),
    });
  }
  for (const model of local.models) {
    if (model.id === LEGACY_DEFAULT_MODEL || rows.some((row) => row.id === model.id)) continue;
    rows.push({ id: model.id, label: model.name ?? model.id, custom: true });
  }
  let shown = rows;
  if (local.available) {
    const allowed = local.available;
    // Keep allow-list order so catalog refresh and turn resolution agree,
    // even before the probe has reported an allowed built-in.
    shown = [...new Set(allowed)]
      .filter((id) => id !== LEGACY_DEFAULT_MODEL)
      .map((id) => rows.find((row) => row.id === id) ?? { id, label: id });
  }
  // A legacy allow-list containing only "default" still needs a real model.
  if (!shown.length) shown.push({ id: WORKBUDDY_DEFAULT_MODEL, label: "DeepSeek V4.1 Flash" });
  const preferred = shown.find((row) => row.id === WORKBUDDY_DEFAULT_MODEL);
  return {
    default: preferred?.id ?? shown[0]!.id,
    options: [
      ...(preferred ? [preferred] : []),
      ...shown.filter((row) => row !== preferred),
    ],
  };
}

let cacheLoaded = false;

function readCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE(), "utf8")) as { entries?: Array<Partial<ProbeState>> };
    for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
      if (typeof entry?.fingerprint !== "string" || !Array.isArray(entry.models) || states.has(entry.fingerprint)) continue;
      states.set(entry.fingerprint, {
        fingerprint: entry.fingerprint,
        at: Number(entry.at) || 0,
        models: entry.models.filter((model) => typeof model?.id === "string" && typeof model?.label === "string"),
        signedIn: typeof entry.signedIn === "boolean" ? entry.signedIn : null,
      });
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
    // oldest first, the order readCache() restores them in
    writeFileSync(CACHE_FILE(), JSON.stringify({ entries: [...states.values()] }, null, 2), { mode: 0o600 });
  } catch {
    // a read-only data dir only costs the next launch a fresh probe
  }
}

/** What the last probe for this fingerprint learned, from memory or disk. */
function knownState(fingerprint: string): ProbeState | null {
  readCache();
  return states.get(fingerprint) ?? null;
}

/** One short ACP handshake — initialize, session/new, then exit — to read the
 * models this account may use and whether it is signed in. Never prompts, so
 * it costs no credits. */
export function probeWorkBuddy(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<WorkBuddyProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const resolved = resolveCli(cli, ["--acp"]);
    const child = spawn(resolved.command, resolved.args, {
      cwd: tmpdir(),
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const unknown: WorkBuddyProbe = { models: [], signedIn: null };
    const finish = (answer: WorkBuddyProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(answer);
    };
    const timer = setTimeout(() => finish(unknown), timeoutMs);
    timer.unref?.();
    const send = (id: number, method: string, params: unknown) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    child.on("error", () => finish(unknown));
    child.on("exit", () => finish(unknown));
    // a CLI that dies before reading stdin must not crash the harness with EPIPE
    child.stdin.on("error", () => finish(unknown));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) return finish(unknown);
          send(2, "session/new", { cwd: tmpdir(), mcpServers: [] });
        } else if (message.id === 2) {
          if (message.error) {
            return finish({ models: [], signedIn: classifyWorkBuddyError(message.error) === "invalid_credentials" ? false : null });
          }
          finish({ models: parseAdvertisedModels(message.result), signedIn: true });
        }
      }
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  });
}

/** Models the probe already returned for this exact CLI/edition/key, or an empty list. */
export async function probeWorkBuddyModels(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Array<{ id: string; label: string }>> {
  return (await probeWorkBuddy(cli, env, timeoutMs)).models;
}

function probeDue(known: ProbeState | null): boolean {
  if (!known) return true;
  const age = Date.now() - known.at;
  return known.signedIn === true && known.models.length ? age >= PROBE_INTERVAL_MS : age >= RETRY_INTERVAL_MS;
}

/** Start a background probe when the last answer is missing or stale. */
function scheduleProbe(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): void {
  const fingerprint = probeFingerprint(env, config.cli);
  const known = knownState(fingerprint);
  if (probing.has(fingerprint) || !probeDue(known)) return;
  probing.add(fingerprint);
  void probeWorkBuddy(config.cli, env)
    .then((answer) => {
      remember({
        fingerprint,
        at: Date.now(),
        // a timeout keeps what was known; a definite answer replaces it
        models: answer.models.length || answer.signedIn === false ? answer.models : (known?.models ?? []),
        signedIn: answer.signedIn ?? known?.signedIn ?? null,
      });
    })
    .finally(() => {
      probing.delete(fingerprint);
    });
}

function resolveModels(env: Record<string, string | undefined>, config: AcpConfig): ModelCatalog {
  scheduleProbe(env, config);
  return workbuddyCatalog(knownState(probeFingerprint(env, config.cli))?.models ?? [], readCodeBuddyModels(env));
}

/** An API key counts as signed in. Otherwise the last probe decides; before
 * the first answer the login is assumed to exist — the OS credential store
 * cannot be inspected, and a turn that finds no login reports the sign-in
 * step itself (classifyWorkBuddyError). */
export function workbuddyIsAuthenticated(
  env: Record<string, string | undefined>,
  config?: Pick<AcpConfig, "cli">,
): boolean {
  if (env.CODEBUDDY_API_KEY?.trim()) return true;
  if (!config) return true;
  return knownState(probeFingerprint(env, config.cli))?.signedIn ?? true;
}

/** argv after the binary: ACP over stdio, a real model (DeepSeek when
 * unspecified), and auto-approval only on a full-auto instance. */
export function workbuddySpawnArgs(config: Pick<AcpConfig, "fullAuto">, model: string | undefined): string[] {
  const args = ["--acp"];
  const selected = !model || model === LEGACY_DEFAULT_MODEL ? WORKBUDDY_DEFAULT_MODEL : model;
  args.push("--model", selected);
  if (config.fullAuto) args.push("--permission-mode", "bypassPermissions");
  return args;
}

const support: AcpSupport = {
  driverKind: "workbuddyAgent",
  displayName: "WorkBuddy",
  models: STATIC_MODELS,
  defaultCli: "codebuddy",
  nativeSource: "workbuddy.acp",
  get loginNote() {
    return t("WorkBuddy is not signed in — run `codebuddy` once in a terminal to log in, or add a WorkBuddy API key in App Settings");
  },
  install: {
    command: {
      darwin: "npm install -g @tencent-ai/codebuddy-code",
      linux: "npm install -g @tencent-ai/codebuddy-code",
      win32: "npm install -g @tencent-ai/codebuddy-code",
    },
    docsUrl: "https://www.workbuddy.ai/docs/cli/acp",
    signInCommand: "codebuddy",
    needsNode: true,
  },
  credentialEnv: ["CODEBUDDY_API_KEY"],
  resolveModels,
  resolveTurnModel: (model, env) => !model || model === LEGACY_DEFAULT_MODEL
    ? workbuddyCatalog([], readCodeBuddyModels(env)).default
    : model,
  spawnArgs: (config, turn) => workbuddySpawnArgs(config, turn.model),
  pickAuthMethod: (methods) => {
    const ids = methods.map((method) => method.id).filter((id): id is string => typeof id === "string");
    return ids.find((id) => /api.?key/i.test(id)) ?? null;
  },
  authFailure: "continue",
  // the probe is also how sign-in is learned, so a status check keeps it fresh
  isAuthenticated: (env, config) => {
    scheduleProbe(env, config);
    return workbuddyIsAuthenticated(env, config);
  },
  classifyError: classifyWorkBuddyError,
  // The CLI takes --model; when the session also advertises the model list,
  // pin it over the wire too so a CLI that ignores argv in ACP mode still runs
  // the model the picker shows. Best effort: agents predating set_model keep
  // the argv choice.
  configureSession: async ({ request, sessionId, turn, sessionModels }) => {
    const model = turn.model;
    if (!model) return;
    if (!sessionModels.some((entry) => entry.modelId === model)) return;
    try {
      await request("session/set_model", { sessionId, modelId: model });
    } catch {
      // argv already asked for this model
    }
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const WorkBuddyAgentDriver = createAcpDriver(support);

/** Environment for the WorkBuddy instance from App Settings: the API key and
 * the edition switch the CLI reads. Absent values leave the CLI on its own
 * login and default (international) edition. */
export function workbuddyEnvironment(settings: { apiKey?: string; environment?: WorkBuddyEnvironment } | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings?.apiKey?.trim()) env.CODEBUDDY_API_KEY = settings.apiKey.trim();
  if (settings?.environment === "internal" || settings?.environment === "ioa") env.CODEBUDDY_INTERNET_ENVIRONMENT = settings.environment;
  return env;
}
