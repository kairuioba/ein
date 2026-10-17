// The Claude API engine: the SAME Claude driver, configured with
// `auth: "apiKey"`.
//
// Why an auth mode and a second instance instead of a second driver: it is
// the same Claude Code CLI, the same stream-json turn protocol, the same
// tools/MCP surface and the same model menu (claude-models.ts). The only
// difference is who pays — a claude.ai subscription sign-in, or the user's
// own Anthropic API key billed per use. Keeping one driver means every fix
// to the turn path lands on both engines.
//
// Credential contract, deliberately narrow:
//   - the key is a workspace secret (config.claudeApi.key, OS-encrypted by
//     the desktop shell, write-only over the API) delivered to the server as
//     EIN_CLAUDE_API_KEY and, by config.injectedEnvironment, to the
//     API-key instance's `environment` — and to no other instance;
//   - the driver builds the CLI child's ANTHROPIC_API_KEY from that
//     environment alone. It never reads a shell ANTHROPIC_API_KEY, the
//     CLI's own login (`auth status`), ~/.claude/settings.json, or any other
//     key already on the machine: "some key exists here" is not consent to
//     spend it. An API-key engine without a saved key just says so.
import { t } from "../../shared/i18n.ts";
import type { CredentialTargetId } from "../../shared/credential-request.ts";

/** How this Claude instance is paid for. */
export type ClaudeAuthMode = "subscription" | "apiKey";

/** The API-key mode's value in the instance config (`auth`). */
export const CLAUDE_API_AUTH = "apiKey" satisfies ClaudeAuthMode;

/** Workspace credential env the desktop shell injects at boot (see
 * electron/workspace-credentials.mjs). Ein-owned on purpose: ANTHROPIC_API_KEY
 * could be inherited from anywhere and must never imply consent. */
export const CLAUDE_API_KEY_ENV = "EIN_CLAUDE_API_KEY";

/** The write-only credential target the settings card saves through. */
export const CLAUDE_API_CREDENTIAL_TARGET: CredentialTargetId = "claudeApiKey";

/** Instance id (and picker name) of the default-fleet API-key engine. */
export const CLAUDE_API_INSTANCE_ID = "claudeApi";
export const CLAUDE_API_DISPLAY_NAME = "Claude API";

/** Validate the optional `auth` field; undefined means the subscription
 * engine (the historical behavior, so saved configs keep working). */
export function decodeClaudeAuth(value: unknown): ClaudeAuthMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "subscription" && value !== "apiKey") {
    throw new Error(t("claude: invalid auth {value}", { value: JSON.stringify(value) }));
  }
  return value;
}

/** The user-saved API key for this instance. Only the instance environment
 * config.injectedEnvironment built from the stored secret is consulted —
 * never process.env, whose ANTHROPIC_API_KEY belongs to whoever launched Ein. */
export function claudeApiKeyFrom(environment: Record<string, string | undefined>): string {
  const key = environment[CLAUDE_API_KEY_ENV];
  return typeof key === "string" ? key.trim() : "";
}
