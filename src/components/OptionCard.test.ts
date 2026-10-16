import { describe, expect, it } from "vitest";

import { decisionIdOf, isLiveQuestion, isOnboardingCard, optionCardStatus, shouldHideOnboardingCard } from "./OptionCard";
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

  it("clips a long choice in the pill and keeps the whole of it as the title", () => {
    const long = "799, with channel pricing and a spec page";
    const status = optionCardStatus(card({ answered: long, decisionId: 3 }));
    expect(status.label.length).toBeLessThan(`Decision #3 · ${long}`.length);
    expect(status.label.endsWith("…")).toBe(true);
    expect(status.title).toBe(long);
  });

  it("voids a card nobody answered in time while unattended", () => {
    expect(optionCardStatus(card({ answered: "expired", dismissed: true }))).toEqual({ tone: "grey", label: "Voided" });
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
