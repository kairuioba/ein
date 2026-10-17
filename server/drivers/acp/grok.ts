// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DATA_DIR } from "../../config.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { t } from "../../../shared/i18n.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** The fallback catalog, for before the CLI has told us its list (below).
 * Grok Build fetches its model list from xAI, so the list it advertises is
 * the one to show; this only has to be current enough for a first launch
 * and keep the ids saved bots hold. */
export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** "grok-4.7-fast" → "Grok 4.7 Fast", "grok-build" → "Grok Build". */
export function grokModelLabel(slug: string): string {
  if (!/^grok-/i.test(slug)) return slug;
  return slug
    .split("-")
    .map((part) => (/^[a-z]/i.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ── the CLI's own list, learned from the sessions it opens ─────────────
// `session/new` advertises the models this account may use (ACP
// `models.availableModels`), which the CLI keeps current from xAI — that is
// how Grok 4.7 appears without a release of Ein. It is read from the turns
// Ein runs anyway (nothing is spawned just to ask, so no extra session lands
// in the user's history) and kept on disk for the picker's next launch.
type GrokRow = { id: string; label: string };
const LEARNED_FILE = () => join(DATA_DIR, "grok-models.json");
let learned: Map<string, { at: number; models: GrokRow[] }> | null = null;

function learnedModels(): Map<string, { at: number; models: GrokRow[] }> {
  if (learned) return learned;
  learned = new Map();
  try {
    const raw = JSON.parse(readFileSync(LEARNED_FILE(), "utf8")) as { entries?: Array<{ cli?: unknown; at?: unknown; models?: unknown }> };
    for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
      if (typeof entry.cli !== "string" || !Array.isArray(entry.models)) continue;
      const models = entry.models.filter(
        (row): row is GrokRow => typeof row?.id === "string" && SLUG.test(row.id) && typeof row?.label === "string",
      );
      if (models.length) learned.set(entry.cli, { at: Number(entry.at) || 0, models });
    }
  } catch {
    // nothing learned yet
  }
  return learned;
}

/** Parse what `session/new` advertised into picker rows. */
export function grokAdvertisedModels(sessionModels: ReadonlyArray<{ modelId?: unknown; name?: unknown }>): GrokRow[] {
  const rows: GrokRow[] = [];
  const seen = new Set<string>();
  for (const model of sessionModels) {
    const id = typeof model?.modelId === "string" ? model.modelId.trim() : "";
    if (!id || !SLUG.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof model.name === "string" ? model.name.trim() : "";
    rows.push({ id, label: name && name !== id ? name : grokModelLabel(id) });
  }
  return rows;
}

/** Remember what this CLI advertised; true when the list changed. */
export function rememberGrokModels(cli: string, sessionModels: ReadonlyArray<{ modelId?: unknown; name?: unknown }>): boolean {
  const models = grokAdvertisedModels(sessionModels);
  if (!models.length) return false;
  const known = learnedModels();
  const before = known.get(cli);
  if (before && JSON.stringify(before.models) === JSON.stringify(models)) return false;
  known.set(cli, { at: Date.now(), models });
  try {
    mkdirSync(dirname(LEARNED_FILE()), { recursive: true });
    writeFileSync(
      LEARNED_FILE(),
      JSON.stringify({ entries: [...known].map(([key, entry]) => ({ cli: key, ...entry })) }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    // a read-only data dir only costs the next launch the fallback list
  }
  return true;
}

/** The list this CLI last advertised, if any. */
export function learnedGrokModels(cli: string): GrokRow[] {
  return learnedModels().get(cli)?.models ?? [];
}

/** Tests: forget what this process learned (the disk file stays). */
export function resetLearnedGrokModels(): void {
  learned = null;
}

function grokHome(env: Record<string, string | undefined>): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** The cloud rows: what the CLI advertised (when it has), then the fallback
 *  ids it did not list, so saved bots keep their row. */
function grokCloudRows(advertised: readonly GrokRow[]): GrokRow[] {
  const rows = advertised.map((row) => ({ ...row }));
  const seen = new Set(rows.map((row) => row.id));
  for (const option of STATIC_GROK_MODELS.options) if (!seen.has(option.id)) rows.push({ id: option.id, label: option.label });
  return rows;
}

/** The CLI's advertised list (or the fallback), plus local slugs from
 *  ~/.grok/config.toml tagged custom. `grok -m <slug>` already accepts
 *  these; the picker just didn't list them. */
export function readGrokModelCatalog(
  env: Record<string, string | undefined> = process.env,
  advertised: readonly GrokRow[] = [],
): ModelCatalog {
  const cloud = grokCloudRows(advertised);
  const cloudDefault = cloud.some((row) => row.id === STATIC_GROK_MODELS.default) ? STATIC_GROK_MODELS.default : cloud[0]!.id;
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return advertised.length ? { default: cloudDefault, options: cloud } : STATIC_GROK_MODELS;
  }

  const options: ModelCatalog["options"] = cloud.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  // every slug config.toml defines: one the CLI advertised too is still the
  // user's own model (custom), unless it is a cloud id it merely renames
  const configured = new Set<string>();
  const flush = () => {
    if (current && SLUG.test(current.slug)) configured.add(current.slug);
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();
  const cloudIds = new Set(STATIC_GROK_MODELS.options.map((option) => option.id));
  for (const option of options) {
    if (configured.has(option.id) && !cloudIds.has(option.id)) option.custom = true;
  }

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : cloudDefault,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return slug;
}

const support: AcpSupport = {
  driverKind: "grokAgent",
  displayName: "Grok",
  images: false,
  models: STATIC_GROK_MODELS,
  resolveModels: (env, config) => mergeLocalInject(readGrokModelCatalog(env, learnedGrokModels(config.cli)), env),
  // Grok's accepted levels vary by model and the CLI validates lazily — a
  // rejected level only logs and falls back. Offer the intersection shared
  // by every model in this driver's picker; notably, grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  get loginNote() {
    return t("Grok CLI is not signed in — run `grok login` in a terminal");
  },

  // No Windows one-liner: the installer is a POSIX shell script, and offering
  // `curl … | bash` there would be advice that cannot run. Windows falls back
  // to docsUrl, which is honest rather than broken.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },

  // Write the [model.slug] block with the instance HOME/GROK_HOME, then pass
  // the slug on argv. spawnArgs must not call ensureGrokInjectSlug itself —
  // that helper defaults to process.env and would miss the instance override.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is a global grok flag. -m and --reasoning-effort are
  // agent flags: Grok 1.0.6 only applies them when they sit AFTER `agent`
  // and BEFORE `stdio` (`grok agent -m slug stdio`). Putting -m first is
  // accepted as a TUI option and then ignored, so ACP session/new keeps
  // [models].default (grok-4.6) and oMLX never sees a request.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto ? "bypassPermissions" : "default",
    "agent",
    ...(turn.model ? ["-m", turn.model] : []),
    // long form on purpose: `--effort` is documented as an alias, and an
    // alias is the part a CLI is free to rename
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  // -m on argv is necessary but not sufficient: session/new still starts on
  // [models].default. Pin the slug over the wire, same as Hermes/Droid.
  async configureSession({ request, sessionId, turn, config, sessionModels }) {
    // the CLI's live list rides along with every session: keep it for the picker
    rememberGrokModels(config.cli, sessionModels);
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      throw new Error(
        t(
          'Grok rejected model "{model}" via session/set_model: {error}. Check that grok is current (1.0.6+ supports it) and that this slug exists in ~/.grok/config.toml.',
          { model: turn.model, error: String((e as Error).message) },
        ),
      );
    }
  },

  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: () => existsSync(join(homedir(), ".grok", "auth.json")),

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
