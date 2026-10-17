// Gemini CLI harness support — Google's `gemini` CLI over ACP stdio
// (`gemini --acp`). Rides the generic runtime in acp/core.ts.
//
// RETIRED FROM THE DEFAULT FLEET: Google stopped serving Gemini CLI requests
// for the free/Pro/Ultra tiers on 2026-06-18 and pointed everyone at the
// Antigravity CLI (see drivers/antigravity.ts), so this only reaches a model
// on an enterprise licence. Kept registered for exactly that case — add
// {"instances": {"gemini": {"driver": "geminiAgent"}}} to config.json.
//
// Auth reality since 2026-06-18 (#28): consumer "Login with Google" no
// longer serves the Gemini CLI — consumer tiers route through Antigravity,
// and the login that produced ~/.gemini/oauth_creds.json stopped working
// for them. The remaining paths are a GEMINI_API_KEY, Vertex, or an
// enterprise Code Assist licence (whose OAuth refresh still works). The
// driver cannot tell a consumer from an enterprise file locally, so the
// file check only counts a *live-looking* credential (unexpired access
// token, or a refresh token the CLI may still be able to use) and the
// login note names the three real paths instead of the retired login.
//
// Auth is intentionally lenient (authFailure "continue"): the CLI may run
// off an ambient login, so we attempt the advertised authenticate method
// but never hard-fail the turn on it, unlike Grok's subscription-bound
// cached_token.
//
// NOTE: untested against a live `gemini` CLI on this machine (not installed);
// the ACP flag + auth method ids follow the published Gemini CLI ACP contract
// and should be re-verified end-to-end once the CLI is present.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { t } from "../../../shared/i18n.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { createLiveCatalog, mergeOptions, reviveCatalog, secretId, type CatalogOption } from "../live-catalog.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// What Gemini CLI's own /model picker offers (gemini-cli models.ts and
// acp/acpUtils.ts buildAvailableModels, 2026-10): Auto — the CLI's default,
// which routes to the newest Pro/Flash this account can use — then the
// preview and stable rows, plus the 2.5 Flash id earlier releases shipped.
// A getter so "Auto" follows the active language.
export const STATIC_GEMINI_MODELS: ModelCatalog = {
  default: "auto",
  get options() {
    return [
      { id: "auto", label: t("Auto") },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ];
  },
};

const GEMINI_API = "https://generativelanguage.googleapis.com";
// Gemini models that cannot drive a coding agent: media generation, speech,
// live audio, embeddings, robotics and computer-use specialists.
const NOT_FOR_CHAT = /embedding|image|imagen|veo|lyria|tts|audio|live|robotics|computer-use|aqa/i;

/** Gemini API `models.list` → picker rows: generateContent models only,
 * labelled the way Google names them and sized by their input limit. */
export function parseGeminiApiModels(payload: unknown): CatalogOption[] {
  const models = payload && typeof payload === "object" ? (payload as { models?: unknown }).models : null;
  if (!Array.isArray(models)) return [];
  const options: CatalogOption[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const model = raw as {
      name?: unknown;
      displayName?: unknown;
      inputTokenLimit?: unknown;
      supportedGenerationMethods?: unknown;
    };
    const id = typeof model.name === "string" ? model.name.replace(/^models\//, "") : "";
    if (!id.startsWith("gemini-") || NOT_FOR_CHAT.test(id)) continue;
    const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) continue;
    if (options.some((option) => option.id === id)) continue;
    const label = typeof model.displayName === "string" && model.displayName.trim() ? model.displayName.trim() : id;
    const limit = typeof model.inputTokenLimit === "number" && model.inputTokenLimit > 0 ? model.inputTokenLimit : 0;
    options.push({ id, label, ...(limit ? { contextWindow: limit } : {}) });
  }
  return options;
}

function geminiKey(env: Record<string, string | undefined>): string {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || "";
}

function geminiApiBase(env: Record<string, string | undefined>): string {
  return (env.GOOGLE_GEMINI_BASE_URL?.trim() || GEMINI_API).replace(/\/+$/, "");
}

/** The models a Gemini API key can call, from the free `models.list`
 * endpoint (no tokens spent). Null without a key or on any failure. */
