// Handoff 接收/退回：交接属于「某一轮发送」，不属于 subtask；
// 所有转移都是纯函数 + 版本号 CAS，sweeper 与隐式 receive 的竞态靠 v 解决。
import type { HandoffAck, HandoffAckState as AckState, HandoffReturnReasonCode as ReturnReasonCode } from "../shared/dispatch-types.ts";

export type { HandoffAck, AckState, ReturnReasonCode };

export interface AckRead {
  ack: HandoffAck;
  /** inferred from historical data; never swept until first real transition */
  implied?: boolean;
  legacy?: boolean;
}

export interface AckSubtaskLike {
  status: string;
  handoff?: { ack?: HandoffAck; round?: number; sentAt?: number; sentBy?: string };
}

const STARTED = new Set(["in_progress", "running", "done", "review", "needs_review"]);

/** Read the ack of a handoff, tolerating data written before ack existed.
 * Historical records are never swept: legacy marks them out of timeout scans. */
export function readAck(subtask: AckSubtaskLike): AckRead | null {
  if (!subtask.handoff) return null;
  const stored = subtask.handoff.ack;
  if (stored) return { ack: stored };
  const round = subtask.handoff.round ?? 1;
  if (STARTED.has(subtask.status)) {
    return {
      implied: true,
      ack: { state: "received", round, sentAt: subtask.handoff.sentAt ?? 0, sentBy: subtask.handoff.sentBy ?? "", receivedAt: subtask.handoff.sentAt ?? 0, receivedBy: "implied", nudgeCount: 0, v: 0 },
    };
  }
  return { legacy: true, ack: { state: "sent", round, sentAt: subtask.handoff.sentAt ?? 0, sentBy: subtask.handoff.sentBy ?? "", nudgeCount: 0, v: 0 } };
}

export type AckResult =
  | { ok: true; ack: HandoffAck; noop: boolean }
  | { ok: false; code: "illegal_transition" | "stale_round" | "forbidden_actor" | "missing_reason" | "version_conflict"; from?: AckState; to?: AckState };

/** Apply an explicit receive/return. `expectedVersion` implements CAS: a
 * sweeper or a retry that read an older version fails instead of clobbering. */
export function transitionAck(
  input: {
    current: HandoffAck;
    action: "receive" | "return";
    round: number;
    actor: string;
    now: number;
    reason?: { code: ReturnReasonCode; text?: string };
    expectedVersion?: number;
  },
): AckResult {
  const { current } = input;
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.v) return { ok: false, code: "version_conflict" };
  if (input.round !== current.round) return { ok: false, code: "stale_round" };
  const target: AckState = input.action === "receive" ? "received" : "returned";
  if (current.state === target) return { ok: true, ack: current, noop: true };
  if (current.state === "received" || current.state === "returned") return { ok: false, code: "illegal_transition", from: current.state, to: target };
  if (input.action === "return" && !input.reason) return { ok: false, code: "missing_reason" };
  return {
    ok: true,
    noop: false,
    ack:
      input.action === "receive"
        ? { ...current, state: "received", receivedAt: input.now, receivedBy: input.actor, v: current.v + 1 }
        : { ...current, state: "returned", returnedAt: input.now, returnedBy: input.actor, returnReason: input.reason!, v: current.v + 1 },
  };
}

export type SweepAction =
  | { kind: "expire"; subtaskId: string; round: number; expectedVersion: number; nudge: boolean; escalate: boolean }
  | { kind: "escalate"; subtaskId: string; round: number; expectedVersion: number };

/** Pure timeout scan: legacy/implied/terminal ack never produce actions. The
 * caller writes with CAS (expectedVersion) so a concurrent receive wins. */
export function sweepHandoffs(
  subtasks: Array<AckSubtaskLike & { id: string }>,
  now: number,
  options: { ttlMs?: number; maxNudges?: number } = {},
): SweepAction[] {
  const ttl = options.ttlMs ?? 10 * 60 * 1000;
  const maxNudges = options.maxNudges ?? 1;
  const actions: SweepAction[] = [];
  for (const subtask of subtasks) {
    const read = readAck(subtask);
    if (!read || read.implied || read.legacy) continue;
    const ack = read.ack;
    if (ack.state !== "sent" && ack.state !== "expired") continue;
    const expiresAt = ack.expiresAt ?? ack.sentAt + ttl;
    if (now < expiresAt) continue;
    if (ack.state === "sent") {
      actions.push({ kind: "expire", subtaskId: subtask.id, round: ack.round, expectedVersion: ack.v, nudge: ack.nudgeCount < maxNudges, escalate: ack.nudgeCount + 1 > maxNudges });
    } else if (ack.nudgeCount >= maxNudges) {
      actions.push({ kind: "escalate", subtaskId: subtask.id, round: ack.round, expectedVersion: ack.v });
    }
  }
  return actions;
}

/** Map an ack onto office waiting-chain fields (sent/expired/returned). */
export function ackWaiting(input: { ack: HandoffAck; assignee?: string; since?: number }):
  | { waitingOn: string; reason: "handoff_unreceived" | "handoff_returned"; since: number; returnCode?: ReturnReasonCode }
  | null {
  const ack = input.ack;
  if (ack.state === "sent" || ack.state === "expired") {
    return { waitingOn: input.assignee ?? ack.sentBy, reason: "handoff_unreceived", since: input.since ?? ack.sentAt };
  }
  if (ack.state === "returned") {
    return { waitingOn: ack.returnedBy ?? "dispatcher", reason: "handoff_returned", since: ack.returnedAt ?? ack.sentAt, ...(ack.returnReason ? { returnCode: ack.returnReason.code } : {}) };
  }
  return null;
}
