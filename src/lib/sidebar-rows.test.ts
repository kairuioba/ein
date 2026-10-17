import { describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSquad, DispatchSubtask } from "../../shared/dispatch-types";
import type { InboxItem, LibraryDoc, OrgDecision } from "../../shared/org-types";
import type { Routine } from "./routines";
import {
  addedSquadsBySection,
  activeRunsByLead,
  botRowStatus,
  callOccursBetween,
  cardLine,
  messageLine,
  departmentDelivered,
  foldDepartmentMembers,
  groupRowPreview,
  groupUnreadCount,
  inboxByBot,
  inboxReason,
  latestGroupDecision,
  libraryCurrentVersion,
  runAssignees,
  runningWorkCount,
  runSummaryText,
  sidebarTime,
  staleLibraryDocCount,
  staleLibraryUsers,
  summarizeRun,
  todayScheduleCount,
} from "./sidebar-rows";

const NOW = new Date(2026, 9, 15, 16, 52).getTime(); // Thursday 15 Oct 2026, 16:52 local

function subtask(id: string, assigneeBotId: string, status: DispatchSubtask["status"], extra: Partial<DispatchSubtask> = {}): DispatchSubtask {
  return {
    id,
    title: id,
    brief: "",
    role: "",
    needs: [],
    difficulty: 3,
    dependsOn: [],
    assigneeBotId,
    status,
    attempts: status === "pending" ? 0 : 1,
    ...extra,
  };
}

function run(id: string, status: DispatchRun["status"], subtasks: DispatchSubtask[], extra: Partial<DispatchRun> = {}): DispatchRun {
  return {
    id,
    chiefBotId: "lead",
    sourceThreadId: "t",
    goal: "",
    policy: "balanced",
    status,
    subtasks,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...extra,
  };
}

const inbox = (id: string, botId: string, kind: InboxItem["kind"], title = "Pick the key visual"): InboxItem => ({
  id,
  kind,
  title,
  botId,
  since: NOW - 60_000,
});

describe("nav counts", () => {
  it("counts running dispatch runs first, and busy bots only when no run is going", () => {
    const bots = [{ busy: true, activity: "working" as const }, { activity: "waiting-on-you" as const, busy: true }, { hidden: true, busy: true }];
    expect(runningWorkCount([run("a", "running", []), run("b", "synthesizing", []), run("c", "done", [])], bots)).toBe(2);
    // a lead's run for one step of the chief's run is part of it
    expect(runningWorkCount([run("a", "running", []), run("child", "running", [], { parentRunId: "a" })], bots)).toBe(1);
    expect(runningWorkCount([run("c", "done", [])], bots)).toBe(1);
    expect(runningWorkCount([], [])).toBe(0);
  });

  it("finds docs a bot still uses an older version of", () => {
    const doc = (versions: number[], inUse: Array<[string, number]>): LibraryDoc => ({
      id: String(Math.random()),
      title: "Price sheet",
      section: null,
      versions: versions.map((version) => ({ version, at: NOW, size: 1 })),
      subscribers: [],
      inUse: inUse.map(([botId, version]) => ({ botId, version })),
      updatedAt: NOW,
    });
    const priceSheet = doc([3, 4], [["social", 3], ["press", 4], ["writer", 3]]);
    expect(libraryCurrentVersion(priceSheet)).toBe(4);
    expect(staleLibraryUsers(priceSheet).map((use) => use.botId)).toEqual(["social", "writer"]);
    expect(staleLibraryDocCount([priceSheet, doc([1, 2], [["a", 2]]), doc([], [])])).toBe(1);
  });

  it("counts today's routine occurrences and meetings", () => {
    const routine = (id: string, schedule: Routine["schedule"], enabled = true): Routine => ({
      id,
      name: id,
      prompt: "",
      botId: "chief",
      runOn: "maus",
      enabled,
      schedule,
      durationMinutes: 30,
      nextRunAt: null,
      createdAt: NOW - 7 * 86_400_000,
      updatedAt: NOW,
    });
    const thursday = new Date(NOW).getDay();
    const routines = [
      routine("daily-brief", { type: "daily", time: "18:00", weekdays: [thursday] }),
      routine("weekend-only", { type: "daily", time: "09:00", weekdays: [(thursday + 2) % 7] }),
      routine("off", { type: "daily", time: "10:00", weekdays: [thursday] }, false),
      routine("tomorrow", { type: "once", at: NOW + 86_400_000 }),
    ];
    const standup = { createdAt: NOW - 86_400_000 * 3, schedule: { type: "daily" as const, time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } };
    const launch = { createdAt: NOW - 1_000, schedule: { type: "once" as const, at: NOW + 3_600_000 } };
    expect(callOccursBetween(standup, NOW - 16 * 3_600_000, NOW + 8 * 3_600_000)).toBe(true);
    expect(todayScheduleCount(routines, [], [standup, launch], NOW)).toBe(3);
    expect(todayScheduleCount([], [], [], NOW)).toBe(0);
  });
});

