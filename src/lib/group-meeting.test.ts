import { describe, expect, it } from "vitest";

import type { OrgDecision } from "../../shared/org-types";
import {
  choiceToken,
  decisionForMessage,
  decisionHeadline,
  decisionsForGroup,
  isAnsweredQuestion,
  meetingChair,
  meetingState,
  meetingTiming,
  meetingWindow,
  minutesDocFor,
  minutesDocName,
  openQuestion,
  parseAgenda,
} from "./group-meeting";

const at = (hh: number, mm: number, ss = 0) => new Date(2026, 9, 15, hh, mm, ss).getTime();
type TestMessage = Parameters<typeof meetingState>[0]["messages"][number];
const text = (id: string, when: number, role: "bot" | "user" = "bot"): TestMessage => ({ id, at: when, role, kind: "text" });
const question = (id: string, when: number, card: Partial<NonNullable<TestMessage["card"]>> = {}): TestMessage => ({
  id,
  at: when,
  role: "bot",
  kind: "options",
  card: { requestId: `req-${id}`, options: ["699 · 按价格表 v3", "799 · 按渠道报价和参数页"], ...card },
});

describe("parseAgenda", () => {
  it("reads topic, host and time limit from the bulletin's first line", () => {
    const agenda = parseAgenda("议题：旗舰款价格 699 还是 799 · 主持：总控 · 时限 15 分钟\n其他说明");
    expect(agenda).toMatchObject({ topic: "旗舰款价格 699 还是 799", host: "总控", limitMin: 15 });
    expect(agenda?.parts).toEqual([
      { key: "议题", value: "旗舰款价格 699 还是 799", topic: true },
      { key: "主持", value: "总控" },
      { value: "时限 15 分钟" },
    ]);
  });

  it("understands English keys and a colon before the limit", () => {
    expect(parseAgenda("Topic: launch price | Host: Chief | Time limit: 20 min")).toMatchObject({
      topic: "launch price",
      host: "Chief",
      limitMin: 20,
    });
  });

  it("keeps a plain bulletin as one part with no topic, and ignores empty ones", () => {
    expect(parseAgenda("周五 19:30 新品发布会 · 全套材料")).toMatchObject({
      topic: undefined,
      parts: [{ value: "周五 19:30 新品发布会" }, { value: "全套材料" }],
    });
    expect(parseAgenda("  \n ")).toBeNull();
    expect(parseAgenda(undefined)).toBeNull();
  });
});

describe("meeting state", () => {
  it("is idle before anyone speaks and live while a member works", () => {
    expect(meetingState({ messages: [], busy: false, decided: false })).toBe("idle");
    expect(meetingState({ messages: [text("a", at(16, 13))], busy: true, decided: false })).toBe("live");
  });

  it("waits on the owner while a question is open, even mid-turn", () => {
    const messages = [text("a", at(16, 13)), question("q", at(16, 16))];
    expect(openQuestion(messages)?.id).toBe("q");
    expect(meetingState({ messages, busy: true, decided: false })).toBe("waiting");
  });

  it("ends when the room is quiet after a decision or an answered question", () => {
    const answered = [text("a", at(16, 13)), question("q", at(16, 16), { answered: "799 · 按渠道报价和参数页" })];
    expect(isAnsweredQuestion(answered[1])).toBe(true);
    expect(meetingState({ messages: answered, busy: false, decided: false })).toBe("ended");
    expect(meetingState({ messages: answered, busy: true, decided: true })).toBe("live");
    expect(meetingState({ messages: [text("a", at(16, 13))], busy: false, decided: true })).toBe("ended");
  });

  it("does not count a voided question as a decision", () => {
    const voided = [question("q", at(16, 16), { answered: "unavailable", dismissed: true })];
    expect(isAnsweredQuestion(voided[0])).toBe(false);
    expect(meetingState({ messages: voided, busy: false, decided: false })).toBe("live");
  });
});

