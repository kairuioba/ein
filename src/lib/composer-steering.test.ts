import { describe, expect, it } from "vitest";

import { busyEngineInstance, canSteerBusyTarget } from "./composer-steering";

const bot = (id: string, instanceId: string) => ({ id, modelSelection: { instanceId } });
const instance = (instanceId: string, queueing: boolean | undefined) => ({
  instanceId,
  ...(queueing === undefined ? {} : { capabilities: { queueing } }),
});

describe("canSteerBusyTarget", () => {
  it("steers a 1:1 send when the bot's engine reports queueing", () => {
    expect(canSteerBusyTarget(undefined, undefined, bot("b1", "claude"), [instance("claude", true)])).toBe(true);
  });

  it("keeps the local hold when the engine cannot steer (or is unknown)", () => {
    expect(canSteerBusyTarget(undefined, undefined, bot("b1", "none"), [instance("none", false)])).toBe(false);
    expect(canSteerBusyTarget(undefined, undefined, bot("b1", "none"), [instance("none", undefined)])).toBe(false);
    expect(canSteerBusyTarget(undefined, undefined, bot("b1", "missing"), [instance("claude", true)])).toBe(false);
    expect(canSteerBusyTarget(undefined, undefined, undefined, [instance("claude", true)])).toBe(false);
  });

  it("steers a room send into the busy speaker's turn, not the default responder's", () => {
    const members = [bot("lead", "claude"), bot("scout", "plain-api")];
    const instances = [instance("claude", true), instance("plain-api", false)];
    const group = { busyBotId: "lead" };
    expect(canSteerBusyTarget(group, members, undefined, instances)).toBe(true);

    // the same room while the non-steering bot speaks keeps the local hold
    expect(canSteerBusyTarget({ busyBotId: "scout" }, members, undefined, instances)).toBe(false);
  });

  it("does not steer a room that is not busy", () => {
    expect(canSteerBusyTarget({ busyBotId: undefined }, [bot("lead", "claude")], undefined, [instance("claude", true)])).toBe(
      false,
    );
    expect(canSteerBusyTarget({}, [bot("lead", "claude")], undefined, [instance("claude", true)])).toBe(false);
  });

  it("falls back to the local hold when the speaker is not a known member", () => {
    expect(canSteerBusyTarget({ busyBotId: "gone" }, [bot("lead", "claude")], undefined, [instance("claude", true)])).toBe(
      false,
    );
    expect(canSteerBusyTarget({ busyBotId: "lead" }, undefined, undefined, [instance("claude", true)])).toBe(false);
  });
});

describe("busyEngineInstance", () => {
  it("names the room speaker's engine, else the 1:1 bot's", () => {
    const members = [bot("lead", "claude"), bot("scout", "plain-api")];
    expect(busyEngineInstance({ busyBotId: "scout" }, members, bot("b1", "x"))).toBe("plain-api");
    expect(busyEngineInstance({}, members, bot("b1", "x"))).toBeNull();
    expect(busyEngineInstance(undefined, members, bot("b1", "x"))).toBe("x");
    expect(busyEngineInstance(undefined, members, undefined)).toBeNull();
  });
});
