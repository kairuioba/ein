import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { initialTail, nextTail, showWorkingDots } from "./turn-tail";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

describe("showWorkingDots", () => {
  it("hides the dots when the bot is idle", () => {
    expect(showWorkingDots(false, msg({ role: "user" }))).toBe(false);
  });

  it("shows the dots while a turn runs with nothing settled yet", () => {
    expect(showWorkingDots(true, undefined)).toBe(true);
    expect(showWorkingDots(true, msg({ role: "user" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "activity" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "options" }))).toBe(true);
  });

  it("keeps the dots hidden after the reply settles, while busy winds down", () => {
    // the end-of-stream window: reply landed, turn.completed + busy:false
    // still in flight — re-showing the dots here is the jitter
    expect(showWorkingDots(true, msg({}))).toBe(false);
  });

  it("rooms: a settled reply only covers the bot that said it", () => {
    const fromA = msg({ from: { botId: "a", name: "A", color: "blue" } });
    expect(showWorkingDots(true, fromA, "a")).toBe(false);
    // the floor moved on — the next speaker's dots are real information
    expect(showWorkingDots(true, fromA, "b")).toBe(true);
    // no attribution (older data) — fail toward showing the indicator
    expect(showWorkingDots(true, msg({}), "a")).toBe(true);
  });
});

describe("nextTail", () => {
  const user = msg({ id: "u1", role: "user" });
  const chip = msg({ id: "t1", kind: "activity" });
  const reply = msg({ id: "r1" });

  it("pops the reply that lands after the working dots, in that render", () => {
    let tail = initialTail(user, true);
    tail = nextTail(tail, false, reply);
    expect(tail.arrivingId).toBe("r1");
    // that wait is answered: the next reply needs dots of its own
    expect(tail.armed).toBe(false);
  });

  it("does not pop a reply that never had dots to replace", () => {
    const tail = nextTail(initialTail(user, false), false, reply);
    expect(tail.arrivingId).toBeNull();
  });

  it("still pops when busy ends a frame before the reply lands", () => {
    let tail = initialTail(user, true);
    tail = nextTail(tail, false, user); // busy:false overtook the message frame
    expect(tail.armed).toBe(true);
    tail = nextTail(tail, false, reply);
    expect(tail.arrivingId).toBe("r1");
  });

  it("keeps waiting through tool chips and pops the final reply", () => {
    let tail = initialTail(user, true);
    tail = nextTail(tail, true, chip);
    expect(tail.arrivingId).toBeNull();
    tail = nextTail(tail, false, reply);
    expect(tail.arrivingId).toBe("r1");
  });

  it("returns the same state when nothing changed, so a render-phase update settles", () => {
    const tail = nextTail(initialTail(user, true), false, reply);
    expect(nextTail(tail, false, reply)).toBe(tail);
  });

  it("rooms: the next speaker's dots stay armed for their own reply", () => {
    let tail = initialTail(user, true);
    // A's reply lands in the same render that B takes the floor
    tail = nextTail(tail, true, msg({ id: "ra", from: { botId: "a", name: "A", color: "blue" } }));
    expect(tail.arrivingId).toBe("ra");
    expect(tail.armed).toBe(true);
    tail = nextTail(tail, false, msg({ id: "rb", from: { botId: "b", name: "B", color: "red" } }));
    expect(tail.arrivingId).toBe("rb");
  });
});
