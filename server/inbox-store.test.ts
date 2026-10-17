import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { InboxStore } from "./inbox-store.ts";

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-inbox-"));
  return { dir, store: new InboxStore(dir) };
};

describe("inbox", () => {
  it("adds idempotently per attempt and counts what the owner must act on", () => {
    const { store } = temp();
    const first = store.add({ kind: "gate_failed", taskId: "t1", subtaskId: "s1", attemptId: "a1", title: "文案", reason: "需要你决定" });
    const again = store.add({ kind: "gate_failed", taskId: "t1", subtaskId: "s1", attemptId: "a1", title: "文案", reason: "需要你决定" });
    expect(again.id).toBe(first.id);
    expect(store.counts()).toEqual({ needsYou: 1, unseen: 1, byTask: { t1: 1 } });
    store.seen(first.id);
    expect(store.counts()).toMatchObject({ needsYou: 1, unseen: 0 });
    const resolved = store.resolve(first.id, "reject", "再写一版");
    expect("error" in resolved).toBe(false);
    expect(store.counts()).toMatchObject({ needsYou: 0, unseen: 0 });
  });

  it("a new attempt gets its own item and survives a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "ein-inbox-"));
    const store = new InboxStore(dir);
    store.add({ kind: "signoff", taskId: "t1", runId: "r1", title: "发布会", reason: "最终确认" });
    store.add({ kind: "gate_failed", taskId: "t1", subtaskId: "s1", attemptId: "a2", title: "文案", reason: "需要你决定" });
    const reloaded = new InboxStore(dir);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.counts().byTask).toEqual({ t1: 2 });
  });

  it("rejects unknown ids and keeps a resolved item resolved", () => {
    const { store } = temp();
    expect(store.resolve("nope", "approve")).toMatchObject({ error: expect.stringContaining("no such") });
    const item = store.add({ kind: "question", title: "问题", reason: "等你回答" });
    store.resolve(item.id, "approve");
    expect(store.resolve(item.id, "reject")).toMatchObject({ resolvedAt: expect.any(Number) });
  });
});
