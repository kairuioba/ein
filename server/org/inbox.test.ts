import { describe, expect, it } from "vitest";

import type { DispatchRun } from "../../shared/dispatch-types.ts";
import { collectInbox, isDecisionCard, questionOf, type InboxSource } from "./inbox.ts";
import type { OrgBot, OrgCard, OrgGroup, OrgMessage } from "./util.ts";

const card = (extra: Partial<OrgCard> = {}): OrgCard => ({ title: "Approval needed", subtitle: "npm install left-pad", options: ["Allow", "Deny"], ...extra });
const msg = (id: string, at: number, cardData: OrgCard, from?: string): OrgMessage => ({
  id,
  role: "bot",
  kind: "options",
  at,
  card: cardData,
  ...(from ? { from: { botId: from } } : {}),
});

function source(threads: Record<string, OrgMessage[]>, extra: Partial<InboxSource> = {}): InboxSource {
  const bots: OrgBot[] = [
    { id: "writer", name: "社媒写手", threadId: "t-writer", tasks: [{ threadId: "t-writer" }, { threadId: "t-writer-2" }] },
    { id: "designer", name: "设计师", threadId: "t-designer" },
    { id: "gone", name: "Archived", threadId: "t-gone", hidden: true },
  ];
  const groups: OrgGroup[] = [{ id: "g1", name: "价格对齐会", threadId: "t-room", memberIds: ["writer", "designer"] }];
  return {
    bots,
    groups,
    messages: (threadId) => threads[threadId] ?? [],
    isLiveRequest: (_threadId, requestId) => requestId.startsWith("live"),
    runs: [],
    ...extra,
  };
}

