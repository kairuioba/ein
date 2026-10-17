import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ApprovalAuditStore } from "./approval-audit.ts";
import type { EvolutionItem } from "./evolution.ts";
import { EvolutionRunStore } from "./evolution-runs.ts";
import { transition } from "./evolution-pipeline.ts";

const item = (extra: Partial<EvolutionItem> = {}): EvolutionItem => ({
  id: "p1",
  signal: "missing_handoff",
  title: "员工常不交交接单",
  why: "why",
  suggestedChange: "add example",
  area: "prompt",
  risk: "low",
  evidence: ["e1"],
  status: "accepted",
  createdAt: 1,
  ...extra,
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-evo-runs-"));
  return { runs: new EvolutionRunStore(dir), audit: new ApprovalAuditStore(dir) };
};

describe("evolution runs wiring", () => {
  it("creates one deterministic run and one manual audit event for repeated accepts", () => {
    const { runs, audit } = temp();
    runs.onAccepted(item({},), audit, 1000);
    runs.onAccepted(item(), audit, 2000);
    expect(runs.list()).toHaveLength(1);
    expect(runs.list()[0]).toMatchObject({ id: "evo-run:p1", proposalId: "p1", state: "accepted" });
    expect(audit.stats("evolution.accept:prompt:low", "ein-self", 3000)).toMatchObject({ manualApproved: 1, trustLevel: "manual" });
  });

  it("rejected or deferred proposals create no run and no trust", () => {
    const { runs, audit } = temp();
    expect(runs.byProposal("p1")).toBeUndefined();
    expect(runs.list()).toHaveLength(0);
    expect(audit.stats("evolution.accept:prompt:low", "ein-self", 3000).manualApproved).toBe(0);
  });

  it("merging requires a merge_ready run at the same head sha; replays do not duplicate audit", () => {
    const { runs, audit } = temp();
    const { run } = runs.onAccepted(item(), audit, 1000);
    expect(transition(run, { type: "approve_merge", headSha: "h1", by: "owner" }).ok).toBe(false);
    const ready = { ...run, state: "merge_ready" as const, headSha: "h1", baseSha: "b", guardOkAtHead: "h1", testsOkAtHead: "h1", reviewOkAtHead: "h1" };
    const applied = transition(ready, { type: "approve_merge", headSha: "h1", by: "owner" });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    audit.append({ idempotencyKey: `evo:merge:${run.id}:h1`, event: "approved", actionType: "evolution.merge:prompt", project: "ein-self", target: run.id, actor: "owner", mode: "manual", ruleVersion: 1, afterHash: "h1" });
    audit.append({ idempotencyKey: `evo:merge:${run.id}:h1`, event: "approved", actionType: "evolution.merge:prompt", project: "ein-self", target: run.id, actor: "owner", mode: "manual", ruleVersion: 1, afterHash: "h1" });
    expect(audit.stats("evolution.merge:prompt", "ein-self", 5000)).toMatchObject({ manualApproved: 1 });
  });
});
