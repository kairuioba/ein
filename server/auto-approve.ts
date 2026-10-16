// Auto mode: when a bot may answer its own permission requests.
//
// Two ways in — the bot is in auto mode, or the user pressed "Always
// allow" for that one tool — and one way out: anything that reads as
// destructive stops and asks a human anyway, and so does anything that
// publishes outside (sends, posts, goes live): that one is the owner's.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

import { t } from "../shared/i18n.ts";

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

// Publishing outside: anything that sends, posts or goes live in the world —
// email, chat messages to people, social posts, releases and deploys. The
// company rule is that these always reach the owner (OrgRules
// .externalPublishNeedsOwner, fixed true): no auto mode, no "always allow",
// no reviewer may answer for them. Deliberately literal and biased towards
// asking; a false match costs one card, a miss sends something in the
// owner's name. Tool names and the request text are matched separately, so
// a bot grepping its code for `send_message` is not mistaken for one sending.
//
// The part of a Composio action slug that sends, posts or goes live:
// GMAIL_SEND_EMAIL, SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL,
// SLACK_CHAT_POST_MESSAGE, TWITTER_CREATION_OF_A_POST,
// LINKEDIN_CREATE_LINKED_IN_POST, NETLIFY_DEPLOY_SITE, … — but not
// REDDIT_GET_POST, TWITTER_GET_TWEETS or VERCEL_GET_DEPLOYMENT, which only read.
const SENDING_ACTION =
  "(?:(?:SENDS?|PUBLISH(?:ES)?|BROADCASTS?|RETWEETS?|FORWARD|REPLY|(?:RE)?DEPLOY)(?:_[A-Z0-9]+)*" +
  "|(?:POST|SCHEDULE)_(?:A_|AN_)?(?:MESSAGE|TWEET|STATUS|UPDATE|COMMENT|REPLY|PHOTO|VIDEO|STORY|TO)(?:_[A-Z0-9]+)*" +
  "|(?:CREATE|CREATION_OF|SUBMIT|ADD|NEW|TRIGGER)(?:_[A-Z0-9]+)*?_(?:POST|TWEET|STORY|REEL|CAMPAIGN|RELEASE|DEPLOYMENT|MESSAGE|COMMENT))";
const slugThatSends = (app: string) => `${app}(?:_[A-Z0-9]+)*?_${SENDING_ACTION}`;
const PUBLISHING_APPS =
  "(?:GMAIL|OUTLOOK|MICROSOFT_OUTLOOK|SLACK|SLACKBOT|DISCORD|DISCORDBOT|TELEGRAM|WHATSAPP|MICROSOFT_TEAMS|GOOGLECHAT|TWITTER|" +
  "LINKEDIN|FACEBOOK|INSTAGRAM|THREADS|REDDIT|YOUTUBE|TIKTOK|PINTEREST|MASTODON|BLUESKY|MEDIUM|WORDPRESS|GHOST|MAILCHIMP|" +
  "SENDGRID|MAILGUN|RESEND|POSTMARK|BREVO|TWILIO|HUBSPOT|INTERCOM|ZENDESK|FRESHDESK|LARK|FEISHU|DINGTALK|WECHAT|WECOM|WEIBO|" +
  "GITHUB|GITLAB|VERCEL|NETLIFY|RENDER|RAILWAY|HEROKU|CLOUDFLARE)";
