import { describe, expect, it } from "vitest";

import { initialState, reducer, type AppState } from "@/state/store";
import { SETTINGS_SECTIONS, sectionMatches, visibleSections } from "./settings-sections";

describe("settings page navigation (toggleAppSettings)", () => {
  const inChat: AppState = { ...initialState, activeView: "chat", selectedId: "bot-1", settingsOpen: true, computerOpen: true };

  it("opens the settings page on a section and remembers where it came from", () => {
    const next = reducer(inChat, { type: "toggleAppSettings", open: true, section: "org" });
    expect(next.activeView).toBe("settings");
    expect(next.appSettingsSection).toBe("org");
    expect(next.settingsReturnView).toBe("chat");
    expect(next.appSettingsOpen).toBe(false);
    expect(next.settingsOpen).toBe(false);
    expect(next.computerOpen).toBe(false);
  });

  it("keeps the section when none is given and toggles closed back to the previous view", () => {
    const open = reducer({ ...inChat, appSettingsSection: "engines" }, { type: "toggleAppSettings" });
    expect(open.activeView).toBe("settings");
    expect(open.appSettingsSection).toBe("engines");
    const closed = reducer(open, { type: "toggleAppSettings" });
    expect(closed.activeView).toBe("chat");
    expect(closed.selectedId).toBe("bot-1");
  });

  it("switches sections on the page without forgetting the view to return to", () => {
    const fromCalendar = reducer({ ...initialState, activeView: "routines" }, { type: "toggleAppSettings", open: true, section: "general" });
    const moved = reducer(fromCalendar, { type: "toggleAppSettings", open: true, section: "usage" });
    expect(moved.appSettingsSection).toBe("usage");
    expect(moved.settingsReturnView).toBe("routines");
    expect(reducer(moved, { type: "toggleAppSettings", open: false }).activeView).toBe("routines");
  });

  it("ignores a close when the page is not open", () => {
    expect(reducer(inChat, { type: "toggleAppSettings", open: false })).toBe(inChat);
  });

  it("lets a bot selection leave the page", () => {
    const open = reducer(inChat, { type: "toggleAppSettings", open: true });
    expect(reducer(open, { type: "select", id: "bot-1" }).activeView).toBe("chat");
  });
});

describe("settings sections", () => {
  it("lists every section once, in the nav order of the design", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "org",
      "engines",
      "review",
      "cadence",
      "computer",
      "connections",
      "companion",
      "usage",
      "experimental",
      "maintenance",
      "updates",
      "about",
    ]);
  });

  it("finds sections by label or by what lives inside them, in either language", () => {
    expect(visibleSections("").length).toBe(SETTINGS_SECTIONS.length);
    expect(visibleSections("skin").map((section) => section.id)).toEqual(["appearance"]);
    expect(visibleSections("预算").map((section) => section.id)).toEqual(["org", "usage"]);
    expect(visibleSections("  WorkBuddy ").map((section) => section.id)).toEqual(["engines"]);
    expect(sectionMatches(SETTINGS_SECTIONS.find((section) => section.id === "companion")!, "phone")).toBe(true);
    expect(visibleSections("no such thing")).toEqual([]);
  });

  it("finds About by what it shows, in either language", () => {
    expect(visibleSections("github").map((section) => section.id)).toEqual(["about"]);
    expect(visibleSections("开源").map((section) => section.id)).toEqual(["about"]);
    expect(visibleSections("version").map((section) => section.id)).toEqual(["updates", "about"]);
  });
});
