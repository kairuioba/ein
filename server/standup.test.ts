import { describe, expect, it } from "vitest";

import type { DispatchRun, InboxItem, RunStatus } from "../shared/dispatch-types.ts";
import { buildStandup, STANDUP_OWNER_SLA_MS, STANDUP_STALL_MS } from "./standup.ts";

const NOW = new Date("2026-10-18T09:00:00+08:00").getTime();
const MIN = 60_000;

const run = (extra: Partial<DispatchRun> & { status?: RunStatus } = {}): DispatchRun =>
  ({
    id: "r1",
    chiefBotId: "c",
    sourceThreadId: "s",
    goal: "官网改版",
    policy: "balanced",
    status: "running",
    subtasks: [],
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW - MIN,
    ...extra,
  }) as DispatchRun;

const subtask = (extra: Record<string, unknown> = {}) =>
  ({
    id: "s1",
    title: "首版文案",
    brief: "写",
    role: "文案",
    needs: [],
    difficulty: 3,
    dependsOn: [],
    assigneeBotId: "b",
    status: "running",
    attempts: 1,
    ...extra,
  }) as DispatchRun["subtasks"][number];

const inbox = (extra: Partial<InboxItem>): InboxItem => ({
  id: "i1",
  kind: "signoff",
  title: "确认交付",
  reason: "r",
  createdAt: NOW - 10 * MIN,
  ...extra,
});

describe("buildStandup", () => {
  it("says one human line and counts zero when there is nothing to report", () => {
    const standup = buildStandup({ runs: [], inboxItems: [], now: NOW });
    expect(standup.lines).toEqual(["今天没有需要你的事，团队在自己跑。"]);
    expect(standup.blockers).toEqual([]);
    expect(standup.counts).toEqual({ running: 0, blocked: 0, waitingOwner: 0 });
    expect(standup.generatedAt).toBe(NOW);
  });

  it("lists failures, stalled runs and overdue owner items, longest wait first", () => {
    const standup = buildStandup({
      runs: [
        run({
          id: "r1",
          goal: "官网改版",
          updatedAt: NOW - 2 * MIN,
          subtasks: [subtask({ status: "failed", error: "验收未通过", finishedAt: NOW - 70 * MIN })],
        }),
        run({ id: "r2", goal: "登录重构", updatedAt: NOW - 45 * MIN }),
        run({ id: "r3", goal: "内容迁移", status: "done", subtasks: [] }),
      ],
      inboxItems: [
        inbox({ id: "old", title: "发布说明", createdAt: NOW - 5 * 60 * MIN }),
        inbox({ id: "fresh", title: "新问题", createdAt: NOW - 5 * MIN }),
      ],
      now: NOW,
    });

    expect(standup.counts.running).toBe(2); // r1 + r2; done run excluded
    expect(standup.counts.waitingOwner).toBe(2); // two open inbox items
    expect(standup.blockers.map((blocker) => blocker.waitingMinutes)).toEqual([300, 70, 45]);
    expect(standup.blockers[0]!.item).toContain("发布说明");
    expect(standup.blockers[2]!.item).toContain("45 分钟没有进展");
    expect(standup.counts.blocked).toBe(3);
    // body caps at 3 blocker lines + summary + waiting line
    expect(standup.lines).toHaveLength(5);
    expect(standup.lines[0]).toContain("2 个任务在跑，2 件等你，3 件卡住");
  });

  it("counts awaiting-approval plans as waiting on the owner", () => {
    const standup = buildStandup({
      runs: [run({ id: "r-plan", status: "awaiting-approval", goal: "季度复盘" })],
      inboxItems: [],
      now: NOW,
    });
    expect(standup.counts).toEqual({ running: 0, blocked: 0, waitingOwner: 1 });
    expect(standup.lines[0]).toContain("0 个任务在跑，1 件等你，0 件卡住");
    expect(standup.lines.at(-1)).toContain("打开「需要你」处理");
  });

  it("uses the owner's local clock in the summary line", () => {
    const utc = buildStandup({ runs: [], inboxItems: [inbox({ createdAt: NOW - STANDUP_OWNER_SLA_MS - 1 })], now: NOW, timeZone: "UTC" });
    const shanghai = buildStandup({ runs: [run()], now: NOW, timeZone: "Asia/Shanghai" });
    expect(utc.lines[0]).toContain("01:00 站会"); // 09:00 +08 = 01:00 UTC
    expect(shanghai.lines[0]).toContain("09:00 站会");
  });

  it("only emits fixed templates with numbers (no model prose) and is order-independent", () => {
    const runs = [
      run({ id: "r1", subtasks: [subtask({ status: "failed", finishedAt: NOW - 30 * MIN })] }),
      run({ id: "r2", goal: "登录重构", updatedAt: NOW - STANDUP_STALL_MS - MIN }),
    ];
    const items = [inbox({ id: "a", createdAt: NOW - 200 * MIN }), inbox({ id: "b", createdAt: NOW - 3 * MIN })];
    const one = buildStandup({ runs, inboxItems: items, now: NOW });
    const two = buildStandup({ runs: [...runs].reverse(), inboxItems: [...items].reverse(), now: NOW });
    expect(two).toEqual(one);
    // every line is either the empty line or a fixed template filled with numbers/labels
    const TEMPLATE =
      /^(?:\d{2}:\d{2} 站会：\d+ 个任务在跑，\d+ 件等你，\d+ 件卡住。|.+：.+，已等 \d+ 分钟。|\d+ 件在等你拍板，打开「需要你」处理。|今天没有需要你的事，团队在自己跑。)$/;
    for (const line of one.lines) expect(line).toMatch(TEMPLATE);
  });
});
