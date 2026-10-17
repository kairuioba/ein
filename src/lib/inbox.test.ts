// 「稍后」回流（localStorage ein.inbox.snooze）的纯函数测试：
// 解析/到期过滤/取消/存储清理，以及统一口径 needs-owner 的容错解析。
// 不依赖浏览器：所有存储函数都接受注入的 fake Storage。
import { describe, expect, it } from "vitest";

import {
  INBOX_SNOOZE_MS,
  INBOX_SNOOZE_STORAGE_KEY,
  activeInboxSnoozes,
  cancelInboxSnooze,
  isInboxItemSnoozed,
  needsOwnerTotalFromPayload,
  parseInboxSnoozes,
  readInboxSnoozes,
  snoozeInboxItem,
  splitBySnooze,
  writeInboxSnoozes,
  type InboxSnoozeStorage,
} from "./inbox";

const NOW = 1_800_000_000_000;

function fakeStorage(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}));
  const storage: InboxSnoozeStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { storage, data };
}

describe("inbox snooze storage", () => {
  it("parses the stored JSON defensively", () => {
    expect(parseInboxSnoozes(null)).toEqual({});
    expect(parseInboxSnoozes("")).toEqual({});
    expect(parseInboxSnoozes("not json")).toEqual({});
    expect(parseInboxSnoozes("[]")).toEqual({});
    expect(parseInboxSnoozes('{"a":123,"b":"456","c":-1,"d":null,"e":0}')).toEqual({ a: 123, b: 456 });
  });

  it("snoozes 24h from now and persists it under the shared key", () => {
    const { storage, data } = fakeStorage();
    const until = snoozeInboxItem("item-1", NOW, storage);
    expect(until).toBe(NOW + INBOX_SNOOZE_MS);
    expect(INBOX_SNOOZE_MS).toBe(24 * 60 * 60 * 1000);
    expect(readInboxSnoozes(storage)).toEqual({ "item-1": NOW + INBOX_SNOOZE_MS });
    expect(JSON.parse(data.get(INBOX_SNOOZE_STORAGE_KEY) ?? "{}")).toEqual({
      "item-1": NOW + INBOX_SNOOZE_MS,
    });

    // a second snooze accumulates ids, not replaces them
    snoozeInboxItem("item-2", NOW, storage);
    expect(Object.keys(readInboxSnoozes(storage)).sort()).toEqual(["item-1", "item-2"]);
  });

  it("drops expired snoozes so they come back", () => {
    const map = { fresh: NOW + 60_000, expired: NOW - 1, boundary: NOW };
    expect(activeInboxSnoozes(map, NOW)).toEqual({ fresh: NOW + 60_000 });

    const items = [{ id: "fresh" }, { id: "expired" }, { id: "boundary" }, { id: "never" }];
    const split = splitBySnooze(items, map, NOW);
    expect(split.snoozed.map((item) => item.id)).toEqual(["fresh"]);
    expect(split.due.map((item) => item.id)).toEqual(["expired", "boundary", "never"]);
    expect(isInboxItemSnoozed("fresh", map, NOW)).toBe(true);
    expect(isInboxItemSnoozed("expired", map, NOW)).toBe(false);
  });

  it("cancels (brings back) one item and cleans the key when nothing is left", () => {
    const { storage, data } = fakeStorage();
    snoozeInboxItem("item-1", NOW, storage);
    expect(cancelInboxSnooze("item-1", storage)).toBe(true);
    expect(readInboxSnoozes(storage)).toEqual({});
    // last entry removed → the storage key is cleaned, not left as "{}"
    expect(data.has(INBOX_SNOOZE_STORAGE_KEY)).toBe(false);
    expect(cancelInboxSnooze("never-snoozed", storage)).toBe(false);
  });

  it("prunes expired entries when writing, and is safe without storage", () => {
    const { storage, data } = fakeStorage();
    writeInboxSnoozes({ fresh: Date.now() + 60_000, expired: Date.now() - 60_000 }, storage);
    const stored = JSON.parse(data.get(INBOX_SNOOZE_STORAGE_KEY) ?? "{}") as Record<string, number>;
    expect(Object.keys(stored)).toEqual(["fresh"]);
    expect(() => writeInboxSnoozes({}, storage)).not.toThrow();
    expect(data.has(INBOX_SNOOZE_STORAGE_KEY)).toBe(false);
    // localStorage unavailable (private mode): in-memory callers never throw
    expect(readInboxSnoozes(null)).toEqual({});
    expect(snoozeInboxItem("x", NOW, null)).toBe(NOW + INBOX_SNOOZE_MS);
  });
});

describe("needs-owner total", () => {
  it("reads the unified count from the route shape and falls back to null", () => {
    expect(needsOwnerTotalFromPayload({ needsOwner: { total: 3 } })).toBe(3);
    expect(needsOwnerTotalFromPayload({ total: 2 })).toBe(2);
    expect(needsOwnerTotalFromPayload({ needsOwner: { total: "3" } })).toBeNull();
    expect(needsOwnerTotalFromPayload({ needsOwner: { total: -1 } })).toBeNull();
    expect(needsOwnerTotalFromPayload({})).toBeNull();
    expect(needsOwnerTotalFromPayload(null)).toBeNull();
  });
});
