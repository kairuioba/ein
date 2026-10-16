import { beforeEach, describe, expect, it, vi } from "vitest";

import { LIBRARY_OPEN_KEY, takeHandOff } from "./deep-links";

// The suite runs on the node environment, which has no sessionStorage.
const store = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => store.clear());

describe("takeHandOff", () => {
  it("returns a fresh hand-off once, then nothing", () => {
    store.set(LIBRARY_OPEN_KEY, JSON.stringify({ docId: "pricing", version: 3, at: 1_000 }));
    expect(takeHandOff(LIBRARY_OPEN_KEY, 2_000)).toMatchObject({ docId: "pricing", version: 3 });
    expect(takeHandOff(LIBRARY_OPEN_KEY, 2_000)).toBeNull();
  });

  it("drops a stale or broken hand-off", () => {
    store.set(LIBRARY_OPEN_KEY, JSON.stringify({ docId: "pricing", at: 1_000 }));
    expect(takeHandOff(LIBRARY_OPEN_KEY, 1_000 + 60_000)).toBeNull();
    expect(store.has(LIBRARY_OPEN_KEY)).toBe(false);
    store.set(LIBRARY_OPEN_KEY, "{nope");
    expect(takeHandOff(LIBRARY_OPEN_KEY)).toBeNull();
  });
});
