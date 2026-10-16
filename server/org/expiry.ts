// Unattended approvals expire. A card raised while nobody is at the keyboard
// (a webhook turn, or work it handed on) and left unanswered for
// rules.unattendedExpiryMin minutes is denied rather than left to hang: the
// bot gets a clear "no" and moves on, the card says it expired, and the
// decision log and the event log both record it. The action never runs.
//
// This module only keeps the clock; the org layer does the denying through
// the harness (see OrgLayer.sweepExpired).

export interface UnattendedApproval {
  threadId: string;
  requestId: string;
  messageId: string;
  botId: string;
  botName?: string;
  tool?: string;
  summary?: string;
  /** the provider instance that raised the request — only it can be answered */
  instanceId: string;
  /** when the card was shown */
  at: number;
}

export class ApprovalExpiry {
  private readonly pending = new Map<string, UnattendedApproval>();

  private static key(threadId: string, requestId: string): string {
    return `${threadId}:${requestId}`;
  }

  track(entry: UnattendedApproval): void {
    this.pending.set(ApprovalExpiry.key(entry.threadId, entry.requestId), { ...entry });
  }

  forget(threadId: string, requestId: string): void {
    this.pending.delete(ApprovalExpiry.key(threadId, requestId));
  }

  get size(): number {
    return this.pending.size;
  }

  /** Remove and return every approval older than `expiryMs`. */
  due(now: number, expiryMs: number): UnattendedApproval[] {
    const out: UnattendedApproval[] = [];
    for (const [key, entry] of this.pending) {
      if (now - entry.at < expiryMs) continue;
      this.pending.delete(key);
      out.push(entry);
    }
    return out;
  }
}
