import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import type { DispatchRun } from "../../../shared/dispatch-types";
import type { Routine, RoutineRun } from "@/lib/routines";
import {
  TIME_GAP_MS,
  anotherTime,
  currentFailure,
  dayChoice,
  dayLabel,
  failureText,
  isExpiryLine,
  isFailureLine,
  isSystemLine,
  isTurnError,
  nextOccurrence,
  nextReplyTarget,
  normalizeTime,
  plainText,
  replyIndex,
  routineSiblings,
  runProgress,
  runSummary,
  runningRunCount,
  runsForThread,
  runsKey,
  scheduleDays,
  scheduleTime,
  separatorBetween,
  slotByTime,
  typingLabel,
  withDayChoice,
  withTime,
} from "./chat-model";

const at = (hours: number, minutes = 0, dayOffset = 0) => new Date(2026, 9, 16 + dayOffset, hours, minutes).getTime();
const NOW = at(17, 0);

const msg = (partial: Partial<Message> & Pick<Message, "id">): Message => ({
  role: "bot",
  kind: "text",
  at: NOW,
  ...partial,
});
const activity = (id: string, tool: Message["tool"] & { system?: boolean }, extra: Partial<Message> = {}) =>
  msg({ id, kind: "activity", tool, ...extra });

describe("row kinds", () => {
  it("treats only server-marked activity as a system line", () => {
    expect(isSystemLine(activity("a", { name: "Created Squad B · 4 people", system: true }))).toBe(true);
    expect(isSystemLine(activity("b", { name: "Bash: ls", ok: true }))).toBe(false);
    expect(isSystemLine(msg({ id: "c", text: "hi" }))).toBe(false);
  });

  it("tells a failed turn from other failures", () => {
    const turn = activity("e", { name: "error: the CLI exited", ok: false });
    const retry = activity("r", { name: "@Front 3 will retry “Landing page” — timeout", ok: false });
    expect(isTurnError(turn)).toBe(true);
    expect(isFailureLine(turn)).toBe(false);
    expect(isFailureLine(retry)).toBe(true);
    expect(isFailureLine(activity("ok", { name: "Bash: ls", ok: true }))).toBe(false);
    expect(failureText(turn)).toBe("the CLI exited");
    expect(failureText(retry)).toContain("will retry");
  });

  it("recognises the company layer's expiry note in English and Chinese", () => {
    const english = activity("x", { name: "Nobody approved this within 10 minutes while unattended, so it did not run", ok: false });
    const chinese = activity("z", { name: "无人值守 30 分钟没人批，已作废，没有执行", ok: false });
    expect(isExpiryLine(english)).toBe(true);
    expect(isExpiryLine(chinese)).toBe(true);
    expect(isFailureLine(english)).toBe(false);
    expect(isExpiryLine(activity("y", { name: "Nobody approved this within ten minutes while unattended, so it did not run", ok: false }))).toBe(false);
    expect(isExpiryLine(activity("w", { name: "timeout, retrying", ok: false }))).toBe(false);
  });
});

describe("currentFailure", () => {
  it("returns the newest failure since anyone last spoke", () => {
    const failure = activity("f", { name: "timeout, retrying", ok: false });
    const later = activity("t", { name: "Dispatched “Copy” to @Writer" });
    expect(currentFailure([msg({ id: "u", role: "user" }), failure, later])?.id).toBe("f");
  });

  it("lets a reply or the person's next message move past it", () => {
    const failure = activity("f", { name: "error: boom", ok: false });
    expect(currentFailure([failure, msg({ id: "reply" })])).toBeUndefined();
    expect(currentFailure([failure, msg({ id: "next", role: "user" })])).toBeUndefined();
  });

  it("ignores bot-to-bot chips", () => {
    const comm = activity("c", { name: "Messaged @Kimi", ok: false }, { comm: { groupId: "g", withBotId: "b", withName: "Kimi", withColor: "blue" } });
    expect(currentFailure([comm])).toBeUndefined();
  });

  it("leaves an expired approval in the history instead of the strip", () => {
    const failure = activity("f", { name: "timeout, retrying", ok: false });
    const expiry = activity("x", { name: "Nobody approved this within 10 minutes while unattended, so it did not run", ok: false });
    expect(currentFailure([expiry])).toBeUndefined();
    expect(currentFailure([failure, expiry])?.id).toBe("f");
  });
});

describe("separatorBetween", () => {
  it("labels the first row and every new day with the day and time", () => {
    expect(separatorBetween(undefined, at(16, 10), NOW)).toEqual({ kind: "day", label: "Today 16:10" });
    expect(separatorBetween(at(23, 0, -1), at(9, 5), NOW)).toEqual({ kind: "day", label: "Today 09:05" });
    expect(separatorBetween(undefined, at(18, 0, -1), NOW)?.label).toBe("Yesterday 18:00");
  });

  it("shows just the clock after a long pause and nothing for a quick exchange", () => {
    expect(separatorBetween(at(16, 10), at(16, 10) + TIME_GAP_MS, NOW)).toEqual({ kind: "time", label: "16:20" });
    expect(separatorBetween(at(16, 10), at(16, 12), NOW)).toBeNull();
  });
});

