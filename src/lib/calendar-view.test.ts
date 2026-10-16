import { describe, expect, it } from "vitest";

import {
  agendaItems,
  cadenceLabel,
  callSessions,
  dayWord,
  durationLabel,
  shortWhen,
  isRecurringRoutine,
  laneSegments,
  monthGridDays,
  routineDaySummary,
  runMinutes,
  weekRangeLabel,
} from "./calendar-view";
import type { RoutineRun } from "./routines";

const monday = new Date(2026, 9, 12).getTime(); // Mon 12 Oct 2026

function run(partial: Partial<RoutineRun> & Pick<RoutineRun, "id" | "scheduledFor" | "status">): RoutineRun {
  return {
    routineId: "r1",
    routineName: "Daily report",
    botId: "b1",
    runOn: "maus",
    manual: false,
    createdAt: partial.scheduledFor,
    ...partial,
  };
}

describe("routine lane", () => {
  it("treats weekly schedules as recurring and one-offs as grid events", () => {
    expect(isRecurringRoutine({ schedule: { type: "daily", time: "09:00", weekdays: [1] } })).toBe(true);
    expect(isRecurringRoutine({ schedule: { type: "once", at: monday } })).toBe(false);
    expect(isRecurringRoutine(null)).toBe(false);
  });

  it("covers a weekday routine Monday to Friday as one bar", () => {
    expect(laneSegments([1, 2, 3, 4, 5], monday, 7)).toEqual([{ from: 0, to: 4 }]);
  });

  it("splits non-contiguous days into separate bars and joins Sunday at the end", () => {
    expect(laneSegments([1, 3, 0], monday, 7)).toEqual([
      { from: 0, to: 0 },
      { from: 2, to: 2 },
      { from: 6, to: 6 },
    ]);
  });

  it("does not claim days that ended before the routine was created", () => {
    const thursdayNoon = new Date(2026, 9, 15, 12).getTime();
    expect(laneSegments([0, 1, 2, 3, 4, 5, 6], monday, 7, thursdayNoon)).toEqual([{ from: 3, to: 6 }]);
  });

  it("counts today's runs, finds the waiting run and an unseen failure", () => {
    const now = new Date(2026, 9, 15, 16, 52).getTime();
    const today = (hour: number) => new Date(2026, 9, 15, hour).getTime();
    const summary = routineDaySummary(
      "r1",
      [
        run({ id: "a", scheduledFor: today(8), status: "completed" }),
        run({ id: "b", scheduledFor: today(10), status: "completed" }),
        run({ id: "c", scheduledFor: today(12), status: "failed" }),
        run({ id: "d", scheduledFor: today(14), status: "waiting" }),
        run({ id: "e", scheduledFor: today(18), status: "queued" }),
        run({ id: "y", scheduledFor: new Date(2026, 9, 14, 8).getTime(), status: "completed" }),
        run({ id: "other", routineId: "r2", scheduledFor: today(9), status: "completed" }),
      ],
      now,
    );
    expect(summary.ranToday).toBe(4);
    expect(summary.waiting?.id).toBe("d");
    expect(summary.failed?.id).toBe("c");
    expect(summary.last?.id).toBe("e");
  });

  it("measures a finished run in whole minutes", () => {
    expect(runMinutes({ startedAt: 0, finishedAt: 14 * 60_000 + 20_000 })).toBe(14);
    expect(runMinutes({ startedAt: 0 })).toBeNull();
  });
});

describe("call sessions", () => {
  it("splits a room's transcript at each scheduled delivery and counts who spoke", () => {
    const at = (minute: number) => monday + minute * 60_000;
    const messages = [
      { id: "m1", role: "user" as const, at: at(0), sendId: "calendar_c1_1" },
      { id: "m2", role: "bot" as const, at: at(2), from: { botId: "a" }, text: "done" },
      { id: "m3", role: "bot" as const, at: at(9), from: { botId: "b" }, text: "next step" },
      { id: "m4", role: "bot" as const, at: at(10), from: { botId: "outsider" }, text: "hi" },
      { id: "m5", role: "user" as const, at: at(1440), sendId: "calendar_c1_2" },
      { id: "m6", role: "bot" as const, at: at(1452), from: { botId: "a" }, text: "all good" },
      { id: "x", role: "user" as const, at: at(1500), sendId: "calendar_other_1" },
    ];
    const sessions = callSessions("c1", ["a", "b", "c"], messages);
    expect(sessions.map((session) => session.messageId)).toEqual(["m5", "m1"]);
    expect(sessions[1]).toMatchObject({ minutes: 10, attended: 2, invited: 3, lastLine: "hi" });
    expect(sessions[0]).toMatchObject({ attended: 1, lastLine: "all good" });
  });

  it("reports zero minutes for a session nobody answered yet", () => {
    expect(callSessions("c1", ["a"], [{ id: "m1", role: "user", at: monday, sendId: "calendar_c1_1" }])[0]?.minutes).toBe(0);
  });
});

describe("agenda", () => {
  it("strips numbering and bullets from multi-line descriptions", () => {
    expect(agendaItems("1. Each team two minutes\n2、Blockers get an owner\n- Decisions go to the brief\n\n")).toEqual([
      "Each team two minutes",
      "Blockers get an owner",
      "Decisions go to the brief",
    ]);
  });

  it("splits a one-line description on semicolons", () => {
    expect(agendaItems("各部门 2 分钟；卡点当场派人；要你拍板的事进简报")).toEqual(["各部门 2 分钟", "卡点当场派人", "要你拍板的事进简报"]);
    expect(agendaItems("Just one thing")).toEqual(["Just one thing"]);
    expect(agendaItems("   ")).toEqual([]);
  });
});

describe("labels and grids", () => {
  it("names common cadences", () => {
    expect(cadenceLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(cadenceLabel([5, 4, 3, 2, 1])).toBe("Mon to Fri");
    expect(cadenceLabel([6, 0])).toBe("Weekends");
    expect(cadenceLabel([0, 1])).toBe("Mon, Sun");
  });

  it("words days relative to now", () => {
    const now = new Date(2026, 9, 15, 16, 52).getTime();
    expect(dayWord(new Date(2026, 9, 15, 9).getTime(), now)).toBe("Today");
    expect(dayWord(new Date(2026, 9, 16, 9).getTime(), now)).toBe("Tomorrow");
    expect(dayWord(new Date(2026, 9, 14, 9).getTime(), now)).toBe("Yesterday");
    expect(dayWord(new Date(2026, 9, 13, 9).getTime(), now)).toBe("Tue");
  });

  it("keeps the clock for today and the day word otherwise", () => {
    const now = new Date(2026, 9, 15, 16, 52).getTime();
    expect(shortWhen(new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe("09:05");
    expect(shortWhen(new Date(2026, 9, 14, 9, 5).getTime(), now)).toBe("Yesterday");
  });

  it("formats durations and week ranges", () => {
    expect(durationLabel(14)).toBe("14 min");
    expect(durationLabel(60)).toBe("1 hr");
    expect(durationLabel(65)).toBe("1 hr 5 min");
    expect(weekRangeLabel(monday, 7, monday)).toBe("October 12 – 18");
  });

  it("lays a month out in six Monday-first weeks", () => {
    const days = monthGridDays(new Date(2026, 9, 20).getTime());
    expect(days).toHaveLength(42);
    expect(new Date(days[0]!).getDay()).toBe(1);
    expect(new Date(days[0]!).getDate()).toBe(28); // Mon 28 Sep 2026
    expect(days.some((day) => new Date(day).getMonth() === 9 && new Date(day).getDate() === 31)).toBe(true);
  });
});
