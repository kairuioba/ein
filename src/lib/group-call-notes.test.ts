import { describe, expect, it } from "vitest";

import {
  callActions,
  callGridShape,
  callPoints,
  captionLines,
  formatClock,
  formatOffset,
  splitSpoken,
  type CaptionLine,
} from "./group-call-notes";

const START = 1_000_000;
const bot = (id: string, offset: number, name: string, text: string) => ({
  id,
  at: START + offset,
  role: "bot" as const,
  kind: "text",
  text,
  from: { botId: name, name },
});

describe("clocks", () => {
  it("formats durations and offsets", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatOffset(48_000)).toBe("00:48");
    expect(formatOffset(402_000)).toBe("06:42");
    expect(formatOffset(-5)).toBe("00:00");
  });
});

describe("captionLines", () => {
  it("keeps spoken lines since the call started, with their offsets", () => {
    const lines = captionLines(
      [
        bot("old", -60_000, "总控", "上次的事"),
        bot("a", 5_000, "总控", "早。每人一分钟：做什么、几点交、卡在哪。"),
        { id: "u", at: START + 20_000, role: "user", kind: "text", text: "继续 <attached-file path=\"/a.pdf\" />" },
        { id: "chip", at: START + 21_000, role: "bot", kind: "activity", text: "" },
        bot("b", 48_000, "市场分析师", "看 [价格表](library:price) 的 **v3**"),
      ],
      START,
    );
    expect(lines.map((line) => [line.id, line.offsetMs, line.speaker.kind, line.text])).toEqual([
      ["a", 5_000, "bot", "早。每人一分钟：做什么、几点交、卡在哪。"],
      ["u", 20_000, "you", "继续"],
      ["b", 48_000, "bot", "看 价格表 的 v3"],
    ]);
  });

  it("names a 1:1 call's bot lines after the bot on the line", () => {
    const [line] = captionLines([{ id: "x", at: START, role: "bot", kind: "text", text: "好的" }], START, { botId: "b1", name: "小文" });
    expect(line.speaker).toEqual({ kind: "bot", botId: "b1", name: "小文" });
  });
});

describe("splitSpoken", () => {
  it("splits a reply after the utterance being read", () => {
    expect(splitSpoken("内容部今天 7 件。新闻稿要嘉宾名单，我先确认", "内容部今天 7 件。")).toEqual({
      spoken: "内容部今天 7 件。",
      pending: "新闻稿要嘉宾名单，我先确认",
    });
    expect(splitSpoken("abc", undefined)).toEqual({ spoken: "abc", pending: "" });
    expect(splitSpoken("abc", "zzz")).toEqual({ spoken: "abc", pending: "" });
  });
});

const line = (id: string, offset: number, name: string, text: string): CaptionLine => ({
  id,
  at: START + offset,
  offsetMs: offset,
  speaker: { kind: "bot", botId: name, name },
  text,
});

describe("callActions", () => {
  it("turns timed commitments into owned action items", () => {
    const actions = callActions([
      line("l0", 5_000, "总控", "早。每人一分钟：做什么、几点交、卡在哪。"),
      line("l1", 48_000, "市场分析师", "竞品调研 5 家，今天 15:40 前交；价格表先用 v3。"),
      line("l2", 123_000, "设计师", "主视觉下午出 4 版，16:50 前给老板挑；动效等主色定了再做。"),
      line("l3", 196_000, "阿杰", "详情页 24 个，14:00 开工，先上 4 个人；落地页等三段卖点终稿。"),
      line("l4", 200_000, "Atlas", "I'll send the deck by 3pm"),
    ]);
    expect(actions.map((action) => [action.ownerName, action.title, action.due, action.offsetMs, action.lineId])).toEqual([
      ["市场分析师", "竞品调研 5 家", "15:40 前", 48_000, "l1"],
      ["设计师", "主视觉下午出 4 版，给老板挑", "16:50 前", 123_000, "l2"],
      ["阿杰", "详情页 24 个，先上 4 个人", "14:00 开工", 196_000, "l3"],
      ["Atlas", "I'll send the deck", "by 3pm", 200_000, "l4"],
    ]);
  });

  it("takes the timed part of a long sentence as the item", () => {
    const [action] = callActions([line("x", 61_000, "总控", "三件事等你：主视觉 4 选 1，社媒帖子 18:00 要你批，嘉宾名单用哪版。")]);
    expect([action.title, action.due]).toEqual(["社媒帖子 要你批", "18:00"]);
  });

  it("ignores your own lines", () => {
    expect(callActions([{ ...line("u", 0, "x", "15:00 前交"), speaker: { kind: "you" } }])).toEqual([]);
  });
});

describe("callPoints", () => {
  it("leads with the goal, then the latest decisions and dependencies", () => {
    const lines = [
      line("l1", 48_000, "市场分析师", "竞品调研 5 家，今天 15:40 前交；价格表先用 v3。"),
      line("l3", 196_000, "阿杰", "详情页 24 个，14:00 开工；落地页等三段卖点终稿。"),
    ];
    expect(callPoints(lines, "目标：周五 19:30 发布会全套材料")).toEqual([
      "目标：周五 19:30 发布会全套材料",
      "价格表先用 v3",
      "落地页等三段卖点终稿",
    ]);
    expect(callPoints([], undefined)).toEqual([]);
  });

  it("skips questions and keeps one point per subject, decisions first", () => {
    const lines = [
      line("a", 5_000, "总控", "早。每人一分钟：做什么、几点交、卡在哪。"),
      line("b", 48_000, "市场分析师", "价格表先用 v3。"),
      line("c", 123_000, "设计师", "动效等主色定了再做。"),
      line("d", 196_000, "阿杰", "落地页等三段卖点终稿。"),
      line("e", 271_000, "总控", "收到。落地页在等卖点，小文 说说内容部。"),
      line("f", 302_000, "小文", "共享盘里有两版，我先确认。"),
    ];
    expect(callPoints(lines)).toEqual(["价格表先用 v3", "落地页在等卖点"]);
  });
});

describe("callGridShape", () => {
  it("lays out a 1:1 call, a room of five plus you, and a crowd", () => {
    expect(callGridShape(2)).toEqual({ cols: 2, rows: 1, scale: 2.5 });
    expect(callGridShape(6)).toEqual({ cols: 3, rows: 2, scale: 2.5 });
    expect(callGridShape(8)).toEqual({ cols: 4, rows: 2, scale: 2 });
    expect(callGridShape(14)).toEqual({ cols: 5, rows: 3, scale: 1.5 });
  });
});