describe("meetingTiming", () => {
  const window = meetingWindow([{ at: at(16, 12, 40) }, { at: at(16, 24, 10) }, { at: at(16, 13) }]);

  it("spans the first to the last message", () => {
    expect(window).toEqual({ start: at(16, 12, 40), end: at(16, 24, 10) });
    expect(meetingWindow([])).toBeNull();
  });

  it("says how early an ended meeting finished against its limit", () => {
    expect(meetingTiming(window, "ended", 15, at(17, 0))).toMatchObject({ durationMin: 12, earlyMin: 3 });
    expect(meetingTiming(window, "ended", 10, at(17, 0))).toMatchObject({ durationMin: 12, overMin: 2 });
    expect(meetingTiming(window, "ended", undefined, at(17, 0))).toEqual({ start: at(16, 12, 40), end: at(16, 24, 10), durationMin: 12 });
  });

  it("counts a running meeting up to now", () => {
    expect(meetingTiming(window, "live", 15, at(16, 20))).toMatchObject({ end: at(16, 24, 10), durationMin: 12, leftMin: 3 });
    expect(meetingTiming(window, "live", 15, at(16, 30))).toMatchObject({ durationMin: 18, overMin: 3 });
  });
});

describe("meetingChair", () => {
  const members = [
    { id: "chief", name: "总控" },
    { id: "wen", name: "小文" },
  ];
  it("prefers the host the agenda names, then the lead, then the chief", () => {
    expect(meetingChair(members, parseAgenda("议题：价格 · 主持：小文"), "chief", "chief")?.id).toBe("wen");
    expect(meetingChair(members, parseAgenda("议题：价格 · 主持：老王"), "wen", "chief")?.id).toBe("wen");
    expect(meetingChair(members, null, undefined, "chief")?.id).toBe("chief");
    expect(meetingChair(members, null, undefined, undefined)).toBeUndefined();
  });
});

describe("decisions", () => {
  const decision = (id: number, source: OrgDecision["source"], extra: Partial<OrgDecision> = {}): OrgDecision => ({
    id,
    title: "旗舰款价格用 799",
    choice: "799 · 按渠道报价和参数页",
    options: [],
    decidedBy: "owner",
    at: at(16, 23),
    source,
    actionItems: [],
    ...extra,
  });
  const all = [
    decision(4, { kind: "group", id: "g1", messageId: "q2" }),
    decision(3, { kind: "group", id: "g1", messageId: "q1" }),
    decision(2, { kind: "chat", id: "bot" }),
  ];

  it("lists a room's decisions in order", () => {
    expect(decisionsForGroup(all, "g1").map((entry) => entry.id)).toEqual([3, 4]);
  });

  it("finds a card's decision by the patched id first, then by its message", () => {
    expect(decisionForMessage(all, { ...question("q1", 0), card: { requestId: "r", decisionId: 4 } })?.id).toBe(4);
    expect(decisionForMessage(all, question("q1", 0))?.id).toBe(3);
    expect(decisionForMessage(all, question("zz", 0))).toBeUndefined();
  });

  it("speaks a choice by its leading figure and never repeats it in the headline", () => {
    expect(choiceToken("799 · 按渠道报价和参数页")).toBe("799");
    expect(choiceToken("699（按价格表 v3）")).toBe("699");
    expect(choiceToken("按 v2 · 9 人")).toBe("按 v2");
    expect(decisionHeadline({ title: "旗舰款价格用 799", choice: "799 · 按渠道报价和参数页" })).toBe("旗舰款价格用 799");
    expect(decisionHeadline({ title: "旗舰款首发价用哪个？", choice: "799 · 按渠道报价" })).toBe("旗舰款首发价用哪个？ → 799");
  });
});

describe("minutes doc", () => {
  const docs = [
    { title: "价格表", updatedAt: 9 },
    { title: "会议纪要 · 价格对齐会 10-14", updatedAt: 1 },
    { title: "会议纪要 · 价格对齐会 10-15", updatedAt: 5 },
    { title: "会议纪要 · 新品发布会", updatedAt: 7 },
  ];
  it("picks the newest minutes that name the room", () => {
    expect(minutesDocFor(docs, "价格对齐会")?.title).toBe("会议纪要 · 价格对齐会 10-15");
    expect(minutesDocFor(docs, "站会")).toBeUndefined();
    expect(minutesDocFor(docs, "")).toBeUndefined();
  });

  it("drops the filing prefix from the shown name", () => {
    expect(minutesDocName("会议纪要 · 价格对齐会 10-15")).toBe("价格对齐会 10-15");
    expect(minutesDocName("Minutes: launch sync")).toBe("launch sync");
    expect(minutesDocName("价格对齐会纪要")).toBe("价格对齐会纪要");
  });
});
