import { describe, expect, it } from "vitest";

import { attentionScore, canMergeGroup, classify, compareCards, mergeKey, type AttentionCard } from "./attention-gate.ts";

const make = (extra: Partial<AttentionCard> = {}): AttentionCard => ({ id: "c1", risk: "medium", ...extra });

describe("attention gate", () => {
  it("pushes only irreversible/high-impact cards with no safe default", () => {
    expect(classify(make({ irreversible: true, hasSafeDefault: false })).kind).toBe("push");
    expect(classify(make({ blastRadius: "money", hasSafeDefault: false })).kind).toBe("push");
    expect(classify(make({ irreversible: true, hasSafeDefault: true })).kind).toBe("inbox");
    expect(classify(make({ blastRadius: "external" })).kind).toBe("inbox");
  });

  it("auto-approves only reversible internal cards with a clean approval history", () => {
    const sample = make({ risk: "low", blastRadius: "internal", actionType: "retry", projectId: "p1" });
    expect(classify(sample, { approvals: 5, rejections: 0 }).kind).toBe("auto");
    expect(classify(sample, { approvals: 2, rejections: 0 }).kind).toBe("inbox");
    expect(classify(sample, { approvals: 6, rejections: 1 }).kind).toBe("inbox");
    expect(classify(sample, { approvals: 6, reverted: true }).kind).toBe("inbox");
    expect(classify(sample, { approvals: 6, autoApprovedToday: 20 })).toMatchObject({ kind: "inbox" });
  });

  it("archives stale suggestions with no downstream", () => {
    expect(classify(make({ suggestion: true, waitAgeMs: 25 * 60 * 60 * 1000 })).kind).toBe("archive");
    expect(classify(make({ suggestion: true, waitAgeMs: 25 * 60 * 60 * 1000, blockedDownstream: 2 })).kind).toBe("inbox");
  });

  it("orders critical first, then overdue SLA, then score", () => {
    const critical = make({ id: "a", risk: "critical", waitAgeMs: 1 });
    const overdue = make({ id: "b", risk: "high", slaMs: 1000, waitAgeMs: 2000 });
    const normal = make({ id: "c", risk: "low", waitAgeMs: 99999 });
    expect([normal, overdue, critical].sort(compareCards).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(attentionScore(critical)).toBeGreaterThan(attentionScore(normal));
  });

  it("merges only same project/cause/action, reversible and non-external groups", () => {
    const a = make({ id: "a", projectId: "p1", causeFingerprint: "f", actionType: "t", risk: "low" });
    const b = make({ id: "b", projectId: "p1", causeFingerprint: "f", actionType: "t", risk: "medium" });
    expect(mergeKey(a)).toBe(mergeKey(b));
    expect(canMergeGroup([a, b])).toBe(true);
    expect(canMergeGroup([a, make({ id: "c", projectId: "p2", causeFingerprint: "f", actionType: "t" })])).toBe(false);
    expect(canMergeGroup([a, make({ id: "d", projectId: "p1", causeFingerprint: "f", actionType: "t", blastRadius: "external" })])).toBe(false);
  });
});
