import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allowsDowngrade, channelFeedUrl, readUpdateChannel } from "./update-channel.mjs";
import { compareVersions } from "./bundle-updater.mjs";

const STABLE = "https://github.com/kairuioba/ein-releases/releases/latest/download";

test("an install follows stable unless its config asks for dev", () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-channel-"));
  try {
    assert.equal(readUpdateChannel(dir), "stable");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maintenance: { channel: "dev" } }));
    assert.equal(readUpdateChannel(dir), "dev");
    writeFileSync(join(dir, "config.json"), "{ not json");
    assert.equal(readUpdateChannel(dir), "stable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev builds come from the rolling dev prerelease; stable is untouched", () => {
  assert.equal(channelFeedUrl(STABLE, "stable"), STABLE);
  assert.equal(channelFeedUrl(STABLE, "dev"), "https://github.com/kairuioba/ein-releases/releases/download/dev");
});

test("only a dev build going back to stable may downgrade", () => {
  assert.equal(allowsDowngrade("stable", "1.1.3-dev.4"), true);
  assert.equal(allowsDowngrade("stable", "1.1.2"), false);
  assert.equal(allowsDowngrade("dev", "1.1.3-dev.4"), false);
});

test("version order: a dev build sits between the stable releases around it", () => {
  assert.ok(compareVersions("1.1.3-dev.2", "1.1.2") > 0);
  assert.ok(compareVersions("1.1.3", "1.1.3-dev.2") > 0);
  assert.ok(compareVersions("1.1.3-dev.10", "1.1.3-dev.9") > 0);
  assert.ok(compareVersions("1.1.3-dev.9", "1.1.3-dev.10") < 0);
});
