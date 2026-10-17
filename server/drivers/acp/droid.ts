// Factory Droid harness support — the `droid` CLI over ACP stdio
// (`droid exec -o acp`), on the Factory login (~/.factory/auth.v2.file) or a
// FACTORY_API_KEY. The generic protocol runtime lives in acp/core.ts; this
// file is only the per-harness quirks. Verified against droid 0.196.0:
// initialize reports protocolVersion 1, loadSession:true (session/load resume
// works), promptCapabilities image+embeddedContext, and authMethods
// device-pairing + factory-api-key.
//
// UNLIKE every other ACP harness here, droid ignores argv for session
// settings. `droid exec --help` says so under "Stream JSON-RPC Mode": "CLI
// flags do not configure JSON-RPC sessions: -m/--model, --auto,
// -r/--reasoning-effort, and --disable-builtin-skills are still validated,
// but session settings come from JSON-RPC requests." So a `-m` that only
// reaches argv is accepted and then ignored, and the session runs whatever
// ~/.factory/settings.json selected. Model and autonomy are session config
// options set over the wire (session/set_model, session/set_mode), which is
// why both live in configureSession() below and NOT in spawnArgs.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import {
  createLiveCatalog,
  mergeOptions,
  pickDefault,
  probeJsonLines,
  reviveCatalog,
  secretId,
  type CatalogOption,
} from "../live-catalog.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { t } from "../../../shared/i18n.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// FACTORY_HOME_OVERRIDE replaces the HOME the CLI resolves, NOT the data root:
// droid builds every path as <home>/.factory/… (verified against 0.196.0 —
// `FACTORY_HOME_OVERRIDE=/tmp/x droid exec -o acp` created /tmp/x/.factory/).
// Kimi's KIMI_CODE_HOME is a data root; this one is not, so the `.factory`
// segment stays on both branches.
//
// Which credential file exists depends on the `secure_auth_storage` feature
// flag droid fetches for the account: with secure storage on it writes
// auth.v2.loginkeychain (macOS) or auth.v2.keyring (keytar), and only falls
// back to auth.v2.file when that write fails. droid's own check tries all of
// them, so checking one name alone reports a fresh signed-in login as logged
// out. Names read from the 0.196.0 binary.
const AUTH_FILES = ["auth.v2.file", "auth.v2.loginkeychain", "auth.v2.keyring"];

function authFilePaths(env: Record<string, string | undefined>) {
  const home = env.FACTORY_HOME_OVERRIDE || env.HOME || homedir();
  return AUTH_FILES.map((name) => join(home, ".factory", name));
}

// droid's real catalog is half user-local: `custom:` providers (Azure, a
// local LM Studio server, …) live in ~/.factory/settings.json, the user
// orders the picker with modelFavorites, and sessionDefaultSettings.model is
// the model the CLI itself starts on. None of that can be enumerated from a
// static list, so read it and fall back to the built-in slice if unreadable.
interface FactoryCustomModel {
  id?: string;
  model?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
}

interface FactorySettings {
  customModels?: FactoryCustomModel[];
  modelFavorites?: string[];
  sessionDefaultSettings?: { model?: string };
}

const INJECT_ID_PREFIX = "custom:ein-";
/** Default of the shipped fallback list: an id every droid release knows. */
const SHIPPED_DEFAULT_MODEL = "claude-opus-5";

export function droidInjectId(host: string, model: string): string {
  const safe = `${host}-${model}`.replace(/[^a-zA-Z0-9._+-]+/g, "-").replace(/-+/g, "-");
  return `${INJECT_ID_PREFIX}${safe}`;
}

function factoryHome(env: Record<string, string | undefined>): string {
  return env.FACTORY_HOME_OVERRIDE || env.HOME || env.USERPROFILE || homedir();
}

