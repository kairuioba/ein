// The developer edition's checks. The git/gh runner is injected, so these
// never touch the developer's real GitHub login or repositories.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import {
  developerStatus,
  maintenanceHandbook,
  releaseArgs,
  repoState,
  resetDeveloperStatus,
  type ToolRunner,
  validRef,
} from "./maintenance.ts";

/** A runner that answers by the first two arguments. */
function runner(answers: Record<string, { ok: boolean; out: string; missing?: boolean }>): ToolRunner {
  return async (file, args) => answers[`${file} ${args.slice(0, 2).join(" ")}`] ?? answers[`${file} ${args[0]}`] ?? { ok: false, out: "" };
}

describe("developer mode", () => {
  afterEach(() => resetDeveloperStatus());

  it("is on where the GitHub CLI's account may push to the source repository", async () => {
    const status = await developerStatus(runner({
      "gh api repos/kairuioba/ein": { ok: true, out: "true" },
      "gh api user": { ok: true, out: "kairuioba" },
    }));
    expect(status).toMatchObject({ available: true, account: "kairuioba" });
  });

  it("says why it is off: no gh, signed out, or no push rights", async () => {
    expect((await developerStatus(runner({ "gh api": { ok: false, out: "", missing: true } }), true)).reason).toBe("no-gh");
    expect((await developerStatus(runner({ "gh api": { ok: false, out: "To get started with GitHub CLI, please run:  gh auth login" } }), true)).reason).toBe("signed-out");
    expect((await developerStatus(runner({ "gh api repos/kairuioba/ein": { ok: true, out: "false" } }), true)).reason).toBe("no-access");
    expect((await developerStatus(runner({ "gh api repos/kairuioba/ein": { ok: false, out: "HTTP 404: Not Found" } }), true)).reason).toBe("no-access");
  });

  it("caches the answer until asked to look again", async () => {
    let calls = 0;
    const counting: ToolRunner = async (file, args) => {
      calls += 1;
      return args[1] === "user" ? { ok: true, out: "me" } : { ok: true, out: "true" };
    };
    await developerStatus(counting);
    await developerStatus(counting);
    expect(calls).toBe(2);
    await developerStatus(counting, true);
    expect(calls).toBe(4);
  });
});

describe("the source clone", () => {
  const folder = mkdtempSync(join(tmpdir(), "ein-src-"));

  it("must exist, be a git checkout, and come from kairuioba/ein", async () => {
    expect((await repoState(join(folder, "nope"))).reason).toBe("missing");
    expect((await repoState(folder, runner({ "git -C": { ok: false, out: "not a git repository" } }))).reason).toBe("not-git");
    const upstream: ToolRunner = async () => ({ ok: true, out: "https://github.com/CuriosityOS/OpenMausBot.git" });
    expect((await repoState(folder, upstream)).reason).toBe("other-repo");
  });

  it("reports branch, last commit and uncommitted changes", async () => {
    const run: ToolRunner = async (_file, args) => {
      const command = args.slice(2).join(" ");
      if (command.startsWith("remote")) return { ok: true, out: "git@github.com:kairuioba/ein.git" };
      if (command.startsWith("rev-parse")) return { ok: true, out: "fix/chat" };
      if (command.startsWith("log")) return { ok: true, out: "abc1234\tfix: the chat scrolls" };
      return { ok: true, out: " M src/a.ts" };
    };
    expect(await repoState(folder, run)).toEqual({ ok: true, branch: "fix/chat", commit: "abc1234", subject: "fix: the chat scrolls", dirty: true });
  });
});

describe("builds", () => {
  it("only accepts plain ref names", () => {
    for (const good of ["main", "fix/chat-scroll", "v1.1.2", "backup/v1.1.3-dev.4"]) expect(validRef(good)).toBe(true);
    for (const bad of ["--help", "-f", "a..b", "x y", "$(rm)", ""]) expect(validRef(bad)).toBe(false);
  });

  it("always takes the workflow from main and builds the chosen ref on the chosen channel", () => {
    expect(releaseArgs("dev", "fix/chat")).toEqual([
      "workflow", "run", "release-ein.yml", "-R", "kairuioba/ein", "--ref", "main",
      "-f", "ref=fix/chat", "-f", "channel=dev", "-f", "windows=true",
    ]);
  });

  it("fits the maintenance handbook into a bot's description", () => {
    const handbook = maintenanceHandbook("/Users/me/Ein-src");
    expect(handbook.length).toBeLessThanOrEqual(BOT_PROFILE_LIMITS.description);
    expect(handbook).toContain("/Users/me/Ein-src");
    expect(handbook).toContain("channel=dev");
    expect(handbook).toContain("backup/v");
    expect(handbook).toContain("CuriosityOS/OpenMausBot");
  });
});
