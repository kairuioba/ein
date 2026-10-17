// MiniMax API driver. The wire protocol is OpenAI chat completions; this file
// keeps only MiniMax's credentials, catalog, and request differences.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createLiveCatalog, pickDefault, reviveCatalog, secretId, type CatalogOption } from "./live-catalog.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { t } from "../../shared/i18n.ts";

const DRIVER_KIND = "minimax";
const API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_URL = "https://api.minimax.io/v1";
const CN_URL = "https://api.minimaxi.com/v1";
// MiniMax's current text models (platform.minimax.io/docs/faq/models, 2026-10).
// Only the fallback: the key's own `GET /v1/models` list replaces it. Every
// row is `custom`: this engine advertises `access: "custom"`, and the picker
// shows such an engine only its custom-flagged options (see openai-compat).
const MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3", custom: true, contextWindow: 1_000_000 },
    { id: "MiniMax-M3.1-Flash-Preview", label: "MiniMax M3.1 Flash Preview", custom: true, contextWindow: 1_000_000 },
    { id: "MiniMax-M2.7", label: "MiniMax M2.7", custom: true, contextWindow: 204_800 },
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", custom: true, contextWindow: 204_800 },
    { id: "MiniMax-M2.5", label: "MiniMax M2.5", custom: true },
    { id: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 Highspeed", custom: true },
  ],
};

// /v1/models may list speech, video, image or music models next to the
// text ones; none of them can hold a chat turn.
const NOT_FOR_CHAT = /speech|tts|t2a|voice|video|hailuo|image|music|embo|embedding|t2v|i2v|s2v/i;

function minimaxLabel(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** MiniMax `GET /v1/models` → picker rows: chat models only, in MiniMax's
 * order, with the known context windows. */
export function parseMinimaxModels(payload: unknown): CatalogOption[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const known = new Map(MODELS.options.map((option) => [option.id, option]));
  const options: CatalogOption[] = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : row && typeof row === "object" ? (row as { id?: unknown }).id : null;
    if (typeof id !== "string" || !id.trim() || NOT_FOR_CHAT.test(id)) continue;
    if (options.some((option) => option.id === id)) continue;
    const shipped = known.get(id);
    options.push({
      id,
      label: shipped?.label ?? minimaxLabel(id),
      custom: true,
      ...(shipped?.contextWindow ? { contextWindow: shipped.contextWindow } : {}),
    });
  }
  return options;
}

/** The models this key can call, from MiniMax's documented `GET /v1/models`
 * (no tokens spent). Null on any failure. */
export async function probeMinimaxModels(
  apiUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogOption[] | null> {
  if (!apiKey) return null;
  try {
    const response = await fetchImpl(`${apiUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const rows = parseMinimaxModels(await response.json());
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

const minimaxCatalogs = createLiveCatalog<ModelCatalog>({ file: "minimax.json", revive: reviveCatalog });

function minimaxFingerprint(apiUrl: string, apiKey: string): string {
  return [apiUrl, secretId(apiKey)].join("|");
}

/** Tests: wait for the background model listing for this endpoint and key. */
export function settleMinimaxModels(apiUrl: string, apiKey: string): Promise<void> {
  return minimaxCatalogs.settle(minimaxFingerprint(apiUrl, apiKey));
}

export interface MinimaxConfig {
  url: string;
}

interface LocalMiniMaxConfig {
  apiKey: string;
  url: string;
  defaultModel: string;
}

const localConfigSchema = z.object({
  api_key: z.string().optional(),
  region: z.enum(["global", "cn"]).optional(),
  base_url: z.string().optional(),
  default_text_model: z.string().optional(),
});
const driverConfigSchema = z.object({ url: z.string().optional() });

function normalizedApiUrl(value: string): string {
  const root = value.trim().replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

export function loadLocalMiniMaxConfig(home = homedir()): LocalMiniMaxConfig {
  try {
    const raw = localConfigSchema.parse(JSON.parse(readFileSync(join(home, ".mmx", "config.json"), "utf8")));
    const configuredUrl = raw.base_url?.trim()
      ? raw.base_url
      : raw.region === "cn" ? CN_URL : DEFAULT_URL;
    return {
      apiKey: raw.api_key?.trim() ?? "",
      url: normalizedApiUrl(configuredUrl),
      defaultModel: raw.default_text_model?.trim() ?? "",
    };
  } catch {
    return { apiKey: "", url: DEFAULT_URL, defaultModel: "" };
  }
}

export function decodeMinimaxConfig(raw: unknown): MinimaxConfig {
  const parsed = driverConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : {};
  return {
    url: normalizedApiUrl(config.url?.trim() || process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_URL),
  };
}

export const MinimaxDriver: ProviderDriver<MinimaxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "MiniMax (API)", supportsMultipleInstances: true, access: "custom" },
  models: MODELS,
  install: {
    docsUrl: "https://platform.minimax.io/docs/token-plan/minimax-cli",
    command: {
      darwin: "npm install -g mmx-cli",
      linux: "npm install -g mmx-cli",
      win32: "npm install -g mmx-cli",
    },
    signInCommand: "mmx auth login --api-key YOUR_MINIMAX_API_KEY",
    needsNode: true,
  },
  decodeConfig: decodeMinimaxConfig,
  defaultConfig: () => decodeMinimaxConfig({}),

  async create(input) {
    const local = loadLocalMiniMaxConfig();
    const apiKey =
      input.environment[API_KEY_ENV]?.trim() ||
      process.env[API_KEY_ENV]?.trim() ||
      local.apiKey;
    const apiUrl = input.config.url === DEFAULT_URL && local.url !== DEFAULT_URL
      ? local.url
      : input.config.url;
    const fingerprint = minimaxFingerprint(apiUrl, apiKey);
    const withDefault = (options: CatalogOption[]): ModelCatalog => ({
      default: pickDefault(options, local.defaultModel, MODELS.default),
      options,
    });
    // A list this key fetched before (disk) is used at once; no request is
    // made until the picker asks.
    const cached = apiKey ? minimaxCatalogs.peek(fingerprint) : null;
    let models = withDefault(cached?.options ?? MODELS.options);
    const refreshModels = async () => {
      if (!apiKey) return;
      const live = minimaxCatalogs.read(
        fingerprint,
        async () => {
          const rows = await probeMinimaxModels(apiUrl, apiKey);
          return rows ? { default: rows[0]!.id, options: rows } : null;
        },
        { ...process.env, ...input.environment },
      );
      if (live) models = withDefault(live.options);
    };

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl,
      models: () => models,
      refreshModels,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        reasoning_split: true,
        stream_options: stream ? { include_usage: true } : undefined,
      }),
      httpErrorLabel: "MiniMax",
      get missingKeyError() {
        return t("no MiniMax key — set {env} or run mmx auth login --api-key …", { env: API_KEY_ENV });
      },
      get unavailableReason() {
        return t("no MiniMax API key — run mmx auth login --api-key … or set {env}", { env: API_KEY_ENV });
      },
      timeoutMs: 180_000,
      billing: "metered",
      includeUsageInCompleted: true,
      noBodyError: "MiniMax returned no response body",
      nativeLog: {
        source: "minimax.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ textLength: text.length, usage }),
      },
    });
  },
};
