// Opening a page at one item ("show this doc's v3", "show this routine"):
// the opener switches the page and hands off the item — kept in
// sessionStorage for a page that mounts after this, and announced as a
// window event for one already on screen. The page takes it once.
import { useEffect, useRef } from "react";

export const LIBRARY_OPEN_EVENT = "omb:library-open";
export const LIBRARY_OPEN_KEY = "omb.library.open";
export const CALENDAR_OPEN_EVENT = "omb:calendar-open";
export const CALENDAR_OPEN_KEY = "omb.calendar.open";

export type LibraryOpen = { docId: string; version?: number };
export type CalendarOpen = { routineId: string };

/** A hand-off older than this is a leftover, not a request. */
const FRESH_MS = 30_000;

export function handOff(key: string, event: string, detail: Record<string, unknown>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...detail, at: Date.now() }));
  } catch {
    // private mode: the page still opens, just without the item selected
  }
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(event, { detail })), 0);
}

/** Read and clear a pending hand-off; null when there is none or it is stale. */
export function takeHandOff<T>(key: string, now = Date.now()): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key);
    const parsed = JSON.parse(raw) as T & { at?: number };
    if (typeof parsed?.at === "number" && now - parsed.at > FRESH_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Open the library at one doc (and version). */
export function openLibraryDoc(dispatchShowLibrary: () => void, detail: LibraryOpen): void {
  dispatchShowLibrary();
  handOff(LIBRARY_OPEN_KEY, LIBRARY_OPEN_EVENT, detail);
}

/** Run `apply` for the hand-off waiting when the page mounts and for every
 * one announced while it is on screen. */
export function useHandOff<T>(key: string, event: string, apply: (detail: T) => void): void {
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    const waiting = takeHandOff<T>(key);
    if (waiting) latest.current(waiting);
    const onEvent = (e: Event) => {
      // the stored copy is for a page that was not mounted yet — this one is
      takeHandOff<T>(key);
      const detail = (e as CustomEvent<T>).detail;
      if (detail) latest.current(detail);
    };
    window.addEventListener(event, onEvent);
    return () => window.removeEventListener(event, onEvent);
  }, [key, event]);
}
