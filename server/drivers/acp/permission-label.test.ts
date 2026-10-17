import { describe, expect, it } from "vitest";

import { describeToolRequest } from "./core.ts";

describe("ACP permission card text", () => {
  it("uses the command for an execute request", () => {
    expect(describeToolRequest({ kind: "execute", rawInput: { command: "pnpm test" } })).toEqual({ tool: "shell", summary: "pnpm test" });
  });

  it("uses the human title when there is no command", () => {
    expect(describeToolRequest({ kind: "edit", title: "Write report.md" })).toEqual({ tool: "edit", summary: "Write report.md" });
  });

  it("summarizes raw input when the engine sends no title", () => {
    const text = describeToolRequest({ kind: "read", rawInput: { path: "/tmp/a.md" } });
    expect(text.tool).toBe("read");
    expect(text.summary).toBe("path: /tmp/a.md");
  });

  it("never leaves the card saying only 'tool'", () => {
    const text = describeToolRequest({});
    expect(text.tool).toBe("tool");
    expect(text.summary).not.toBe("tool");
    expect(text.summary.length).toBeGreaterThan(5);
  });
});