describe("dayLabel", () => {
  it("says today, yesterday, the day before, a weekday, then a date", () => {
    expect(dayLabel(at(9, 0), NOW)).toBe("Today");
    expect(dayLabel(at(9, 0, -1), NOW)).toBe("Yesterday");
    expect(dayLabel(at(9, 0, -2), NOW)).toBe("The day before yesterday");
    expect(dayLabel(at(9, 0, -4), NOW)).toBe("Mon");
    expect(dayLabel(at(9, 0, -30), NOW)).toBe("Sep 16");
  });
});

describe("plainText", () => {
  it("drops markdown markers but keeps the words", () => {
    expect(plainText("This is **external** and `code` and *soft*")).toBe("This is external and code and soft");
    expect(plainText("## Title\n- one\n> quote\n1. two")).toBe("Title\none\nquote\ntwo");
    expect(plainText("see [the doc](https://x.y) ~~old~~")).toBe("see the doc old");
    expect(plainText("```js\nconst a = 1;\n```\nafter")).toBe("after");
    expect(plainText("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
});

describe("normalizeTime", () => {
  it("reads what people type into a time field", () => {
    expect(normalizeTime("18:00")).toBe("18:00");
    expect(normalizeTime("9:30")).toBe("09:30");
    expect(normalizeTime("0930")).toBe("09:30");
    expect(normalizeTime("18")).toBe("18:00");
    expect(normalizeTime("18：05")).toBe("18:05");
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("12:60")).toBeNull();
    expect(normalizeTime("noon")).toBeNull();
  });
});

describe("thread replies", () => {
  const messages = [
    msg({ id: "a", text: "post at 18:00?" }),
    msg({ id: "b", role: "user", text: "why", replyToId: "a" }),
    msg({ id: "c", text: "because", replyToId: "a" }),
    msg({ id: "d", role: "user", text: "ok", replyToId: "c" }),
    msg({ id: "self", text: "loop", replyToId: "self" }),
  ];

  it("indexes replies by the message they answer, oldest first", () => {
    const index = replyIndex(messages);
    expect(index.get("a")).toEqual(["b", "c"]);
    expect(index.get("c")).toEqual(["d"]);
    expect(index.has("self")).toBe(false);
  });

  it("walks the replies one click at a time and wraps", () => {
    expect(nextReplyTarget(["b", "c"], null)).toBe("b");
    expect(nextReplyTarget(["b", "c"], "b")).toBe("c");
    expect(nextReplyTarget(["b", "c"], "c")).toBe("b");
    expect(nextReplyTarget(["b", "c"], "elsewhere")).toBe("b");
    expect(nextReplyTarget([], null)).toBeUndefined();
  });
});

describe("slotByTime", () => {
  const rows = [at(16, 0), at(16, 30), at(17, 0)];

  it("puts each card after the last row at or before it", () => {
    const placed = slotByTime(rows, [{ id: "late", at: at(18, 0) }, { id: "mid", at: at(16, 40) }], { hasEarlier: false });
    expect(placed.map((entry) => [entry.card.id, entry.after])).toEqual([["mid", 1], ["late", 2]]);
  });

  it("keeps a card from before the window out while earlier history is folded", () => {
    expect(slotByTime(rows, [{ id: "old", at: at(10, 0) }], { hasEarlier: true })).toEqual([]);
    expect(slotByTime(rows, [{ id: "old", at: at(10, 0) }], { hasEarlier: false })[0]?.after).toBe(-1);
  });
});

describe("dispatch runs", () => {
  const run = (id: string, patch: Partial<DispatchRun>): DispatchRun => ({
    id,
    chiefBotId: "chief",
    sourceThreadId: "thread",
    goal: "Launch kit",
    policy: "balanced",
    status: "running",
    subtasks: [],
    createdAt: at(16, 0),
    updatedAt: at(16, 0),
    ...patch,
  });
  const subtask = (status: DispatchRun["subtasks"][number]["status"]) => ({
    id: status,
    title: status,
    brief: "",
    role: "",
    needs: [],
    difficulty: 2 as const,
    dependsOn: [],
    assigneeBotId: "b",
    status,
    attempts: 1,
  });

  it("counts a bot's top-level runs that are still working", () => {
    const runs = [
      run("1", {}),
      run("2", { status: "synthesizing" }),
      run("3", { status: "done" }),
      run("4", { chiefBotId: "other" }),
      run("5", { status: "awaiting-approval" }),
      // a department lead's plan for one subtask is part of run 1
      run("6", { parentRunId: "1", parentSubtaskId: "s1" }),
    ];
    expect(runningRunCount(runs, "chief")).toBe(2);
    expect(runningRunCount([run("7", { chiefBotId: "lead", parentRunId: "1" })], "lead")).toBe(0);
  });

  it("lists this conversation's runs oldest first", () => {
    const runs = [run("b", { createdAt: at(16, 30) }), run("a", {}), run("x", { sourceThreadId: "elsewhere" })];
    expect(runsForThread(runs, "thread").map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("summarises progress and changes its key only when something moved", () => {
    const live = run("1", { subtasks: [subtask("done"), subtask("running"), subtask("failed"), subtask("pending")] });
    expect(runProgress(live)).toEqual({ done: 1, total: 4, failed: 1, running: 1 });
    expect(runsKey([live])).toBe(runsKey([{ ...live }]));
    expect(runsKey([live])).not.toBe(runsKey([{ ...live, status: "done" }]));
  });
});

describe("typingLabel", () => {
  it("names the routine first, then the current step, else thinking", () => {
    expect(typingLabel("Chief", { routine: "Daily brief" })).toBe("Chief is running “Daily brief”");
    expect(typingLabel("Chief", { activity: "Running a command" })).toBe("Chief · Running a command");
    expect(typingLabel("Chief", {})).toBe("Chief is thinking");
  });
});

describe("routine panel", () => {
  const routine = (id: string, patch: Partial<Routine> = {}): Routine => ({
    id,
    name: "Daily brief",
    prompt: "Collect every report.",
    botId: "chief",
    runOn: "maus",
    enabled: true,
    schedule: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] },
    durationMinutes: 30,
    nextRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  });

  it("groups the same job at other times, and nothing else", () => {
    const all = [
      routine("b", { createdAt: 2, schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } }),
      routine("a"),
      routine("other-bot", { botId: "x" }),
      routine("other-prompt", { prompt: "Something else" }),
    ];
    expect(routineSiblings(all, all[1]!).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("describes days and times the way the panel shows them", () => {
    expect(scheduleDays({ type: "daily", time: "18:00", weekdays: [5, 4, 3, 2, 1] })).toBe("Weekdays");
    expect(scheduleDays({ type: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day");
    expect(scheduleDays({ type: "daily", time: "18:00", weekdays: [6, 0] })).toBe("Weekends");
    expect(scheduleDays({ type: "daily", time: "18:00", weekdays: [1, 3] })).toBe("Mon, Wed");
    expect(scheduleTime({ type: "daily", time: "18:00", weekdays: [1] })).toBe("Daily 18:00");
  });

  it("switches day sets and times without losing the other half", () => {
    const weekdays = { type: "daily" as const, time: "18:00", weekdays: [1, 2, 3, 4, 5] };
    expect(dayChoice(weekdays)).toBe("weekdays");
    expect(withDayChoice(weekdays, "daily")).toEqual({ type: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(withDayChoice({ type: "daily", time: "08:30", weekdays: [1, 3] }, "custom").weekdays).toEqual([1, 3]);
    const once = withDayChoice(weekdays, "once", at(17, 0));
    expect(once).toEqual({ type: "once", at: at(18, 0) });
    expect(withTime(weekdays, "07:45")).toEqual({ ...weekdays, time: "07:45" });
    expect(withTime(weekdays, "7:4")).toBe(weekdays);
    expect(anotherTime(weekdays)).toEqual({ ...weekdays, time: "19:00" });
    expect(anotherTime({ type: "daily", time: "23:30", weekdays: [1] })).toEqual({ type: "daily", time: "00:30", weekdays: [1] });
  });

  it("finds the next time a clock reading comes around", () => {
    expect(nextOccurrence("18:00", at(17, 0))).toBe(at(18, 0));
    expect(nextOccurrence("09:00", at(17, 0))).toBe(at(9, 0, 1));
  });

  it("summarises a run in one short line", () => {
    const run = (patch: Partial<RoutineRun>): RoutineRun => ({
      id: "r",
      routineId: "a",
      routineName: "Daily brief",
      botId: "chief",
      runOn: "maus",
      scheduledFor: at(18, 0),
      status: "completed",
      manual: false,
      createdAt: at(18, 0),
      ...patch,
    });
    expect(runSummary(run({ output: "## 14 reports · 3 need you\n\nDetails…" }))).toBe("14 reports · 3 need you");
    expect(runSummary(run({ status: "failed", error: "Computer was offline", output: "partial" }))).toBe("Computer was offline");
    expect(runSummary(run({ output: "x".repeat(80) }))).toHaveLength(48);
    expect(runSummary(run({}))).toBe("");
  });
});
