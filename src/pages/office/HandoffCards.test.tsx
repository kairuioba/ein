// 交接回执卡的纯逻辑 + SSR 自检：排序（超时优先、最久等待在前）、状态词、
// 按钮只按 can* 渲染、退回编辑器、提示文案。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  HandoffList,
  handoffMinutes,
  handoffStateKey,
  sortHandoffCards,
  type HandoffCardData,
} from "./HandoffCards";

const card = (patch: Partial<HandoffCardData> = {}): HandoffCardData => ({
  runId: "run-1",
  subtaskId: "sub-1",
  title: "首版文案",
  state: "sent",
  round: 1,
  sentAt: 1_000,
  waitedMs: 6 * 60_000,
  overdue: false,
  canReceive: true,
  canReturn: true,
  canResend: false,
  nudgeCount: 0,
  ...patch,
});

const render = (element: ReturnType<typeof createElement>): string => renderToStaticMarkup(element);

const listOf = (handoffs: HandoffCardData[], extra: Partial<Parameters<typeof HandoffList>[0]> = {}) =>
  render(
    createElement(HandoffList, {
      handoffs,
      onReceive: () => {},
      onStartReturn: () => {},
      onCancelReturn: () => {},
      onReasonCode: () => {},
      onReasonText: () => {},
      onSubmitReturn: () => {},
      onResend: () => {},
      ...extra,
    }),
  );

describe("sortHandoffCards", () => {
  it("puts overdue first, then the longest wait", () => {
    const sorted = sortHandoffCards([
      card({ subtaskId: "short", waitedMs: 60_000 }),
      card({ subtaskId: "old", waitedMs: 30 * 60_000 }),
      card({ subtaskId: "late", waitedMs: 2 * 60_000, overdue: true }),
      card({ subtaskId: "mid", waitedMs: 10 * 60_000 }),
    ]);
    expect(sorted.map((entry) => entry.subtaskId)).toEqual(["late", "old", "mid", "short"]);
  });

  it("is stable on equal waits", () => {
    const sorted = sortHandoffCards([
      card({ subtaskId: "b", waitedMs: 5_000 }),
      card({ subtaskId: "a", waitedMs: 5_000 }),
    ]);
    expect(sorted.map((entry) => entry.subtaskId)).toEqual(["a", "b"]);
  });
});

describe("handoffStateKey / handoffMinutes", () => {
  it("labels every state, and a sent-but-overdue handoff reads as expired", () => {
    expect(handoffStateKey(card())).toBe("Waiting to receive");
    expect(handoffStateKey(card({ state: "received" }))).toBe("Received");
    expect(handoffStateKey(card({ state: "returned", canReturn: false }))).toBe("Returned");
    expect(handoffStateKey(card({ state: "expired" }))).toBe("Expired");
    expect(handoffStateKey(card({ overdue: true }))).toBe("Expired");
    expect(handoffStateKey(card({ legacy: true, state: "received" }))).toBe("Legacy handoff");
  });

  it("formats the wait in minutes with a 1-minute floor", () => {
    expect(handoffMinutes(0)).toBe(1);
    expect(handoffMinutes(6 * 60_000)).toBe(6);
    expect(handoffMinutes(132 * 60_000)).toBe(132);
    expect(handoffMinutes(Number.NaN)).toBe(1);
  });
});

describe("HandoffList", () => {
  it("renders receive/return only when the state machine allows them", () => {
    const markup = listOf([card({ assigneeName: "阿哲" })]);
    expect(markup).toContain("Handoffs");
    expect(markup).toContain("首版文案");
    expect(markup).toContain("Waiting to receive");
    expect(markup).toContain("Waiting 6 min");
    expect(markup).toContain("Handed to 阿哲");
    expect(markup).toContain("Receive");
    expect(markup).toContain("Return…");
    expect(markup).not.toContain("Resend");
  });

  it("marks overdue rows red and shows the nudge count + resend on a returned handoff", () => {
    const overdue = listOf([card({ overdue: true, waitedMs: 132 * 60_000 })]);
    expect(overdue).toContain("Overdue by 132 min");
    expect(overdue).toContain("text-danger");

    const returned = listOf([
      card({
        state: "returned",
        canReceive: false,
        canReturn: false,
        canResend: true,
        nudgeCount: 2,
        returnReason: { code: "wrong_scope", text: "范围跑偏了" },
      }),
    ]);
    expect(returned).toContain("Returned");
    expect(returned).toContain("Resend");
    expect(returned).toContain("Nudged 2 time(s)");
    expect(returned).toContain("范围跑偏了");
    expect(returned).not.toContain("Receive");
  });

  it("keeps received / legacy handoffs read-only", () => {
    const received = listOf([card({ state: "received", canReceive: false, canReturn: false })]);
    expect(received).toContain("Received");
    expect(received).not.toContain(">Receive<");
    expect(received).not.toContain("Return…");

    const legacy = listOf([card({ legacy: true, state: "received", canReceive: false, canReturn: false })]);
    expect(legacy).toContain("Legacy handoff");
    expect(legacy).not.toContain("Resend");
  });

  it("shows the inline return editor with a reason picker and a required sentence", () => {
    const markup = listOf([card()], { returning: "sub-1", reasonCode: "", reasonText: "" });
    expect(markup).toContain("Why return it?");
    expect(markup).toContain("Pick a reason");
    expect(markup).toContain("Missing input");
    expect(markup).toContain("Wrong scope");
    expect(markup).toContain("Overload"); // Overloaded
    expect(markup).toContain("One sentence: why send it back (required)");
    expect(markup).toContain("Confirm return");
    // 没选原因 / 没写说明 → 确认按钮 disabled
    expect(markup).toMatch(/Confirm return/);
    expect(markup).toContain("disabled");
  });

  it("surfaces the friendly conflict notice instead of an error wall", () => {
    const markup = listOf([card()], {
      notice: { tone: "error", text: "Already handled or expired — refreshed for you" },
    });
    expect(markup).toContain("Already handled or expired — refreshed for you");
  });
});
