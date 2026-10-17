import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundleOf,
  compareVersions,
  createBundleUpdater,
  installBlocker,
  parseLatestYml,
  pickZip,
  SWAP_SCRIPT,
} from "./bundle-updater.mjs";

const LATEST = `version: 0.2.0
files:
  - url: Ein-0.2.0-arm64.zip
    sha512: ARM
    size: 11
  - url: Ein-0.2.0-x64.zip
    sha512: X64
    size: 12
  - url: Ein-0.2.0-arm64.dmg
    sha512: DMG
    size: 13
path: Ein-0.2.0-x64.zip
sha512: X64
releaseDate: '2026-10-17T03:00:00.000Z'
`;

test("compares versions the way releases are numbered", () => {
  assert.equal(compareVersions("0.2.0", "0.1.43"), 1);
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.2"), 1);
  assert.equal(compareVersions("0.1.43", "0.2.0"), -1);
});

test("reads latest-mac.yml and picks the ZIP for this Mac", () => {
  const info = parseLatestYml(LATEST);
  assert.equal(info.version, "0.2.0");
  assert.equal(info.releaseDate, "2026-10-17T03:00:00.000Z");
  assert.deepEqual(info.files.map((file) => file.url), ["Ein-0.2.0-arm64.zip", "Ein-0.2.0-x64.zip", "Ein-0.2.0-arm64.dmg"]);
  assert.equal(pickZip(info.files, "arm64").url, "Ein-0.2.0-arm64.zip");
  assert.equal(pickZip(info.files, "x64").url, "Ein-0.2.0-x64.zip");
  assert.equal(pickZip([], "arm64"), null);
});

test("finds the bundle and refuses to replace a copy it cannot", () => {
  assert.equal(bundleOf("/Applications/Ein.app/Contents/MacOS/Ein"), "/Applications/Ein.app");
  assert.equal(bundleOf("/usr/bin/node"), null);
  const writable = () => true;
  assert.equal(installBlocker("/Applications/Ein.app", { writable }), null);
  assert.equal(installBlocker("/Volumes/Ein 0.1.43/Ein.app", { writable }), "not-installed");
  assert.equal(installBlocker("/private/var/folders/x/AppTranslocation/ABC/d/Ein.app", { writable }), "not-installed");
  assert.equal(installBlocker("/Applications/Ein.app", { writable: () => false }), "read-only");
  assert.equal(installBlocker(null, { writable }), "not-a-bundle");
});

test("the swap script copies beside the app, renames twice and rolls back", () => {
  assert.match(SWAP_SCRIPT, /kill -0 "\$pid"/);
  assert.match(SWAP_SCRIPT, /ditto "\$staged" "\$incoming"/);
  assert.match(SWAP_SCRIPT, /mv "\$old" "\$target"/);
  assert.match(SWAP_SCRIPT, /xattr -dr com\.apple\.quarantine/);
});

