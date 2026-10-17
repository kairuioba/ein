import { describe, expect, it } from "vitest";

import type { DispatchHandoff, HandoffAck } from "../shared/dispatch-types.ts";
import {
  DEFAULT_HANDOFF_ACK_TTL_MS,
  HANDOFF_ACK_HISTORY_LIMIT,
  ackHandoff,
  ackSummaryForOffice,
  handoffCard,
  isHandoffReturnReasonCode,
  resendHandoff,
  type HandoffWithHistory,
  type ResendHandoffResult,
} from "./handoff-actions.ts";

// fake clock: 10h after epoch so "sent 20 minutes ago" reads clearly
const NOW = 10 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const ack = (extra: Partial<HandoffAck> = {}): HandoffAck => ({
  state: "sent",
  round: 1,
  sentAt: NOW - MIN,
  sentBy: "bot-a",
  expiresAt: NOW + 9 * MIN,
  nudgeCount: 0,
  v: 1,
  ...extra,
});

const handoff = (extra: Partial<DispatchHandoff> = {}): DispatchHandoff => ({
  status: "done",
  summary: "首版文案已交付",
  id: "s1#1",
  round: 1,
  sentAt: NOW - MIN,
  sentBy: "bot-a",
  ack: ack(),
  ...extra,
});

/** assert the action succeeded, else surface the error code in the failure */
const okAck = (result: ReturnType<typeof ackHandoff>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
};
const okResend = (result: ResendHandoffResult) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
};

