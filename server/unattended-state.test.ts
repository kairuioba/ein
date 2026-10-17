// The unattended mark must follow the turn that earned it, not the bot for
// ever: a long-running turn stays unattended, an idle bot's stale mark ages
// out, and a turn that never dispatched leaves nothing behind.
import { describe, expect, it } from "vitest";

import { UnattendedBots, UNATTENDED_TTL_MS } from "./unattended-state.ts";

const MIN = 60_000;

describe("UnattendedBots", () => {
  it("keeps a long-running turn unattended even when it outlives the idle window", () => {
    let now = 0;
    const marks = new UnattendedBots(() => true, () => now);
    marks.mark("bot");
    now = UNATTENDED_TTL_MS + MIN;
    expect(marks.is("bot")).toBe(true);
    // the live turn keeps refreshing its own window
    now += UNATTENDED_TTL_MS + MIN;
    expect(marks.is("bot")).toBe(true);
  });

  it("lets an idle bot's stale mark age out instead of refreshing it on every read", () => {
    let now = 0;
    const marks = new UnattendedBots(() => false, () => now);
    marks.mark("bot");
    // a read inside the window (dispatch startTurn reads it on every run)
    // must not extend the window for a bot that is not running
    now = UNATTENDED_TTL_MS - MIN;
    expect(marks.is("bot")).toBe(true);
    now = UNATTENDED_TTL_MS + MIN;
    expect(marks.is("bot")).toBe(false);
    expect(marks.size()).toBe(0);
  });

  it("drops the mark of a turn that failed or was stopped before it dispatched", () => {
    let busy = false;
    const marks = new UnattendedBots(() => busy);
    marks.mark("bot");
    marks.settle("bot");
    expect(marks.is("bot")).toBe(false);
    // a turn that is running keeps its mark
    busy = true;
    marks.mark("bot");
    marks.settle("bot");
    expect(marks.is("bot")).toBe(true);
    // and a person typing ends it
    marks.clear("bot");
    expect(marks.is("bot")).toBe(false);
    // no mark for bots that were never marked
    expect(marks.is(undefined)).toBe(false);
    expect(marks.is("other")).toBe(false);
  });
});
