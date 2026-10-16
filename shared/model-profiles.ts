// Model capability profiles used by the recommender.
//
// A profile is a heuristic judgment about a model family, matched by
// pattern against the model id and label — not a benchmark. Order matters:
// the first matching profile wins, so specific patterns come before broad
// ones ("deepseek-v4-flash" before "deepseek", "gpt-4o-mini" before "gpt-4o").
// Teams can override any family from App Settings (stored as
// `modelProfiles` overrides), so these defaults only need to be sensible.

export const CAPABILITIES = ["coding", "reasoning", "writing", "chinese", "vision", "computer", "longContext", "speed"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type Level = 1 | 2 | 3 | 4 | 5;

export interface ModelProfile {
  /** Stable id for overrides and display. */
  id: string;
  /** Display name of the family. */
  family: string;
  /** Matched against `${modelId} ${label}`, lower-cased. */
  match: RegExp;
  /** Overall capability: 5 = frontier, 1 = small/local. */
  tier: Level;
  /** Relative cost of one task: 5 = most expensive. */
  cost: Level;
  /** Relative latency: 5 = fastest. */
  speed: Level;
  strengths: readonly Capability[];
}

export const MODEL_PROFILES: readonly ModelProfile[] = [
  // CLI defaults: the engine picks its own (usually strong) model.
  { id: "engine-default", family: "Engine default", match: /^(default|auto)(\s|$)/, tier: 4, cost: 3, speed: 3, strengths: ["coding", "reasoning", "writing"] },

  // Anthropic
  { id: "claude-frontier", family: "Claude Opus / Fable", match: /(opus|fable|mythos)/, tier: 5, cost: 5, speed: 2, strengths: ["coding", "reasoning", "writing", "computer", "longContext"] },
  { id: "claude-sonnet", family: "Claude Sonnet", match: /sonnet/, tier: 4, cost: 3, speed: 3, strengths: ["coding", "writing", "reasoning", "computer"] },
  { id: "claude-haiku", family: "Claude Haiku", match: /haiku/, tier: 3, cost: 1, speed: 5, strengths: ["speed", "writing", "coding"] },

  // OpenAI
  { id: "gpt-codex", family: "GPT Codex", match: /codex/, tier: 5, cost: 4, speed: 3, strengths: ["coding", "reasoning"] },
  { id: "gpt-small", family: "GPT mini / nano", match: /gpt-[\d.]+[-\s]?(mini|nano)|o\d-mini|gpt-4o-mini/, tier: 3, cost: 1, speed: 5, strengths: ["speed", "writing"] },
  { id: "gpt-frontier", family: "GPT-5", match: /gpt-?[5-9]|\bo3(-pro)?\b|\bo1-pro\b/, tier: 5, cost: 4, speed: 2, strengths: ["coding", "reasoning", "writing", "vision"] },
  { id: "gpt-4", family: "GPT-4.x", match: /gpt-4/, tier: 3, cost: 3, speed: 4, strengths: ["writing", "vision"] },

  // Google
  { id: "gemini-flash", family: "Gemini Flash", match: /gemini.*(flash|lite)/, tier: 3, cost: 1, speed: 5, strengths: ["speed", "vision", "longContext"] },
  { id: "gemini-pro", family: "Gemini Pro", match: /gemini/, tier: 5, cost: 3, speed: 3, strengths: ["reasoning", "coding", "vision", "longContext"] },

  // xAI
  { id: "grok-fast", family: "Grok Fast", match: /grok.*(fast|mini)/, tier: 3, cost: 1, speed: 5, strengths: ["speed", "coding"] },
  { id: "grok", family: "Grok", match: /grok/, tier: 4, cost: 3, speed: 3, strengths: ["reasoning", "coding"] },

  // China-based model families
  { id: "deepseek-fast", family: "DeepSeek Flash / Chat", match: /deepseek.*(flash|chat|lite)/, tier: 3, cost: 1, speed: 4, strengths: ["chinese", "writing", "coding", "speed"] },
  { id: "deepseek", family: "DeepSeek", match: /deepseek/, tier: 4, cost: 2, speed: 3, strengths: ["coding", "reasoning", "chinese"] },
  { id: "kimi", family: "Kimi", match: /kimi|moonshot/, tier: 4, cost: 2, speed: 3, strengths: ["coding", "chinese", "longContext"] },
  { id: "glm-air", family: "GLM Air / Flash", match: /glm.*(air|flash)/, tier: 3, cost: 1, speed: 4, strengths: ["chinese", "speed"] },
  { id: "glm", family: "GLM", match: /glm/, tier: 4, cost: 2, speed: 3, strengths: ["coding", "chinese", "reasoning"] },
  { id: "qwen-coder", family: "Qwen Coder", match: /qwen.*coder/, tier: 4, cost: 2, speed: 3, strengths: ["coding", "chinese"] },
  { id: "qwen-max", family: "Qwen Max", match: /qwen.*max|qwq/, tier: 4, cost: 2, speed: 3, strengths: ["reasoning", "chinese", "writing"] },
  { id: "qwen", family: "Qwen", match: /qwen/, tier: 3, cost: 1, speed: 4, strengths: ["chinese", "writing", "speed"] },
  { id: "hunyuan", family: "Hunyuan", match: /hunyuan/, tier: 4, cost: 2, speed: 3, strengths: ["chinese", "writing", "reasoning"] },
  { id: "doubao", family: "Doubao", match: /doubao|seed-/, tier: 4, cost: 1, speed: 4, strengths: ["chinese", "writing", "speed"] },
  { id: "minimax", family: "MiniMax", match: /minimax|abab/, tier: 4, cost: 1, speed: 4, strengths: ["coding", "chinese", "speed"] },

  // Open-weight models usually served locally (Ollama, LM Studio, vLLM)
  { id: "local-large", family: "Open-weight (large)", match: /(llama|mistral|gemma|phi|gpt-oss)[^\s]*?(70b|72b|120b|405b|large)/, tier: 3, cost: 1, speed: 2, strengths: ["writing"] },
  { id: "local", family: "Open-weight", match: /llama|mistral|gemma|phi-?\d|gpt-oss|::/, tier: 2, cost: 1, speed: 3, strengths: ["speed"] },
];

export const UNKNOWN_PROFILE: ModelProfile = {
  id: "unknown",
  family: "Unknown model",
  match: /$^/,
  tier: 3,
  cost: 2,
  speed: 3,
  strengths: [],
};

export type ProfileOverride = Partial<Pick<ModelProfile, "tier" | "cost" | "speed" | "strengths">>;

/** The profile for a model, with any team override for its family applied. */
export function profileFor(
  modelId: string,
  label = "",
  overrides: Readonly<Record<string, ProfileOverride>> = {},
): ModelProfile {
  const haystack = `${modelId} ${label}`.toLowerCase();
  const base = MODEL_PROFILES.find((profile) => profile.match.test(haystack)) ?? UNKNOWN_PROFILE;
  const override = overrides[base.id];
  return override ? { ...base, ...override } : base;
}
