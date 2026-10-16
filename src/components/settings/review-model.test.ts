import { describe, expect, it } from "vitest";

import { DEFAULT_ORG_RULES } from "../../../shared/org-types";
import { reviewCounts, reviewRules } from "./review-model";

describe("auto-review rules", () => {
  it("always lists the owner's and the harness's ask-first rules, locked", () => {
    const rules = reviewRules([], DEFAULT_ORG_RULES);
    expect(rules.filter((rule) => rule.locked).map((rule) => rule.id)).toEqual(["external-publish", "destructive", "secrets"]);
    expect(rules.find((rule) => rule.id === "external-publish")?.params).toEqual({ minutes: 10 });
    expect(rules.find((rule) => rule.id === "over-budget")).toMatchObject({ kind: "ask", locked: false, params: { budget: 60 } });
  });

  it("reads each bot's own permissions, ignoring hidden bots", () => {
    const bots = [
      { id: "a", name: "A", autoApprove: true, alwaysAllow: ["Bash:git"] },
      { id: "b", name: "B", approvePeerComms: true, autoReview: "enforce" as const },
      { id: "c", name: "C", hidden: true, autoApprove: true },
    ];
    const rules = reviewRules(bots, DEFAULT_ORG_RULES);
    const byId = Object.fromEntries(rules.map((rule) => [rule.id, rule]));
    expect(byId["peer-comms"]?.botIds).toEqual(["b"]);
    expect(byId.manual?.botIds).toEqual(["b"]);
    expect(byId["auto-mode"]?.botIds).toEqual(["a"]);
    expect(byId["auto-review"]?.botIds).toEqual(["b"]);
    expect(byId["always-allow"]?.params).toEqual({ count: 1, example: "A · Bash:git" });
  });

  it("puts ask-first rules before approvals and counts them", () => {
    const rules = reviewRules([{ id: "a", name: "A", autoApprove: true }], DEFAULT_ORG_RULES);
    const firstAllow = rules.findIndex((rule) => rule.kind === "allow");
    expect(rules.slice(firstAllow).every((rule) => rule.kind === "allow")).toBe(true);
    expect(reviewCounts(rules)).toEqual({ ask: 4, allow: 2, locked: 3 });
  });

  it("drops the chief's powers rule when every power is off", () => {
    const rules = reviewRules([], { ...DEFAULT_ORG_RULES, chiefMay: { addPeople: false, newSpecialist: false, switchModel: false } });
    expect(rules.some((rule) => rule.id === "chief-within-budget")).toBe(false);
  });
});
