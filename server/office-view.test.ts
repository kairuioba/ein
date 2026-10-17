import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask, InboxItem } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";
import { buildProjectOffice, emptyProjectOffice, type OfficeBot } from "./office-view.ts";

// fake clock: 10h after epoch so "40 minutes ago" reads clearly
const NOW = 10 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const folder = (extra: Partial<TaskFolderRecord> = {}): TaskFolderRecord => ({
  id: "f1",
  title: "官网改版",
  color: "#0EA5E9",
  order: 0,
  collapsed: false,
  createdAt: NOW - 120 * MIN,
  leadBotId: "chief",
  ...extra,
});

const bot = (id: string, section: string, name = id, title = "成员"): OfficeBot => ({ id, name, title, section });

const subtask = (extra: Partial<DispatchSubtask> & Pick<DispatchSubtask, "id">): DispatchSubtask => ({
  title: `任务 ${extra.id}`,
  brief: "b",
  role: "成员",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId: "b1",
  status: "pending",
  attempts: 1,
  ...extra,
});

const run = (extra: Partial<DispatchRun> = {}): DispatchRun => ({
  id: "r1",
  chiefBotId: "chief",
  sourceThreadId: "t1",
  goal: "4 周内上线新版官网首页",
  policy: "balanced",
  status: "running",
  subtasks: [],
  createdAt: NOW - 180 * MIN,
  updatedAt: NOW - 5 * MIN,
  ...extra,
});

const item = (extra: Partial<InboxItem> & Pick<InboxItem, "id" | "kind">): InboxItem => ({
  taskId: "f1",
  title: "待拍板",
  reason: "请确认",
  createdAt: NOW - 10 * MIN,
  ...extra,
});