function world({ zipBytes = Buffer.from("zip-contents"), bundleId = "com.kairuioba.ein", current = "0.1.43", arch = "arm64" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bundle-updater-"));
  const app = join(root, "Applications/Ein.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  const sha = createHash("sha512").update(zipBytes).digest("base64");
  const feed = LATEST.replace("sha512: ARM", `sha512: ${sha}`).replace("size: 11", `size: ${zipBytes.length}`);
  const fetched = [];
  const runs = [];
  const spawned = [];
  let quit = 0;
  const fetch = async (url) => {
    fetched.push(url);
    if (url.endsWith("/latest-mac.yml")) return new Response(feed, { status: 200 });
    if (url.endsWith(".zip")) return new Response(zipBytes, { status: 200, headers: { "content-length": String(zipBytes.length) } });
    return new Response("nope", { status: 404 });
  };
  const run = async (file, args) => {
    runs.push([file, ...args]);
    if (file === "/usr/bin/ditto") {
      const into = args[3];
      mkdirSync(join(into, "Ein.app/Contents"), { recursive: true });
      writeFileSync(join(into, "Ein.app/Contents/Info.plist"), "<plist/>");
      return "";
    }
    if (file === "/usr/libexec/PlistBuddy") return args[2].startsWith(app) ? "com.kairuioba.ein\n" : `${bundleId}\n`;
    return "";
  };
  const updater = createBundleUpdater({
    feedUrl: "https://github.com/kairuioba/ein-releases/releases/latest/download",
    currentVersion: current,
    appPath: app,
    arch,
    cacheDir: join(root, "cache"),
    fetch,
    run,
    spawnDetached: (file, args) => spawned.push([file, ...args]),
    writable: () => true,
    quit: () => {
      quit += 1;
    },
    pid: 4242,
  });
  const events = [];
  for (const name of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"]) {
    updater.on(name, (payload) => events.push([name, payload]));
  }
  return { root, app, updater, fetched, runs, spawned, events, quits: () => quit };
}

test("checks, downloads, verifies, unpacks and installs on restart", async () => {
  const w = world();
  try {
    const result = await w.updater.checkForUpdates();
    assert.equal(result.isUpdateAvailable, true);
    assert.deepEqual(w.events.find(([name]) => name === "update-available")?.[1].version, "0.2.0");
    const [staged] = await w.updater.downloadUpdate();
    assert.ok(staged.endsWith(join("0.2.0", "unpacked", "Ein.app")));
    assert.ok(existsSync(staged));
    assert.ok(w.fetched.includes("https://github.com/kairuioba/ein-releases/releases/latest/download/Ein-0.2.0-arm64.zip"));
    assert.ok(w.events.some(([name, payload]) => name === "download-progress" && payload.percent === 100));
    assert.ok(w.events.some(([name, payload]) => name === "update-downloaded" && payload.version === "0.2.0"));
    assert.ok(w.runs.some(([file]) => file === "/usr/bin/ditto"));
    // restart: the swap runs detached after this process quits, and reopens the app
    w.updater.quitAndInstall(true, true);
    assert.equal(w.quits(), 1);
    const [shell, script, pid, target, from, relaunch] = w.spawned[0];
    assert.equal(shell, "/bin/bash");
    assert.equal(readFileSync(script, "utf8"), SWAP_SCRIPT);
    assert.deepEqual([pid, target, from, relaunch], ["4242", w.app, staged, "1"]);
    // a second request does not schedule a second swap
    w.updater.quitAndInstall(true, true);
    assert.equal(w.spawned.length, 1);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a background download goes in when the app quits, without reopening it", async () => {
  const w = world();
  try {
    await w.updater.checkForUpdates();
    await w.updater.downloadUpdate();
    assert.equal(w.updater.installOnQuit(), true);
    assert.equal(w.spawned[0].at(-1), "0");
    assert.equal(w.quits(), 0);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("says so when already on the latest version", async () => {
  const w = world({ current: "0.2.0" });
  try {
    const result = await w.updater.checkForUpdates();
    assert.equal(result.isUpdateAvailable, false);
    assert.ok(w.events.some(([name]) => name === "update-not-available"));
    await assert.rejects(w.updater.downloadUpdate());
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("refuses a download that is another app", async () => {
  const other = world({ bundleId: "com.example.other" });
  try {
    other.updater.on("error", () => {});
    await other.updater.checkForUpdates();
    await assert.rejects(other.updater.downloadUpdate(), /different app/);
    assert.equal(other.spawned.length, 0);
  } finally {
    rmSync(other.root, { recursive: true, force: true });
  }
});

test("refuses a download whose bytes do not match latest-mac.yml", async () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-updater-sum-"));
  try {
    const app = join(root, "Applications/Ein.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    const updater = createBundleUpdater({
      feedUrl: "https://example.test/download",
      currentVersion: "0.1.0",
      appPath: app,
      arch: "x64",
      cacheDir: join(root, "cache"),
      fetch: async (url) =>
        url.endsWith(".yml") ? new Response(LATEST, { status: 200 }) : new Response(Buffer.from("other bytes"), { status: 200 }),
      run: async () => "com.kairuioba.ein",
      spawnDetached: () => {},
      writable: () => true,
      quit: () => {},
      pid: 1,
    });
    updater.on("error", () => {});
    await updater.checkForUpdates();
    await assert.rejects(updater.downloadUpdate(), /checksum/);
    assert.equal(existsSync(join(root, "cache/0.2.0")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a copy run from the disk image is told to move into Applications", async () => {
  const updater = createBundleUpdater({
    feedUrl: "https://example.test/download",
    currentVersion: "0.1.0",
    appPath: "/Volumes/Ein/Ein.app",
    arch: "arm64",
    cacheDir: join(tmpdir(), "never-used"),
    fetch: async () => new Response(LATEST, { status: 200 }),
    run: async () => "",
    spawnDetached: () => {},
    writable: () => true,
    quit: () => {},
    pid: 1,
  });
  updater.on("error", () => {});
  await updater.checkForUpdates();
  await assert.rejects(updater.downloadUpdate(), /Applications/);
});
