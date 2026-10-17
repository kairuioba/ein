import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types.ts";
import { DEFAULT_ORG_RULES, type InboxItem, type OrgConfig, type OrgEvent } from "../../shared/org-types.ts";
import { buildBrief, headlineFor, runsInView, type BriefInput, type ConversationState } from "./brief.ts";
import type { OrgBot } from "./util.ts";
import { startOfDay } from "./util.ts";

const NOW = new Date(2026, 9, 15, 16, 52).getTime();
const MIN = 60_000;
const DAY = startOfDay(NOW);

const ORG: OrgConfig = {
  version: 1,
  chiefBotId: "chief",
  departments: [
    { section: "市场部", color: "#0EA5E9" },
    { section: "内容部", color: "#65A30D" },
    { section: "技术部", color: "#F59E0B" },
    { section: "空部门", color: "#475467" },
  ],
  projects: [],
  rules: DEFAULT_ORG_RULES,
  decisionRights: [],
  updatedAt: 0,
};

const BOTS: OrgBot[] = [
  { id: "chief", name: "总控", threadId: "t-chief", chiefOfStaff: true },
  { id: "market-lead", name: "市场分析师", threadId: "t-ml", section: "市场部", chiefOfStaff: true },
  { id: "market-1", name: "竞品研究员", threadId: "t-m1", section: "市场部" },
  { id: "content-lead", name: "小文", threadId: "t-cl", section: "内容部", chiefOfStaff: true },
  { id: "writer", name: "社媒写手", threadId: "t-w", section: "内容部" },
  { id: "dev-lead", name: "阿杰", threadId: "t-dl", section: "技术部", chiefOfStaff: true, tasks: [{ threadId: "t-dl" }, { threadId: "t-dl-2" }] },
  { id: "dev-1", name: "前端 1", threadId: "t-d1", section: "技术部", busy: true, activity: "working" },
];

const st = (id: string, assigneeBotId: string, status: DispatchSubtask["status"], extra: Partial<DispatchSubtask> = {}): DispatchSubtask => ({
  id,
  title: id,
  brief: "",
  role: "r",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId,
  status,
  attempts: 1,
  ...extra,
});

const RUN: DispatchRun = {
  id: "run-1",
  chiefBotId: "chief",
  sourceThreadId: "t-chief",
  goal: "发布会",
  policy: "balanced",
  status: "running",
  subtasks: [
    st("竞品调研", "market-1", "done", { finishedAt: DAY + 15 * 60 * MIN + 40 * MIN }),
    st("三段卖点", "writer", "running", { threadId: "t-w-sub", startedAt: NOW - 5 * MIN }),
    st("社媒文案", "writer", "pending", { dependsOn: ["三段卖点"] }),
    st("预约表单接口", "dev-1", "pending", { error: "timeout", attempts: 1 }),
    st("上线预览", "dev-1", "pending", { dependsOn: ["预约表单接口"] }),
    st("嘉宾页", "dev-lead", "failed", { error: "接口 500" }),
    st("取消的", "dev-lead", "canceled"),
  ],
  createdAt: DAY + 9 * 60 * MIN,
  updatedAt: NOW,
};

const OLD_RUN: DispatchRun = { ...RUN, id: "old", status: "done", updatedAt: DAY - 60 * MIN, subtasks: [st("昨天", "market-1", "done")] };

const event = (kind: OrgEvent["kind"], at: number, extra: Partial<OrgEvent> = {}): OrgEvent => ({ id: `${kind}-${at}`, at, kind, title: kind, ...extra });

function input(extra: Partial<BriefInput> = {}): BriefInput {
  const conversations: Record<string, ConversationState> = {
    "t-d1": { lastAt: NOW - 30 * MIN, replied: false },
    "t-ml": { lastAt: NOW - 2 * MIN, replied: true },
  };
  return {
    now: NOW,
    since: NOW - 60 * MIN,
    org: ORG,
    bots: BOTS,
    groups: [],
    runs: [RUN, OLD_RUN],
    needsYou: [],
    events: [],
    autoApproved: [],
    spend: { currency: "CNY", todayCost: 38, budgetPerDay: 60, weekPercent: 62, byBot: [], unpricedTokens: 0 },
    conversation: (threadId) => conversations[threadId] ?? { replied: false },
    lastBotMessageAt: (botId) => (botId === "market-lead" ? NOW - 2 * MIN : undefined),
    ...extra,
  };
}

