// 把「需要你」收件箱接进注意力闸门：每条待办先被分成 push/inbox/auto/archive，
// 推送类才会真正打扰老板；历史手动批准次数来自 approval-audit，自动批准不计。
import type { InboxItem } from "../shared/dispatch-types.ts";
import { classify, compareCards, type AttentionCard, type AttentionClass, type AttentionHistory } from "./attention-gate.ts";
import type { ApprovalAuditStore } from "./approval-audit.ts";

const riskFor = (item: InboxItem): AttentionCard["risk"] => {
  switch (item.kind) {
    case "signoff":
    case "gate_failed":
    case "handoff_stuck":
      return "high";
    case "question":
      return "medium";
    case "failed_exhausted":
      return "low";
    default:
      return "medium";
  }
};

/** Inbox items are all "no safe default": ignoring one means the work stalls.
 * signoff/gate_failed are the irreversible halves (accepting a result). */
export function attentionCardFor(item: InboxItem, _audit: ApprovalAuditStore, now = Date.now()): AttentionCard {
  return {
    id: item.id,
    risk: riskFor(item),
    irreversible: item.kind === "signoff" || item.kind === "gate_failed",
    blastRadius: "internal",
    hasSafeDefault: item.kind === "question" || item.kind === "failed_exhausted",
    waitAgeMs: now - item.createdAt,
    slaMs: 60 * 60 * 1000,
    blockedDownstream: item.kind === "gate_failed" || item.kind === "handoff_stuck" ? 1 : 0,
    actionType: `inbox.approve:${item.kind}`,
    projectId: item.taskId ?? "ein",
    causeFingerprint: item.kind,
    createdAt: item.createdAt,
  };
}

export interface AttentionQueueEntry {
  item: InboxItem;
  card: AttentionCard;
  kind: AttentionClass;
  reasons: string[];
}

export function classifyInboxQueue(items: InboxItem[], audit: ApprovalAuditStore, now = Date.now()): AttentionQueueEntry[] {
  const entries = items
    .filter((item) => !item.resolvedAt)
    .map((item) => {
      const card = attentionCardFor(item, audit, now);
      const stats = audit.stats(card.actionType!, card.projectId!, now);
      const history: AttentionHistory = {
        approvals: stats.manualApproved,
        rejections: 0,
        reverted: stats.revertedCount > 0,
        pushesToday: 0,
      };
      const verdict = classify(card, history);
      return { item, card, kind: verdict.kind, reasons: verdict.reasons };
    });
  return entries.sort((a, b) => compareCards(a.card, b.card));
}

export function attentionCounts(entries: AttentionQueueEntry[]): Record<AttentionClass, number> {
  const counts: Record<AttentionClass, number> = { push: 0, inbox: 0, auto: 0, archive: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}