const EXTERNAL_PUBLISH_TOOL = [
  // a Composio action as the tool itself (optionally behind an MCP prefix)
  new RegExp(`^(?:mcp__[\\w-]+__)?${slugThatSends("[A-Z][A-Z0-9]*")}$`),
  // snake_case tools from other MCP servers: send_email, post_message, publish_post, …
  /(?:^|[^a-z0-9])(?:send|post|publish|tweet|broadcast|reply|forward)_(?:an?_)?(?:e?mail|message|msg|dm|sms|text|tweet|post|status|newsletter|campaign|comment|reply|notification|invite|invitation)s?(?:$|[^a-z0-9])/i,
  /(?:^|[^a-z0-9])(?:post|publish|share)_(?:to_|on_)?(?:twitter|x|weibo|xiaohongshu|xhs|douyin|wechat|weixin|linkedin|facebook|instagram|reddit|threads|tiktok|bilibili|zhihu|mastodon|bluesky)(?:$|[^a-z0-9])/i,
  // publish / deploy tools: deploy, deploy_project, publish_site, vercel_deploy, create_deployment
  /(?:^|__)(?:publish|deploy)(?:_[a-z0-9]+)*$|_(?:publish|deploy)$|(?:^|__|_)(?:create|trigger|start)_deployment$/i,
];
const EXTERNAL_PUBLISH_TEXT = [
  // Composio actions inside COMPOSIO_MULTI_EXECUTE_TOOL's arguments: a
  // messaging, posting or hosting app's slug, or any quoted sending slug
  new RegExp(`\\b${slugThatSends(PUBLISHING_APPS)}\\b`),
  new RegExp(`["']${slugThatSends("[A-Z][A-Z0-9]*")}["']`),
  // command lines: mail senders, package and app releases, deploys
  /(?:^|[;&|(]\s*|\s)(?:sendmail|mailx|mutt|swaks|msmtp)\b/,
  /(?:^|[;&|(]\s*)mail\s+-s\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:npm\s+)?publish\b|\b(?:cargo|poetry|flit)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b|\bdocker\s+push\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|release)(?::[\w-]+)?\b/,
  /\b(?:vercel|netlify|firebase|flyctl|fly|wrangler|serverless|sls|amplify|eb|railway|cf|surge)\s+(?:[^|;&\n]*\s)?(?:deploy|publish|up|push|--prod)\b/,
  /\bgh\s+release\s+create\b|\bgit\s+push\s+(?:\S+\s+)*(?:heroku|dokku|production|prod|live)\b/,
  /\b(?:terraform|tofu)\s+apply\b|\bpulumi\s+up\b|\bkubectl\s+(?:apply|rollout\s+restart|set\s+image)\b|\bhelm\s+(?:upgrade|install)\b/,
  /\bfastlane\s+(?:deliver|pilot|supply|upload_to_app_store|upload_to_play_store)\b|\beas\s+submit\b|\baltool\s+--upload-app\b/,
  // raw HTTP to messaging and posting endpoints
  /hooks\.slack\.com\/|discord(?:app)?\.com\/api\/webhooks\/|api\.telegram\.org\/bot|oapi\.dingtalk\.com\/robot\/send|qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send|open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook/i,
  /api\.sendgrid\.com\/v3\/mail\/send|api\.mailgun\.net\/v3\/\S+\/messages|api\.resend\.com\/emails|api\.postmarkapp\.com\/email|api\.twilio\.com\/\S+\/Messages|api\.(?:twitter|x)\.com\/2\/tweets|graph\.facebook\.com\/\S+\/(?:feed|media_publish|photos|messages)|api\.linkedin\.com\/(?:v2\/ugcPosts|rest\/posts)/i,
];

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

export function looksSensitive(text: string): boolean {
  return matchFirst(SENSITIVE, text) !== null;
}

export function looksDestructive(text: string): boolean {
  return matchFirst(DESTRUCTIVE, text) !== null;
}

/** The external-publishing rule a request matches (tool name or request
 * text), or null. Such a request always goes to the owner. */
export function externalPublishRule(tool: string, summary: string): string | null {
  return matchFirst(EXTERNAL_PUBLISH_TOOL, tool) ?? matchFirst(EXTERNAL_PUBLISH_TEXT, summary);
}

export function looksExternalPublish(tool: string, summary: string): boolean {
  return externalPublishRule(tool, summary) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string {
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (!COMMAND_TOOLS.has(bare)) return scope ? `${scope}:${tool}` : tool;
  // first bare word of the command, skipping env assignments and sudo
  const words = summary.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  const program = (words[i] ?? "").split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
  const key = program ? `${tool}:${program}` : tool;
  return scope ? `${scope}:${key}` : key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all.
 * `external-publish` is the company rule that posting, emailing and going
 * live always reach the owner. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "external-publish"
  | "sensitive-guard"
  | "no-grant";

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
  },
): AutoVerdict {
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructive = matchFirst(DESTRUCTIVE, summary) ?? matchFirst(DESTRUCTIVE, tool);
  // publishing outside is the owner's call in every mode: no grant reaches it
  const external = destructive ? null : externalPublishRule(tool, summary);
  const sensitive = destructive || external ? null : matchFirst(SENSITIVE, summary);
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const grant =
    destructive || external || sensitive
      ? null
      : bot.alwaysAllow?.includes(key)
        ? { approve: t("auto-approved {key} (always allowed)", { key }), source: "always-allow" as const, rule: key }
        : bot.autoApprove
          ? { approve: t("auto-approved {tool}", { tool }), source: "auto-mode" as const, rule: undefined }
          : null;
  if (context?.unattended) {
    // Auto mode is something a person switched on for turns they are present
    // for. A webhook turn begins with nobody watching, on a payload someone
    // else wrote, so it does not inherit that decision — the guard above is a
    // pattern list its own comment calls "not a security boundary", and it
    // must not stand in for a human at 3am. A guard that would have carded
    // anyway keeps its own name; the block is only the story when it is the
    // thing that changed the outcome.
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (external) return { approve: null, source: "external-publish", rule: external };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && !bot.autoApprove) {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (external) return { approve: null, source: "external-publish", rule: external };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (external) return { approve: null, source: "external-publish", rule: external };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
