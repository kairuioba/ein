import { describe, expect, it } from "vitest";

import { actionOf, approvalEventFor, autoApprovedRow, ruleLabel, type DecisionRowInput } from "./approval-events.ts";

const row = (extra: Partial<DecisionRowInput>): DecisionRowInput => ({
  threadId: "t-1",
  requestId: "r-1",
  botId: "dev-1",
  botName: "前端 1",
  tool: "Bash",
  summary: "npm install left-pad\nand more",
  decision: "card-shown",
  source: "no-grant",
  ...extra,
});

describe("approval events", () => {
  it("turns a card shown to the owner into approval.requested, naming the action", () => {
    expect(approvalEventFor(row({}), { section: "技术部" })).toEqual({
      kind: "approval.requested",
      title: "前端 1 is waiting for your approval: npm install left-pad",
      botId: "dev-1",
      section: "技术部",
      threadId: "t-1",
      detail: "npm install left-pad",
      severity: "warn",
    });
  });

  it("says when a card came from the external-publishing rule", () => {
    const event = approvalEventFor(row({ source: "external-publish", tool: "GMAIL_SEND_EMAIL", summary: "" }), { botName: "社媒写手", groupId: "g1" });
    expect(event).toMatchObject({ kind: "approval.requested", title: "社媒写手 wants to publish outside — needs your approval: GMAIL_SEND_EMAIL", groupId: "g1" });
  });

  it("covers auto-approvals, the owner's answers and expiries, and skips the rest", () => {
    expect(approvalEventFor(row({ decision: "auto-approved", source: "auto-mode" }), {})).toMatchObject({
      kind: "approval.auto",
      title: "Approved for 前端 1 by rule: npm install left-pad",
      severity: "info",
    });
    expect(approvalEventFor(row({ decision: "user-approved", source: "user" }), {})).toMatchObject({ kind: "approval.resolved", title: "You approved 前端 1: npm install left-pad" });
    expect(approvalEventFor(row({ decision: "user-denied", source: "user" }), {})).toMatchObject({ kind: "approval.resolved", title: "You denied 前端 1: npm install left-pad" });
    expect(approvalEventFor(row({ decision: "expired", source: "unattended-expiry" }), {})).toMatchObject({
      kind: "approval.expired",
      title: "Expired unanswered while unattended — 前端 1: npm install left-pad",
      detail: "npm install left-pad",
      severity: "warn",
    });
    expect(approvalEventFor(row({ source: "question" }), {})).toBeNull();
    expect(approvalEventFor(row({ decision: "review-would-approve", source: "auto-review-shadow" }), {})).toBeNull();
  });

  it("names the rule behind an auto-approval", () => {
    expect(ruleLabel({ source: "always-allow", rule: "Bash:git" })).toBe("Always allowed: Bash:git");
    expect(ruleLabel({ source: "auto-mode" })).toBe("Auto mode is on for this bot");
    expect(ruleLabel({ source: "auto-review", rule: "routine read-only command" })).toBe("The reviewer approved it: routine read-only command");
    expect(ruleLabel({ source: "auto-review" })).toBe("The reviewer approved it");
  });

  it("lists auto-approvals for the brief with their time and rule", () => {
    const at = new Date(2026, 9, 15, 16, 10).toISOString();
    expect(autoApprovedRow({ ...row({ decision: "auto-approved", source: "always-allow", rule: "Bash:npm" }), at })).toEqual({
      id: "r-1",
      title: "npm install left-pad",
      botId: "dev-1",
      at: Date.parse(at),
      rule: "Always allowed: Bash:npm",
    });
    expect(autoApprovedRow({ ...row({}), at })).toBeNull();
    expect(autoApprovedRow({ ...row({ decision: "auto-approved", source: "auto-mode" }), at: "not a date" })).toBeNull();
  });

  it("falls back to the tool when there is no summary", () => {
    expect(actionOf({ summary: "", tool: "WebFetch" })).toBe("WebFetch");
    expect(actionOf({})).toBe("an action");
  });
});
