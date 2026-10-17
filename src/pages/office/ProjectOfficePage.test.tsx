// 项目协同工作台的自检：结论优先级（加载中绝不显示绿色）、等待时长格式化、
// 「决策卡透传 attemptId」，以及各区块在加载/空态/有数据时的 DOM 文案。
// 环境是 node + react-dom/server（仓库现有组件测试同款模式）：只做静态渲染，
// 点击行为由 resolveDecision 的单测覆盖。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { formatWaitMinutes, officeConclusion, type ProjectOffice } from "@/lib/office";

import { DecisionQueue, resolveDecision } from "./DecisionQueue";
import { ProjectOfficePage } from "./ProjectOfficePage";
import { TeamStrip } from "./TeamStrip";
import { ViewSwitch } from "./ViewSwitch";
import { WaitChain } from "./WaitChain";

// vitest 跑在 en locale（见 shared/i18n.ts detectLocale），所以断言英文源文案。
const office = (patch: Partial<ProjectOffice> = {}): ProjectOffice => ({
  project: {
    id: "folder-1",
    title: "官网改版",
    status: "active",
    goal: "4 周内上线新版官网首页",
    leadName: "阿哲",
    progress: { done: 3, total: 7 },
  },
  departments: [{ name: "内容部", members: [{ botId: "bot-1", name: "小林", presence: "working" }] }],
  now: { waiting: [] },
  decisions: [],
  activity: [],
  anomalies: [],
  ...patch,
});

const render = (element: ReturnType<typeof createElement>): string => renderToStaticMarkup(element);

describe("officeConclusion", () => {
  it("never shows a green conclusion without a snapshot", () => {
    expect(officeConclusion(null, { loading: true })).toEqual({ tone: "muted", kind: "loading" });
    expect(officeConclusion(null, { error: "boom" })).toEqual({ tone: "muted", kind: "error" });
    expect(officeConclusion(null).tone).not.toBe("ok");
  });

  it("answers the owner's priority: decisions > anomalies > blocked >= 15m > normal", () => {
    const decisions = office({ decisions: [{ id: "d1", kind: "signoff", title: "发布吗", reason: "评审已过" }] });
    expect(officeConclusion(decisions)).toEqual({ tone: "danger", kind: "decisions", count: 1 });

    const anomalies = office({
      anomalies: [{ subtaskId: "s1", title: "配图", kind: "rework", detail: "被打回 2 次" }],
    });
    expect(officeConclusion(anomalies)).toEqual({ tone: "warning", kind: "anomalies", count: 1 });

    // decisions outrank anomalies when both exist
    expect(officeConclusion(office({ ...anomalies, ...decisions }))).toEqual({
      tone: "danger",
      kind: "decisions",
      count: 1,
    });
  });

  it("flags a wait only at 15 minutes or more", () => {
    const wait = (minutes: number) =>
      office({
        now: {
          waiting: [{ from: { name: "小林" }, to: { name: "阿哲" }, item: "首版文案", status: "waiting", minutes }],
        },
      });
    expect(officeConclusion(wait(14))).toEqual({ tone: "ok", kind: "clear" });
    expect(officeConclusion(wait(15))).toEqual({ tone: "warning", kind: "blocked", minutes: 15 });
  });

  it("is clear only with a real snapshot and nothing wrong", () => {
    expect(officeConclusion(office())).toEqual({ tone: "ok", kind: "clear" });
    // 失败但有上一份数据：结论仍按数据算，页面另给「上次数据」提示
    expect(officeConclusion(office(), { error: "boom" })).toEqual({ tone: "ok", kind: "clear" });
  });
});

describe("formatWaitMinutes", () => {
  it("formats minutes and hours compactly", () => {
    expect(formatWaitMinutes(0)).toBe("1m");
    expect(formatWaitMinutes(6)).toBe("6m");
    expect(formatWaitMinutes(59)).toBe("59m");
    expect(formatWaitMinutes(60)).toBe("1h");
    expect(formatWaitMinutes(132)).toBe("2h 12m");
  });

  it("rounds and survives nonsense", () => {
    expect(formatWaitMinutes(6.4)).toBe("6m");
    expect(formatWaitMinutes(Number.NaN)).toBe("1m");
    expect(formatWaitMinutes(-3)).toBe("1m");
  });
});