/** Upsert a BYOK custom model so session/set_model can reach the local host. */
export function ensureDroidInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const id = droidInjectId(inject.host, inject.model);
  const dir = join(factoryHome(env), ".factory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  let settings: FactorySettings & Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as FactorySettings & Record<string, unknown>;
  } catch (error) {
    if (existsSync(path)) throw error;
  }
  const custom = Array.isArray(settings.customModels) ? [...settings.customModels] : [];
  const match = custom.find(
    (row) =>
      row.id === id || (row.model === inject.model && row.baseUrl === host.baseUrl),
  );
  if (match) {
    if (!match.id) {
      match.id = id;
      settings.customModels = custom;
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    }
    return match.id;
  }
  custom.push({
    id,
    model: inject.model,
    displayName: `${inject.model} (${host.label})`,
    baseUrl: host.baseUrl,
    apiKey: hostApiKey(host, env),
    provider: "generic-chat-completion-api",
  });
  settings.customModels = custom;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return id;
}

/** ACP `session/new` throws "Authentication required" unless a Factory
 *  login or FACTORY_API_KEY is present — even for a BYOK custom model.
 *  Droid 0.198 only checks that the env var is set, then uses the
 *  custom row's own key for the local host. Do not invent a key for
 *  subscription models, and do not overwrite a real Factory key. */
export function applyDroidLocalAuthEnv(
  env: Record<string, string | undefined>,
  modelId: string | undefined,
): void {
  if (!decodeInjectId(modelId)) return;
  if (env.FACTORY_API_KEY?.trim()) return;
  // session/new already succeeds on a Factory login file. A placeholder
  // FACTORY_API_KEY can take precedence over that login, so leave env
  // alone when one of the auth files is present.
  if (authFilePaths(env).some(existsSync)) return;
  env.FACTORY_API_KEY = "ein-local";
}

function readSettings(env: Record<string, string | undefined>): FactorySettings {
  return JSON.parse(readFileSync(join(factoryHome(env), ".factory", "settings.json"), "utf8")) as FactorySettings;
}

// ── live catalog ────────────────────────────────────────────────────────
// Factory decides which models an account may use and ships new ones
// server-side, so the installed CLI is asked — exactly the way the Droid SDK's
// listModels() does it (@factory/droid-sdk 0.9): `droid exec --input-format
// stream-jsonrpc --output-format stream-jsonrpc`, one `droid.list_models`
// request in Factory's JSON-RPC envelope, answered from the catalog "without
// creating a session". Disabled models are left out unless asked for, which
// is what a picker wants. Older droids answer -32601 and keep the fallback.
const DROID_SDK_ARGS = ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"];
const PROBE_TIMEOUT_MS = 20_000;

/** `droid.list_models` result → picker rows. Factory's own models stay in the
 * main list; the account's BYOK models (`isCustom`) go to Custom. */
export function parseDroidModelList(result: unknown): CatalogOption[] | null {
  const models = result && typeof result === "object" ? (result as { models?: unknown }).models : null;
  if (!Array.isArray(models)) return null;
  const options: CatalogOption[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const model = raw as {
      id?: unknown;
      modelId?: unknown;
      displayName?: unknown;
      shortDisplayName?: unknown;
      isCustom?: unknown;
      disabled?: unknown;
    };
    const id = typeof model.id === "string" ? model.id.trim() : typeof model.modelId === "string" ? model.modelId.trim() : "";
    if (!id || seen.has(id) || model.disabled === true || id.startsWith(INJECT_ID_PREFIX)) continue;
    seen.add(id);
    const label =
      (typeof model.displayName === "string" && model.displayName.trim()) ||
      (typeof model.shortDisplayName === "string" && model.shortDisplayName.trim()) ||
      id;
    options.push({ id, label, ...(model.isCustom === true || id.startsWith("custom:") ? { custom: true } : {}) });
  }
  return options.length ? options : null;
}

/** Ask the installed droid for its model catalog. Null when the CLI is
 * missing, signed out, too old for `droid.list_models`, or silent. */
