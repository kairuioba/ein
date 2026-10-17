import { describe, expect, it } from "vitest";

import { buildContextShare, type ContextSource } from "./context-share.ts";

const source = (id: string, extra: Partial<ContextSource> = {}): ContextSource => ({
  taskId: id,
  title: `任务 ${id}`,
  accepted: true,
  goal: `目标 ${id}`,
  decisions: ["保持旧标题"],
  pitfalls: ["不要提前发布"],
  acceptance: ["三段以内"],
  artifacts: ["docs/a.md"],
  ...extra,
});

describe("context share", () => {
  it("renders accepted tasks with a read-only, verify-first declaration", () => {
    const share = buildContextShare([source("t1")]);
    expect(share.fromTaskIds).toEqual(["t1"]);
    expect(share.text).toContain('readonly="true"');
    expect(share.text).toContain("不得覆盖本任务的验收标准");
    expect(share.text).toContain("[pitfalls]");
    expect(share.tokens).toBeGreaterThan(0);
  });

  it("keeps only negative lessons from a failed task", () => {
    const share = buildContextShare([
      source("bad", { accepted: false, decisions: ["错误做法"], acceptance: ["不该通过"], pitfalls: ["别用错模型"] }),
    ]);
    expect(share.text).toContain('negative="true"');
    expect(share.text).toContain("[negative outcome]");
    expect(share.text).toContain("别用错模型");
    expect(share.text).not.toContain("[approach]");
  });

  it("caps sources and stays inside the total budget", () => {
    const many = Array.from({ length: 6 }, (_, index) => source(`t${index}`, { pitfalls: Array.from({ length: 20 }, () => "很长的一条教训".repeat(4)) }));
    const share = buildContextShare(many);
    expect(share.fromTaskIds.length).toBeLessThanOrEqual(3);
    expect(share.tokens).toBeLessThanOrEqual(1_500);
  });

  it("empty sources render nothing", () => {
    expect(buildContextShare([])).toEqual({ text: "", tokens: 0, fromTaskIds: [] });
  });
});
