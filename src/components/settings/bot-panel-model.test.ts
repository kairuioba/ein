import { describe, expect, it } from "vitest";

import { countMemoryNotes, heroStatus, superiorOf, teamSize } from "./bot-panel-model";

describe("hero status", () => {
  it("poses the mascot by what the bot is doing", () => {
    expect(heroStatus({ busy: true })).toEqual({ tone: "blue", pose: "work", kind: "working" });
    expect(heroStatus({ activity: "waiting-on-you", busy: true })).toEqual({ tone: "amber", pose: "wave", kind: "waiting" });
    expect(heroStatus({ activity: "dead" })).toEqual({ tone: "red", pose: "scared", kind: "offline" });
    expect(heroStatus({})).toEqual({ tone: "grey", pose: "idle", kind: "idle" });
  });
});

describe("reporting line", () => {
  const bots = [
    { id: "main", name: "总控", chiefOfStaff: true },
    { id: "lead", name: "阿杰", section: "技术部", chiefOfStaff: true },
    { id: "dev", name: "前端 1", section: "技术部" },
    { id: "dev2", name: "前端 2", section: "技术部" },
    { id: "loose", name: "秋分" },
    { id: "solo", name: "插画师", section: "设计部" },
    { id: "gone", name: "旧", section: "技术部", hidden: true },
  ];

  it("sends the main bot to you, leads and loose bots to the main bot, members to their lead", () => {
    expect(superiorOf(bots[0]!, bots, "main")).toEqual({ kind: "you" });
    expect(superiorOf(bots[1]!, bots, "main")).toEqual({ kind: "bot", bot: bots[0] });
    expect(superiorOf(bots[2]!, bots, "main")).toEqual({ kind: "bot", bot: bots[1] });
    expect(superiorOf(bots[4]!, bots, "main")).toEqual({ kind: "bot", bot: bots[0] });
    // a department without a lead reports to the main bot
    expect(superiorOf(bots[5]!, bots, "main")).toEqual({ kind: "bot", bot: bots[0] });
    expect(superiorOf(bots[4]!, bots, undefined)).toEqual({ kind: "none" });
  });

  it("counts the people a lead leads", () => {
    expect(teamSize(bots[1]!, bots, "main")).toBe(2);
    expect(teamSize(bots[2]!, bots, "main")).toBe(0);
    expect(teamSize(bots[0]!, bots, "main")).toBe(5);
  });
});

describe("memory notes", () => {
  it("counts list items when the file has them", () => {
    expect(countMemoryNotes("# Notes\n- likes short reports\n- price list v4\n  * nested\n1. ship friday\n")).toBe(4);
  });

  it("counts plain lines otherwise, skipping headings and fences", () => {
    expect(countMemoryNotes("# Memory\n\nThe boss prefers 799.\n```\ncode\n```\nUse 价格表 v4.")).toBe(3);
    expect(countMemoryNotes("")).toBe(0);
  });
});