export function probeDroidModels(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<CatalogOption[] | null> {
  const id = randomUUID();
  return probeJsonLines<CatalogOption[]>({
    cli,
    args: DROID_SDK_ARGS,
    env,
    cwd: factoryHome(env),
    timeoutMs,
    start: (send) =>
      send({ jsonrpc: "2.0", factoryApiVersion: "1.0.0", type: "request", id, method: "droid.list_models", params: {} }),
    onMessage: (message) => {
      if (!message || message.id !== id) return undefined;
      if (message.error) return null;
      return parseDroidModelList(message.result);
    },
  });
}

const droidCatalogs = createLiveCatalog<ModelCatalog>({ file: "droid.json", revive: reviveCatalog });

function droidFingerprint(cli: string, env: Record<string, string | undefined>): string {
  return [cli, factoryHome(env), secretId(env.FACTORY_API_KEY)].join("|");
}

/** Tests: wait for the background catalog refresh for this CLI/account. */
export function settleDroidModels(cli: string, env: Record<string, string | undefined>): Promise<void> {
  return droidCatalogs.settle(droidFingerprint(cli, env));
}

/** The CLI's live list when there is one, else null. Never waits — a stale
 * list refreshes in the background. */
function liveDroidRows(cli: string, env: Record<string, string | undefined>): CatalogOption[] | null {
  const live = droidCatalogs.read(
    droidFingerprint(cli, env),
    async () => {
      const rows = await probeDroidModels(cli, env);
      return rows ? { default: rows[0]!.id, options: rows } : null;
    },
    env,
  );
  return live?.options ?? null;
}

/** With a live list, the newest flagship it confirms becomes the default for
 * new bots. The shipped fallback keeps an id every droid release knows. */
const LIVE_DEFAULTS = ["claude-opus-5-5", SHIPPED_DEFAULT_MODEL];

async function resolveModels(env: Record<string, string | undefined>, config: { cli: string }) {
  const live = liveDroidRows(config.cli || "droid", env);
  const rows = live ?? MODELS.options;
  const official = rows.filter((row) => !row.custom);
  const liveCustom = rows.filter((row) => row.custom);
  let catalog: ModelCatalog = {
    default: live ? pickDefault(official, ...LIVE_DEFAULTS) : MODELS.default,
    options: mergeOptions(liveCustom, official),
  };
  try {
    const settings = readSettings(env);
    const custom = (settings.customModels ?? []).flatMap((m) => {
      // Live inject rows come from mergeLocalInject as host::model. Skip the
      // BYOK copies we wrote so the picker does not list the same model twice.
      if (m.id?.startsWith(INJECT_ID_PREFIX)) return [];
      const id = m.id || (m.model ? `custom:${m.model}` : "");
      if (!id) return [];
      return [{ id, label: m.displayName || m.model || id, custom: true as const }];
    });
    const merged = mergeOptions(mergeOptions(custom, liveCustom), official);

    // Favourites first, in the user's own order; everything else keeps its
    // existing order (Array.prototype.sort is stable).
    const rank = new Map((settings.modelFavorites ?? []).map((id, i) => [id, i]));
    const options = merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));

    catalog = {
      // the CLI's own session default, then the user's first favourite
      default: pickDefault(
        options,
        settings.sessionDefaultSettings?.model,
        settings.modelFavorites?.find((id) => options.some((o) => o.id === id)),
        catalog.default,
      ),
      options,
    };
  } catch {
    // no settings file yet, or unreadable: the catalog alone
  }
  return mergeLocalInject(catalog, env);
}

// droid answers a rejected setting with a bare JSON-RPC message ("Model not
// recognized", "Method not found") that reaches the error card verbatim,
// naming neither the engine nor the setting that failed. Say what we asked for.
async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(
      t(
        "Droid rejected {setting} via {method}: {error}. Check that `droid` is current (0.196.0+ supports it) and that this account can use that value.",
        { setting: what, method, error: String((e as Error).message) },
      ),
    );
  }
}

