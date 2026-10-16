import { beforeEach, describe, expect, it, vi } from "vitest";

import { callStartedAt, currentCall, deferCallCleanup, endCall, startCall } from "./call";

describe("call ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    endCall();
  });

  it("does not let stale cleanup hang up a newer call", () => {
    startCall("bot-a");
    startCall("bot-b");

    expect(endCall("bot-a")).toBe(false);
    expect(currentCall()).toBe("bot-b");
    expect(endCall("bot-b")).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("does not let StrictMode's effect probe hang up a new call", async () => {
    startCall("bot-a");
    let mounted = false;
    deferCallCleanup("bot-a", () => mounted);
    mounted = true;

    await Promise.resolve();

    expect(currentCall()).toBe("bot-a");
  });

  it("hangs up after a genuine call-screen unmount", async () => {
    startCall("bot-a");
    deferCallCleanup("bot-a", () => false);

    await Promise.resolve();

    expect(currentCall()).toBeNull();
  });

  it("remembers when the call started until it ends", () => {
    expect(callStartedAt()).toBeNull();
    startCall("room-a", 1_000);
    expect(callStartedAt()).toBe(1_000);
    // placing the same call again keeps the original start
    startCall("room-a", 5_000);
    expect(callStartedAt()).toBe(1_000);
    // a different call restarts the clock
    startCall("room-b", 9_000);
    expect(callStartedAt()).toBe(9_000);
    endCall("room-b");
    expect(callStartedAt()).toBeNull();
  });
});
