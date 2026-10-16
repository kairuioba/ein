import { describe, expect, it } from "vitest";

import { isBrowserApp, pageTitle, skillApps, skillParams, slashCommand, suggestSkillName, transcriptWithNotes } from "./skill-teach";
import type { RecordedSkillEvent } from "./skill-recorder";

let n = 0;
const ev = (partial: Partial<RecordedSkillEvent> & Pick<RecordedSkillEvent, "type">): RecordedSkillEvent => ({ id: `e${++n}`, atMs: n * 1000, ...partial });

describe("teaching a skill", () => {
  it("recognises browsers and strips the browser name from window titles", () => {
    expect(isBrowserApp("Google Chrome")).toBe(true);
    expect(isBrowserApp("Feishu")).toBe(false);
    expect(pageTitle("Creator Center - Publish note - Google Chrome")).toBe("Creator Center - Publish note");
    expect(pageTitle(undefined)).toBeUndefined();
  });

  it("lists the apps a recording used, once each, in order of first use", () => {
    const apps = skillApps([
      ev({ type: "app", app: "Google Chrome", windowTitle: "Creator Center - Google Chrome" }),
      ev({ type: "click", app: "Google Chrome", windowTitle: "Creator Center - Google Chrome", name: "Schedule" }),
      ev({ type: "app", app: "Finder", windowTitle: "Assets" }),
      ev({ type: "download", filename: "cover.png", whereFroms: ["https://library.example.cn/assets/cover.png"] }),
      ev({ type: "app", app: "Google Chrome" }),
    ]);
    expect(apps).toEqual([
      { kind: "browser", label: "Google Chrome", detail: "Creator Center" },
      { kind: "app", label: "Finder", detail: "Assets" },
      { kind: "download", label: "library.example.cn", detail: "cover.png" },
    ]);
  });

  it("collects what will change next time: typed text, pasted content and files", () => {
    const params = skillParams([
      ev({ type: "typing", app: "Notes", windowTitle: "Selling points", keyCount: 40 }),
      ev({ type: "typing", app: "Notes", windowTitle: "Selling points", keyCount: 3 }),
      ev({ type: "clipboard", op: "paste", app: "Google Chrome", windowTitle: "Editor - Google Chrome" }),
      ev({ type: "clipboard", op: "copy", app: "Notes" }),
      ev({ type: "download", filename: "a-very-long-cover-image-name.png" }),
    ]);
    expect(params).toEqual([
      { kind: "Typed text", value: "Selling points" },
      { kind: "Pasted content", value: "Editor" },
      { kind: "File", value: "a-very-long-cover…" },
    ]);
  });

  it("suggests the place the demonstration spent most steps in", () => {
    expect(suggestSkillName([])).toBe("");
    expect(
      suggestSkillName([
        ev({ type: "app", app: "Finder" }),
        ev({ type: "click", app: "Google Chrome", windowTitle: "Publish note - Google Chrome" }),
        ev({ type: "click", app: "Google Chrome", windowTitle: "Publish note - Google Chrome" }),
      ]),
    ).toBe("Publish note");
  });

  it("turns a name into a slash command", () => {
    expect(slashCommand("定时发小红书")).toBe("/定时发小红书");
    expect(slashCommand(" post weekly report ")).toBe("/post-weekly-report");
    expect(slashCommand("创作者中心 · 发布笔记")).toBe("/创作者中心-发布笔记");
    expect(slashCommand("  ")).toBe("");
  });

  it("appends typed notes to the narration it saves", () => {
    const format = (ms: number) => `0:${String(ms / 1000).padStart(2, "0")}`;
    expect(transcriptWithNotes("I open the editor.", [{ id: "1", source: "typed", text: "only the first two paragraphs", atMs: 17_000 }, { id: "2", source: "said", text: "ignored" }], format))
      .toBe("I open the editor.\n\n[0:17] only the first two paragraphs");
    expect(transcriptWithNotes("same", [], format)).toBe("same");
  });
});
