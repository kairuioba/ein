import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cadenceDue, CadenceStore, dailyBriefTime } from "./cadence.ts";
import { startOfDay } from "./util.ts";

const HOUR = 60 * 60_000;
const at = (hours: number, minutes = 0) => {
  const date = new Date(2026, 9, 16, hours, minutes, 0, 0);
  return date.getTime();
};

describe("cadenceDue", () => {
  it("posts the daily brief once, from its time on", () => {
    const base = { dailyBriefAt: "18:00", everyHours: 0, state: {} };
    expect(cadenceDue({ ...base, now: at(17, 59) }).daily).toBe(false);
    expect(cadenceDue({ ...base, now: at(18, 0) }).daily).toBe(true);
    // a late start still gets today's
    expect(cadenceDue({ ...base, now: at(21, 30) }).daily).toBe(true);
    // but only once a day
    expect(cadenceDue({ ...base, now: at(21, 30), state: { dailyDay: startOfDay(at(18)) } }).daily).toBe(false);
    expect(cadenceDue({ ...base, dailyBriefAt: "nope", now: at(21) }).daily).toBe(false);
  });

  it("reports progress every N hours, only while work runs", () => {
    const base = { dailyBriefAt: "23:59", everyHours: 2, state: {} };
    expect(cadenceDue({ ...base, now: at(12) }).progress).toBe(false);
    expect(cadenceDue({ ...base, now: at(12), activeSince: at(11) }).progress).toBe(false);
    expect(cadenceDue({ ...base, now: at(13), activeSince: at(11) }).progress).toBe(true);
    // counted from the last report
    expect(cadenceDue({ ...base, now: at(13), activeSince: at(9), state: { progressAt: at(12) } }).progress).toBe(false);
    expect(cadenceDue({ ...base, now: at(14), activeSince: at(9), state: { progressAt: at(12) } }).progress).toBe(true);
    expect(cadenceDue({ ...base, everyHours: 0, now: at(20), activeSince: at(9) }).progress).toBe(false);
  });

  it("reads the brief time in local time", () => {
    expect(dailyBriefTime(at(9), "18:30") - at(0)).toBe(18.5 * HOUR);
  });
});

describe("CadenceStore", () => {
  it("remembers what was posted across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cadence-"));
    new CadenceStore(dir).set({ dailyDay: 5, progressAt: 7 });
    expect(new CadenceStore(dir).get()).toEqual({ dailyDay: 5, progressAt: 7 });
  });
});
