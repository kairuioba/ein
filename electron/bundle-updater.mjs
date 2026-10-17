// Auto-update for a Mac build without a Developer ID signature.
//
// Squirrel.Mac (electron-updater's MacUpdater) refuses to install into an
// app whose signature it cannot verify, and an ad-hoc signed build has none
// it accepts. This does the same job by hand, behind the same interface the
// updater coordinator drives (checkForUpdates / downloadUpdate /
// quitAndInstall plus electron-updater's events):
//
//   check     read latest-mac.yml from the releases feed and compare versions
//   download  fetch the ZIP for this architecture, verify its sha512, unpack
//             it with ditto, and check it is this same app (bundle id)
//   install   once the app has quit, a small detached script swaps the bundle
//             in place (copy beside it, two renames, roll back on failure),
//             clears the quarantine flag and, when asked, opens the new one
//
// Nothing here imports electron, so it runs under plain node in tests; the
// caller injects fetch, process helpers and how to quit.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.cjs";

/** "1.2.3" vs "1.2.10", "1.2.3-beta.1" < "1.2.3". */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ""] = String(value).trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  // semver precedence: dot-separated parts, numbers compared as numbers
  // ("dev.10" is newer than "dev.9"), a number below a word
  const leftParts = left.pre.split(".");
  const rightParts = right.pre.split(".");
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const l = leftParts[i];
    const r = rightParts[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const numL = /^\d+$/.test(l);
    const numR = /^\d+$/.test(r);
    if (numL && numR) return Number(l) > Number(r) ? 1 : -1;
    if (numL !== numR) return numL ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

/** The fields of electron-builder's latest-mac.yml this updater reads. */
export function parseLatestYml(text) {
  const info = { version: "", files: [], releaseDate: undefined };
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(raw);
    const field = /^(\s*)(\w+):\s*(.*)$/.exec(raw);
    const value = (text) => text.trim().replace(/^['"]|['"]$/g, "");
    if (item) {
      current = { [item[1]]: value(item[2]) };
      info.files.push(current);
    } else if (field && field[1].length > 0 && current) {
      current[field[2]] = value(field[3]);
    } else if (field && field[1].length === 0) {
      current = null;
      if (field[2] === "version") info.version = value(field[3]);
      if (field[2] === "releaseDate") info.releaseDate = value(field[3]);
    }
  }
  info.files = info.files
    .filter((file) => file.url)
    .map((file) => ({ url: file.url, sha512: file.sha512, size: file.size ? Number(file.size) : undefined }));
  return info;
}

/** The ZIP for this machine: arm64 → the arm64 build, x64 → the other one. */
export function pickZip(files, arch) {
  const zips = files.filter((file) => /\.zip$/i.test(file.url));
  if (arch === "arm64") return zips.find((file) => /arm64/i.test(file.url)) ?? null;
  return zips.find((file) => !/arm64/i.test(file.url)) ?? null;
}

/** The .app bundle around an executable path (…/Ein.app/Contents/MacOS/x). */
export function bundleOf(exePath) {
  const marker = exePath.lastIndexOf(".app/Contents/");
  return marker === -1 ? null : exePath.slice(0, marker + 4);
}

/** Why this copy cannot replace itself, or null when it can. */
export function installBlocker(appPath, { writable }) {
  if (!appPath) return "not-a-bundle";
  // run straight from the disk image, or from Downloads before it was moved
  if (appPath.startsWith("/Volumes/") || appPath.includes("/AppTranslocation/")) return "not-installed";
  if (!writable(dirname(appPath))) return "read-only";
  return null;
}

/** The detached script that swaps the bundle once the app has quit. */
export const SWAP_SCRIPT = `#!/bin/bash
# Written by bundle-updater.mjs: put a downloaded app in place of this one.
pid="$1"; target="$2"; staged="$3"; relaunch="$4"
for _ in $(seq 1 600); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
sleep 0.5
parent="$(dirname "$target")"
incoming="$parent/.ein-update-$$.app"
old="$parent/.ein-previous-$$.app"
/usr/bin/ditto "$staged" "$incoming" || { rm -rf "$incoming"; exit 1; }
mv "$target" "$old" || { rm -rf "$incoming"; exit 1; }
if mv "$incoming" "$target"; then
  rm -rf "$old"
else
  mv "$old" "$target"; rm -rf "$incoming"; exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
rm -rf "$(dirname "$staged")"
if [ "$relaunch" = "1" ]; then /usr/bin/open "$target"; fi
exit 0
`;

/**
 * @param {object} options
 * @param {string} options.feedUrl  where latest-mac.yml and the ZIPs live
 *   (https://github.com/<owner>/<repo>/releases/latest/download)
 * @param {boolean} [options.allowDowngrade]  also offer an OLDER version (a dev
 *   build going back to stable; see update-channel.mjs)
 * @param {string} options.currentVersion
 * @param {string|null} options.appPath  the running .app bundle
 * @param {string} options.arch  process.arch
 * @param {string} options.cacheDir  where downloads are staged
 * @param {(url: string) => Promise<Response>} options.fetch
 * @param {(file: string, args: string[]) => Promise<string>} options.run  execFile, stdout
 * @param {(script: string, args: string[]) => void} options.spawnDetached
 * @param {(dir: string) => boolean} options.writable
 * @param {() => void} options.quit
 * @param {number} options.pid
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 */
export function createBundleUpdater(options) {
  const updater = new EventEmitter();
  const log = options.logger ?? {};
  let available = null; // { version, file }
  let staged = null; // { version, app }
  let installing = false;

  const fail = (message) => {
    const error = new Error(message);
    updater.emit("error", error);
    return error;
  };

  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    const response = await options.fetch(`${options.feedUrl}/latest-mac.yml`);
    if (!response.ok) throw fail(t("The update feed answered {status}", { status: response.status }));
    const latest = parseLatestYml(await response.text());
    const file = pickZip(latest.files, options.arch);
    if (!latest.version || !file) throw fail(t("The update feed has no build for this Mac"));
    // a newer version, or — for a dev build going back to stable — any other one
    const order = compareVersions(latest.version, options.currentVersion);
    if (order === 0 || (order < 0 && !options.allowDowngrade)) {
      available = null;
      updater.emit("update-not-available", { version: latest.version });
      return { updateInfo: latest, isUpdateAvailable: false };
    }
    available = { version: latest.version, file };
    updater.emit("update-available", { version: latest.version, releaseDate: latest.releaseDate });
    return { updateInfo: latest, isUpdateAvailable: true };
  };

  updater.downloadUpdate = async () => {
    if (!available) throw fail(t("Check for updates first"));
    const { version, file } = available;
    if (staged?.version === version && existsSync(staged.app)) {
      updater.emit("update-downloaded", { version });
      return [staged.app];
    }
    const blocker = installBlocker(options.appPath, { writable: options.writable });
    if (blocker) throw fail(blockerMessage(blocker));
    const dir = join(options.cacheDir, version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, file.url.split("/").pop());
    const url = /^https?:/.test(file.url) ? file.url : `${options.feedUrl}/${encodeURIComponent(file.url)}`;
    const response = await options.fetch(url);
    if (!response.ok || !response.body) throw fail(t("The download answered {status}", { status: response.status }));
    const total = Number(response.headers.get("content-length")) || file.size || 0;
    const hash = createHash("sha512");
    const out = createWriteStream(zip);
    let received = 0;
    let lastPercent = -1;
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          updater.emit("download-progress", { percent, transferred: received, total });
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (file.sha512 && hash.digest("base64") !== file.sha512) {
      rmSync(dir, { recursive: true, force: true });
      throw fail(t("The download did not match its checksum"));
    }
    const unpacked = join(dir, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    await options.run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    const name = readdirSync(unpacked).find((entry) => entry.endsWith(".app"));
    if (!name) throw fail(t("The download has no app in it"));
    const app = join(unpacked, name);
    // the same app, not something else that happens to be in the feed
    const id = (path) => options.run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(path, "Contents/Info.plist")]).then((text) => text.trim());
    const [incoming, running] = await Promise.all([id(app), id(options.appPath)]);
    if (!incoming || incoming !== running) {
      rmSync(dir, { recursive: true, force: true });
      throw fail(t("The download is a different app"));
    }
    await options.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]).catch(() => "");
    rmSync(zip, { force: true });
    staged = { version, app };
    log.info?.(`staged ${version} at ${app}`);
    updater.emit("update-downloaded", { version });
    return [app];
  };

  /** Swap the staged app in once this process exits; open it again when asked. */
  const scheduleSwap = (relaunch) => {
    if (!staged || installing) return false;
    installing = true;
    const script = join(options.cacheDir, "swap.sh");
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    options.spawnDetached("/bin/bash", [script, String(options.pid), options.appPath, staged.app, relaunch ? "1" : "0"]);
    log.info?.(`swap scheduled (relaunch=${relaunch})`);
    return true;
  };

  updater.quitAndInstall = () => {
    if (!staged) throw fail(t("Nothing has been downloaded yet"));
    if (!scheduleSwap(true)) return;
    options.quit();
  };

  /** Called while the app quits on its own: an update that was downloaded
   * in the background goes in now, and the app stays closed. */
  updater.installOnQuit = () => scheduleSwap(false);

  updater.hasStagedUpdate = () => Boolean(staged);
  return updater;
}

export function blockerMessage(blocker) {
  if (blocker === "not-installed") return t("Move the app into the Applications folder, open it from there, then check again.");
  if (blocker === "read-only") return t("This copy of the app cannot be replaced from here. Move it into your Applications folder, then check again.");
  return t("This copy of the app cannot update itself.");
}
