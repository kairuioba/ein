import { describe, expect, it } from "vitest";

import type { InboxItem } from "../shared/dispatch-types.ts";
import type { DispatchRetro } from "./dispatch.ts";
import type { EvolutionItem } from "./evolution.ts";
import { buildWeeklyRetro } from "./weekly-retro.ts";

// 2026-10-18 is a Sunday; the local (Asia/Shanghai) week started Mon 10-12 00:00.
const NOW = new Date("2026-10-18T09:00:00+08:00").getTime();
const WEEK_START = new Date("2026-10-12T00:00:00+08:00").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const retro = (extra: Partial<DispatchRetro> = {}): DispatchRetro =>
  ({
    at: NOW - DAY,
    runId: "r1",
    goal: "官网改版",
    status: "done",
    chiefBotId: "c",
    finishedAt: NOW - DAY,
    counts: { total: 4, done: 4, failed: 0, canceled: 0, skipped: 0, retried: 1 },
    versions: { schema: 2, prompt: 1, gate: 1, models: [] },
    subtasks: [],
    ...extra,
  }) as DispatchRetro;

const item = (extra: Partial<InboxItem>): InboxItem => ({
  id: "i1",
  kind: "signoff",
  title: "确认交付",
  reason: "r",
  createdAt: NOW - 60 * MIN,
  ...extra,
});

const proposal = (extra: Partial<EvolutionItem>): EvolutionItem =>
  ({
    id: "p1",
    signal: "gate-needs-human",
    title: "把验收标准写得更可判定",
    why: "w",
    suggestedChange: "s",
    area: "prompt",
    risk: "low",
    evidence: [],
    status: "accepted",
    createdAt: NOW - DAY,
    resolvedAt: NOW - DAY,
    ...extra,
  }) as EvolutionItem;

