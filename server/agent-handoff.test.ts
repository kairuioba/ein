import { describe, expect, it } from "vitest";

import { extractHandoffBlock, handoffLine, parseHandoff } from "./agent-handoff.ts";

const reply = (body: unknown) => `done the work\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;

describe("agent handoff envelope", () => {
  it("parses a normal handoff and normalizes fields", () => {
    const parsed = parseHandoff(
      reply({
        handoff: {
          status: "partial",
          summary: "wrote 3 of 5 sections",
          evidence: ["docs/a.md#L1", 42, " "],
          decisions: [{ what: "kept the old title", why: "owner liked it" }],
          risks: [{ risk: "missing data", impact: "two sections empty", next: "ask for numbers" }],
          openQuestions: ["which tone?"],
          nextStep: "fill sections 4-5",
          acceptanceMet: false,
        },
      }),
    );
    expect(parsed).toMatchObject({
      status: "partial",
      summary: "wrote 3 of 5 sections",
      evidence: ["docs/a.md#L1"],
      decisions: [{ what: "kept the old title", why: "owner liked it" }],
      risks: [{ risk: "missing data", impact: "two sections empty", next: "ask for numbers" }],
      openQuestions: ["which tone?"],
      nextStep: "fill sections 4-5",
      acceptanceMet: false,
    });
    expect(handoffLine(parsed!)).toContain("acceptance: not met");
  });

  it("uses the last valid block so drafts do not win", () => {
    const text = `${reply({ handoff: { status: "done", summary: "draft" } })}then a better one\n\`\`\`json\n${JSON.stringify({
      handoff: { status: "done", summary: "final" },
    })}\n\`\`\``;
    expect(parseHandoff(text)?.summary).toBe("final");
  });

  it("falls back to free text when there is no block (weaker models)", () => {
    expect(parseHandoff("I just did it, no json.")).toBeUndefined();
    expect(parseHandoff("```json\n{broken}\n```")).toBeUndefined();
    expect(extractHandoffBlock("plain")).toBeUndefined();
  });

  it("accepts the bare object form without the handoff key", () => {
    expect(parseHandoff(reply({ summary: "done", status: "done" }))).toMatchObject({ summary: "done", status: "done" });
  });
});
