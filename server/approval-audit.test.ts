import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ApprovalAuditStore, foldAuditEvents, type AuditEvent } from "./approval-audit.ts";

const base = (extra: Partial<AuditEvent>): AuditEvent => ({
  id: "e1",
  idempotencyKey: "k1",
  event: "approved",
  actionType: "retry",
  project: "p1",
  target: "t",
  actor: "owner",
  mode: "manual",
  ruleVersion: 1,
  decidedAt: 1000,
  ...extra,
});

describe("approval audit", () => {
  it("only manual approvals grant auto eligibility", () => {
    const events = [1, 2, 3].map((n) => base({ id: `m${n}`, idempotencyKey: `m${n}` }));
    const manual = foldAuditEvents(events, { now: 2000 }).get("retry\u0000p1")!;
    expect(manual).toMatchObject({ manualApproved: 3, autoApproved: 0, eligibleForAuto: true, trustLevel: "auto" });
    const autoOnly = [1, 2, 3].map((n) => base({ id: `a${n}`, idempotencyKey: `a${n}`, mode: "auto" }));
    expect(foldAuditEvents(autoOnly, { now: 2000 }).get("retry\u0000p1")).toMatchObject({ autoApproved: 3, manualApproved: 0, eligibleForAuto: false });
  });

  it("a revert cools down and zeroes the manual history; two reverts lock ask_only", () => {
    const approved = [1, 2, 3].map((n) => base({ id: `m${n}`, idempotencyKey: `m${n}`, decidedAt: n }));
    const revert = base({ id: "r1", idempotencyKey: "r1", event: "reverted", revertedAt: 10, rollbackRef: "c1" });
    const cooled = foldAuditEvents([...approved, revert], { now: 11 }).get("retry\u0000p1")!;
    expect(cooled).toMatchObject({ manualApproved: 0, revertedCount: 1, eligibleForAuto: false, trustLevel: "manual" });
    const locked = foldAuditEvents([...approved, revert, base({ id: "r2", idempotencyKey: "r2", event: "reverted", revertedAt: 20 })], { now: 30 }).get("retry\u0000p1")!;
    expect(locked).toMatchObject({ revertedCount: 2, eligibleForAuto: false, trustLevel: "ask_only" });
  });

  it("is idempotent by key and survives a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "ein-audit-"));
    const store = new ApprovalAuditStore(dir);
    const first = store.append({ idempotencyKey: "x1", event: "approved", actionType: "retry", project: "p1", target: "t", actor: "bot", mode: "auto", ruleVersion: 1 });
    const again = store.append({ idempotencyKey: "x1", event: "approved", actionType: "retry", project: "p1", target: "t", actor: "bot", mode: "auto", ruleVersion: 1 });
    expect(first.deduped).toBe(false);
    expect(again.deduped).toBe(true);
    expect(new ApprovalAuditStore(dir).list()).toHaveLength(1);
  });
});
