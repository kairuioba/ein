// xAI API driver. Grok uses the OpenAI chat-completions wire contract and
// adds the shared transient-failure retry policy.
import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { t } from "../../shared/i18n.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";
const MODELS = {
  default: "grok-4",
  options: [
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

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
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      models: () => MODELS,
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
      generateModel: () => "grok-3-mini",
      nativeLog: {
        source: "xai.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messages }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};
