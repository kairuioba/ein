// Read-mostly data for the company layer (org, brief, spend, library,
// decisions), kept outside the main store: every hook polls its endpoint while
// something on screen uses it, shares one request per URL across components,
// and refetches when the window regains focus. Endpoints that are missing or
// failing leave the fallback in place, so a page renders before the server
// knows the route.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_ORG_RULES,
  type Brief,
  type LibraryDoc,
  type OrgConfig,
  type OrgDecision,
  type OrgEvent,
  type RunDiagnosis,
  type UsageSummary,
} from "../../shared/org-types";

type Entry = {
  data: unknown;
  error: string | null;
  loadedAt: number;
  subscribers: Set<() => void>;
  intervals: Map<() => void, number>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: Promise<void> | null;
};

const entries = new Map<string, Entry>();

function entryFor(url: string): Entry {
  let entry = entries.get(url);
  if (!entry) {
    entry = { data: undefined, error: null, loadedAt: 0, subscribers: new Set(), intervals: new Map(), timer: null, inflight: null };
    entries.set(url, entry);
  }
  return entry;
}

function notify(entry: Entry) {
  for (const fn of entry.subscribers) fn();
}

async function load(url: string): Promise<void> {
  const entry = entryFor(url);
  if (entry.inflight) return entry.inflight;
  entry.inflight = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      entry.data = await res.json();
      entry.error = null;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.loadedAt = Date.now();
      entry.inflight = null;
      notify(entry);
    }
  })();
  return entry.inflight;
}

function reschedule(url: string) {
  const entry = entryFor(url);
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = null;
  const fastest = Math.min(...entry.intervals.values());
  if (Number.isFinite(fastest) && fastest > 0) {
    entry.timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load(url);
    }, fastest);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const [url, entry] of entries) if (entry.subscribers.size) void load(url);
  });
}

/** Refetch every mounted copy of an endpoint now (after a write). */
export function refreshApi(prefix: string): Promise<void> {
  const loads: Promise<void>[] = [];
  for (const [url, entry] of entries) if (url.startsWith(prefix) && entry.subscribers.size) loads.push(load(url));
  return Promise.all(loads).then(() => undefined);
}

export function useApi<T>(url: string | null, fallback: T, intervalMs = 10_000): { data: T; loaded: boolean; error: string | null; refresh: () => Promise<void> } {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!url) return () => {};
      const entry = entryFor(url);
      entry.subscribers.add(onChange);
      entry.intervals.set(onChange, intervalMs);
      reschedule(url);
      if (!entry.loadedAt || Date.now() - entry.loadedAt > intervalMs) void load(url);
      return () => {
        entry.subscribers.delete(onChange);
        entry.intervals.delete(onChange);
        reschedule(url);
      };
    },
    [url, intervalMs],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (url ? entryFor(url).data : undefined),
    () => undefined,
  );
  const error = url ? entryFor(url).error : null;
  const loaded = url ? entryFor(url).loadedAt > 0 : false;
  const refresh = useCallback(() => (url ? load(url) : Promise.resolve()), [url]);
  return { data: (snapshot as T | undefined) ?? fallback, loaded, error, refresh };
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((payload as { error?: string }).error || `${res.status}`);
  return payload as T;
}

// ── org ───────────────────────────────────────────────────────────────────────
export const EMPTY_ORG: OrgConfig = {
  version: 1,
  chiefBotId: null,
  departments: [],
  projects: [],
  rules: DEFAULT_ORG_RULES,
  decisionRights: [],
  updatedAt: 0,
};

export function useOrg() {
  return useApi<OrgConfig>("/api/org", EMPTY_ORG, 15_000);
}

/** Save part of the org config; the server validates and returns the whole. */
export async function saveOrg(patch: Partial<Omit<OrgConfig, "version" | "updatedAt">>): Promise<OrgConfig> {
  const next = await send<OrgConfig>("PATCH", "/api/org", patch);
  await refreshApi("/api/org");
  await refreshApi("/api/brief");
  return next;
}

// ── "since you last looked" ───────────────────────────────────────────────────
const LAST_SEEN_KEY = "omb.lastSeen";

export function getLastSeen(): number {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function markSeen(at = Date.now()): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(at));
  } catch {
    /* private mode — the banner simply shows again next time */
  }
}

// ── brief, events, decisions, spend, library ─────────────────────────────────
export const EMPTY_USAGE: UsageSummary = { currency: "CNY", todayCost: 0, budgetPerDay: 0, weekPercent: null, byBot: [], unpricedTokens: 0 };

export const EMPTY_BRIEF: Brief = {
  at: 0,
  headline: "",
  done: 0,
  total: 0,
  departments: [],
  needsYou: [],
  autoApproved: [],
  expired: [],
  changes: [],
  risks: [],
  spend: EMPTY_USAGE,
  timeline: [],
};

export function useBrief(since: number) {
  // round to the minute so every caller with the same last-seen shares a request
  const sinceKey = Math.floor(since / 60_000) * 60_000;
  return useApi<Brief>(`/api/brief?since=${sinceKey}`, EMPTY_BRIEF, 5_000);
}

export function useOrgEvents(since: number) {
  const sinceKey = Math.floor(since / 60_000) * 60_000;
  return useApi<{ events: OrgEvent[] }>(`/api/org/events?since=${sinceKey}`, { events: [] }, 5_000);
}

export function useDecisions() {
  return useApi<{ decisions: OrgDecision[] }>("/api/org/decisions", { decisions: [] }, 10_000);
}

export function useUsageSummary() {
  return useApi<UsageSummary>("/api/usage/summary", EMPTY_USAGE, 15_000);
}

export function useLibrary() {
  return useApi<{ docs: LibraryDoc[] }>("/api/library", { docs: [] }, 10_000);
}

export async function publishLibraryDoc(input: {
  id?: string;
  title: string;
  section: string | null;
  text: string;
  note?: string;
  ownerBotId?: string;
  /** the line under the title; the server takes the text's first line otherwise */
  summary?: string;
  /** the decision (决议 #n) this version carries out */
  decisionId?: number;
}) {
  const doc = await send<LibraryDoc>("POST", "/api/library", input);
  await refreshApi("/api/library");
  return doc;
}

export async function readLibraryDoc(id: string, version?: number): Promise<{ doc: LibraryDoc; text: string; version: number }> {
  return send("GET", `/api/library/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`);
}

// ── adding people to a running job ───────────────────────────────────────────
export function diagnoseRun(runId: string): Promise<RunDiagnosis> {
  return send("POST", `/api/dispatch/runs/${encodeURIComponent(runId)}/diagnose`, {});
}

export async function amendRun(runId: string, add: number): Promise<{ ok: true; added: string[] }> {
  const result = await send<{ ok: true; added: string[] }>("POST", `/api/dispatch/runs/${encodeURIComponent(runId)}/amend`, { add });
  await refreshApi("/api/brief");
  return result;
}

/** Keep an endpoint warm for a page without reading it (prefetch on hover). */
export function usePrefetch(url: string | null) {
  useEffect(() => {
    if (url) void load(url);
  }, [url]);
}
