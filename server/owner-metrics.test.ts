import { describe, expect, it } from "vitest";

import type { InboxItem } from "../shared/dispatch-types.ts";
import type { DispatchRetro } from "./dispatch.ts";
import { buildOwnerMetrics, ownerDayStart, ownerWeekStart } from "./owner-metrics.ts";

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

  it("uses the owner's Asia/Shanghai day boundary, not UTC or the host zone", () => {
    const now = new Date("2026-10-18T02:00:00+08:00").getTime();
    expect(ownerDayStart(now)).toBe(new Date("2026-10-18T00:00:00+08:00").getTime());
    const metrics = buildOwnerMetrics({
      items: [
        // 23:30 the previous local day — before local midnight, so not "today"
        item({ id: "late", createdAt: new Date("2026-10-17T20:00:00+08:00").getTime(), resolvedAt: new Date("2026-10-17T23:30:00+08:00").getTime() }),
        item({ id: "early", createdAt: new Date("2026-10-18T00:05:00+08:00").getTime(), resolvedAt: new Date("2026-10-18T00:30:00+08:00").getTime() }),
      ],
      retros: [],
      now,
    });
    expect(metrics.decisions.today).toBe(1);
  });

  it("starts the week on local Monday in the owner's timezone", () => {
    expect(ownerWeekStart(new Date("2026-10-18T02:00:00+08:00").getTime())).toBe(new Date("2026-10-12T00:00:00+08:00").getTime());
    const now = new Date("2026-10-18T02:00:00+08:00").getTime();
    const metrics = buildOwnerMetrics({
      items: [
        item({ id: "sunday", createdAt: new Date("2026-10-11T20:00:00+08:00").getTime(), resolvedAt: new Date("2026-10-11T23:59:00+08:00").getTime() }),
        item({ id: "monday", createdAt: new Date("2026-10-12T00:01:00+08:00").getTime(), resolvedAt: new Date("2026-10-12T00:05:00+08:00").getTime() }),
      ],
      retros: [],
      now,
    });
    expect(metrics.decisions.week).toBe(1);
  });

  it("accepts another owner timezone and computes its local day", () => {
    const now = new Date("2026-10-18T02:00:00+08:00").getTime(); // 2026-10-17T18:00Z
    expect(ownerDayStart(now, "UTC")).toBe(Date.parse("2026-10-17T00:00:00Z"));
    const utcMetrics = buildOwnerMetrics({
      items: [
        item({ id: "utc-today", createdAt: Date.parse("2026-10-17T01:00:00Z"), resolvedAt: Date.parse("2026-10-17T02:00:00Z") }),
        item({ id: "utc-yesterday", createdAt: Date.parse("2026-10-16T01:00:00Z"), resolvedAt: Date.parse("2026-10-16T02:00:00Z") }),
      ],
      retros: [],
      now,
      timeZone: "UTC",
    });
    expect(utcMetrics.decisions.today).toBe(1);
  });

  it("computes the rework rate from retros and is honest about automation", () => {
    const metrics = buildOwnerMetrics({ items: [], retros: [retro({}), retro({ counts: { total: 6, done: 6, failed: 0, canceled: 0, skipped: 0, retried: 2 } })], now: 5 });
    expect(metrics.rework).toEqual({ rate: 0.3, retriedSubtasks: 3, totalSubtasks: 10 });
    expect(metrics.automation.ratio).toBeNull();
    expect(metrics.automation.note).toContain("not audited");
  });
});