// Autonomy maps onto droid's session modes (session/new advertises
// normal | spec | auto-low | auto-medium | auto-high). Always set it
// explicitly: ~/.factory/settings.json can pin a mode, and inheriting it
// would either make every session yolo or make fullAuto silently ask.
const MODE_DEFAULT = "normal"; // auto-approves reads only; everything else asks
const MODE_FULL_AUTO = "auto-high";

// The fallback before the CLI answers (or when it is too old to): a curated
// slice of Factory's catalog as of 2026-10 (docs.factory.com/models), newest
// first, keeping every id the earlier slice shipped so saved bots still match.
// Custom models from ~/.factory/settings.json are per-machine and carry a
// `custom:` prefix; they are read live above.
const MODELS: ModelCatalog = {
  default: SHIPPED_DEFAULT_MODEL,
  options: [
    { id: "auto", label: "Auto (Factory picks)" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "glm-5.3", label: "GLM-5.3" },
    { id: "glm-5.2", label: "GLM-5.2" },
    { id: "kimi-k3", label: "Kimi K3" },
    { id: "minimax-m3", label: "MiniMax M3" },
  ],
};

/** Exported for the catalog tests. */
export const STATIC_DROID_MODELS = MODELS;

const support: AcpSupport = {
  driverKind: "droidAgent",
  displayName: "Droid",
  models: MODELS,
  defaultCli: "droid",
  nativeSource: "droid.acp",
  get loginNote() {
    return t("Droid CLI is not signed in — run `droid` once and log in, or set FACTORY_API_KEY");
  },

  install: {
    command: {
      darwin: "curl -fsSL https://app.factory.ai/cli | sh",
      linux: "curl -fsSL https://app.factory.ai/cli | sh",
      win32: "irm https://app.factory.ai/cli/windows | iex",
    },
    docsUrl: "https://docs.factory.ai/droid-cli/quickstart",
    signInCommand: "droid",
  },

  // No model/mode flags here on purpose: see the header note. `-o acp` is the
  // ACP entry point; everything else is negotiated over the protocol.
  spawnArgs: () => ["exec", "-o", "acp"],
  credentialEnv: ["FACTORY_API_KEY"],

  // The advertised methods are device-pairing (a browser flow that cannot be
  // driven over ACP) and factory-api-key (read from the child env, no
  // authenticate call needed). Ride the ambient login instead, like Kimi.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // The signed-in CLI is the primary source; FACTORY_API_KEY is the fallback
  // droid itself advertises, and it is checked last so an ambient key can
  // never be what makes an otherwise logged-out instance look ready.
  isAuthenticated: (env) => authFilePaths(env).some(existsSync) || Boolean(env.FACTORY_API_KEY),
  // Never waits: the CLI's live list (cached, refreshed in the background)
  // plus ~/.factory/settings.json custom models, favourites and default.
  resolveModels: (env, config) => resolveModels(env, config),
  resolveTurnModel: (model, env) => (model ? ensureDroidInjectModel(model, env) : model),
  applyTurnEnv: (env, { requestedModel }) => {
    applyDroidLocalAuthEnv(env, requestedModel);
  },

  async configureSession({ request, sessionId, config, turn }) {
    const modeId = config.fullAuto ? MODE_FULL_AUTO : MODE_DEFAULT;
    await applySetting(request, "session/set_mode", { sessionId, modeId }, t('autonomy mode "{mode}"', { mode: modeId }));
    // Pin the model for the same reason as the mode: with no set_model the
    // session runs whatever ~/.factory/settings.json selected, which can be a
    // `custom:` provider pointing at its own endpoint and key.
    const modelId = turn.model ?? MODELS.default;
    await applySetting(request, "session/set_model", { sessionId, modelId }, t('model "{model}"', { model: modelId }));
  },

  // House convention for ACP harnesses (grok, gemini, kimi all do this): the
  // persona rides in the prompt text rather than a CLI system-prompt flag.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DroidAgentDriver = createAcpDriver(support);
