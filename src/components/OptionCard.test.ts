import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OptionCard,
  cardOutcome,
  decisionIdOf,
  isLiveQuestion,
  isOnboardingCard,
  optionCardStatus,
  optionParts,
  questionParts,
  shouldHideOnboardingCard,
} from "./OptionCard";
import type { Message, OptionCardData } from "@/state/store";

const msg = (partial: Partial<Message> & Pick<Message, "id" | "kind">): Message => ({
  role: "bot",
  at: 1,
  ...partial,
});

describe("shouldHideOnboardingCard", () => {
  const quiz = msg({
    id: "quiz",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects"],
    },
  });
  const greeting = msg({ id: "hi", kind: "text", text: "Hey — I'm Echo." });
  const user = msg({ id: "u1", role: "user", kind: "text", text: "Hi bro" });

  it("keeps the quiz until the person talks", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz])).toBe(false);
  });

  it("hides once a later user message is on the path", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz, user])).toBe(true);
  });

  it("hides an answered or dismissed quiz even with no later user message", () => {
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, answered: "Work & projects" } }, [greeting, quiz]),
    ).toBe(true);
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, dismissed: true } }, [greeting, quiz]),
    ).toBe(true);
  });

  it("never hides a live permission or question card", () => {
    const ask = msg({
      id: "ask",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    expect(shouldHideOnboardingCard(ask, [greeting, quiz, user, ask])).toBe(false);
    const question = msg({
      id: "q",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: "which file?",
        options: [],
        requestId: "req-2",
      },
    });
    expect(shouldHideOnboardingCard(question, [user, question])).toBe(false);
  });

  it("never treats a card the org layer recorded as a decision as the quiz", () => {
    const recorded = { ...quiz, card: { ...quiz.card!, answered: "Work & projects", decisionId: 4 } };
    expect(isOnboardingCard(recorded)).toBe(false);
    expect(shouldHideOnboardingCard(recorded, [greeting, recorded, user])).toBe(false);
  });
});

