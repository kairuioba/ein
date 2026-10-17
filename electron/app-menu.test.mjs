// The menu bar speaks the app's language, with each platform's own Chinese
// wording, and routes renderer-owned items through menu:command.
import { afterEach, describe, expect, it } from "vitest";

import { applicationMenuTemplate, menuLabel } from "./app-menu.mjs";
// Imported the way app-menu.mjs imports it, so both share one module (and one
// current locale): under Vitest a require() here can be a separate copy.
import * as i18n from "./i18n.cjs";

const build = (overrides = {}) =>
  applicationMenuTemplate({
    // main.mjs passes t("Ein"), the name people read in that language
    appName: i18n.t("Ein"),
    platform: "darwin",
    isFullScreen: false,
    homepage: "https://example.test/omb",
    command: () => {},
    openExternal: () => {},
    ...overrides,
  });

const labels = (template) => template.map((menu) => menu.label);
const find = (template, label) => template.flatMap((menu) => menu.submenu ?? []).find((item) => item.label === label);

describe("application menu", () => {
  afterEach(() => i18n.setLocale("en"));

  it("keeps the English menu in English", () => {
    i18n.setLocale("en");
    expect(labels(build())).toEqual(["Ein", "File", "Edit", "View", "Window", "Help"]);
    expect(menuLabel("Quit {app}", { app: i18n.t("Ein") }, "darwin")).toBe("Quit Ein");
    expect(find(build(), "Ein Website")).toBeDefined();
  });

  it("uses macOS's own Chinese words on a Mac and the usual ones elsewhere", () => {
    i18n.setLocale("zh-CN");
    expect(labels(build())).toEqual(["一念", "文件", "编辑", "显示", "窗口", "帮助"]);
    expect(menuLabel("Copy", {}, "darwin")).toBe("拷贝");
    expect(menuLabel("Quit {app}", { app: i18n.t("Ein") }, "darwin")).toBe("退出“一念”");
    expect(menuLabel("Copy", {}, "win32")).toBe("复制");
    expect(labels(build({ platform: "win32" }))).toEqual(["文件", "编辑", "视图", "窗口", "帮助"]);
  });

  it("follows full screen and keeps developer tools, like Electron's default menu", () => {
    i18n.setLocale("zh-CN");
    expect(find(build({ isFullScreen: true }), "退出全屏幕")?.role).toBe("togglefullscreen");
    expect(find(build({ isFullScreen: false }), "进入全屏幕")?.role).toBe("togglefullscreen");
    expect(find(build(), "开发者工具")?.role).toBe("toggleDevTools");
  });

  it("leaves the workbench's ⌘0 / ⌘= / ⌘- to the page", () => {
    for (const label of ["Actual Size", "Zoom In", "Zoom Out"]) {
      expect(find(build(), label).registerAccelerator).toBe(false);
    }
  });

  it("sends renderer-owned items to the page and leaves ⌘N to the page's own handler", () => {
    const sent = [];
    const template = build({ command: (name) => sent.push(name) });
    const newBot = find(template, "New Bot");
    expect(newBot.registerAccelerator).toBe(false);
    newBot.click();
    find(template, "Settings…").click();
    find(template, "Workbench").click();
    expect(sent).toEqual(["new-bot", "open-settings", "open-workbench"]);
  });
});
