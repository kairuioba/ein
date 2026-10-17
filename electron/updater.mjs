// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// stages the downloaded ZIP immediately and the explicit restart applies it.
// One state object is broadcast on every transition.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain, net } from "electron";
import { execFile, spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { bundleOf, createBundleUpdater } from "./bundle-updater.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { allowsDowngrade, channelFeedUrl, readUpdateChannel } from "./update-channel.mjs";
import { t } from "./i18n.cjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle", current: app.getVersion() };
let updaterCoordinator = null;

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => updaterCoordinator?.install());
}

/** owner/repo of the GitHub releases feed baked into app-update.yml. */
export function feedFromAppUpdateYml(text) {
  const field = (name) => new RegExp(`^${name}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, "m").exec(text)?.[1];
  const owner = field("owner");
  const repo = field("repo");
  if (field("provider") !== "github" || !owner || !repo) return null;
  return `https://github.com/${owner}/${repo}/releases/latest/download`;
}

const execText = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}${stderr}`))),
  );

/** A Developer ID signature lets Squirrel.Mac install updates; an ad-hoc
 * build (no Apple developer account) has to swap its bundle itself. */
async function hasDeveloperId(appPath) {
  try {
    return /Authority=Developer ID Application/.test(await execText("/usr/bin/codesign", ["-dv", "--verbose=2", appPath]));
  } catch {
    return false;
  }
}

function bundleUpdater(feedUrl, logger, allowDowngrade = false) {
  const appPath = bundleOf(app.getPath("exe"));
  const updater = createBundleUpdater({
    feedUrl,
    allowDowngrade,
    currentVersion: app.getVersion(),
    appPath,
    arch: process.arch,
    cacheDir: join(app.getPath("userData"), "pending-update"),
    fetch: (url) => net.fetch(url, { cache: "no-store" }),
    run: execText,
    spawnDetached: (file, args) => spawn(file, args, { detached: true, stdio: "ignore" }).unref(),
    writable: (dir) => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    quit: () => app.quit(),
    pid: process.pid,
    logger,
  });
  // downloaded in the background and never restarted for: it goes in as
  // the app quits, and the next launch is the new version
  app.on("will-quit", () => updater.installOnQuit());
  return updater;
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  // No feed baked in (a build made with `publish: null`): nothing to check
  // against, so the updater stays dormant. Release builds bake in
  // kairuioba/ein-releases (electron-builder.yml → publish).
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) {
    updaterCoordinator = null;
    setState({ status: "idle", unavailable: true });
    return;
  }
  const logger = updaterLogger();
  // a new version downloads as soon as it is found; a check you asked for
  // goes on to restart into it, one found in the background waits for you
  // (or for the app to quit)
  const automatic = { autoDownload: true, installAfterManualCheck: true };
  // the developer edition's channel (read once: switching asks for a restart)
  const channel = readUpdateChannel(process.env.OMB_DATA_DIR || join(app.getPath("home"), ".ein"));
  const stableFeed = feedFromAppUpdateYml(readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8"));
  setState({ channel });
  logger.info(`update channel: ${channel}`);
  if (process.platform === "darwin") {
    const appPath = bundleOf(app.getPath("exe"));
    void hasDeveloperId(appPath ?? "").then((signed) => {
      if (signed) return startElectronUpdater(logger, automatic, channel, stableFeed);
      if (!stableFeed) {
        setState({ status: "idle", unavailable: true });
        return;
      }
      const updater = bundleUpdater(channelFeedUrl(stableFeed, channel), logger, allowsDowngrade(channel, app.getVersion()));
      updaterCoordinator = createUpdaterCoordinator(updater, setState, automatic);
      scheduleChecks();
    });
    return;
  }
  startElectronUpdater(logger, automatic, channel, stableFeed);
}

function startElectronUpdater(logger, automatic, channel = "stable", stableFeed = null) {
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: t("updater unavailable") });
    return;
  }
  autoUpdater.autoDownload = false; // the coordinator starts the download
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Start it immediately so "Restart to update" never has to begin that slow
  // pass and wait indefinitely. Windows installs on quit too: a version
  // downloaded in the background goes in when the app closes.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = logger;
  // dev channel: the rolling `dev` prerelease, read as a plain feed so a
  // stable install never sees it; back on stable, a dev build may go down to
  // the latest stable release
  if (channel === "dev" && stableFeed) {
    autoUpdater.allowPrerelease = true;
    autoUpdater.setFeedURL({ provider: "generic", url: channelFeedUrl(stableFeed, "dev") });
  }
  if (allowsDowngrade(channel, app.getVersion())) autoUpdater.allowDowngrade = true;

  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, automatic);
  scheduleChecks();
}

function scheduleChecks() {
  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