describe("ackHandoff", () => {
  it("receives a sent handoff without mutating the input, and a repeat receive is a noop", () => {
    const source = handoff();
    const first = okAck(ackHandoff({ handoff: source, subtaskId: "s1", action: "receive", actor: "bot-b", now: NOW }));
    expect(first).toMatchObject({ ok: true, noop: false, ack: { state: "received", receivedBy: "bot-b", receivedAt: NOW, v: 2 } });
    // pure: the caller decides when to write the new ack back
    expect(source.ack!.state).toBe("sent");
    const again = okAck(ackHandoff({ handoff: { ...source, ack: first.ack }, subtaskId: "s1", action: "receive", actor: "bot-b", now: NOW + MIN }));
    expect(again).toMatchObject({ ok: true, noop: true, ack: { state: "received", v: 2 } });
  });

  it("rejects a return after the handoff was already received", () => {
    const received = handoff({ ack: ack({ state: "received", receivedAt: NOW - 30_000, receivedBy: "bot-b", v: 2 }) });
    expect(
      ackHandoff({ handoff: received, subtaskId: "s1", action: "return", actor: "bot-b", reason: { code: "blocked" }, now: NOW }),
    ).toMatchObject({ ok: false, code: "illegal_transition", from: "received", to: "returned" });
  });

  it("requires a reason to return, and records the reason when given", () => {
    expect(ackHandoff({ handoff: handoff(), subtaskId: "s1", action: "return", actor: "bot-c", now: NOW })).toMatchObject({
      ok: false,
      code: "missing_reason",
    });
    const returned = okAck(
      ackHandoff({
        handoff: handoff(),
        subtaskId: "s1",
        action: "return",
        actor: "bot-c",
        reason: { code: "wrong_scope", text: "只改外观，不要动定价文案" },
        now: NOW,
      }),
    );
    expect(returned).toMatchObject({
      ok: true,
      noop: false,
      ack: { state: "returned", returnedBy: "bot-c", returnedAt: NOW, returnReason: { code: "wrong_scope", text: "只改外观，不要动定价文案" }, v: 2 },
    });
    expect(isHandoffReturnReasonCode("wrong_scope")).toBe(true);
    expect(isHandoffReturnReasonCode("because")).toBe(false);
  });

  it("uses the current round when the caller omits it, and rejects a stale round", () => {
    const roundTwo = handoff({ round: 2, ack: ack({ round: 2 }) });
    expect(okAck(ackHandoff({ handoff: roundTwo, subtaskId: "s1", action: "receive", actor: "bot-b", now: NOW }))).toMatchObject({
      ok: true,
      ack: { round: 2, state: "received" },
    });
    expect(
      ackHandoff({ handoff: roundTwo, subtaskId: "s1", action: "receive", actor: "bot-b", round: 1, now: NOW }),
    ).toMatchObject({ ok: false, code: "stale_round" });
    // an expired round can still be received late (the CAS version is what matters)
    const expired = handoff({ ack: ack({ state: "expired", expiresAt: NOW - MIN }) });
    expect(okAck(ackHandoff({ handoff: expired, subtaskId: "s1", action: "receive", actor: "bot-b", now: NOW }))).toMatchObject({
      ok: true,
      ack: { state: "received" },
    });
  });

  it("honours a CAS version and accepts legacy handoffs that predate receipts", () => {
    expect(
      ackHandoff({ handoff: handoff(), subtaskId: "s1", action: "receive", actor: "bot-b", expectedVersion: 99, now: NOW }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    const legacy = handoff({ ack: undefined });
    const first = okAck(ackHandoff({ handoff: legacy, subtaskId: "s1", action: "receive", actor: "bot-b", now: NOW }));
    expect(first).toMatchObject({ ok: true, ack: { state: "received", round: 1, receivedBy: "bot-b", v: 1 } });
    expect(ackHandoff({ handoff: undefined, subtaskId: "s1", action: "receive", actor: "bot-b", now: NOW })).toMatchObject({
      ok: false,
      code: "missing_handoff",
    });
  });
});

describe("resendHandoff", () => {
  it("only resends a returned or expired handoff", () => {
    expect(resendHandoff({ handoff: handoff(), subtaskId: "s1", actor: "chief", now: NOW })).toMatchObject({
      ok: false,
      code: "illegal_transition",
      from: "sent",
    });
    expect(
      resendHandoff({
        handoff: handoff({ ack: ack({ state: "received", receivedAt: NOW - MIN, receivedBy: "bot-b" }) }),
        subtaskId: "s1",
        actor: "chief",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "illegal_transition", from: "received" });
    expect(resendHandoff({ handoff: handoff({ ack: undefined }), subtaskId: "s1", actor: "chief", now: NOW })).toMatchObject({
      ok: false,
      code: "illegal_transition",
    });
    expect(resendHandoff({ handoff: undefined, subtaskId: "s1", actor: "chief", now: NOW })).toMatchObject({ ok: false, code: "missing_handoff" });
  });

  it("bumps the round, restarts the timer and keeps the old ack in history", () => {
    const returned = handoff({
      ack: ack({ state: "returned", returnedAt: NOW - 5 * MIN, returnedBy: "bot-c", returnReason: { code: "missing_input" }, v: 3 }),
    });
    const result = okResend(resendHandoff({ handoff: returned, subtaskId: "s1", actor: "chief", now: NOW }));
    expect(result.round).toBe(2);
    expect(result.handoff).toMatchObject({
      id: "s1#2",
      round: 2,
      sentAt: NOW,
      sentBy: "chief",
      ack: { state: "sent", round: 2, sentAt: NOW, sentBy: "chief", expiresAt: NOW + DEFAULT_HANDOFF_ACK_TTL_MS, nudgeCount: 0, v: 1 },
      history: [returned.ack],
    });
    // default TTL is ten minutes and can be overridden per resend
    const short = okResend(resendHandoff({ handoff: returned, subtaskId: "s1", actor: "chief", now: NOW, ttlMs: MIN }));
    expect(short.handoff.ack!.expiresAt).toBe(NOW + MIN);
  });

  it("caps the ack history at ten rounds", () => {
    let current: HandoffWithHistory = okResend(
      resendHandoff({
        handoff: handoff({ ack: ack({ state: "returned", returnedAt: NOW - MIN, returnedBy: "bot-c" }) }),
        subtaskId: "s1",
        actor: "chief",
        now: NOW,
      }),
    ).handoff;
    for (let round = 2; round <= 12; round += 1) {
      // pretend the fresh round came back from the receiver
      current = { ...current, ack: { ...current.ack!, state: "returned", returnedAt: NOW, returnedBy: "bot-c", returnReason: { code: "other" }, v: 2 } };
      current = okResend(resendHandoff({ handoff: current, subtaskId: "s1", actor: "chief", now: NOW })).handoff;
    }
    expect(current.ack!.round).toBe(13);
    expect(current.history).toHaveLength(HANDOFF_ACK_HISTORY_LIMIT);
    expect(current.history!.at(-1)!.round).toBe(12);
    expect(current.history![0]!.round).toBe(3);
  });
});

describe("handoffCard", () => {
  it("projects a waiting handoff: waited time, overdue and the three buttons from the ack", () => {
    const card = handoffCard({ subtaskId: "s1", title: "首版文案", handoff: handoff(), assigneeName: "小林", now: NOW });
    expect(card).toEqual({
      subtaskId: "s1",
      title: "首版文案",
      state: "sent",
      round: 1,
      sentAt: NOW - MIN,
      expiresAt: NOW + 9 * MIN,
      waitedMs: MIN,
      overdue: false,
      canReceive: true,
      canReturn: true,
      canResend: false,
      nudgeCount: 0,
      assigneeName: "小林",
    });
    // past the expiry (but not swept yet): overdue, still receivable/resendable-ready when expired
    const late = handoffCard({ subtaskId: "s1", title: "首版文案", handoff: handoff({ ack: ack({ expiresAt: NOW - MIN }) }), now: NOW });
    expect(late).toMatchObject({ overdue: true, waitedMs: MIN, canReceive: true, canReturn: true, canResend: false });
  });

  it("projects terminal states: received is final, returned carries the reason and can be resent", () => {
    const received = handoffCard({
      subtaskId: "s1",
      title: "首版文案",
      handoff: handoff({ ack: ack({ state: "received", receivedAt: NOW - 30_000, receivedBy: "bot-b", v: 2 }) }),
      now: NOW,
    });
    expect(received).toMatchObject({ state: "received", canReceive: false, canReturn: false, canResend: false, overdue: false });
    const returned = handoffCard({
      subtaskId: "s1",
      title: "首版文案",
      handoff: handoff({
        ack: ack({ state: "returned", returnedAt: NOW - 5 * MIN, returnedBy: "bot-c", returnReason: { code: "missing_input", text: "缺价格页" }, nudgeCount: 1, v: 2 }),
      }),
      now: NOW,
    });
    expect(returned).toMatchObject({
      state: "returned",
      canReceive: false,
      canReturn: false,
      canResend: true,
      nudgeCount: 1,
      returnReason: { code: "missing_input", text: "缺价格页" },
    });
  });

  it("renders a legacy handoff (no ack) as received with no actions", () => {
    const legacy = handoffCard({ subtaskId: "s1", title: "首版文案", handoff: handoff({ ack: undefined }), now: NOW });
    expect(legacy).toMatchObject({
      state: "received",
      round: 1,
      sentAt: NOW - MIN,
      waitedMs: MIN,
      overdue: false,
      canReceive: false,
      canReturn: false,
      canResend: false,
      legacy: true,
    });
    expect(handoffCard({ subtaskId: "s2", title: "没有交接", handoff: undefined, now: NOW })).toMatchObject({
      state: "received",
      legacy: true,
      waitedMs: 0,
      canReceive: false,
      canReturn: false,
      canResend: false,
    });
  });
});

describe("ackSummaryForOffice", () => {
  it("maps sent/returned acks onto the project-page waiting row and ignores consumed ones", () => {
    expect(ackSummaryForOffice(handoff(), "小林")).toEqual({
      waitingOn: "小林",
      reason: "handoff_unreceived",
      since: NOW - MIN,
    });
    expect(ackSummaryForOffice(handoff({ ack: ack({ sentBy: "bot-a" }) }))).toEqual({
      waitingOn: "bot-a",
      reason: "handoff_unreceived",
      since: NOW - MIN,
    });
    expect(
      ackSummaryForOffice(
        handoff({ ack: ack({ state: "returned", returnedAt: NOW - 5 * MIN, returnedBy: "bot-c", returnReason: { code: "overload" }, v: 2 }) }),
      ),
    ).toEqual({ waitingOn: "bot-c", reason: "handoff_returned", since: NOW - 5 * MIN, returnCode: "overload" });
    expect(ackSummaryForOffice(handoff({ ack: ack({ state: "received", receivedAt: NOW, receivedBy: "bot-b" }) }))).toBeNull();
    expect(ackSummaryForOffice(handoff({ ack: undefined }))).toBeNull();
    expect(ackSummaryForOffice(undefined)).toBeNull();
  });
});
