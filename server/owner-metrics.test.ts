import { describe, expect, it } from "vitest";

import type { InboxItem } from "../shared/dispatch-types.ts";
import type { DispatchRetro } from "./dispatch.ts";
import { buildOwnerMetrics } from "./owner-metrics.ts";

const item = (extra: Partial<InboxItem>): InboxItem => ({
  id: "i1",
  kind: "signoff",
  title: "t",
  reason: "r",
  createdAt: 1000,
  ...extra,
});

const retro = (extra: Partial<DispatchRetro>): DispatchRetro =>
  ({ at: 1, runId: "r", goal: "g", status: "done", chiefBotId: "c", finishedAt: 1, counts: { total: 4, done: 4, failed: 0, canceled: 0, skipped: 0, retried: 1 }, subtasks: [], versions: { schema: 2, prompt: 1, gate: 1, models: [] }, ...extra }) as DispatchRetro;

describe("owner-time metrics", () => {
  it("computes decision latency percentiles and today/week/open counts", () => {
    const now = new Date("2026-10-18T02:00:00+08:00").getTime();
    const metrics = buildOwnerMetrics({
      items: [
        item({ id: "a", createdAt: now - 10 * 60_000, resolvedAt: now - 5 * 60_000 }),
        item({ id: "b", createdAt: now - 30 * 60_000, resolvedAt: now - 10 * 60_000 }),
        item({ id: "c", createdAt: now - 20 * 60_000 }),
      ],
      retros: [retro({})],
      now,
    });
    expect(metrics.decisions.open).toBe(1);
    expect(metrics.decisions.today).toBe(2);
    expect(metrics.latency.samples).toBe(2);
    expect(metrics.latency.p50Ms).toBe(5 * 60_000);
    expect(metrics.latency.p90Ms).toBe(20 * 60_000);
  });

  it("computes the rework rate from retros and is honest about automation", () => {
    const metrics = buildOwnerMetrics({ items: [], retros: [retro({}), retro({ counts: { total: 6, done: 6, failed: 0, canceled: 0, skipped: 0, retried: 2 } })], now: 5 });
    expect(metrics.rework).toEqual({ rate: 0.3, retriedSubtasks: 3, totalSubtasks: 10 });
    expect(metrics.automation.ratio).toBeNull();
    expect(metrics.automation.note).toContain("not audited");
  });
});
