// The menu bar. Electron's default menu is English in every language, so the
// app builds its own. In Chinese it uses the words macOS itself uses in
// Simplified Chinese (拷贝 rather than 复制, 退出“App”, 前置全部窗口 …), so the
// menus read like every other Mac app's rather than like a web page's.
//
// Items that belong to the renderer (new bot, settings, workbench) send a
// `menu:command` to the focused window; App.tsx carries them out. Shortcuts
// the page already handles itself (⌘N) are shown but not registered, so the
// keystroke keeps reaching the page exactly as before.
import { getLocale, t } from "./i18n.cjs";

/** Mac menu vocabulary. Kept out of the shared dictionary on purpose: the
 * same English word is translated differently in a Mac menu ("Copy" → 拷贝)
 * than on a web button ("Copy" → 复制). */
const MAC_ZH = {
  "About {app}": "关于“{app}”",
  "Settings…": "设置…",
  Services: "服务",
  "Hide {app}": "隐藏“{app}”",
  "Hide Others": "隐藏其他",
  "Show All": "全部显示",
  "Quit {app}": "退出“{app}”",
  File: "文件",
  "New Bot": "新建 Bot",
  Workbench: "工作台",
  "Close Window": "关闭窗口",
  Edit: "编辑",
  Undo: "撤销",
  Redo: "重做",
  Cut: "剪切",
  Copy: "拷贝",
  "Copy Link": "拷贝链接",
  Paste: "粘贴",
  "Paste and Match Style": "粘贴并匹配样式",
  Delete: "删除",
  "Select All": "全选",
  Speech: "语音",
  "Start Speaking": "开始朗读",
  "Stop Speaking": "停止朗读",
  View: "显示",
  Reload: "重新载入",
  "Force Reload": "强制重新载入",
  "Developer Tools": "开发者工具",
  "Actual Size": "实际大小",
  "Zoom In": "放大",
  "Zoom Out": "缩小",
  "Enter Full Screen": "进入全屏幕",
  "Exit Full Screen": "退出全屏幕",
  Window: "窗口",
  Minimize: "最小化",
  Zoom: "缩放",
  "Bring All to Front": "前置全部窗口",
  Help: "帮助",
  "{app} Website": "{app} 网站",
  "Report an Issue": "报告问题",
};

/** Windows and Linux say 复制 / 视图 / 重新加载 where a Mac says 拷贝 / 显示 / 重新载入. */
const OTHER_ZH = {
  ...MAC_ZH,
  "About {app}": "关于 {app}",
  "Quit {app}": "退出",
  Copy: "复制",
  "Copy Link": "复制链接",
  View: "视图",
  Reload: "重新加载",
  "Force Reload": "强制重新加载",
  "Enter Full Screen": "全屏",
  "Exit Full Screen": "退出全屏",
};

/** A menu label in the active language, in the platform's own Chinese wording. */
export function menuLabel(english, params = {}, platform = process.platform) {
  return localizedLabel(english, params, platform);
}

function localizedLabel(english, params = {}, platform = process.platform) {
  const words = platform === "darwin" ? MAC_ZH : OTHER_ZH;
  const template = getLocale() === "zh-CN" ? (words[english] ?? t(english)) : english;
  return template.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])));
}