describe("rows", () => {
  it("says why a bot is waiting on you before anything else", () => {
    const items = [inbox("1", "press", "escalation"), inbox("2", "designer", "choice", "Key visual: 1 of 4"), inbox("3", "social", "approval")];
    const byBot = inboxByBot(items);
    expect(byBot.get("press")?.map((item) => item.id)).toEqual(["1"]);
    expect(inboxReason(items[0]!)).toBe("stuck");
    expect(inboxReason(items[1]!)).toBe("Key visual: 1 of 4");
    expect(inboxReason(items[2]!)).toBe("needs your approval");

    expect(botRowStatus({ activity: "working", busy: true, inbox: byBot.get("press") ?? [], preview: "hi" })).toEqual({ kind: "waiting", reason: "stuck" });
    expect(botRowStatus({ activity: "waiting-on-you", inbox: [], waitingReason: "Allow Bash?", preview: "hi" })).toEqual({ kind: "waiting", reason: "Allow Bash?" });
    expect(botRowStatus({ activity: "waiting-on-you", inbox: [], preview: "hi" })).toEqual({ kind: "waiting", reason: "waiting for you" });
    expect(botRowStatus({ activity: "working", busy: true, inbox: [], preview: "hi" })).toEqual({ kind: "working" });
    expect(botRowStatus({ activity: "idle", inbox: [], preview: "hello there" })).toEqual({ kind: "preview", text: "hello there" });
  });

  it("sums a lead's run up as people, progress and retries", () => {
    const leadRun = run("r", "running", [
      ...Array.from({ length: 13 }, (_, i) => subtask(`d${i}`, `front-${i % 8}`, "done")),
      subtask("retry", "front-1", "running", { attempts: 2 }),
      ...Array.from({ length: 10 }, (_, i) => subtask(`p${i}`, `front-${i % 8}`, "pending")),
      subtask("skipped", "front-9", "skipped"),
    ]);
    const summary = summarizeRun(leadRun);
    expect(summary).toEqual({ people: 8, done: 13, total: 24, retrying: 1 });
    expect(runSummaryText(summary)).toBe("8 people · 13/24 · 1 retrying");
    expect(runSummaryText({ people: 1, done: 0, total: 2, retrying: 0 })).toBe("1 person · 0/2");
    expect(botRowStatus({ activity: "working", inbox: [], run: summary, preview: "" })).toEqual({ kind: "run", text: "8 people · 13/24 · 1 retrying" });
    expect(runAssignees(leadRun).has("front-9")).toBe(false);
    expect(runAssignees(leadRun).size).toBe(8);
  });

  it("keeps the newest active run per lead", () => {
    const older = run("old", "running", [], { createdAt: NOW - 7_200_000 });
    const newer = run("new", "synthesizing", [], { createdAt: NOW - 600_000 });
    const finished = run("done", "done", [], { createdAt: NOW, chiefBotId: "other" });
    const byLead = activeRunsByLead([older, newer, finished]);
    expect(byLead.get("lead")?.id).toBe("new");
    expect(byLead.has("other")).toBe(false);
  });

  it("puts an added squad on the department it joined while the work goes on", () => {
    const squad = (name: string, leadBotId: string, addedAt: number, endedAt?: number): DispatchSquad => ({
      name,
      leadBotId,
      botIds: [leadBotId],
      subtaskIds: [],
      addedAt,
      by: "chief",
      reviewAt: addedAt + 30 * 60_000,
      endedAt,
    });
    const sections: Record<string, string> = { "kimi-1": "Engineering", "kimi-2": "Engineering", lead: "Design", "new-x": "" };
    const sectionOf = (id: string) => sections[id] || undefined;
    const runs = [
      run("tech", "running", [], { squads: [squad("Squad B", "kimi-1", NOW - 40 * 60_000), squad("Squad C", "kimi-2", NOW - 5 * 60_000)] }),
      // a squad whose lead has no department lands on the run lead's
      run("design", "running", [], { squads: [squad("", "new-x", NOW - 60_000)] }),
      run("ended", "running", [], { chiefBotId: "x", squads: [squad("Squad B", "kimi-1", NOW, NOW)] }),
      run("done", "done", [], { squads: [squad("Squad D", "kimi-1", NOW)] }),
    ];
    const chips = addedSquadsBySection(runs, sectionOf);
    expect(chips.get("Engineering")).toBe("Squad C");
    expect(chips.get("Design")).toBe("Squad B");
    expect(chips.size).toBe(2);
    expect(addedSquadsBySection([run("plain", "running", [])], sectionOf).size).toBe(0);
  });

  it("counts a group's unread messages since you last spoke", () => {
    const messages = [
      { role: "bot", kind: "text" },
      { role: "user", kind: "text" },
      { role: "bot", kind: "text" },
      { role: "bot", kind: "activity" },
      { role: "bot", kind: "options" },
    ];
    expect(groupUnreadCount({ unread: true, messages })).toBe(2);
    expect(groupUnreadCount({ unread: false, messages })).toBe(0);
    expect(groupUnreadCount({ unread: true, messages: [{ role: "user", kind: "text" }] })).toBe(1);
  });

  it("previews a group by who is talking, its decision, or its last line", () => {
    expect(groupRowPreview({ memberCount: 5, busyName: "Designer" })).toBe("Designer is working…");
    expect(groupRowPreview({ memberCount: 4, decision: { id: 3, choice: "799" } })).toBe("Decision #3 made · 799");
    expect(
      groupRowPreview({ memberCount: 5, decision: { id: 3, choice: "799" }, unread: true, last: { role: "bot", kind: "text", text: "1 of 4\nready", from: { name: "Designer" } } }),
    ).toBe("5 bots · Designer: 1 of 4 ready");
    expect(groupRowPreview({ memberCount: 1, last: { role: "user", kind: "text", text: "go" } })).toBe("1 bot · You: go");
    expect(groupRowPreview({ memberCount: 2 })).toBe("No messages yet");
    // a card has no text: the preview reads the card instead of going blank
    expect(
      groupRowPreview({
        memberCount: 4,
        last: { role: "bot", kind: "options", from: { name: "Ajie" }, card: { title: "Approval needed", subtitle: "git push", requestId: "r1", tool: "Bash" } },
      }),
    ).toBe("4 bots · Ajie: Approval needed");

    const decisions: OrgDecision[] = [
      { id: 1, title: "", choice: "a", options: [], decidedBy: "owner", at: 10, source: { kind: "group", id: "g" }, actionItems: [] },
      { id: 2, title: "", choice: "b", options: [], decidedBy: "owner", at: 30, source: { kind: "group", id: "g" }, actionItems: [] },
      { id: 3, title: "", choice: "c", options: [], decidedBy: "owner", at: 50, source: { kind: "chat", id: "g" }, actionItems: [] },
    ];
    expect(latestGroupDecision(decisions, "g")?.id).toBe(2);
    expect(latestGroupDecision(decisions, "other")).toBeUndefined();
  });

  it("formats row times relative to today", () => {
    expect(sidebarTime(undefined, NOW)).toBe("");
    expect(sidebarTime(NOW - 60_000, NOW)).toBe("4:51 PM");
    expect(sidebarTime(NOW - 86_400_000, NOW)).toBe("Yesterday");
    expect(sidebarTime(NOW - 3 * 86_400_000, NOW)).toBe("Mon");
    expect(sidebarTime(NOW - 30 * 86_400_000, NOW)).toBe("9/15");
  });
});

