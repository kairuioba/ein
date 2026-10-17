import { describe, expect, it } from "vitest";

import type { ExecPorts, ReviewPort } from "./evolution-executor.ts";
import type { EvolutionItem } from "./evolution.ts";
import type { PipelineRun } from "./evolution-pipeline.ts";
import { EvolutionService } from "./evolution-service.ts";

const proposal = (extra: Partial<EvolutionItem> = {}): EvolutionItem => ({
  id: "p1", signal: "missing_handoff", title: "t", why: "w", suggestedChange: "add example", area: "prompt", risk: "low", evidence: ["e"], status: "accepted", createdAt: 1, ...extra,
});
const run = (extra: Partial<PipelineRun> = {}): PipelineRun => ({ id: "evo-run:p1", proposalId: "p1", state: "accepted", baseSha: "", testFailures: 0, reviewBlocks: 0, implementRounds: 0, updatedAt: 1, ...extra });

const fakePorts = (overrides: Partial<ExecPorts> = {}): ExecPorts => ({
  createWorktree: async () => ({ dir: "/fake/worktree", branch: "evo/fake" }),
  removeWorktree: async () => undefined,
  proposeChange: async () => ({ error: "no implementer" }),
  runTests: async () => ({ ok: true, log: "ok" }),
  readDiff: async () => "diff --git a/docs/x.md b/docs/x.md\n+hello",
  commit: async () => ({ sha: "abc123" }),
  merge: async () => ({ ok: true, ref: "mergedref" }),
  revert: async () => ({ ok: true }),
  sha256File: async () => "hash",
  ...overrides,
});

const service = (ports: ExecPorts, review: ReviewPort = async () => ({ pass: false, reason: "stub" })) =>
  new EvolutionService({ buildPorts: () => ports, implementer: async () => ({ headSha: "abc123" }), review,  });

describe("evolution service orchestration", () => {
  it("stops before merge when tests fail and records the terminal state", async () => {
    const ports = fakePorts({
      proposeChange: async () => ({ headSha: "abc123" }),
      runTests: async () => ({ ok: false, log: "red" }),
    });
    const svc = service(ports);
    const record = await svc.start(proposal(), run(), "basesha");
    expect(record.state).toBe("rejected");
    expect(record.error).toBeTruthy();
    expect(svc.byProposal("p1")).toBeTruthy();
  });

  it("never merges without a merge_ready record", async () => {
    const svc = service(fakePorts());
    await svc.start(proposal(), run(), "basesha");
    const merged = await svc.approveMerge(proposal(), "abc123");
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain("not merge_ready");
  });

  it("calls merge once then removes the worktree for a merge_ready record", async () => {
    let mergeCalls = 0;
    let removed = 0;
    const ports = fakePorts({
      proposeChange: async () => ({ headSha: "abc123" }),
      merge: async () => { mergeCalls += 1; return { ok: true, ref: "ref" }; },
      removeWorktree: async () => { removed += 1; },
    });
    const review: ReviewPort = async () => ({ pass: true, reviewer: "fake" });
    const svc = service(ports, review);
    const record = await svc.start(proposal(), run(), "basesha");
    expect(record.state).toBe("merge_ready");
    const merged = await svc.approveMerge(proposal(), "abc123");
    expect(merged.ok).toBe(true);
    expect(mergeCalls).toBe(1);
    expect(removed).toBe(1);
  });

  it("rejects a mismatched head sha without merging", async () => {
    let mergeCalls = 0;
    const ports = fakePorts({
      proposeChange: async () => ({ headSha: "abc123" }),
      merge: async () => { mergeCalls += 1; return { ok: true, ref: "ref" }; },
    });
    const svc = service(ports, async () => ({ pass: true, reviewer: "fake" }));
    await svc.start(proposal(), run(), "basesha");
    const merged = await svc.approveMerge(proposal(), "other-sha");
    expect(merged.ok).toBe(false);
    expect(mergeCalls).toBe(0);
  });
});
