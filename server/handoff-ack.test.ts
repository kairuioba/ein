import { describe, expect, it } from "vitest";

import { ackWaiting, readAck, sweepHandoffs, transitionAck, type HandoffAck } from "./handoff-ack.ts";

const ack = (extra: Partial<HandoffAck> = {}): HandoffAck => ({ state: "sent", round: 1, sentAt: 1000, sentBy: "a", nudgeCount: 0, v: 1, ...extra });

describe("handoff ack", () => {
  it("receive is idempotent and a terminal ack rejects further transitions", () => {
    const first = transitionAck({ current: ack(), action: "receive", round: 1, actor: "b", now: 2000 });
    expect(first).toMatchObject({ ok: true, noop: false });
    if (!first.ok) return;
    expect(first.ack).toMatchObject({ state: "received", receivedBy: "b", v: 2 });
    expect(transitionAck({ current: first.ack, action: "receive", round: 1, actor: "b", now: 3000 })).toMatchObject({ ok: true, noop: true });
    expect(transitionAck({ current: first.ack, action: "return", round: 1, actor: "b", now: 3000, reason: { code: "blocked" } })).toMatchObject({ ok: false, code: "illegal_transition" });
  });

  it("return needs a reason and a matching round; stale rounds are rejected", () => {
    expect(transitionAck({ current: ack(), action: "return", round: 1, actor: "b", now: 2000 })).toMatchObject({ ok: false, code: "missing_reason" });
    expect(transitionAck({ current: ack(), action: "receive", round: 2, actor: "b", now: 2000 })).toMatchObject({ ok: false, code: "stale_round" });
    const returned = transitionAck({ current: ack(), action: "return", round: 1, actor: "b", now: 2000, reason: { code: "wrong_scope", text: "scope" } });
    expect(returned).toMatchObject({ ok: true });
    if (returned.ok) expect(ackWaiting({ ack: returned.ack, assignee: "a" })).toMatchObject({ reason: "handoff_returned", returnCode: "wrong_scope" });
  });

  it("reads legacy/implied acks and never sweeps them", () => {
    expect(readAck({ status: "running", handoff: { sentAt: 1 } })).toMatchObject({ implied: true, ack: { state: "received" } });
    expect(readAck({ status: "pending", handoff: { sentAt: 1 } })).toMatchObject({ legacy: true, ack: { state: "sent" } });
    expect(sweepHandoffs([{ id: "s1", status: "pending", handoff: { sentAt: 1 } }], 10_000_000)).toEqual([]);
    expect(sweepHandoffs([{ id: "s1", status: "running", handoff: { sentAt: 1 } }], 10_000_000)).toEqual([]);
  });

  it("sweeps a timed-out sent ack with CAS version and escalates after nudges", () => {
    const subtask = { id: "s1", status: "pending", handoff: { sentAt: 0, round: 1, ack: ack({ expiresAt: 100 }) } };
    const actions = sweepHandoffs([subtask], 500);
    expect(actions).toEqual([{ kind: "expire", subtaskId: "s1", round: 1, expectedVersion: 1, nudge: true, escalate: false }]);
    const noisy = { id: "s2", status: "pending", handoff: { sentAt: 0, round: 1, ack: ack({ state: "expired", expiresAt: 100, nudgeCount: 1 }) } };
    expect(sweepHandoffs([noisy], 500)[0]).toMatchObject({ kind: "escalate" });
    const fresh = { id: "s3", status: "pending", handoff: { sentAt: 0, round: 1, ack: ack({ expiresAt: 10_000 }) } };
    expect(sweepHandoffs([fresh], 500)).toEqual([]);
  });
});
