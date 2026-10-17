import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ApprovalAuditStore } from "./approval-audit.ts";
import { attentionCardFor, attentionCounts, classifyInboxQueue } from "./attention-inbox.ts";
import type { InboxItem } from "../shared/dispatch-types.ts";

const item = (extra: Partial<InboxItem>): InboxItem => ({ id: "i1", kind: "signoff", title: "t", reason: "r", createdAt: 1000, ...extra });
const audit = () => new ApprovalAuditStore(mkdtempSync(join(tmpdir(), "ein-att-")));

describe("attention inbox bridge", () => {
  it("signoff/gate_failed are high risk and cannot be auto-approved", () => {
    const store = audit();
    const queue = classifyInboxQueue([item({ id: "a" }), item({ id: "b", kind: "gate_failed" })], store, 5000);
    expect(queue.map((entry) => entry.kind)).toEqual(["push", "push"]);
    expect(queue.every((entry) => entry.card.risk === "high")).toBe(true);
    expect(attentionCounts(queue)).toEqual({ push: 2, inbox: 0, auto: 0, archive: 0 });
  });

  it("an old stuck handoff sorts before a fresh question and is an interruption", () => {
    const store = audit();
    const queue = classifyInboxQueue(
      [item({ id: "old", kind: "handoff_stuck", createdAt: 1000 }), item({ id: "new", kind: "question", createdAt: 499_000 })],
      store,
      500_000,
    );
    expect(queue[0]!.item.id).toBe("old");
    expect(attentionCounts(queue)).toMatchObject({ push: 0, inbox: 2 });
  });

  it("uses manual approvals from the audit but never lets auto approvals grant trust", () => {
    const store = audit();
    for (let n = 0; n < 3; n += 1) {
      store.append({ idempotencyKey: `auto${n}`, event: "approved", actionType: "inbox.approve:question", project: "t1", target: "x", actor: "bot", mode: "auto", ruleVersion: 1 });
    }
    expect(attentionCardFor(item({ kind: "question", taskId: "t1" }), store, 5000)).toMatchObject({ risk: "medium" });
    expect(store.stats("inbox.approve:question", "t1", 5000).manualApproved).toBe(0);
  });
});