export async function probeGeminiApiModels(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogOption[] | null> {
  const key = geminiKey(env);
  if (!key) return null;
  const options: CatalogOption[] = [];
  let pageToken = "";
  try {
    for (let page = 0; page < 5; page++) {
      const url = `${geminiApiBase(env)}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      // the key rides a header, never the URL, so it stays out of logs
      const response = await fetchImpl(url, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return options.length ? options : null;
      const payload = (await response.json()) as { nextPageToken?: unknown };
      for (const option of parseGeminiApiModels(payload)) {
        if (!options.some((row) => row.id === option.id)) options.push(option);
      }
      pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
      if (!pageToken) break;
    }
  } catch {
    return options.length ? options : null;
  }
  return options.length ? options : null;
}

const geminiCatalogs = createLiveCatalog<ModelCatalog>({ file: "gemini.json", revive: reviveCatalog });

function geminiFingerprint(env: Record<string, string | undefined>): string {
  return [geminiApiBase(env), secretId(geminiKey(env))].join("|");
}

/** The picker catalog without waiting: Gemini CLI's own rows, then every
 * other model the API key can use (cached, refreshed in the background).
 * Vertex and Code Assist logins have no free listing; Auto still reaches
 * the newest models through the CLI's own routing. */
export function geminiModelCatalog(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ModelCatalog {
  const base = STATIC_GEMINI_MODELS.options;
  if (!geminiKey(env)) return { default: STATIC_GEMINI_MODELS.default, options: base };
  const live = geminiCatalogs.read(
    geminiFingerprint(env),
    async () => {
      const rows = await probeGeminiApiModels(env, fetchImpl);
      return rows ? { default: rows[0]!.id, options: rows } : null;
    },
    env,
  );
  return { default: STATIC_GEMINI_MODELS.default, options: mergeOptions(base, live?.options ?? []) };
}

/** Tests: wait for the background API listing for this key. */
export function settleGeminiModels(env: Record<string, string | undefined>): Promise<void> {
  return geminiCatalogs.settle(geminiFingerprint(env));
}

// Prefer an explicit key method, then personal OAuth, then Vertex — but fall
// back to whatever the CLI advertises so a new method id still works.
const AUTH_PREFERENCE = ["gemini-api-key", "oauth-personal", "vertex-ai"];

/** A stored oauth_creds.json only counts when it looks alive: the access
 * token has not passed its expiry_date, or a refresh token is present that
 * an enterprise licence may still redeem. A stale consumer credential —
 * the common case since 2026-06-18 — reads as not signed in, which is the
 * truthful answer for an engine that would fail its first turn anyway. */
function liveOauthCredential(): boolean {
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), ".gemini", "oauth_creds.json"), "utf8")) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expiry_date?: unknown;
    };
    if (typeof creds.access_token !== "string" || creds.access_token.trim().length === 0) return false;
    const hasRefresh = typeof creds.refresh_token === "string" && creds.refresh_token.trim().length > 0;
    if (creds.expiry_date !== undefined) {
      if (typeof creds.expiry_date !== "number" || !Number.isFinite(creds.expiry_date)) return false;
      return Date.now() < creds.expiry_date || hasRefresh;
    }
    // no recorded expiry — treat possession of the credential as the signal
    return true;
  } catch {
    return false;
  }
}

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

/** The credential check as a named function, so the support entry and the
 * exported test surface are the same implementation, not a self-call.
 * Config is unused — kept to match the AcpSupport signature. */
export function geminiIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return (
    nonBlank(env.GEMINI_API_KEY) ||
    nonBlank(env.GOOGLE_API_KEY) ||
    (existsSync(join(homedir(), ".gemini", "oauth_creds.json")) && liveOauthCredential())
  );
}

const support: AcpSupport = {
  driverKind: "geminiAgent",
  displayName: "Gemini",
  models: STATIC_GEMINI_MODELS,
  resolveModels: (env) => geminiModelCatalog(env),
  defaultCli: "gemini",
  nativeSource: "gemini.acp",
  get loginNote() {
    return t(
      "Gemini CLI needs a GEMINI_API_KEY, a Vertex AI setup, or an enterprise Code Assist login — consumer Google logins stopped working on 2026-06-18 (use the Antigravity engine for those accounts)",
    );
  },

  // --acp is the stable Gemini CLI surface. --experimental-acp remains an
  // alias for older releases, but using it now emits a deprecation warning.
  spawnArgs: (_config, turn) => ["--acp", ...(turn.model ? ["-m", turn.model] : [])],
  credentialEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],

  pickAuthMethod: (methods) => {
    const ids = methods.map((m) => m.id).filter((id): id is string => typeof id === "string");
    for (const pref of AUTH_PREFERENCE) if (ids.includes(pref)) return pref;
    return ids[0] ?? null;
  },
  authFailure: "continue",

  isAuthenticated: geminiIsAuthenticated,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GeminiAgentDriver = createAcpDriver(support);
