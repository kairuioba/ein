import { describe, expect, it } from "vitest";

import {
  PALETTE_CATEGORIES,
  cycleCategory,
  excerptAround,
  highlightParts,
  nextRunLabel,
  rankByFields,
  rankByName,
  routineScheduleLabel,
} from "./palette-rank";

const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

describe("rankByName", () => {
  it("puts prefix matches above substring matches", () => {
    const items = [{ name: "Big Momo" }, { name: "Momo" }, { name: "Lemon Momo" }];
    expect(names(rankByName(items, "mo"))).toEqual(["Momo", "Big Momo", "Lemon Momo"]);
  });

  it("matches case-insensitively on both sides", () => {
    const items = [{ name: "MOSS" }, { name: "quiet moss" }];
    expect(names(rankByName(items, "Moss"))).toEqual(["MOSS", "quiet moss"]);
  });

  it("keeps input order within a tier", () => {
    const items = [{ name: "Miso One" }, { name: "Miso Two" }, { name: "A Miso" }, { name: "B Miso" }];
    expect(names(rankByName(items, "miso"))).toEqual(["Miso One", "Miso Two", "A Miso", "B Miso"]);
  });

  it("filters out non-matches", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(rankByName(items, "zebra")).toEqual([]);
    expect(names(rankByName(items, "oss"))).toEqual(["Moss"]);
  });

  it("returns everything in input order for an empty or whitespace query", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(names(rankByName(items, ""))).toEqual(["Momo", "Moss"]);
    expect(names(rankByName(items, "   "))).toEqual(["Momo", "Moss"]);
  });
});

describe("rankByFields", () => {
  const bots = [
    { name: "Writer", title: "Pricing copy" },
    { name: "Pricing analyst", title: "Market lead" },
    { name: "Price watcher", title: "" },
    { name: "Designer", title: "Key visual" },
  ];
  it("ranks name prefixes, then name substrings, then other fields", () => {
    const ranked = rankByFields(bots, "pric", (bot) => bot.name, (bot) => [bot.title]);
    expect(names(ranked)).toEqual(["Pricing analyst", "Price watcher", "Writer"]);
    expect(rankByFields(bots, "", (bot) => bot.name, () => [])).toHaveLength(4);
    expect(rankByFields(bots, "zebra", (bot) => bot.name, (bot) => [bot.title, null, undefined])).toEqual([]);
  });
});

describe("highlightParts", () => {
  it("marks every case-insensitive occurrence", () => {
    expect(highlightParts("Price sheet: price v4", "PRICE")).toEqual([
      { text: "Price", match: true },
      { text: " sheet: ", match: false },
      { text: "price", match: true },
      { text: " v4", match: false },
    ]);
    expect(highlightParts("旗舰款价格就按 799，今天把价格表改成 v4。", "价格").filter((part) => part.match)).toHaveLength(2);
    expect(highlightParts("nothing here", "zz")).toEqual([{ text: "nothing here", match: false }]);
    expect(highlightParts("anything", "  ")).toEqual([{ text: "anything", match: false }]);
  });
});

describe("excerptAround", () => {
  it("keeps short text whole and centres long text on the first match", () => {
    expect(excerptAround("short prompt", "prompt")).toBe("short prompt");
    const long = `${"a".repeat(60)} price check ${"b".repeat(60)}`;
    const excerpt = excerptAround(long, "price", 10);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("price");
    expect(excerptAround("x".repeat(80), "nomatch", 10)).toBe(`${"x".repeat(27)}…`);
  });
});

describe("palette categories and labels", () => {
  it("cycles tabs both ways", () => {
    expect(cycleCategory("all", 1)).toBe("bots");
    expect(cycleCategory("routines", 1)).toBe("all");
    expect(cycleCategory("all", -1)).toBe("routines");
    expect(PALETTE_CATEGORIES).toHaveLength(6);
  });

  it("describes routine schedules", () => {
    expect(routineScheduleLabel({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] })).toBe("Weekdays 09:00");
    expect(routineScheduleLabel({ type: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day 18:00");
    expect(routineScheduleLabel({ type: "daily", time: "10:00", weekdays: [6, 0] })).toBe("Weekends 10:00");
    expect(routineScheduleLabel({ type: "daily", time: "10:00", weekdays: [3, 1] })).toBe("Mon, Wed 10:00");
  });

  it("says when a routine runs next", () => {
    const now = new Date(2026, 9, 15, 16, 52).getTime();
    expect(nextRunLabel(null, now)).toBe("");
    expect(nextRunLabel(new Date(2026, 9, 15, 18, 0).getTime(), now)).toBe("Next today 6:00 PM");
    expect(nextRunLabel(new Date(2026, 9, 16, 9, 0).getTime(), now)).toBe("Next tomorrow 9:00 AM");
    expect(nextRunLabel(new Date(2026, 9, 20, 9, 0).getTime(), now)).toBe("Next Oct 20 9:00 AM");
  });
});
