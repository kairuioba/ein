import { describe, expect, it } from "vitest";

import { botsAllowedApp, categoryOf, lastAppUse, monogram, recommendedSlugs } from "./app-catalog";

describe("connected-app catalog helpers", () => {
  it("files known apps under a category and leaves the rest uncategorised", () => {
    expect(categoryOf("github")).toBe("dev");
    expect(categoryOf("Figma")).toBe("design");
    expect(categoryOf("something-new")).toBeUndefined();
  });

  it("recommends only apps the catalog actually has, in the recommended order", () => {
    const cards = [{ slug: "gmail" }, { slug: "figma" }, { slug: "stripe" }, { slug: "notion" }, { slug: "github" }];
    expect(recommendedSlugs(cards).map((card) => card.slug)).toEqual(["notion", "github", "figma", "gmail"]);
    expect(recommendedSlugs(cards, 2)).toHaveLength(2);
  });

  it("draws a stable monogram: the first CJK character, else the first letter", () => {
    expect(monogram("飞书", "lark").char).toBe("飞");
    expect(monogram("GitHub").char).toBe("G");
    expect(monogram("x (Twitter)", "x").char).toBe("X");
    expect(monogram("Notion", "notion")).toEqual(monogram("Notion", "notion"));
  });

  it("lets every bot use an app unless it is switched off or its department narrows the list", () => {
    const bots = [
      { id: "a", section: "市场部" },
      { id: "b", section: "技术部" },
      { id: "c", composio: false },
      { id: "d", hidden: true },
      { id: "e" },
    ];
    const org = { departments: [{ section: "技术部", color: "#F59E0B", allowedApps: ["github", "figma"] }] };
    expect(botsAllowedApp("github", bots, org).map((bot) => bot.id)).toEqual(["a", "b", "e"]);
    expect(botsAllowedApp("gmail", bots, org).map((bot) => bot.id)).toEqual(["a", "e"]);
    expect(botsAllowedApp("gmail", bots, null).map((bot) => bot.id)).toEqual(["a", "b", "e"]);
  });

  it("finds the newest tool call naming the app", () => {
    const bots = [
      { id: "a", messages: [{ at: 1, kind: "activity", tool: { name: "mcp__composio__GITHUB_CREATE_ISSUE" } }, { at: 5, kind: "text" }] },
      { id: "b", messages: [{ at: 3, kind: "activity", tool: { name: "GITHUB_LIST_PULLS" } }, { at: 9, kind: "activity", tool: { name: "SLACK_SEND" } }] },
    ];
    expect(lastAppUse("github", bots)).toEqual({ botId: "b", at: 3, tool: "GITHUB_LIST_PULLS" });
    expect(lastAppUse("notion", bots)).toBeNull();
  });
});
