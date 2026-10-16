import { describe, expect, it } from "vitest";

import { ApprovalExpiry, type UnattendedApproval } from "./expiry.ts";

const entry = (requestId: string, at: number): UnattendedApproval => ({
  threadId: "t",
  requestId,
  messageId: `m-${requestId}`,
  botId: "bot",
  instanceId: "grok",
  at,
});

describe("ApprovalExpiry", () => {
  it("hands back each approval once, only after it waited the full time", () => {
    const expiry = new ApprovalExpiry();
    expiry.track(entry("a", 0));
    expiry.track(entry("b", 5_000));
    expect(expiry.size).toBe(2);
    expect(expiry.due(9_999, 10_000)).toEqual([]);
    expect(expiry.due(10_000, 10_000).map((due) => due.requestId)).toEqual(["a"]);
    expect(expiry.due(10_000, 10_000)).toEqual([]);
    expect(expiry.due(15_000, 10_000).map((due) => due.requestId)).toEqual(["b"]);
    expect(expiry.size).toBe(0);
  });

  it("forgets an approval and re-tracks by thread and request", () => {
    const expiry = new ApprovalExpiry();
    expiry.track(entry("a", 0));
    expiry.track({ ...entry("a", 3_000), messageId: "newer" });
    expect(expiry.size).toBe(1);
    expect(expiry.due(3_000 + 10_000, 10_000)[0]!.messageId).toBe("newer");
    expiry.track(entry("c", 0));
    expiry.forget("t", "c");
    expect(expiry.due(Number.MAX_SAFE_INTEGER, 1)).toEqual([]);
  });
});