describe("brief", () => {
  it("counts every department's dispatched work and sums the whole", () => {
    const brief = buildBrief(input());
    expect(brief.departments.map((dep) => [dep.section, dep.done, dep.total])).toEqual([
      ["市场部", 1, 1],
      ["内容部", 0, 2],
      ["技术部", 0, 3],
    ]);
    expect([brief.done, brief.total]).toEqual([1, 6]);
    expect(brief.headline).toBe("Overall 1/6; nothing needs your decision.");
    expect(brief.at).toBe(NOW);
    expect(brief.spend.todayCost).toBe(38);
  });

  it("colours health by what is happening and writes one status line", () => {
    const needsYou: InboxItem[] = [{ id: "q", kind: "choice", title: "主视觉 4 选 1", botId: "writer", since: NOW - MIN }];
    const brief = buildBrief(input({ needsYou }));
    const dep = (section: string) => brief.departments.find((entry) => entry.section === section)!;
    expect(dep("市场部")).toMatchObject({ health: "green", status: "“竞品调研” delivered at 15:40", leadBotId: "market-lead", lastReportAt: NOW - 2 * MIN });
    expect(dep("内容部")).toMatchObject({ health: "yellow", status: "Waiting for you: 主视觉 4 选 1", leadBotId: "content-lead" });
    expect(dep("技术部")).toMatchObject({ health: "red", status: "“嘉宾页” failed" });
    expect(brief.headline).toBe("Overall 1/6; 1 thing needs your decision.");
  });

  it("lists failures, blocked work and bots with no progress as risks, errors first", () => {
    const brief = buildBrief(input());
    expect(brief.risks).toEqual([
      { title: "“嘉宾页” failed", detail: "接口 500", botId: "dev-lead", severity: "error" },
      { title: "“上线预览” is waiting on “预约表单接口”", detail: "“预约表单接口” is being retried", botId: "dev-1", severity: "warn" },
      { title: "前端 1 has shown no progress for 30 min", detail: "Past the 10-minute escalation rule", botId: "dev-1", severity: "warn" },
    ]);
  });

  it("counts a department's own plan, not also the subtask its lead handed to it", () => {
    const company: DispatchRun = {
      ...RUN,
      id: "company",
      subtasks: [st("落地页", "dev-lead", "running", { childRunId: "dept", threadId: "t-dl-2" }), st("竞品调研", "market-1", "done", { finishedAt: NOW - 3 * MIN })],
    };
    const dept: DispatchRun = {
      ...RUN,
      id: "dept",
      chiefBotId: "dev-lead",
      sourceThreadId: "t-dl-2",
      parentRunId: "company",
      parentSubtaskId: "落地页",
      subtasks: [st("页面开发", "dev-1", "done", { finishedAt: NOW - MIN }), st("预约接口", "dev-1", "running", { startedAt: NOW - MIN })],
    };
    const brief = buildBrief(input({ runs: [company, dept] }));
    // like the workbench: the lead's subtask is a container for its team's two
    expect(brief.departments.find((dep) => dep.section === "技术部")).toMatchObject({ done: 1, total: 2 });
    expect([brief.done, brief.total]).toEqual([2, 3]);
    // once the team is done and the lead's subtask with it, still two of two
    const finished = buildBrief(
      input({
        runs: [
          { ...company, subtasks: [{ ...company.subtasks[0]!, status: "done", finishedAt: NOW }, company.subtasks[1]!] },
          { ...dept, status: "done", subtasks: dept.subtasks.map((subtask) => ({ ...subtask, status: "done" as const, finishedAt: NOW - MIN })) },
        ],
      }),
    );
    expect(finished.departments.find((dep) => dep.section === "技术部")).toMatchObject({ done: 2, total: 2 });
    expect(finished.headline).toBe("Overall 3/3; nothing needs your decision.");
  });

  it("falls back to the owner's own conversations when a department has no dispatched work", () => {
    const conversations: Record<string, ConversationState> = {
      "t-cl": { lastAt: NOW - MIN, lastUserAt: NOW - 2 * MIN, replied: true },
      "t-w": { lastAt: NOW - MIN, lastUserAt: NOW - MIN, replied: false },
      // asked yesterday: not today's work
      "t-ml": { lastAt: DAY - MIN, lastUserAt: DAY - 2 * MIN, replied: true },
    };
    const brief = buildBrief(input({ runs: [], conversation: (threadId) => conversations[threadId] ?? { replied: false } }));
    expect(brief.departments.map((dep) => [dep.section, dep.done, dep.total, dep.status])).toEqual([
      ["市场部", 0, 0, "Nothing in progress"],
      ["内容部", 1, 2, "1 of 2 done"],
      ["技术部", 0, 0, "前端 1 is working"],
    ]);
    expect(brief.headline).toBe("Overall 1/2; nothing needs your decision.");
  });

  it("skips empty departments and leaves the chief out of every room", () => {
    const brief = buildBrief(input({ bots: [...BOTS, { id: "x", name: "x", threadId: "t-x", section: "空部门", hidden: true }] }));
    expect(brief.departments.map((dep) => dep.section)).not.toContain("空部门");
  });

  it("shows only today's runs and runs still going", () => {
    expect(runsInView([RUN, OLD_RUN, { ...OLD_RUN, id: "older-but-running", status: "running" }], DAY).map((run) => run.id)).toEqual([
      "run-1",
      "older-but-running",
    ]);
  });

  it("splits events into changes since the last visit (newest first) and today's timeline (oldest first)", () => {
    const events = [
      event("run.started", DAY - 10 * MIN),
      event("people.added", DAY + 10 * MIN),
      event("decision", NOW - 30 * MIN, { decisionId: 3 }),
      event("approval.expired", NOW - 20 * MIN, { botId: "dev-1", detail: "npm install left-pad" }),
    ];
    const brief = buildBrief(input({ events, since: NOW - 45 * MIN }));
    expect(brief.changes.map((entry) => entry.kind)).toEqual(["approval.expired", "decision"]);
    expect(brief.timeline.map((entry) => entry.kind)).toEqual(["people.added", "decision", "approval.expired"]);
    expect(brief.expired).toEqual([{ id: "approval.expired-" + (NOW - 20 * MIN), title: "npm install left-pad", botId: "dev-1", at: NOW - 20 * MIN }]);
  });

  it("keeps today's auto-approvals, newest first", () => {
    const brief = buildBrief(
      input({
        autoApproved: [
          { id: "a", title: "git status", botId: "dev-1", at: NOW - 5 * MIN, rule: "Always allowed: Bash:git" },
          { id: "b", title: "yesterday", botId: "dev-1", at: DAY - MIN, rule: "Auto mode is on for this bot" },
          { id: "c", title: "ls", botId: "dev-1", at: NOW - MIN, rule: "Auto mode is on for this bot" },
        ],
      }),
    );
    expect(brief.autoApproved.map((row) => row.id)).toEqual(["c", "a"]);
    expect(brief.autoApprovedTotal).toBe(2);
  });

  it("carries only the newest 50 auto-approvals, with the day's total", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, title: "ls", botId: "dev-1", at: DAY + i * 1_000, rule: "Auto mode is on for this bot" }));
    const brief = buildBrief(input({ autoApproved: many }));
    expect(brief.autoApproved).toHaveLength(50);
    expect(brief.autoApproved[0]!.id).toBe("r119");
    expect(brief.autoApprovedTotal).toBe(120);
  });

  it("builds the headline from the numbers", () => {
    expect(headlineFor(0, 0, 0)).toBe("Nothing in progress, and nothing needs your decision.");
    expect(headlineFor(0, 0, 1)).toBe("Nothing in progress; 1 thing needs your decision.");
    expect(headlineFor(0, 0, 3)).toBe("Nothing in progress; 3 things need your decision.");
    expect(headlineFor(13, 31, 0)).toBe("Overall 13/31; nothing needs your decision.");
    expect(headlineFor(13, 31, 3)).toBe("Overall 13/31; 3 things need your decision.");
  });
});
