// What an approval card shows about the action it asks for. The server hands
// the card a tool name and a summary of the call (a command, a path, or the
// call's arguments as JSON — cut at 200 characters, so often not valid JSON
// any more). This module turns that into a preview a person can judge: an
// email as a draft (recipients, subject, body), a social post with its
// account and text, a chat message with its channel, a command or a path.
import { t } from "@/lib/i18n";

export type ApprovalKind = "email" | "social" | "message" | "command" | "file" | "web" | "computer" | "generic";

export interface ApprovalPreview {
  kind: ApprovalKind;
  /** the service, e.g. "Gmail", "小红书", "Slack" — brand names stay as they are */
  platform?: string;
  account?: string;
  recipients?: string;
  subject?: string;
  body?: string;
  channel?: string;
  /** when a post is scheduled for, as the tool gave it */
  schedule?: string;
  tags?: string[];
  /** command / path / url, for the plain kinds */
  target?: string;
}

/** Post, mail and message tools publish outside the company: the org rule
 * "external publishing always needs you" applies to them. */
export function isExternalPublish(kind: ApprovalKind): boolean {
  return kind === "email" || kind === "social" || kind === "message";
}

const bare = (tool: string) => tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");

// Connected-app tools are named TOOLKIT_ACTION (GMAIL_SEND_EMAIL,
// SLACK_SENDS_A_MESSAGE …), so the service is matched at the start of the
// name and the action has to be one that sends — reading a mailbox is not a
// draft, and GITHUB_LIST_TEAMS is not a Teams message.
const PLATFORMS: Array<{ test: RegExp; kind: "email" | "social" | "message"; name: () => string }> = [
  { test: /^gmail/i, kind: "email", name: () => "Gmail" },
  { test: /^(outlook|office365|microsoft_outlook)/i, kind: "email", name: () => "Outlook" },
  { test: /^(xiaohongshu|rednote|xhs)/i, kind: "social", name: () => t("Xiaohongshu") },
  { test: /^weibo/i, kind: "social", name: () => t("Weibo") },
  { test: /^(twitter|x_)/i, kind: "social", name: () => "X" },
  { test: /^linkedin/i, kind: "social", name: () => "LinkedIn" },
  { test: /^facebook/i, kind: "social", name: () => "Facebook" },
  { test: /^instagram/i, kind: "social", name: () => "Instagram" },
  { test: /^threads/i, kind: "social", name: () => "Threads" },
  { test: /^reddit/i, kind: "social", name: () => "Reddit" },
  { test: /^(bluesky|bsky)/i, kind: "social", name: () => "Bluesky" },
  { test: /^mastodon/i, kind: "social", name: () => "Mastodon" },
  { test: /^(douyin|tiktok)/i, kind: "social", name: () => t("Douyin") },
  { test: /^slack/i, kind: "message", name: () => "Slack" },
  { test: /^discord/i, kind: "message", name: () => "Discord" },
  { test: /^telegram/i, kind: "message", name: () => "Telegram" },
  { test: /^whatsapp/i, kind: "message", name: () => "WhatsApp" },
  { test: /^(microsoft_)?teams/i, kind: "message", name: () => "Teams" },
  { test: /^(wechat|weixin|wecom)/i, kind: "message", name: () => t("WeChat") },
  { test: /^(feishu|lark)/i, kind: "message", name: () => t("Feishu") },
  { test: /^dingtalk/i, kind: "message", name: () => t("DingTalk") },
];

const SENDS: Record<"email" | "social" | "message", RegExp> = {
  email: /send|draft|reply|forward/i,
  social: /post|publish|create|tweet|share|upload|schedule|comment|note/i,
  message: /send|post|reply|message|chat/i,
};

const EMAIL_VERB = /(send|draft|reply|forward)_?e?mail|e?mail_?(send|draft|reply)/i;
const POST_VERB = /(create|publish|schedule)_?(social_?)?post|social_?post|tweet/i;
const MESSAGE_VERB = /(send|post)_?(a_?)?(message|dm|chat)/i;

