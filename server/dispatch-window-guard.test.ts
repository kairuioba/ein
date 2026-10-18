import { describe, expect, it } from "vitest";

import { hasActiveRunInWindow } from "./dispatch-api.ts";

const run = (sourceThreadId: string, status: string) => ({ sourceThreadId, status });

describe("one window, one live run", () => {
  it("detects a live run in the same conversation", () => {
    expect(hasActiveRunInWindow([run("t1", "running")], "t1")).toBe(true);
    expect(hasActiveRunInWindow([run("t1", "synthesizing")], "t1")).toBe(true);
    expect(hasActiveRunInWindow([run("t1", "pending")], "t1")).toBe(true);
  });

  it("ignores finished runs and other windows", () => {
    expect(hasActiveRunInWindow([run("t1", "done"), run("t1", "canceled")], "t1")).toBe(false);
    expect(hasActiveRunInWindow([run("t2", "running")], "t1")).toBe(false);
  });
});
