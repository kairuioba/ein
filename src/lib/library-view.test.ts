import { describe, expect, it } from "vitest";

import { changeHunks, currentVersion, derivedSummary, diffLines, docLevel, downloadName, oldestStaleVersion, staleUsers, summaryOf } from "./library-view";

const doc = {
  section: null,
  versions: [
    { version: 2, at: 1, size: 10 },
    { version: 4, at: 3, size: 12, decisionId: 3 },
    { version: 3, at: 2, size: 11 },
  ],
  inUse: [
    { botId: "writer", version: 3 },
    { botId: "designer", version: 4 },
    { botId: "old", version: 2 },
  ],
};

describe("library view", () => {
  it("files a doc as company-wide, departmental or isolated", () => {
    const departments = [
      { section: "市场部", color: "#0EA5E9" },
      { section: "财务法务", color: "#475467", settings: { isolated: true } },
    ];
    expect(docLevel({ section: null }, departments)).toEqual({ kind: "company" });
    expect(docLevel({ section: "市场部" }, departments)).toEqual({ kind: "department", section: "市场部", color: "#0EA5E9" });
    expect(docLevel({ section: "财务法务" }, departments)).toMatchObject({ kind: "isolated" });
    expect(docLevel({ section: "新部门" }, departments)).toMatchObject({ kind: "department", section: "新部门" });
  });

  it("finds the current version and who still uses an older one", () => {
    expect(currentVersion(doc)?.version).toBe(4);
    expect(staleUsers(doc)).toEqual([{ botId: "old", version: 2 }, { botId: "writer", version: 3 }]);
    expect(oldestStaleVersion(doc)).toBe(2);
    expect(staleUsers({ versions: [], inUse: [] })).toEqual([]);
  });

  it("diffs two versions line by line and counts the changes", () => {
    const before = "价格表\n旗舰款 ¥699\n标准款 ¥499\n渠道价见附表";
    const after = "价格表\n旗舰款 ¥799\n标准款 ¥499\n渠道价见附表\n早鸟价 ¥749";
    const diff = diffLines(before, after);
    expect(diff.filter((line) => line.kind !== "same")).toEqual([
      { kind: "del", text: "旗舰款 ¥699" },
      { kind: "add", text: "旗舰款 ¥799" },
      { kind: "add", text: "早鸟价 ¥749" },
    ]);
    expect(changeHunks(diff)).toEqual([
      { removed: ["旗舰款 ¥699"], added: ["旗舰款 ¥799"] },
      { removed: [], added: ["早鸟价 ¥749"] },
    ]);
    expect(changeHunks(diffLines("same", "same"))).toEqual([]);
  });

  it("summarises the first paragraph and names downloads", () => {
    expect(summaryOf("# 价格表\n\n发布会三款机型的定价。\n内容部按它写稿。\n\n附表")).toBe("价格表");
    expect(summaryOf("Line one\nline two\n\nNext")).toBe("Line one line two");
    expect(summaryOf("# 价格表\n\n发布会三款机型的定价。\n\n附表", 140, "价格表")).toBe("发布会三款机型的定价。");
    expect(downloadName("价格表 / 定稿", 4)).toBe("价格表 - 定稿-v4.md");
  });

  it("derives the summary the way the server does when a publish names none", () => {
    // the same cases as server/org/library.test.ts
    expect(derivedSummary("# 价格表\n\n三款定价 · 发布价与早鸟价\n旗舰款", "价格表")).toBe("三款定价 · 发布价与早鸟价");
    expect(derivedSummary("价格表\n旗舰款 ¥799", "价格表")).toBe("旗舰款 ¥799");
    expect(derivedSummary("# 只有标题", "x")).toBe("只有标题");
    expect(derivedSummary("", "x")).toBe("");
    expect(derivedSummary("字".repeat(70), "x")).toBe(`${"字".repeat(59)}…`);
  });
});