describe("options card status", () => {
  const card = (patch: Partial<OptionCardData> = {}): OptionCardData => ({
    title: "Your bot has a question",
    subtitle: "Which price for the flagship?",
    options: ["799", "899"],
    requestId: "req-q",
    ...patch,
  });

  it("waits on you until answered", () => {
    expect(optionCardStatus(card())).toEqual({ tone: "amber", label: "Your call" });
  });

  it("shows the decision number with the choice once recorded", () => {
    expect(optionCardStatus(card({ answered: "799", decisionId: 3 }))).toMatchObject({ tone: "green", label: "Decision #3 · 799" });
    expect(optionCardStatus(card({ answered: "799" }))).toMatchObject({ tone: "green", label: "You chose 799" });
  });

  it("names just the value of a value-and-note choice, as the design does", () => {
    expect(optionCardStatus(card({ answered: "799 按渠道报价和参数页" }))).toEqual({
      tone: "green",
      label: "You chose 799",
      title: "799 按渠道报价和参数页",
    });
    expect(optionCardStatus(card({ answered: "799, with channel pricing", decisionId: 3 })).label).toBe("Decision #3 · 799");
  });

  it("clips a long choice in the pill and keeps the whole of it as the title", () => {
    const long = "Keep the current plan and revisit it next quarter";
    const status = optionCardStatus(card({ answered: long, decisionId: 3 }));
    expect(status.label.length).toBeLessThan(`Decision #3 · ${long}`.length);
    expect(status.label.endsWith("…")).toBe(true);
    expect(status.title).toBe(long);
  });

  it("voids a card nobody answered in time while unattended", () => {
    expect(optionCardStatus(card({ answered: "expired", dismissed: true }))).toEqual({ tone: "grey", label: "Voided" });
  });

  it("reads every word the harness writes when nobody chose", () => {
    expect(cardOutcome(card())).toEqual({ kind: "open" });
    expect(cardOutcome(card({ answered: "unavailable", dismissed: true }))).toEqual({ kind: "void", reason: "unavailable" });
    expect(cardOutcome(card({ answered: "deny", dismissed: true }))).toEqual({ kind: "void", reason: "deny" });
    expect(cardOutcome(card({ answered: "answer" }))).toEqual({ kind: "answered" });
    expect(cardOutcome(card({ answered: "a free-text reply" }))).toEqual({ kind: "choice", choice: "a free-text reply" });
    // an option that happens to be one of those words is still a choice
    expect(cardOutcome(card({ options: ["deny", "allow"], answered: "deny" }))).toEqual({ kind: "choice", choice: "deny" });
    expect(optionCardStatus(card({ answered: "unavailable" }))).toEqual({ tone: "grey", label: "Closed" });
    expect(optionCardStatus(card({ answered: "deny" }))).toEqual({ tone: "grey", label: "Dismissed" });
    expect(optionCardStatus(card({ answered: "answer" }))).toEqual({ tone: "green", label: "Answered" });
  });

  it("splits a choice into its value and note only when the first word reads as a value", () => {
    expect(optionParts("799 按渠道报价和参数页")).toEqual({ head: "799", rest: "按渠道报价和参数页" });
    expect(optionParts("699 按价格表 v3")).toEqual({ head: "699", rest: "按价格表 v3" });
    expect(optionParts("Kimi 负责前端")).toEqual({ head: "Kimi", rest: "负责前端" });
    expect(optionParts("2 weeks, then review")).toEqual({ head: "2", rest: "weeks, then review" });
    expect(optionParts("Work & projects")).toEqual({ head: "Work & projects" });
    expect(optionParts("方案 A 先做落地页")).toEqual({ head: "方案 A 先做落地页" });
    expect(optionParts("视频号直播（导社群）")).toEqual({ head: "视频号直播（导社群）" });
    expect(optionParts("  Allow  ")).toEqual({ head: "Allow" });
  });

  it("leads a live question with its first sentence and keeps the rest as the body", () => {
    expect(questionParts("请你裁决：旗舰款首发价用哪个？\n两边依据不同，定价不在我的权限里")).toEqual({
      title: "请你裁决：旗舰款首发价用哪个？",
      body: "两边依据不同，定价不在我的权限里",
    });
    expect(questionParts("发布会直播放在哪个平台？两边的预约量差不多。")).toEqual({
      title: "发布会直播放在哪个平台？",
      body: "两边的预约量差不多。",
    });
    expect(questionParts("Ship v2.1 or wait for v3? QA signs off Friday.")).toEqual({
      title: "Ship v2.1 or wait for v3?",
      body: "QA signs off Friday.",
    });
    expect(questionParts("Which file")).toEqual({ title: "Which file" });
    expect(questionParts("x".repeat(80))).toBeNull();
    expect(questionParts("  ")).toBeNull();
  });

  it("reads the decision id and the live question", () => {
    expect(decisionIdOf(card({ decisionId: 7 }))).toBe(7);
    expect(decisionIdOf(card())).toBeUndefined();
    expect(decisionIdOf(card({ decisionId: Number.NaN }))).toBeUndefined();
    expect(isLiveQuestion(card())).toBe(true);
    expect(isLiveQuestion(card({ requestId: undefined }))).toBe(false);
    expect(isLiveQuestion(card({ tool: "Bash" }))).toBe(false);
  });
});

describe("OptionCard", () => {
  const question = (patch: Partial<OptionCardData> = {}): Message =>
    msg({
      id: "price",
      kind: "options",
      from: { botId: "chief", name: "Chief", color: "blue" },
      card: {
        title: "Your call: which launch price?",
        subtitle: "",
        options: ["699 按价格表 v3", "799 按渠道报价和参数页"],
        ...patch,
      },
    });

  it("draws the chosen option as the black chip and says what you chose", () => {
    const markup = renderToStaticMarkup(createElement(OptionCard, { botId: "chief", message: question({ answered: "799 按渠道报价和参数页" }) }));
    expect(markup).toContain("You chose 799");
    expect(markup).toMatch(/aria-pressed="true"[^>]*class="[^"]*bg-primary text-primary-ink/);
    expect(markup).toContain("按渠道报价和参数页");
    expect(markup).not.toContain("Type your own answer");
  });

  it("names the decision by default, and just the choice where a room draws the decision itself", () => {
    const answered = question({ answered: "799 按渠道报价和参数页", decisionId: 3 });
    expect(renderToStaticMarkup(createElement(OptionCard, { botId: "chief", message: answered }))).toContain("Decision #3 · 799");
    const room = renderToStaticMarkup(createElement(OptionCard, { botId: "chief", message: answered, showDecision: false }));
    expect(room).toContain("You chose 799");
    expect(room).not.toContain("Decision #3");
  });

  it("waits for an answer, with a free-text field, when a room routes answers itself", () => {
    const markup = renderToStaticMarkup(createElement(OptionCard, { botId: "chief", message: question(), onAnswer: () => {} }));
    expect(markup).toContain("Your call");
    expect(markup).toContain("Type your own answer");
    expect(markup).not.toContain('aria-pressed="true"');
  });
});
