// Gemini catalog: Gemini CLI's own picker rows, plus — with an API key —
// every chat model the key can call, read from the free models.list endpoint.
import { describe, expect, it } from "vitest";

import {
  geminiModelCatalog,
  GeminiAgentDriver,
  parseGeminiApiModels,
  probeGeminiApiModels,
  settleGeminiModels,
  STATIC_GEMINI_MODELS,
} from "./gemini.ts";

const PAGE_ONE = {
  models: [
    {
      name: "models/gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro Preview",
      inputTokenLimit: 1_048_576,
      supportedGenerationMethods: ["generateContent", "countTokens"],
    },
    {
      name: "models/gemini-4-pro-preview",
      displayName: "Gemini 4 Pro Preview",
      inputTokenLimit: 2_097_152,
      supportedGenerationMethods: ["generateContent"],
    },
    { name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-3.5-flash-image", displayName: "Nano Banana", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-flash-preview-tts", displayName: "TTS", supportedGenerationMethods: ["generateContent"] },
  ],
  nextPageToken: "page-2",
};
const PAGE_TWO = {
  models: [
    { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/imagen-5.0-generate", displayName: "Imagen 5", supportedGenerationMethods: ["predict"] },
  ],
};

function fakeApi(calls: Array<{ url: string; headers: Record<string, string> }>, status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (status !== 200) return new Response("denied", { status });
    return new Response(JSON.stringify(url.includes("pageToken=page-2") ? PAGE_TWO : PAGE_ONE), { status: 200 });
  }) as typeof fetch;
}

describe("Gemini catalog", () => {
  it("ships Gemini CLI's own rows with Auto as the default and keeps the earlier ids", () => {
    expect(STATIC_GEMINI_MODELS.default).toBe("auto");
    const ids = STATIC_GEMINI_MODELS.options.map((option) => option.id);
    expect(ids[0]).toBe("auto");
    expect(ids).toEqual(expect.arrayContaining(["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash"]));
    expect(GeminiAgentDriver.models.default).toBe("auto");
  });

  it("keeps only chat models from models.list, named and sized the way Google lists them", () => {
    expect(parseGeminiApiModels(PAGE_ONE)).toEqual([
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", contextWindow: 1_048_576 },
      { id: "gemini-4-pro-preview", label: "Gemini 4 Pro Preview", contextWindow: 2_097_152 },
    ]);
    expect(parseGeminiApiModels(null)).toEqual([]);
  });

  it("pages through models.list with the key in a header, never the URL", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const rows = await probeGeminiApiModels({ GEMINI_API_KEY: "AIza-secret" }, fakeApi(calls));
    expect(rows?.map((row) => row.id)).toEqual(["gemini-3.1-pro-preview", "gemini-4-pro-preview", "gemini-3.8-flash"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.url.includes("AIza-secret") && call.headers["x-goog-api-key"] === "AIza-secret")).toBe(true);
    await expect(probeGeminiApiModels({}, fakeApi([]))).resolves.toBeNull();
    await expect(probeGeminiApiModels({ GEMINI_API_KEY: "bad" }, fakeApi([], 403))).resolves.toBeNull();
  });

  it("adds what the key can use after Gemini CLI's rows, without waiting for the API", async () => {
    const env = { GEMINI_API_KEY: "AIza-catalog", EIN_PROBE_LIVE_MODELS: "1", VITEST: "true" };
    const first = geminiModelCatalog(env, fakeApi([]));
    expect(first.options.map((option) => option.id)).toEqual(STATIC_GEMINI_MODELS.options.map((option) => option.id));
    await settleGeminiModels(env);
    const live = geminiModelCatalog(env, fakeApi([]));
    expect(live.default).toBe("auto");
    expect(live.options.slice(0, STATIC_GEMINI_MODELS.options.length).map((option) => option.id)).toEqual(
      STATIC_GEMINI_MODELS.options.map((option) => option.id),
    );
    expect(live.options.slice(STATIC_GEMINI_MODELS.options.length)).toEqual([
      { id: "gemini-4-pro-preview", label: "Gemini 4 Pro Preview", contextWindow: 2_097_152 },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ]);
  });

  it("offers the CLI's own rows when there is no key to list with", () => {
    expect(geminiModelCatalog({ EIN_PROBE_LIVE_MODELS: "1" }, fakeApi([])).options).toEqual(STATIC_GEMINI_MODELS.options);
  });
});
