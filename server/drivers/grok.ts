// xAI API driver. Grok uses the OpenAI chat-completions wire contract and
// adds the shared transient-failure retry policy.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { grokModelLabel } from "./acp/grok.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { t } from "../../shared/i18n.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";
/** The fallback before the key's own list arrives (xAI's /models, below):
 * the current models (docs.x.ai, October 2026). Retired ids such as grok-4,
 * grok-4-fast and grok-3 still answer — xAI redirects them to grok-4.3 — so
 * a bot that saved one keeps working; they are just not offered any more. */
export const STATIC_XAI_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
    { id: "grok-4.3", label: "Grok 4.3" },
  ],
};
/** The least expensive current model, for the app's own short generations. */
const UTILITY_MODEL = "grok-4.3";
/** Not chat models: image and video generation, speech, embeddings. */
const NOT_CHAT = /(imagine|image|video|vision-only|embed|tts|speech|voice|realtime|audio)/i;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

/** Picker rows from xAI's /models answer: chat models only, newest first. */
export function xaiCatalogFromModels(json: unknown): ModelCatalog | null {
  const rows = Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : [];
  const models = rows
    .flatMap((row) => {
      const record = row as { id?: unknown; created?: unknown };
      const id = typeof record?.id === "string" ? record.id.trim() : "";
      return id && !NOT_CHAT.test(id) ? [{ id, created: typeof record.created === "number" ? record.created : 0 }] : [];
    })
    .sort((a, b) => b.created - a.created);
  const seen = new Set<string>();
  const options = models.flatMap(({ id }) => (seen.has(id) ? [] : (seen.add(id), [{ id, label: grokModelLabel(id) }])));
  if (!options.length) return null;
  return { default: seen.has(STATIC_XAI_MODELS.default) ? STATIC_XAI_MODELS.default : options[0]!.id, options };
}

export interface GrokConfig {
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): GrokConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true },
  models: STATIC_XAI_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    // The key's own model list, asked in the background and seldom: the
    // picker never waits on xAI, and a failed ask is retried soon.
    let catalog = STATIC_XAI_MODELS;
    let nextAsk = 0;
    let asking = false;
    const askModels = () => {
      if (!apiKey || asking || Date.now() < nextAsk) return;
      asking = true;
      void fetch(`${config.url.replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      })
        .then(async (response) => (response.ok ? xaiCatalogFromModels(await response.json()) : null))
        .catch(() => null)
        .then((live) => {
          if (live) catalog = live;
          nextAsk = Date.now() + (live ? REFRESH_MS : RETRY_MS);
        })
        .finally(() => {
          asking = false;
        });
    };
    askModels();
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      models: () => catalog,
      refreshModels: async () => askModels(),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "xAI",
      get missingKeyError() {
        return t("no xAI key — set {env} or config.json xai.key", { env: config.apiKeyEnv });
      },
      get unavailableReason() {
        return t("no xAI API key — add {snippet} to ~/.ein/config.json or set {env}", {
          snippet: '{"xai":{"key":"xai-…"}}',
          env: config.apiKeyEnv,
        });
      },
      timeoutMs: 120_000,
      retryScale: Number(process.env.FAKE_GROK_RETRY_SCALE ?? "1"),
      generateModel: () => (catalog.options.some((option) => option.id === UTILITY_MODEL) ? UTILITY_MODEL : catalog.default),
      nativeLog: {
        source: "xai.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messages }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};