describe("departments", () => {
  it("is delivered when the brief says every piece of work is done", () => {
    const brief = [{ section: "Marketing", done: 3, total: 3 }, { section: "Content", done: 3, total: 7 }];
    expect(departmentDelivered("Marketing", brief, [], new Set(), NOW)).toBe(true);
    expect(departmentDelivered("Content", brief, [], new Set(), NOW)).toBe(false);
  });

  it("falls back to today's dispatch work without a brief", () => {
    const members = new Set(["a", "b"]);
    const today = run("r", "done", [subtask("1", "a", "done"), subtask("2", "b", "done"), subtask("3", "x", "failed"), subtask("4", "a", "canceled")]);
    expect(departmentDelivered("Marketing", [], [today], members, NOW)).toBe(true);
    const busy = run("r2", "running", [subtask("1", "a", "done"), subtask("2", "b", "running")]);
    expect(departmentDelivered("Marketing", [], [busy], members, NOW)).toBe(false);
    const yesterday = run("r3", "done", [subtask("1", "a", "done")], { updatedAt: NOW - 2 * 86_400_000 });
    expect(departmentDelivered("Marketing", [], [yesterday], members, NOW)).toBe(false);
  });

  it("folds quiet members behind the lead and sums run members on the lead's row", () => {
    const members = [{ id: "idle-1" }, { id: "waiting" }, { id: "in-run" }, { id: "idle-2" }];
    const keep = (bot: { id: string }) => bot.id === "waiting";
    const folded = foldDepartmentMembers(members, { hasLead: true, expanded: false, keep, runAssignees: new Set(["in-run"]) });
    expect(folded.shown.map((bot) => bot.id)).toEqual(["waiting"]);
    expect(folded.folded).toBe(2);
    expect(folded.inRun).toBe(1);

    expect(foldDepartmentMembers(members, { hasLead: true, expanded: true, keep }).shown).toHaveLength(4);
    expect(foldDepartmentMembers(members, { hasLead: false, expanded: false, keep }).shown).toHaveLength(4);
  });
});