describe("buildWeeklyRetro", () => {
  it("reports honest empties instead of making numbers up", () => {
    const retro = buildWeeklyRetro({ retros: [], inboxItems: [], evolutionProposals: [], now: NOW });
    expect(retro.windowDays).toBe(7);
    expect(retro.metrics).toEqual({ completed: 0, retriedRate: null, decisionLatencyP50Ms: null, decisions: 0 });
    expect(retro.review).toEqual({ adopted: 0, rejected: 0, deferred: 0 });
    expect(retro.highlights).toContain("本周还没有完成的任务。");
    expect(retro.highlights).toContain("本周没有可计算的返工率。");
    expect(retro.warnings).toContain("本周没有可复盘的任务。");
  });

  it("computes the retry rate inside the local week, skipping child runs and older weeks", () => {
    const weekly = buildWeeklyRetro({
      retros: [
        retro({ counts: { total: 4, done: 4, failed: 0, canceled: 0, skipped: 0, retried: 1 } }),
        retro({ runId: "r2", counts: { total: 6, done: 6, failed: 0, canceled: 0, skipped: 0, retried: 3 } }),
        // a department's child run — part of r1, must not be counted twice
        retro({ runId: "r1-child", parentRunId: "r1", counts: { total: 4, done: 4, failed: 0, canceled: 0, skipped: 0, retried: 1 } }),
        // last week
        retro({ runId: "old", finishedAt: WEEK_START - 1, counts: { total: 100, done: 100, failed: 0, canceled: 0, skipped: 0, retried: 90 } }),
      ],
      now: NOW,
    });
    expect(weekly.metrics.completed).toBe(2);
    expect(weekly.metrics.retriedRate).toBe(0.4); // (1+3) / (4+6)
    expect(weekly.highlights.join(" ")).toContain("40%：4 / 10");
    expect(weekly.warnings.join(" ")).toContain("返工率超过 30%");
  });

  it("counts only owner-resolved decisions and reports their median wait", () => {
    const retro = buildWeeklyRetro({
      inboxItems: [
        item({ id: "a", createdAt: NOW - 40 * MIN, resolvedAt: NOW - 10 * MIN }), // 30m
        item({ id: "b", createdAt: NOW - 120 * MIN, resolvedAt: NOW - 60 * MIN }), // 60m
        item({ id: "c", createdAt: NOW - 20 * MIN, resolvedAt: NOW - 5 * MIN }), // 15m
        item({ id: "open" }),
        item({ id: "last-week", resolvedAt: WEEK_START - 1 }),
      ],
      now: NOW,
    });
    expect(retro.metrics.decisions).toBe(3);
    expect(retro.metrics.decisionLatencyP50Ms).toBe(30 * MIN);
    expect(retro.highlights.join(" ")).toContain("3 个决定");
    expect(retro.warnings.join(" ")).toContain("1 件还挂在「需要你」");
  });

  it("uses the local Monday window and follows the requested timezone", () => {
    // Sunday 23:59 local is last week; Monday 00:01 is this week.
    const shanghai = buildWeeklyRetro({
      retros: [
        retro({ runId: "sun", finishedAt: new Date("2026-10-11T23:59:00+08:00").getTime() }),
        retro({ runId: "mon", finishedAt: new Date("2026-10-12T00:01:00+08:00").getTime() }),
      ],
      now: NOW,
    });
    expect(shanghai.metrics.completed).toBe(1);
    // The same instant is still Sunday in UTC, so a UTC owner sees it too...
    const utc = buildWeeklyRetro({
      retros: [retro({ finishedAt: new Date("2026-10-11T23:59:00+08:00").getTime() })],
      now: NOW,
      timeZone: "UTC",
    });
    expect(utc.metrics.completed).toBe(0); // 2026-10-11T15:59Z is still in the previous UTC week (Mon 10-05)
    expect(buildWeeklyRetro({ now: NOW, timeZone: "UTC" }).highlights.at(-1)).toContain("(UTC)".replace(/[()]/g, ""));
  });

  it("tallies only proposals decided this week, by status", () => {
    const retro = buildWeeklyRetro({
      evolutionProposals: [
        proposal({ id: "a", status: "accepted" }),
        proposal({ id: "r", status: "rejected" }),
        proposal({ id: "d", status: "deferred" }),
        proposal({ id: "open", status: "open", resolvedAt: undefined }),
        proposal({ id: "old", status: "accepted", resolvedAt: WEEK_START - 1 }),
      ],
      now: NOW,
    });
    expect(retro.review).toEqual({ adopted: 1, rejected: 1, deferred: 1 });
  });

  it("emits only fixed templates with numbers (no model prose) and is order-independent", () => {
    const retros = [retro({ runId: "1" }), retro({ runId: "2", finishedAt: NOW - 2 * DAY })];
    const items = [
      item({ id: "a", resolvedAt: NOW - MIN }),
      item({ id: "b", createdAt: NOW - 30 * MIN }),
    ];
    const proposals = [proposal({ id: "p" })];
    const one = buildWeeklyRetro({ retros, inboxItems: items, evolutionProposals: proposals, now: NOW });
    const two = buildWeeklyRetro({
      retros: [...retros].reverse(),
      inboxItems: [...items].reverse(),
      evolutionProposals: [...proposals].reverse(),
      now: NOW,
    });
    expect(two).toEqual(one);
    // Output is a closed set of phrases filled with counts — no free-form prose.
    const TEMPLATE =
      /^(?:本周完成 \d+ 个任务。|本周还没有完成的任务。|本周没有可计算的返工率。|返工率 \d+%：\d+ \/ \d+ 个子任务重试过。|你做了 \d+ 个决定，中位等待 \d+ 分钟。|本周没有需要你拍板的事。|改进提案：采纳 \d+，驳回 \d+，延后 \d+。|统计窗口：本地周一 00:00 起 7 天（[A-Za-z/_+-]+）。|本周没有可复盘的任务。|返工率超过 \d+%：下周先查验收标准与评审人。|有任务完成但 0 个决定：确认是自治生效，而不是漏记。|\d+ 件还挂在「需要你」，周复盘前先清掉。)$/;
    for (const line of [...one.highlights, ...one.warnings]) expect(line).toMatch(TEMPLATE);
  });
});
