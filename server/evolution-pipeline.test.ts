import { describe, expect, it } from "vitest";

import { pipelineHeadline, transition, type PipelineRun } from "./evolution-pipeline.ts";

const run = (extra: Partial<PipelineRun> = {}): PipelineRun => ({
  id: "p1", state: "accepted", baseSha: "base", testFailures: 0, reviewBlocks: 0, implementRounds: 0, updatedAt: 0, ...extra,
});
const ok = (r: PipelineRun, event: Parameters<typeof transition>[1]) => {
  const t = transition(r, event);
  expect(t.ok).toBe(true);
  return t.run;
};

describe("evolution pipeline", () => {
  it("happy path merges only after owner approval at the same head sha", () => {
    let r = ok(run(), { type: "provision", baseSha: "base1" });
    r = ok(r, { type: "implement", headSha: "h1" });
    r = ok(r, { type: "guard_pass" });
    r = ok(r, { type: "test_pass" });
    r = ok(r, { type: "review_pass" });
    expect(r.state).toBe("merge_ready");
    expect(transition(r, { type: "approve_merge", headSha: "h1", by: "bot" })).toMatchObject({ ok: false });
    expect(transition(r, { type: "approve_merge", headSha: "h2", by: "owner" })).toMatchObject({ ok: false });
    const merged = ok(r, { type: "approve_merge", headSha: "h1", by: "owner" });
    expect(merged.state).toBe("merged");
    expect(merged.ownerApprovedAtHead).toBe("h1");
  });

  it("guard violations are rejected immediately, never retried", () => {
    let r = ok(run(), { type: "provision", baseSha: "b" });
    r = ok(r, { type: "implement", headSha: "h1" });
    const blocked = transition(r, { type: "guard_violation", reason: "touched server/" });
    expect(blocked.ok).toBe(false);
    expect(blocked.run.state).toBe("rejected");
    expect(transition(blocked.run, { type: "implement", headSha: "h2" }).ok).toBe(false);
  });

  it("test failures retry twice, the third rejects", () => {
    let r = ok(run(), { type: "provision", baseSha: "b" });
    r = ok(r, { type: "implement", headSha: "h1" });
    r = ok(r, { type: "guard_pass" });
    r = ok(r, { type: "test_fail", reason: "red" });
    expect(r.state).toBe("implementing");
    r = ok(r, { type: "implement", headSha: "h2" });
    r = ok(r, { type: "guard_pass" });
    r = ok(r, { type: "test_fail", reason: "red" });
    expect(r.state).toBe("implementing");
    r = ok(r, { type: "implement", headSha: "h3" });
    r = ok(r, { type: "guard_pass" });
    expect(transition(r, { type: "test_fail", reason: "red" }).run.state).toBe("rejected");
  });

  it("a new head sha invalidates earlier approvals and returns to guarding", () => {
    let r = ok(run(), { type: "provision", baseSha: "b" });
    r = ok(r, { type: "implement", headSha: "h1" });
    r = ok(r, { type: "guard_pass" });
    r = ok(r, { type: "test_pass" });
    r = ok(r, { type: "review_pass" });
    const moved = ok(r, { type: "implement", headSha: "h2" });
    expect(moved.guardOkAtHead).toBeUndefined();
    const approve = transition(moved, { type: "approve_merge", headSha: "h2", by: "owner" });
    expect(approve.ok).toBe(false);
    expect(approve.run.state).toBe("guarding");
    expect(pipelineHeadline(approve.run)).toContain("检查改动范围");
  });
});
