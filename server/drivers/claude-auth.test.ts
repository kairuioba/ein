// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import { claudeLogin, claudeLoginProblem, claudeSignedIn } from "./claude.ts";

type Run = typeof import("../procs.ts").execCli;

/** A runner that answers `auth status --json` and `--text` like the real CLI. */
function cliAnswering(json: Record<string, unknown> | string, text = ""): Run {
  return ((_cli, args, _options, callback) => {
    if (args.includes("--text")) return callback(null, `${text}\n`);
    callback(null, typeof json === "string" ? json : JSON.stringify(json));
  }) as Run;
}

describe("claudeSignedIn", () => {
  it("uses the CLI's machine-readable auth status", async () => {
    const run = ((cli, args, options, callback) => {
      expect(cli).toBe("claude-custom");
      expect(args).toEqual(["auth", "status", "--json"]);
      expect(options).toMatchObject({ timeout: 8000, env: { PATH: "/custom/bin" } });
      callback(null, '{"loggedIn":true}');
    }) satisfies Run;

    expect(await claudeSignedIn("claude-custom", { PATH: "/custom/bin" }, run)).toBe(true);
  });

  it("uses loggedIn:false even though the real CLI exits with code 1", async () => {
    const run = ((_cli, _args, _options, callback) => {
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies Run;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
  });

  it("fails closed when the command has no valid status", async () => {
    const failed = ((_cli, _args, _options, callback) => {
      callback(new Error("auth status unavailable"), "");
    }) satisfies Run;
    const malformed = ((_cli, _args, _options, callback) => {
      callback(null, "not json");
    }) satisfies Run;

    expect(await claudeSignedIn("claude", {}, failed)).toBe(false);
    expect(await claudeSignedIn("claude", {}, malformed)).toBe(false);
  });
});

// Regression: Claude showed as signed in — and ran turns, billed per use —
// on whatever credential Claude Code had (a Console account, a key or a relay
// token in ~/.claude/settings.json), without the user ever signing in to
// their own subscription.
describe("claudeLogin", () => {
  it("accepts the claude.ai subscription sign-in", async () => {
    const login = await claudeLogin("claude", {}, cliAnswering({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
    expect(login).toEqual({ checked: true, loggedIn: true, subscription: true });
    expect(claudeLoginProblem(login)).toBeUndefined();
  });

  it("accepts the subscription token `claude setup-token` creates", async () => {
    const run = cliAnswering({ loggedIn: true, authMethod: "oauth_token" }, "Auth token: CLAUDE_CODE_OAUTH_TOKEN");
    expect(await claudeLogin("claude", {}, run)).toEqual({ checked: true, loggedIn: true, subscription: true });
  });

  it("refuses a gateway token from Claude Code's settings and says where it comes from", async () => {
    const run = cliAnswering({ loggedIn: true, authMethod: "oauth_token" }, "Auth token: ANTHROPIC_AUTH_TOKEN");
    const login = await claudeLogin("claude", {}, run);
    expect(login).toEqual({ checked: true, loggedIn: true, subscription: false, otherLogin: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" } });
    expect(claudeLoginProblem(login)).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(claudeLoginProblem(login)).toContain("settings.json");
  });

  it("refuses a Console account's managed API key", async () => {
    const run = cliAnswering({ loggedIn: true, authMethod: "api_key", apiKeySource: "/login managed key" });
    const login = await claudeLogin("claude", {}, run);
    expect(login.subscription).toBe(false);
    expect(login.otherLogin).toEqual({ kind: "console", name: "/login managed key" });
    expect(claudeLoginProblem(login)).toContain("Console");
  });

  it("refuses an API key, an apiKeyHelper and a cloud provider", async () => {
    const key = await claudeLogin("claude", {}, cliAnswering({ loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }));
    expect(key.otherLogin).toEqual({ kind: "env", name: "ANTHROPIC_API_KEY" });
    const helper = await claudeLogin("claude", {}, cliAnswering({ loggedIn: true, authMethod: "api_key_helper" }));
    expect(helper.otherLogin?.kind).toBe("helper");
    const bedrock = await claudeLogin("claude", {}, cliAnswering({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }));
    expect(bedrock.otherLogin).toEqual({ kind: "cloud", name: "Bedrock" });
    for (const login of [key, helper, bedrock]) {
      expect(login.subscription).toBe(false);
      expect(claudeLoginProblem(login)).toMatch(/subscription/);
    }
  });

  it("has nothing to explain when the CLI is simply signed out", async () => {
    const login = await claudeLogin("claude", {}, cliAnswering({ loggedIn: false, authMethod: "none" }));
    expect(login).toEqual({ checked: true, loggedIn: false, subscription: false });
    expect(claudeLoginProblem(login)).toBeUndefined();
  });

  it("lets a test rig opt in to any login", async () => {
    const run = cliAnswering({ loggedIn: true, authMethod: "oauth_token" }, "Auth token: SANDBOX_TOKEN_FILE");
    expect((await claudeLogin("claude", { EIN_CLAUDE_ACCEPT_ANY_LOGIN: "1" }, run)).subscription).toBe(true);
    expect((await claudeLogin("claude", {}, run)).subscription).toBe(false);
  });
});
