// The source-string localization shared by the app, the harness and the
// desktop shell (shared/i18n.ts): lookup, interpolation, plurals and which
// language a process starts in.
import { afterEach, describe, expect, it } from "vitest";

import zhCN from "../shared/i18n/zh-CN.json" with { type: "json" };
import {
  allTranslations,
  detectLocale,
  getLocale,
  interpolate,
  intlLocale,
  msg,
  replyLanguageInstruction,
  setLocale,
  t,
  tn,
} from "../shared/i18n.ts";

describe("translation", () => {
  afterEach(() => setLocale("en"));

  it("returns the English source in English and the dictionary entry in Chinese", () => {
    expect(getLocale()).toBe("en"); // test runners start in the source language
    expect(t("Workbench")).toBe("Workbench");
    setLocale("zh-CN");
    expect(t("Workbench")).toBe((zhCN as Record<string, string>).Workbench);
    expect(t("Workbench")).not.toBe("Workbench");
  });

  it("falls back to the source for text the dictionary lacks", () => {
    setLocale("zh-CN");
    expect(t("A sentence no dictionary has")).toBe("A sentence no dictionary has");
    // inherited object keys are not translations
    expect(t("constructor")).toBe("constructor");
    expect(t("toString")).toBe("toString");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(t("{count} files", { count: 3 })).toBe("3 files");
    expect(interpolate("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    expect(interpolate("{a}", { a: null })).toBe("{a}");
  });

  it("picks the singular or plural source and passes the count", () => {
    expect(tn(1, "{count} bot", "{count} bots")).toBe("1 bot");
    expect(tn(4, "{count} bot", "{count} bots")).toBe("4 bots");
  });

  it("lists every rendering of a source, whatever the active language", () => {
    const renderings = allTranslations("Workbench");
    expect(renderings[0]).toBe("Workbench");
    expect(renderings).toContain((zhCN as Record<string, string>).Workbench);
    expect(allTranslations("A sentence no dictionary has")).toEqual(["A sentence no dictionary has"]);
  });

  it("marks without translating", () => {
    setLocale("zh-CN");
    expect(msg("Workbench")).toBe("Workbench");
  });

  it("formats and instructs in the active language", () => {
    expect(intlLocale()).toBe("en-US");
    expect(replyLanguageInstruction()).toBe("");
    setLocale("zh-CN");
    expect(intlLocale()).toBe("zh-CN");
    expect(replyLanguageInstruction()).toContain("Simplified Chinese");
  });

  it("keeps every placeholder of a source in its translation", () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
    for (const [source, translated] of Object.entries(zhCN as Record<string, string>)) {
      expect(names(translated), source).toBe(names(source));
    }
  });
});

describe("the starting language", () => {
  const storage = (value: string | null) => ({ getItem: () => value });

  it("honours an explicit OMB_LOCALE first", () => {
    expect(detectLocale({ env: { OMB_LOCALE: "en" }, shell: "zh-CN" })).toBe("en");
    expect(detectLocale({ env: { OMB_LOCALE: "zh-CN", VITEST: "true" } })).toBe("zh-CN");
  });

  it("starts test runners in the source language", () => {
    expect(detectLocale({ env: { VITEST: "true" }, shell: "zh-CN" })).toBe("en");
    expect(detectLocale({ env: { NODE_TEST_CONTEXT: "child" } })).toBe("en");
  });

  it("prefers the desktop shell's saved choice over browser storage", () => {
    expect(detectLocale({ env: {}, shell: "en", storage: storage("zh-CN") })).toBe("en");
    expect(detectLocale({ env: {}, shell: null, storage: storage("en") })).toBe("en");
  });

  it("starts everything else in Simplified Chinese", () => {
    expect(detectLocale({ env: {} })).toBe("zh-CN");
    expect(detectLocale({ env: {}, storage: storage("klingon") })).toBe("zh-CN");
    expect(
      detectLocale({
        env: {},
        storage: {
          getItem: () => {
            throw new Error("denied");
          },
        },
      }),
    ).toBe("zh-CN");
  });
});