const pick = (args: Record<string, string>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = args[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
};

const RECIPIENT_KEYS = ["to", "recipient_email", "recipient", "recipients", "to_email", "to_emails", "emails", "email", "send_to", "cc"];
const SUBJECT_KEYS = ["subject", "title", "topic"];
const BODY_KEYS = ["body", "message_body", "text", "content", "message", "html", "markdown", "caption", "commentary", "status", "post", "description"];
const ACCOUNT_KEYS = ["account", "account_name", "author", "username", "user_name", "handle", "page", "page_name", "profile", "from", "sender", "as_user"];
const CHANNEL_KEYS = ["channel", "channel_name", "channel_id", "chat", "chat_id", "room", "conversation", "to", "recipient", "user", "group"];
const SCHEDULE_KEYS = ["scheduled_at", "schedule", "schedule_time", "publish_at", "publish_time", "send_at", "time", "when"];

/** Pull string fields out of a call's arguments: real JSON when it parses,
 * else every complete `"key": "value"` (and a trailing value the 200-char
 * cut left open) — enough to preview a truncated email. */
export function parseArgs(detail: string): Record<string, string> {
  const text = detail.trim();
  if (!text.startsWith("{")) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
        else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
        else if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = value.join(", ");
      }
      return out;
    }
  } catch {
    // cut short — fall through to the lenient reader
  }
  const out: Record<string, string> = {};
  const pair = /"([\w-]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)("?)|(-?\d+(?:\.\d+)?|true|false)|\[\s*((?:"(?:[^"\\]|\\.)*"\s*,?\s*)*))/g;
  let match: RegExpExecArray | null;
  while ((match = pair.exec(text))) {
    const [, key, quoted, closed, scalar, list] = match;
    if (!key) continue;
    if (quoted !== undefined) out[key] = unescape(quoted) + (closed ? "" : "…");
    else if (scalar !== undefined) out[key] = scalar;
    else if (list !== undefined) {
      out[key] = [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => unescape(item[1] ?? "")).join(", ");
    }
  }
  return out;
}

function unescape(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\$/, "")}"`) as string;
  } catch {
    return value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

const stripHtml = (value: string) =>
  value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

const hashtags = (body: string | undefined) => [...new Set((body ?? "").match(/#[^\s#，。,.!！?？]+/g) ?? [])].slice(0, 6);

/** Classify the tool and read what a person needs to see before saying yes. */
export function approvalPreview(tool: string | undefined, detail: string, scope?: string): ApprovalPreview {
  const name = bare(tool ?? "");
  const args = parseArgs(detail);
  const service = PLATFORMS.find((entry) => entry.test.test(name));
  const platform = service && SENDS[service.kind].test(name.replace(service.test, "")) ? service : undefined;
  const kind: ApprovalKind | undefined =
    platform?.kind ??
    (service ? undefined : EMAIL_VERB.test(name) ? "email" : POST_VERB.test(name) ? "social" : MESSAGE_VERB.test(name) ? "message" : undefined);

  if (scope === "local-computer" || /^mcp__computer/i.test(tool ?? "") || /^(computer|computer_batch|screenshot|click|type_text|press_key|scroll)$/i.test(name)) {
    return { kind: "computer", target: detail };
  }

  if (kind === "email") {
    const body = pick(args, BODY_KEYS);
    return {
      kind: "email",
      platform: platform?.name(),
      recipients: pick(args, RECIPIENT_KEYS),
      subject: pick(args, SUBJECT_KEYS),
      body: body ? stripHtml(body) : Object.keys(args).length ? undefined : detail,
    };
  }

  if (kind === "social") {
    const body = pick(args, BODY_KEYS) ?? (Object.keys(args).length ? undefined : detail);
    return {
      kind: "social",
      platform: platform?.name(),
      account: pick(args, ACCOUNT_KEYS),
      schedule: pick(args, SCHEDULE_KEYS),
      body: body ? stripHtml(body) : undefined,
      tags: hashtags(body),
    };
  }

  if (kind === "message") {
    const body = pick(args, BODY_KEYS) ?? (Object.keys(args).length ? undefined : detail);
    return {
      kind: "message",
      platform: platform?.name(),
      channel: pick(args, CHANNEL_KEYS),
      body: body ? stripHtml(body) : undefined,
    };
  }

  if (/^(bash|shell|terminal|run_command|execute|exec)$/i.test(name) || /^bash\b|shell/i.test(name)) {
    return { kind: "command", target: args.command ?? detail };
  }
  if (/^(write|edit|multiedit|create_file|write_file|str_replace|apply_patch|notebookedit)$/i.test(name)) {
    return { kind: "file", target: args.file_path ?? args.path ?? args.filePath ?? detail };
  }
  if (/^(webfetch|web_fetch|fetch|open_url|navigate)$/i.test(name) || /^https?:\/\//.test(detail.trim())) {
    return { kind: "web", target: args.url ?? detail };
  }
  return { kind: "generic", target: detail };
}

/** The card's headline for a preview: "Post to Xiaohongshu", "Email draft ·
 * to 6 guests", "Run a command" … Undefined = fall back to "{name} wants to …". */
export function previewTitle(preview: ApprovalPreview): string | undefined {
  switch (preview.kind) {
    case "email":
      return preview.recipients
        ? t("Email draft · to {recipients}", { recipients: shorten(preview.recipients, 28) })
        : t("Email draft");
    case "social":
      return preview.platform ? t("Post to {platform}", { platform: preview.platform }) : t("Publish a post");
    case "message":
      return preview.platform
        ? t("Send a message on {platform}", { platform: preview.platform })
        : t("Send a message");
    case "command":
      return t("Run a command");
    case "file":
      return t("Change a file");
    case "web":
      return t("Open a web page");
    case "computer":
      return t("Use this computer");
    default:
      return undefined;
  }
}

function shorten(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}