/**
 * @param {{
 *   appName: string,
 *   platform: NodeJS.Platform,
 *   isFullScreen: boolean,
 *   homepage: string,
 *   command: (name: "new-bot" | "open-settings" | "open-workbench") => void,
 *   openExternal: (url: string) => void,
 * }} options
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function applicationMenuTemplate({ appName, platform, isFullScreen, homepage, command, openExternal }) {
  const mac = platform === "darwin";
  const app = { app: appName };
  const menuLabel = (english, params) => localizedLabel(english, params, platform);
  const template = [];

  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { label: menuLabel("About {app}", app), role: "about" },
        { type: "separator" },
        { label: menuLabel("Settings…"), accelerator: "Command+,", click: () => command("open-settings") },
        { type: "separator" },
        { label: menuLabel("Services"), role: "services" },
        { type: "separator" },
        { label: menuLabel("Hide {app}", app), role: "hide" },
        { label: menuLabel("Hide Others"), role: "hideOthers" },
        { label: menuLabel("Show All"), role: "unhide" },
        { type: "separator" },
        { label: menuLabel("Quit {app}", app), role: "quit" },
      ],
    });
  }

  template.push({
    label: menuLabel("File"),
    submenu: [
      // ⌘N is the page's own shortcut (App.tsx); the menu only shows it
      { label: menuLabel("New Bot"), accelerator: "CmdOrCtrl+N", registerAccelerator: false, click: () => command("new-bot") },
      { label: menuLabel("Workbench"), accelerator: "CmdOrCtrl+Shift+B", click: () => command("open-workbench") },
      ...(mac
        ? []
        : [{ type: "separator" }, { label: menuLabel("Settings…"), accelerator: "Ctrl+,", click: () => command("open-settings") }]),
      { type: "separator" },
      mac ? { label: menuLabel("Close Window"), role: "close" } : { label: menuLabel("Quit {app}", app), role: "quit" },
    ],
  });

  template.push({
    label: menuLabel("Edit"),
    submenu: [
      { label: menuLabel("Undo"), role: "undo" },
      { label: menuLabel("Redo"), role: "redo" },
      { type: "separator" },
      { label: menuLabel("Cut"), role: "cut" },
      { label: menuLabel("Copy"), role: "copy" },
      { label: menuLabel("Paste"), role: "paste" },
      { label: menuLabel("Paste and Match Style"), role: "pasteAndMatchStyle" },
      { label: menuLabel("Delete"), role: "delete" },
      { label: menuLabel("Select All"), role: "selectAll" },
      ...(mac
        ? [
            { type: "separator" },
            {
              label: menuLabel("Speech"),
              submenu: [
                { label: menuLabel("Start Speaking"), role: "startSpeaking" },
                { label: menuLabel("Stop Speaking"), role: "stopSpeaking" },
              ],
            },
          ]
        : []),
    ],
  });

  template.push({
    label: menuLabel("View"),
    submenu: [
      { label: menuLabel("Reload"), role: "reload" },
      { label: menuLabel("Force Reload"), role: "forceReload" },
      // kept in packaged builds too, as Electron's default menu always had it
      { label: menuLabel("Developer Tools"), role: "toggleDevTools" },
      { type: "separator" },
      // ⌘0 / ⌘= / ⌘- belong to the workbench canvas (fit, zoom in, zoom out),
      // so the page-zoom items show their keys without claiming them
      { label: menuLabel("Actual Size"), role: "resetZoom", accelerator: "CmdOrCtrl+0", registerAccelerator: false },
      { label: menuLabel("Zoom In"), role: "zoomIn", accelerator: "CmdOrCtrl+=", registerAccelerator: false },
      { label: menuLabel("Zoom Out"), role: "zoomOut", accelerator: "CmdOrCtrl+-", registerAccelerator: false },
      { type: "separator" },
      { label: menuLabel(isFullScreen ? "Exit Full Screen" : "Enter Full Screen"), role: "togglefullscreen" },
    ],
  });

  template.push({
    label: menuLabel("Window"),
    role: "windowMenu",
    submenu: [
      { label: menuLabel("Minimize"), role: "minimize" },
      { label: menuLabel("Zoom"), role: "zoom" },
      ...(mac ? [{ type: "separator" }, { label: menuLabel("Bring All to Front"), role: "front" }] : []),
    ],
  });

  template.push({
    label: menuLabel("Help"),
    role: "help",
    submenu: [
      { label: menuLabel("{app} Website", app), click: () => openExternal(homepage) },
      { label: menuLabel("Report an Issue"), click: () => openExternal(`${homepage}/issues`) },
    ],
  });

  return template;
}
