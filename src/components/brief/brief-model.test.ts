// The brief's pure helpers: headline, progress, inbox order and timing,
// detail splitting, the folded day, the week start and the share text.
import { describe, expect, it } from "vitest";

import type { Brief, InboxItem, OrgEvent } from "../../../shared/org-types";
import { EMPTY_BRIEF } from "@/state/org-api";
import { briefText, foldTimeline, handlingMinutes, headlineOf, inboxOrder, isImageOption, percent, progressSegments, splitDetail, weekStart } from "./brief-model";

const item = (kind: InboxItem["kind"], since: number, detail?: string): InboxItem => ({ id: `${kind}${since}`, kind, title: kind, botId: "b", since, detail });
const event = (minute: number, title: string): OrgEvent => ({ id: String(minute), at: minute * 60_000, kind: "report", title });

describe("brief model", () => {
  it("keeps the server's headline and builds one from the numbers otherwise", () => {
    expect(headlineOf({ headline: "整体 13/31", done: 13, total: 31, needsYou: [] })).toBe("整体 13/31");
    expect(headlineOf({ headline: "", done: 13, total: 31, needsYou: [item("choice", 1)] })).toBe("Overall 13/31; 1 things need your call.");
    expect(headlineOf({ headline: "", done: 0, total: 0, needsYou: [] })).toBe("");
    expect(percent(13, 31)).toBe(42);
    expect(percent(0, 0)).toBe(0);
  });

  it("draws one progress segment per department and the rest in grey", () => {
    const segments = progressSegments(
      [
        { section: "市场部", color: "#0EA5E9", done: 3, total: 3, health: "green", status: "" },
        { section: "内容部", color: "#65A30D", done: 0, total: 7, health: "yellow", status: "" },
      ],
      10,
    );
    expect(segments).toEqual([
      { key: "市场部", flex: 3, color: "#0EA5E9" },
      { key: "__rest__", flex: 7, color: null },
    ]);
  });

  it("orders the inbox and estimates the time to clear it", () => {
    const items = [item("escalation", 5), item("approval", 8), item("choice", 9), item("choice", 2)];
    expect(inboxOrder(items).map((entry) => `${entry.kind}${entry.since}`)).toEqual(["choice2", "choice9", "approval8", "escalation5"]);
    expect(handlingMinutes(items)).toBe(3);
    expect(handlingMinutes([])).toBe(1);
  });

  it("reads the consequence and the content out of an item's detail", () => {
    expect(splitDetail(item("approval", 1, "18:00 前不批：顺延到明天\n周五 19:30 新品发布会"))).toEqual({ consequence: "18:00 前不批：顺延到明天", body: "周五 19:30 新品发布会" });
    expect(splitDetail(item("choice", 1, "不选：3 个尺寸都开不了工"))).toEqual({ consequence: "不选：3 个尺寸都开不了工" });
    expect(splitDetail(item("escalation", 1, "新闻稿按哪版写？"))).toEqual({ body: "新闻稿按哪版写？" });
    expect(splitDetail(item("approval", 1))).toEqual({});
    expect(isImageOption("https://example.com/kv-2.png")).toBe(true);
    expect(isImageOption("方向 2 · 斑马条纹")).toBe(false);
  });

  it("folds the middle of a long day", () => {
    const rows = foldTimeline([event(540, "站会"), event(840, "开工"), event(965, "分歧"), event(970, "加人"), event(984, "决定 #3"), event(1007, "失败"), event(1011, "主视觉")]);
    expect(rows.map((row) => row.kind)).toEqual(["event", "event", "fold", "event"]);
    const fold = rows[2] as Extract<(typeof rows)[number], { kind: "fold" }>;
    expect(fold.count).toBe(4);
    expect(fold.titles).toEqual(["分歧", "加人", "决定 #3"]);
    expect(foldTimeline([event(1, "a"), event(2, "b")])).toHaveLength(2);
  });

  it("finds Monday and writes a shareable text", () => {
    const thursday = new Date(2026, 9, 15, 16, 52).getTime();
    expect(new Date(weekStart(thursday)).getDay()).toBe(1);
    expect(new Date(weekStart(thursday)).getDate()).toBe(12);
    const brief: Brief = { ...EMPTY_BRIEF, headline: "整体 13/31", departments: [{ section: "市场部", color: "#0EA5E9", done: 3, total: 3, health: "green", status: "已交付" }], needsYou: [item("choice", 1)] };
    const text = briefText(brief, thursday, () => "设计师");
    expect(text).toContain("整体 13/31");
    expect(text).toContain("市场部 3/3 · 已交付");
    expect(text).toContain("- choice (设计师)");
  });
});
