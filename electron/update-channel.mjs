// Which update feed this install follows — the developer edition's channel
// switch (server/maintenance.ts stores it in config.json). Everyone is on
// "stable": the latest non-prerelease of kairuioba/ein-releases. The owner's
// machines may follow "dev": the rolling `dev` prerelease, rebuilt by every
// dev build, which stable installs never look at.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** "stable" unless this install's config.json asks for the dev channel. */
export function readUpdateChannel(dataDir) {
  try {
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    return config?.maintenance?.channel === "dev" ? "dev" : "stable";
  } catch {
    return "stable";
  }
}

/** The feed for a channel, from the stable one baked into the app
 * ("https://github.com/<owner>/<repo>/releases/latest/download"). */
export function channelFeedUrl(stableFeed, channel) {
  return channel === "dev" ? stableFeed.replace(/\/releases\/latest\/download\/?$/, "/releases/download/dev") : stableFeed;
}

/** A dev build switched back to stable may go DOWN to the latest stable
 * release: that is the way back from a dev build. Nothing else downgrades. */
export function allowsDowngrade(channel, currentVersion) {
  return channel === "stable" && /-dev\./.test(String(currentVersion));
}
