// Live model catalogs — one cache for every engine that can ask its own CLI,
// config or account which models exist, so a model a vendor ships tomorrow
// shows up in the picker without an Ein release.
//
// The picker never waits on it. describe() reads whatever is cached; when
// that answer is missing or older than its TTL, one background probe starts
// and the next describe() shows the result. A probe that fails or times out
// keeps the last good answer and is not retried for a while. Answers persist
// under DATA_DIR/model-catalogs, so a restart opens on the last list the
// engine reported instead of the shipped fallback.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import type { ModelCatalog } from "../contracts.ts";

export type CatalogOption = ModelCatalog["options"][number];

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_RETRY_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENTRIES = 8;

export interface LiveCatalogOptions<T> {
  /** File under DATA_DIR/model-catalogs that keeps answers across restarts. */
  file: string;
  /** Turn a value read back from disk into T, or null to drop it. */
  revive(raw: unknown): T | null;
  /** A good answer is reused this long before a background re-probe. */
  ttlMs?: number;
  /** After a failed probe, wait this long before trying again. */
  retryMs?: number;
  /** Stop waiting for a probe after this long (the probe kills its own child). */
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface LiveCatalog<T> {
  /** The last good answer for this fingerprint (memory, else disk), or null.
   * Starts one background probe when that answer is missing or stale, unless
   * one is running, the last failure is recent, or `env` disables probes.
   * Never waits. */
  read(
    fingerprint: string,
    probe: () => Promise<T | null>,
    env?: Record<string, string | undefined>,
  ): T | null;
  /** The cached answer without ever probing. */
  peek(fingerprint: string): T | null;
  /** Resolves once the probe in flight for this fingerprint, if any, is done. */
  settle(fingerprint: string): Promise<void>;
  /** Forget what is in memory (tests); the disk copy is read again on next use. */
  reset(): void;
}

/** Background probes spawn real CLIs. Unit tests run under VITEST and opt in
 * per instance with EIN_PROBE_LIVE_MODELS=1 — the same convention as
 * mergeLocalInject's EIN_PROBE_LOCAL_INJECT — so a stray probe can never race
 * a test's own fake CLI. */
export function liveModelProbesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const vitest = env.VITEST ?? process.env.VITEST;
  if (!vitest || vitest === "false" || vitest === "0") return true;
  return (env.EIN_PROBE_LIVE_MODELS ?? process.env.EIN_PROBE_LIVE_MODELS) === "1";
}

/** A short one-way id for a secret that selects which account a list belongs to. */
export function secretId(value: string | undefined): string {
  const secret = value?.trim();
  return secret ? createHash("sha256").update(secret).digest("hex").slice(0, 12) : "-";
}

function sanitizeOption(raw: unknown): CatalogOption | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || typeof row.label !== "string") return null;
  return {
    id: row.id,
    label: row.label || row.id,
    ...(row.custom === true ? { custom: true } : {}),
    ...(row.loaded === true ? { loaded: true } : {}),
    ...(typeof row.contextWindow === "number" && Number.isFinite(row.contextWindow) && row.contextWindow > 0
      ? { contextWindow: Math.floor(row.contextWindow) }
      : {}),
  };
}

/** Revive a cached ModelCatalog; anything malformed is dropped row by row. */
export function reviveCatalog(raw: unknown): ModelCatalog | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { default?: unknown; options?: unknown };
  if (!Array.isArray(record.options)) return null;
  const options = record.options.flatMap((row) => {
    const option = sanitizeOption(row);
    return option ? [option] : [];
  });
  if (!options.length) return null;
  const fallback = options[0]!.id;
  const preferred = typeof record.default === "string" ? record.default : "";
  return { default: options.some((option) => option.id === preferred) ? preferred : fallback, options };
}

function withTimeout<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function createLiveCatalog<T>(options: LiveCatalogOptions<T>): LiveCatalog<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const path = () => join(DATA_DIR, "model-catalogs", options.file);

  const entries = new Map<string, { at: number; value: T }>();
  const failedAt = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  let loaded = false;

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(readFileSync(path(), "utf8")) as { entries?: unknown };
      for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
        if (!item || typeof item !== "object") continue;
        const row = item as { fingerprint?: unknown; at?: unknown; value?: unknown };
        if (typeof row.fingerprint !== "string" || entries.has(row.fingerprint)) continue;
        const value = options.revive(row.value);
        if (value === null) continue;
        entries.set(row.fingerprint, { at: Number(row.at) || 0, value });
      }
    } catch {
      // first launch, or an older or damaged file: probe afresh
    }
  };

  const persist = () => {
    try {
      const file = path();
      mkdirSync(join(DATA_DIR, "model-catalogs"), { recursive: true });
      const body = JSON.stringify(
        { version: 1, entries: [...entries].map(([fingerprint, entry]) => ({ fingerprint, ...entry })) },
        null,
        2,
      );
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, body, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // a read-only data dir only costs the next launch a fresh probe
    }
  };

  const remember = (fingerprint: string, value: T) => {
    entries.delete(fingerprint);
    entries.set(fingerprint, { at: now(), value });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    failedAt.delete(fingerprint);
    persist();
  };

  const peek = (fingerprint: string): T | null => {
    load();
    return entries.get(fingerprint)?.value ?? null;
  };

  return {
    peek,
    read(fingerprint, probe, env) {
      load();
      const hit = entries.get(fingerprint) ?? null;
      const at = now();
      const stale = !hit || at - hit.at >= ttlMs;
      const backingOff = at - (failedAt.get(fingerprint) ?? Number.NEGATIVE_INFINITY) < retryMs;
      if (stale && !backingOff && !inflight.has(fingerprint) && liveModelProbesEnabled(env)) {
        const run = withTimeout(Promise.resolve().then(probe), timeoutMs)
          .then((value) => {
            if (value === null || value === undefined) failedAt.set(fingerprint, now());
            else remember(fingerprint, value);
          })
          .finally(() => {
            inflight.delete(fingerprint);
          });
        inflight.set(fingerprint, run);
      }
      return hit?.value ?? null;
    },
    settle: (fingerprint) => inflight.get(fingerprint) ?? Promise.resolve(),
    reset() {
      entries.clear();
      failedAt.clear();
      loaded = false;
    },
  };
}

/** Rows of `primary`, then rows of `extra` whose id is new. */
export function mergeOptions(primary: readonly CatalogOption[], extra: readonly CatalogOption[]): CatalogOption[] {
  const seen = new Set(primary.map((option) => option.id));
  const merged = primary.map((option) => ({ ...option }));
  for (const option of extra) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push({ ...option });
  }
  return merged;
}

/** The first of `preferred` that the options contain, else the first option. */
export function pickDefault(options: readonly CatalogOption[], ...preferred: Array<string | null | undefined>): string {
  for (const id of preferred) {
    if (id && options.some((option) => option.id === id)) return id;
  }
  return options[0]?.id ?? "";
}