describe("ViewSwitch", () => {
  it("renders a controlled two-way switch and marks the active side", () => {
    const markup = render(createElement(ViewSwitch, { value: "office", onChange: () => {} }));
    expect(markup).toContain("Collaborate");
    expect(markup).toContain("Chat");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-selected="false"');
  });
});

describe("WaitChain", () => {
  it("shows a one-line chain with the server's wait time and empty state", () => {
    expect(render(createElement(WaitChain, { waiting: [] }))).toContain("Nobody is waiting on anybody.");
    const markup = render(
      createElement(WaitChain, {
        waiting: [
          {
            from: { name: "小林" },
            to: { name: "阿哲" },
            item: "首版文案",
            status: "waiting",
            minutes: 6,
          },
          {
            from: { name: "阿美" },
            to: { name: "小林" },
            item: "落地页",
            status: "waiting",
            minutes: 132,
          },
        ],
      }),
    );
    expect(markup).toContain("小林 waits on 阿哲");
    expect(markup).toContain("首版文案");
    expect(markup).toContain("waiting 6m");
    expect(markup).toContain("waiting 2h 12m");
    // ≥15 分钟的那行标红（只有它一个），6 分钟的不标
    expect(markup.split("text-danger").length - 1).toBe(1);
  });
});

describe("TeamStrip", () => {
  it("renders one chip per member with a visible status word", () => {
    const empty = render(createElement(TeamStrip, { departments: [] }));
    expect(empty).toContain("No members are working in this project yet.");

    const markup = render(createElement(TeamStrip, { departments: office().departments }));
    expect(markup).toContain("内容部");
    expect(markup).toContain("小林");
    expect(markup).toContain("Working");
    expect(markup).toContain("bg-select");
  });
});

describe("DecisionQueue", () => {
  it("shows the empty state and renders decision cards with both actions", () => {
    expect(render(createElement(DecisionQueue, { decisions: [] }))).toContain(
      "Nothing is waiting for you in this project.",
    );

    const markup = render(
      createElement(DecisionQueue, {
        decisions: [
          {
            id: "d1",
            kind: "signoff",
            title: "最终文案可以对外发布吗？",
            reason: "评审阿哲已通过 · 小林提交",
            risk: "对外",
            attemptId: "attempt-9",
          },
        ],
      }),
    );
    expect(markup).toContain("最终文案可以对外发布吗？");
    expect(markup).toContain("评审阿哲已通过");
    expect(markup).toContain("Approve, go on");
    expect(markup).toContain("Not good — fix it");
  });

  it("passes attemptId (and the reject reason) through to the inbox resolve API", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const decision = { id: "d1", kind: "signoff", title: "t", reason: "r", attemptId: "attempt-9" };
      await resolveDecision(decision, "approve");
      await resolveDecision(decision, "reject", "  范围跑偏  ");

      expect(calls[0]).toEqual({
        url: "/api/inbox/d1/resolve",
        body: { action: "approve", expectedAttemptId: "attempt-9" },
      });
      expect(calls[1]).toEqual({
        url: "/api/inbox/d1/resolve",
        body: { action: "reject", note: "范围跑偏", expectedAttemptId: "attempt-9" },
      });
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("ProjectOfficePage", () => {
  afterEach(() => {
    // SSR never runs effects, so no fetch is made; nothing else to clean up.
  });

  it("starts in a neutral loading state — no fake green, no empty sections", () => {
    const markup = render(createElement(ProjectOfficePage, { folderId: "folder-1", title: "官网改版" }));
    expect(markup).toContain("官网改版");
    expect(markup).toContain("Connecting to the project office…");
    // 首屏加载时绝不出现「一切正常」的绿色结论
    expect(markup).not.toContain("Everything is under control right now");
    expect(markup).not.toContain("Waiting for your decision");
    expect(markup).toContain('aria-busy="true"');
  });
});