describe("buildProjectOffice", () => {
  it("groups the project team into departments and derives presence from subtask facts", () => {
    const office = buildProjectOffice({
      folder: folder(),
      run: run({
        subtasks: [
          subtask({ id: "s1", title: "首版文案", assigneeBotId: "lin", status: "running" }),
          subtask({ id: "s2", title: "评审视觉稿", assigneeBotId: "zhe", status: "done", gate: { status: "needs_human", criteria: [], deterministic: [], at: NOW - 3 * MIN } }),
          subtask({ id: "s3", title: "导出切图", assigneeBotId: "mei", status: "done", gate: { status: "pass", criteria: [], deterministic: [], at: NOW - 2 * MIN } }),
          subtask({ id: "s4", title: "配图落地", assigneeBotId: "kai", status: "failed", error: "engine crashed" }),
        ],
      }),
      bots: [bot("chief", "总经办", "阿头"), bot("lin", "内容部", "小林"), bot("zhe", "评审部", "阿哲"), bot("mei", "设计部", "阿美"), bot("kai", "设计部", "阿凯")],
      inboxItems: [],
      now: NOW,
    });
    expect(office.project).toMatchObject({
      id: "f1",
      title: "官网改版",
      status: "running",
      goal: "4 周内上线新版官网首页",
      leadBotId: "chief",
      leadName: "阿头",
      progress: { done: 2, total: 4 },
    });
    expect(office.departments.map((department) => department.name)).toEqual(["总经办", "内容部", "评审部", "设计部"]);
    const members = office.departments.flatMap((department) => department.members);
    expect(members.map((member) => [member.botId, member.presence])).toEqual([
      ["chief", "working"], // the lead with no subtask of its own is coordinating a live run
      ["lin", "working"],
      ["zhe", "reviewing"],
      ["mei", "idle"],
      ["kai", "blocked"],
    ]);
    expect(members[0]).toMatchObject({ current: "统筹项目" });
    expect(members[1]).toMatchObject({ current: "首版文案", name: "小林" });
    expect(members[2]).toMatchObject({ waitingOn: "评审" });
  });

  it("draws the waiting chain: a running dependency and a delivered handoff waiting for the next worker", () => {
    const office = buildProjectOffice({
      folder: folder(),
      run: run({
        subtasks: [
          subtask({ id: "s1", title: "写首页文案", assigneeBotId: "lin", status: "running", startedAt: NOW - 20 * MIN }),
          subtask({
            id: "s2",
            title: "评审定稿",
            assigneeBotId: "zhe",
            status: "done",
            finishedAt: NOW - 90 * MIN,
            handoff: { status: "done", summary: "定稿已交付" },
          }),
          subtask({ id: "s3", title: "做落地页", assigneeBotId: "mei", status: "pending", dependsOn: ["s1", "s2"] }),
        ],
      }),
      bots: [bot("chief", "总经办", "阿头"), bot("lin", "内容部", "小林"), bot("zhe", "评审部", "阿哲"), bot("mei", "设计部", "阿美")],
      inboxItems: [],
      now: NOW,
    });
    // longest wait first: the delivered handoff (90 min) before the still-running dependency (20 min)
    expect(office.now.waiting).toEqual([
      { from: { botId: "zhe", name: "阿哲" }, to: { botId: "mei", name: "阿美" }, item: "做落地页", status: "handoff_unreceived", since: NOW - 90 * MIN, minutes: 90 },
      { from: { botId: "lin", name: "小林" }, to: { botId: "mei", name: "阿美" }, item: "做落地页", status: "running", since: NOW - 20 * MIN, minutes: 20 },
    ]);
  });

  it("filters decisions to this project's open inbox items and reuses the risk rules", () => {
    const office = buildProjectOffice({
      folder: folder(),
      run: run({
        subtasks: [
          subtask({ id: "s1", title: "首版文案", assigneeBotId: "lin", status: "done", reworkCount: 2, gate: { status: "fail", criteria: [], deterministic: [], reason: "cannot verify: artifacts", at: NOW - 5 * MIN } }),
        ],
      }),
      bots: [bot("chief", "总经办", "阿头"), bot("lin", "内容部", "小林")],
      inboxItems: [
        item({ id: "signoff", kind: "signoff", title: "官网改版", reason: "任务完成，确认交付", createdAt: NOW - 30 * MIN }),
        item({ id: "gate", kind: "gate_failed", subtaskId: "s1", reason: "cannot verify: artifacts", createdAt: NOW - 5 * MIN }),
        item({ id: "other-project", kind: "question", taskId: "f2" }),
        item({ id: "resolved", kind: "signoff", resolvedAt: NOW - MIN }),
      ],
      now: NOW,
    });
    expect(office.decisions.map((decision) => decision.id)).toEqual(["signoff", "gate"]);
    expect(office.decisions[0]).toMatchObject({ kind: "signoff", risk: "high" });
    expect(office.decisions[1]).toMatchObject({ kind: "gate_failed", risk: "high", evidence: [] });
  });

  it("flags failed, needs-human, rework and stalled subtasks as anomalies", () => {
    const office = buildProjectOffice({
      folder: folder(),
      run: run({
        updatedAt: NOW - 45 * MIN,
        subtasks: [
          subtask({ id: "s1", title: "配图", assigneeBotId: "kai", status: "failed", error: "engine crashed", finishedAt: NOW - 40 * MIN }),
          subtask({ id: "s2", title: "视觉稿", assigneeBotId: "mei", status: "done", gate: { status: "needs_human", criteria: [], deterministic: [], reason: "2 required criterion(ia) cannot be verified without a reviewer", at: NOW - 50 * MIN } }),
          subtask({ id: "s3", title: "文案", assigneeBotId: "lin", status: "running", startedAt: NOW - 90 * MIN, reworkCount: 2 }),
        ],
      }),
      bots: [bot("chief", "总经办", "阿头"), bot("lin", "内容部", "小林"), bot("mei", "设计部", "阿美"), bot("kai", "设计部", "阿凯")],
      inboxItems: [],
      now: NOW,
    });
    expect(office.anomalies.map((anomaly) => [anomaly.subtaskId, anomaly.kind])).toEqual([
      ["s1", "failed"],
      ["s2", "needs_human"],
      ["s3", "rework"],
      ["s3", "stalled"],
    ]);
    expect(office.anomalies[1]!.detail).toContain("cannot be verified");
    expect(office.anomalies[2]!.detail).toContain("2");
    expect(office.anomalies[3]!.detail).toContain("45 分钟");
  });

  it("renders a skeleton for a project that has no dispatch run yet", () => {
    const office = buildProjectOffice({
      folder: folder(),
      bots: [bot("chief", "总经办", "阿头")],
      inboxItems: [],
      now: NOW,
    });
    expect(office).toMatchObject({
      project: { id: "f1", title: "官网改版", status: "draft", leadBotId: "chief", progress: { done: 0, total: 0 } },
      departments: [{ name: "总经办", members: [{ botId: "chief", name: "阿头", presence: "idle" }] }],
      now: { waiting: [] },
      decisions: [],
      activity: [],
      anomalies: [],
    });
    expect(emptyProjectOffice(folder()).project).toMatchObject({ status: "draft", progress: { done: 0, total: 0 } });
  });

  it("orders the activity stream newest first and keeps at most 20 rows", () => {
    const subtasks = Array.from({ length: 25 }, (_, index) =>
      subtask({
        id: `s${index + 1}`,
        title: `第 ${index + 1} 步`,
        assigneeBotId: "lin",
        status: "done",
        startedAt: NOW - (60 - index) * MIN,
        finishedAt: NOW - (30 - index) * MIN,
        handoff: { status: "done", summary: `产出 ${index + 1}` },
      }),
    );
    const office = buildProjectOffice({
      folder: folder(),
      run: run({ subtasks, status: "done", finishedAt: NOW - MIN }),
      bots: [bot("chief", "总经办", "阿头"), bot("lin", "内容部", "小林")],
      inboxItems: [],
      now: NOW,
    });
    expect(office.activity).toHaveLength(20);
    expect(office.activity[0]).toMatchObject({ kind: "finished", summary: "项目完成" });
    for (let index = 1; index < office.activity.length; index += 1) {
      expect(office.activity[index - 1]!.at).toBeGreaterThanOrEqual(office.activity[index]!.at);
    }
    expect(office.project).toMatchObject({ status: "done", progress: { done: 25, total: 25 }, closedAt: NOW - MIN });
  });
});