describe("card previews", () => {
  it("reads a bot's question from its subtitle and an approval from its title", () => {
    expect(cardLine({ title: "Your bot has a question", subtitle: "Pick the  hero\nimage", requestId: "r" })).toBe("Pick the hero image");
    expect(cardLine({ title: "Approval needed", subtitle: "git push", requestId: "r", tool: "Bash" })).toBe("Approval needed");
    expect(cardLine({ title: "", subtitle: "Which one?" })).toBe("Which one?");
    // once settled the line says how it ended
    expect(cardLine({ title: "Approval needed", subtitle: "npm  publish", requestId: "r", tool: "shell", answered: "allow" })).toBe("Allowed · npm publish");
    expect(cardLine({ title: "Approval needed", subtitle: "rm -rf", requestId: "r", tool: "shell", answered: "deny" })).toBe("Denied · rm -rf");
    expect(cardLine({ title: "Price?", subtitle: "", answered: "799" })).toBe("You chose 799");
    expect(cardLine({ title: "Approval needed", subtitle: "x", requestId: "r", tool: "shell", answered: "expired" })).toBe("Voided");
  });

  it("previews a message by its text, card or tool", () => {
    expect(messageLine(undefined)).toBe("");
    expect(messageLine({ role: "bot", kind: "text", text: " hi\n there " })).toBe("hi there");
    expect(messageLine({ role: "bot", kind: "options", card: { title: "Price?", subtitle: "" } })).toBe("Price?");
    expect(messageLine({ role: "bot", kind: "activity", tool: { name: "Read" } })).toBe("Read");
  });
});
