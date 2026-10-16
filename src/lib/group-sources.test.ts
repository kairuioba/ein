import { describe, expect, it } from "vitest";

import { backedOption, basisNumbers, extractSources, numberSources, supersededBy } from "./group-sources";

describe("extractSources", () => {
  it("turns a trailing library link into a chip and cuts it from the text", () => {
    const out = extractSources("文案按 699 写的，依据是 3 周前的价格表 v3 [价格表 v3 · 9月25日](library:price-table?v=3)");
    expect(out.text).toBe("文案按 699 写的，依据是 3 周前的价格表 v3");
    expect(out.sources).toEqual([
      {
        key: "library:price-table@3",
        kind: "library",
        docId: "price-table",
        version: 3,
        label: "价格表 v3 · 9月25日",
        title: "价格表 v3",
        detail: "9月25日",
        target: "library:price-table?v=3",
      },
    ]);
  });

  it("keeps the words of a link inside a sentence", () => {
    const out = extractSources("先看 [渠道报价单](https://example.com/quotes) 再定价。");
    expect(out.text).toBe("先看 渠道报价单 再定价。");
    expect(out.sources.map((source) => [source.kind, source.title])).toEqual([["web", "渠道报价单"]]);
  });

  it("cuts a run of trailing citations with the separators between them", () => {
    const out = extractSources("两份依据：[渠道报价单](library://quotes)、[产品参数页](/library/spec#v2)");
    expect(out.text).toBe("两份依据");
    expect(out.sources.map((source) => [source.docId, source.version])).toEqual([
      ["quotes", undefined],
      ["spec", 2],
    ]);
  });

  it("treats attachment tags, file links and a closing bare URL as sources", () => {
    const out = extractSources(
      '报告在这里 <attached-file path="/Users/me/报告.pdf" /> 原始表格 [数据](file:///tmp/data.csv)。来源：https://example.com/a/b.html',
    );
    expect(out.text).toBe("报告在这里  原始表格 数据。来源");
    expect(out.sources.map((source) => [source.kind, source.title])).toEqual([
      ["file", "报告.pdf"],
      ["file", "数据"],
      ["web", "example.com › b.html"],
    ]);
  });

  it("leaves images, relative links and plain text alone", () => {
    const text = "看图 ![图](https://x.com/a.png) 和 [下一节](#next)，没有来源。";
    expect(extractSources(text)).toEqual({ text, sources: [] });
  });
});

describe("numberSources", () => {
  const messages = [
    { id: "m1", at: 1, role: "bot" as const, kind: "text", text: "按 699 [价格表 v3 · 9月25日](library:price?v=3)", from: { botId: "wen", name: "小文" } },
    { id: "m2", at: 2, role: "user" as const, kind: "text", text: "[不算](library:other)" },
    { id: "m3", at: 3, role: "bot" as const, kind: "text", text: "是 799 [渠道报价单 · 昨天](library:quotes)", from: { botId: "mk", name: "市场分析师" } },
    { id: "m4", at: 4, role: "bot" as const, kind: "text", text: "同意 [价格表 v3](library:price?v=3) [渠道报价单](library:quotes)", from: { botId: "chief", name: "总控" } },
  ];

  it("numbers each distinct source once, in the order it was first cited", () => {
    const room = numberSources(messages);
    expect(room.list.map((source) => [source.n, source.title, source.messageId, source.name])).toEqual([
      [1, "价格表 v3", "m1", "小文"],
      [2, "渠道报价单", "m3", "市场分析师"],
    ]);
    expect(room.byMessage.get("m4")?.map((chip) => chip.n)).toEqual([1, 2]);
    expect(room.byMessage.has("m2")).toBe(false);
    expect(room.texts.get("m1")).toBe("按 699");
  });
});

describe("supersededBy", () => {
  const docs = [{ id: "price", versions: [{ version: 1 }, { version: 4 }, { version: 3 }] }];
  it("names the newer version that replaced a cited one", () => {
    expect(supersededBy({ kind: "library", docId: "price", version: 3 }, docs)).toBe(4);
    expect(supersededBy({ kind: "library", docId: "price", version: 4 }, docs)).toBeUndefined();
    expect(supersededBy({ kind: "library", docId: "price" }, docs)).toBeUndefined();
    expect(supersededBy({ kind: "web", docId: "price", version: 1 }, docs)).toBeUndefined();
  });
});

describe("backedOption", () => {
  const options = ["699 · 按价格表 v3", "799 · 按渠道报价和参数页"];
  it("finds the one option a message argues for", () => {
    expect(backedOption("文案按 699 写的", options)).toBe("699");
    expect(backedOption("最新渠道报价是799，昨天更新了", options)).toBe("799");
    expect(backedOption("699 和 799 都有人说", options)).toBeUndefined();
    expect(backedOption("报价 7990 元", options)).toBeUndefined();
  });
});

describe("basisNumbers", () => {
  it("maps a decision's quoted basis onto the room's numbers", () => {
    const list = [
      { n: 1, title: "价格表 v3", label: "价格表 v3 · 9月25日" },
      { n: 2, title: "渠道报价单", label: "渠道报价单 · 昨天" },
    ];
    expect(basisNumbers(["渠道报价单", "参数页", "价格表"], list)).toEqual([
      { text: "渠道报价单", n: 2 },
      { text: "参数页", n: undefined },
      { text: "价格表", n: 1 },
    ]);
    expect(basisNumbers(undefined, list)).toEqual([]);
  });
});
