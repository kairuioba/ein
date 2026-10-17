// Qwen Code — Alibaba's `qwen --acp` CLI. Custom-only in OpenMausBot:
// the official pane has no Qwen Cloud catalog (the free Qwen OAuth tier
// ended 2026-04-15). The picker offers what Qwen Code's own /model offers —
// every `modelProviders` entry in ~/.qwen/settings.json, which its Coding
// Plan / Token Plan setup and hand-added providers write — plus live local
// hosts, which a pick writes into that same file.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { pickDefault, type CatalogOption } from "../live-catalog.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { t } from "../../../shared/i18n.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

function qwenHome(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".qwen");
}

const INJECT_ENV_PREFIX = "EIN_QWEN_";

function envKeyFor(hostId: string): string {
  return `${INJECT_ENV_PREFIX}${hostId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Qwen Code reads settings.json with comments allowed; drop them (outside
 *  strings) so a commented file still parses. */
function stripJsonComments(text: string): string {
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') {
      quote = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

/** The models Qwen Code's own /model picker would offer: every
 *  `modelProviders.<provider>[]` entry in ~/.qwen/settings.json, labelled with
 *  its `name`, with `model.name` as the default. Rows a local-host pick wrote
 *  are left to the live inject probe so a model is never listed twice. */
export function readQwenModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  let settings: { modelProviders?: unknown; model?: { name?: unknown } } = {};
  try {
    settings = JSON.parse(stripJsonComments(readFileSync(join(qwenHome(env), "settings.json"), "utf8")));
  } catch {
    return EMPTY;
  }
  const providers =
    settings.modelProviders && typeof settings.modelProviders === "object" && !Array.isArray(settings.modelProviders)
      ? (settings.modelProviders as Record<string, unknown>)
      : {};
  const options: CatalogOption[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(providers)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as { id?: unknown; name?: unknown; envKey?: unknown };
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (!id || seen.has(id)) continue;
      if (typeof row.envKey === "string" && row.envKey.startsWith(INJECT_ENV_PREFIX)) continue;
      seen.add(id);
      const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
      options.push({ id, label, custom: true });
    }
  }
  const configured = typeof settings.model?.name === "string" ? settings.model.name.trim() : "";
  return { default: pickDefault(options, configured), options };
}

/** Upsert an OpenAI-compatible provider row so `qwen -m` can reach the host. */
export function ensureQwenInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const dir = qwenHome(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const keyName = envKeyFor(inject.host);
  const key = hostApiKey(host, env);
  const envMap =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? { ...(settings.env as Record<string, unknown>) }
      : {};
  envMap[keyName] = key;
  settings.env = envMap;

  const providers =
    settings.modelProviders && typeof settings.modelProviders === "object" && !Array.isArray(settings.modelProviders)
      ? { ...(settings.modelProviders as Record<string, unknown>) }
      : {};
  const openai = Array.isArray(providers.openai) ? [...providers.openai] : [];
  const match = openai.find(
    (row) =>
      row &&
      typeof row === "object" &&
      (row as { id?: unknown }).id === inject.model &&
      (row as { baseUrl?: unknown }).baseUrl === host.baseUrl,
  );
  if (!match) {
    openai.push({
      id: inject.model,
      name: `${inject.model} (${host.label})`,
      baseUrl: host.baseUrl,
      envKey: keyName,
    });
    providers.openai = openai;
    settings.modelProviders = providers;
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
  return inject.model;
}

async function resolveModels(env: Record<string, string | undefined>): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(readQwenModelCatalog(env), env);
  return { default: pickDefault(catalog.options, catalog.default), options: catalog.options };
}

const support: AcpSupport = {
  driverKind: "qwenAgent",
  displayName: "Qwen",
  access: "custom",
  models: EMPTY,
  resolveModels,
  resolveTurnModel: (model, env) => (model ? ensureQwenInjectModel(model, env) : model),
  defaultCli: "qwen",
  nativeSource: "qwen.acp",
  get loginNote() {
    return t("Qwen Code CLI is not installed");
  },
  install: {
    command: {
      darwin: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      linux: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      win32: "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
    },
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/overview/",
  },
  spawnArgs: (_config, turn) => ["--acp", ...(turn.model ? ["-m", turn.model] : [])],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const QwenAgentDriver = createAcpDriver(support);