describe("needs you", () => {
  it("lists live approvals with their request id and the external-publishing rule", () => {
    const items = collectInbox(
      source({
        "t-writer-2": [
          msg("m1", 10, card({ requestId: "live-1", tool: "GMAIL_SEND_EMAIL", subtitle: "发给 6 位嘉宾", rule: "External publishing always needs your approval" })),
          // an ask left over from a previous run of the server can no longer be answered
          msg("m2", 11, card({ requestId: "stale-1", tool: "Bash" })),
        ],
      }),
    );
    expect(items).toEqual([
      {
        id: "live-1",
        kind: "approval",
        title: "Needs your own approval (external)",
        botId: "writer",
        threadId: "t-writer-2",
        messageId: "m1",
        since: 10,
        detail: "发给 6 位嘉宾",
        rule: "External publishing always needs your approval",
        requestId: "live-1",
      },
    ]);
  });

  it("keeps durable harness asks (routines, skills, peer hand-offs) whatever the process", () => {
    const items = collectInbox(
      source({
        "t-writer": [
          msg("r", 1, card({ requestId: "stale-r", title: "Schedule a routine", routineRequest: {} })),
          msg("s", 2, card({ requestId: "stale-s", title: "Enable skill", skillRequest: {} })),
          msg("p", 3, card({ requestId: "stale-p", title: "@社媒写手 wants to contact @设计师", tool: "ask_bot" })),
        ],
      }),
    );
    expect(items.map((item) => [item.id, item.kind, item.title])).toEqual([
      ["stale-r", "approval", "Schedule a routine"],
      ["stale-s", "approval", "Enable skill"],
      ["stale-p", "approval", "@社媒写手 wants to contact @设计师"],
    ]);
  });

  it("lists a bot's question as a choice with its options, answerable through its request", () => {
    const items = collectInbox(
      source({
        "t-designer": [msg("q", 5, card({ title: "Your bot has a question", subtitle: "主视觉 4 选 1", options: ["1", "2", "3", "4"], requestId: "live-q" }))],
      }),
    );
    expect(items).toEqual([
      { id: "q", kind: "choice", title: "主视觉 4 选 1", botId: "designer", threadId: "t-designer", messageId: "q", since: 5, requestId: "live-q", options: ["1", "2", "3", "4"] },
    ]);
  });

  it("attributes room cards to the member who asked", () => {
    const items = collectInbox(source({ "t-room": [msg("g", 7, card({ title: "Your bot has a question", subtitle: "699 还是 799？", options: ["699", "799"], requestId: "live-g" }), "designer")] }));
    expect(items[0]).toMatchObject({ kind: "choice", botId: "designer", groupId: "g1", threadId: "t-room", title: "699 还是 799？" });
  });

  it("lists a harness choice card, but never the onboarding quiz, answered cards, or hidden bots", () => {
    const items = collectInbox(
      source({
        "t-writer": [
          msg("quiz", 1, card({ title: "What do you mostly want help with?", subtitle: "Pick", options: ["Work & projects", "Life admin"] })),
          // the quiz as a Chinese-language server wrote it
          msg("quiz-zh", 2, card({ title: "你最想在哪些方面得到帮助？", subtitle: "选一个", options: ["工作"] })),
          msg("answered", 3, card({ requestId: "live-a", tool: "Bash", answered: "allow" })),
          msg("dismissed", 4, card({ requestId: "live-d", tool: "Bash", dismissed: true })),
          msg("pick", 5, card({ title: "嘉宾名单按哪版？", subtitle: "共享盘里有两版", options: ["按 v2 · 9 人", "按 v1 · 12 人"] })),
        ],
        "t-gone": [msg("hidden", 6, card({ requestId: "live-h", tool: "Bash" }))],
      }),
    );
    const ids = items.map((item) => item.id);
    expect(ids).toContain("pick");
    expect(ids).not.toContain("quiz");
    expect(ids).not.toContain("quiz-zh");
    expect(ids).not.toContain("live-a");
    expect(ids).not.toContain("live-d");
    expect(ids).not.toContain("live-h");
    expect(items.find((item) => item.id === "pick")).toMatchObject({ kind: "choice", title: "嘉宾名单按哪版？", detail: "共享盘里有两版", options: ["按 v2 · 9 人", "按 v1 · 12 人"] });
  });

  it("lists a plan waiting to be started, and a bot waiting on the owner with no card", () => {
    const run = {
      id: "run-1",
      chiefBotId: "writer",
      sourceThreadId: "t-writer",
      goal: "新品发布会全套材料",
      status: "awaiting-approval",
      subtasks: [{ title: "海报" }, { title: "文案" }],
      createdAt: 3,
    } as unknown as DispatchRun;
    const base = source({ "t-designer": [{ id: "x", role: "bot", kind: "text", at: 9, text: "我需要嘉宾名单才能继续" }] }, { runs: [run] });
    const items = collectInbox({ ...base, bots: base.bots.map((bot) => (bot.id === "designer" ? { ...bot, activity: "waiting-on-you" } : bot)) });
    expect(items).toEqual([
      { id: "run:run-1", kind: "approval", title: "Start “新品发布会全套材料”?", botId: "writer", threadId: "t-writer", since: 3, detail: "海报 · 文案", runId: "run-1" },
      {
        id: "bot:designer",
        kind: "escalation",
        title: "设计师 is waiting for you",
        botId: "designer",
        threadId: "t-designer",
        since: 9,
        detail: "我需要嘉宾名单才能继续",
        chain: [{ botId: "designer", at: 9 }],
      },
    ]);
  });

  it("does not add a waiting bot twice when its card is already listed, and sorts oldest first", () => {
    const base = source({
      "t-designer": [msg("late", 20, card({ requestId: "live-2", tool: "Bash" }))],
      "t-writer": [msg("early", 10, card({ requestId: "live-1", tool: "Bash" }))],
    });
    const items = collectInbox({ ...base, bots: base.bots.map((bot) => ({ ...bot, activity: "waiting-on-you" })) });
    expect(items.map((item) => item.id)).toEqual(["live-1", "live-2"]);
  });
});

describe("card helpers", () => {
  it("reads the question from a provider question's subtitle", () => {
    expect(questionOf({ title: "Your bot has a question", subtitle: "Which one?", requestId: "r" })).toBe("Which one?");
    expect(questionOf({ title: "Pick a colour", subtitle: "for the hero", requestId: undefined })).toBe("Pick a colour");
  });

  it("knows which cards make decisions", () => {
    expect(isDecisionCard(card({ requestId: "r", tool: "Bash" }))).toBe(false);
    expect(isDecisionCard(card({ requestId: "r", routineRequest: {} }))).toBe(false);
    expect(isDecisionCard(card({ title: "What do you mostly want help with?", options: ["a"] }))).toBe(false);
    expect(isDecisionCard(card({ title: "Q", options: [] }))).toBe(false);
    expect(isDecisionCard(card({ title: "Your bot has a question", requestId: "r", tool: undefined, options: ["699", "799"] }))).toBe(true);
    expect(isDecisionCard(card({ title: "价格？", options: ["699", "799"] }))).toBe(true);
    expect(isDecisionCard(undefined)).toBe(false);
  });
});
