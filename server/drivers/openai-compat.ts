// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createLiveCatalog, reviveCatalog, secretId, type CatalogOption } from "./live-catalog.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { t } from "../../shared/i18n.ts";

const DRIVER_KIND = "openai-compat";
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

/** Picker rows from an OpenAI-style `GET /models` answer. Every row is
 * `custom`: this engine advertises `access: "custom"`, and the picker renders
 * only custom-flagged options for such engines. Exported for the test. */
export function parseOpenAICompatModels(payload: unknown): CatalogOption[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const seen = new Set<string>();
  const options: CatalogOption[] = [];
  for (const row of rows) {
    const record = row && typeof row === "object" ? (row as { id?: unknown; name?: unknown }) : null;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof record?.name === "string" && record.name.trim() ? record.name : id;
    options.push({ id, label, custom: true });
  }
  return options;
}

/** The models this endpoint's key can call, from its documented `GET /models`
 * (no tokens spent). Null on any failure. */
export async function probeOpenAICompatModels(
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
    const options = parseOpenAICompatModels(await response.json());
    return options.length ? options : null;
  } catch {
    return null;
  }
}

// The endpoint's own list, cached on disk and refreshed in the background:
// opening the model picker must never fire a `/models` request, and a failed
// ask is retried after a pause — the same contract every other engine's live
// catalog follows (live-catalog.ts).
const compatCatalogs = createLiveCatalog<ModelCatalog>({ file: "openai-compat.json", revive: reviveCatalog });

export function settleOpenAICompatModels(apiUrl: string, apiKey: string): Promise<void> {
  return compatCatalogs.settle([apiUrl, secretId(apiKey)].join("|"));
}

export interface OpenAICompatConfig {
  url: string;
  apiKeyEnv: string;
  key?: string;
  model?: string;
  provider?: string;
}

function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : "OPENAI_COMPAT_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : process.env.OPENAI_COMPAT_MODEL || undefined,
    provider: typeof config.provider === "string" && config.provider
      ? config.provider
      : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // A getter so the setup copy is localized when the UI asks for it, not at
  // module load.
  get install() {
    const getKey = (path: string) =>
      t("Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to {path} under openaiCompat.key", { path });
    return {
      docsUrl: "https://openrouter.ai/keys",
      signInCommand: t("add {snippet} to ~/.ein/config.json (or set OPENAI_COMPAT_API_KEY)", {
        snippet: "{\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}}",
      }),
      command: {
        darwin: getKey("~/.ein/config.json"),
        linux: getKey("~/.ein/config.json"),
        win32: getKey("%USERPROFILE%\\.ein\\config.json"),
      },
    };
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment.OPENAI_COMPAT_API_KEY ??
      process.env[config.apiKeyEnv] ??
      process.env.OPENAI_COMPAT_API_KEY ??
      "";
    // The configured model pins the default even when the live list omits it
    // (an endpoint's list can lag a model the user already selected).
    const buildCatalog = (options: readonly CatalogOption[]): ModelCatalog => {
      const rows = [...options];
      if (config.model && !rows.some((row) => row.id === config.model)) {
        rows.unshift({ id: config.model, label: config.model, custom: true });
      }
      return { default: config.model ?? rows[0]?.id ?? "", options: rows };
    };
    const fingerprint = [config.url, secretId(apiKey)].join("|");
    // A list this endpoint reported before (disk) is used at once; nothing is
    // requested until the picker first asks (refreshModels).
    const cached = apiKey ? compatCatalogs.peek(fingerprint) : null;
    let catalog = buildCatalog(cached?.options ?? DEFAULT_MODELS.options);
    const refreshModels = async () => {
      if (!apiKey) return;
      const live = compatCatalogs.read(
        fingerprint,
        async () => {
          const options = await probeOpenAICompatModels(config.url, apiKey);
          return options ? { default: options[0]!.id, options } : null;
        },
        { ...process.env, ...input.environment },
      );
      if (live) catalog = buildCatalog(live.options);
    };

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      models: () => catalog,
      refreshModels,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        ...(config.provider && isOpenRouterUrl(config.url)
          ? { provider: { order: [config.provider], allow_fallbacks: false } }
          : {}),
      }),
      httpErrorLabel: "upstream",
      get missingKeyError() {
        return t("no API key — set {env} or add it to the instance config", { env: config.apiKeyEnv });
      },
      get unavailableReason() {
        return t("no API key — set {env} or add it to the instance config", { env: config.apiKeyEnv });
      },
      timeoutMs: 120_000,
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "openai-compat.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          usage,
        }),
      },
    });
  },
};
