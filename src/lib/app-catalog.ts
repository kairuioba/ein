// Client-side shape for the connected-apps screens (U13): categories and the
// recommended list over whatever catalog /api/connectors/catalog returns, the
// neutral monogram tile each app gets (never a logo), who may use an app, and
// when a bot last used it.
import { msg } from "@/lib/i18n";
import type { OrgConfig } from "../../shared/org-types";

export type AppCategory = "collab" | "data" | "design" | "support" | "finance" | "dev" | "calendar";

export const CATEGORY_LABEL: Record<AppCategory, string> = {
  collab: msg("Office & collaboration"),
  data: msg("Data & analytics"),
  design: msg("Design"),
  support: msg("Customer service"),
  finance: msg("Finance & legal"),
  dev: msg("Development"),
  calendar: msg("Scheduling"),
};
export const CATEGORY_ORDER: AppCategory[] = ["collab", "data", "design", "support", "finance", "dev", "calendar"];

const CATEGORY: Record<string, AppCategory> = {
  lark: "collab", feishu: "collab", dingtalk: "collab", wecom: "support", tencentdocs: "collab", yuque: "collab",
  slack: "collab", gmail: "collab", googledocs: "collab", googledrive: "collab", notion: "collab", discord: "collab",
  zapier: "collab", asana: "collab", trello: "collab", dropbox: "collab", outlook: "collab", microsoftteams: "collab",
  onedrive: "collab", box: "collab", clickup: "collab", monday: "collab", confluence: "collab", coda: "collab",
  googlesheets: "data", posthog: "data", airtable: "data", googleanalytics: "data", mixpanel: "data", amplitude: "data",
  metabase: "data", tableau: "data", snowflake: "data", bigquery: "data", supabase: "data", excel: "data",
  figma: "design", canva: "design", miro: "design", webflow: "design", framer: "design",
  hubspot: "support", salesforce: "support", intercom: "support", zendesk: "support", freshdesk: "support",
  x: "support", twitter: "support", reddit: "support", linkedin: "support", instagram: "support", youtube: "support",
  stripe: "finance", quickbooks: "finance", xero: "finance", docusign: "finance", paypal: "finance", shopify: "finance",
  github: "dev", gitlab: "dev", bitbucket: "dev", linear: "dev", sentry: "dev", jira: "dev", vercel: "dev",
  netlify: "dev", cloudflare: "dev", datadog: "dev", pagerduty: "dev",
  googlecalendar: "calendar", calendly: "calendar", zoom: "calendar", googlemeet: "calendar", cal: "calendar",
};

/** What teams here reach for first; only entries the catalog has are shown. */
export const RECOMMENDED = [
  "lark", "feishu", "dingtalk", "wecom", "tencentdocs", "yuque",
  "notion", "github", "figma", "slack", "googledocs", "googlesheets", "linear", "gmail", "googlecalendar",
];

export function categoryOf(slug: string): AppCategory | undefined {
  return CATEGORY[slug.toLowerCase()];
}

export function recommendedSlugs<T extends { slug: string }>(cards: readonly T[], max = 8): T[] {
  const bySlug = new Map(cards.map((card) => [card.slug.toLowerCase(), card]));
  return RECOMMENDED.flatMap((slug) => bySlug.get(slug) ?? []).slice(0, max);
}

// ── monogram tiles ────────────────────────────────────────────────────────────
const TONES = [
  { bg: "#E7EEFF", fg: "#2F55D4" },
  { bg: "#E0F2FE", fg: "#0369A1" },
  { bg: "#E6F6EC", fg: "#15803D" },
  { bg: "#ECEBFF", fg: "#4338CA" },
  { bg: "#DDF4F0", fg: "#0F766E" },
  { bg: "#EEEFF2", fg: "#2A2D34" },
  { bg: "#FCE7F3", fg: "#BE185D" },
  { bg: "#FFE4E6", fg: "#BE123C" },
  { bg: "#FFF1DB", fg: "#B45309" },
  { bg: "#F1E8FF", fg: "#7E22CE" },
] as const;

/** One character on a soft colour, stable per app: the first CJK character,
 * else the first letter. Never a logo. */
export function monogram(label: string, slug = label): { char: string; bg: string; fg: string } {
  const trimmed = label.trim();
  const cjk = trimmed.match(/[㐀-鿿]/)?.[0];
  const latin = trimmed.match(/[A-Za-z0-9]/)?.[0];
  const char = cjk ?? (latin ? latin.toUpperCase() : trimmed.slice(0, 1) || "?");
  let hash = 0;
  for (const ch of slug.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return { char, ...TONES[hash % TONES.length]! };
}

// ── who may use an app, and when it was last used ─────────────────────────────
type BotShape = { id: string; hidden?: boolean; composio?: boolean; section?: string };

/** Bots that may call an app: connected apps are on for a bot unless switched
 * off for it, and a department can narrow them to its own allow-list. */
export function botsAllowedApp<B extends BotShape>(slug: string, bots: readonly B[], org: Pick<OrgConfig, "departments"> | null | undefined): B[] {
  const allow = new Map((org?.departments ?? []).map((department) => [department.section.trim(), department.allowedApps]));
  return bots.filter((bot) => {
    if (bot.hidden || bot.composio === false) return false;
    const list = allow.get(bot.section?.trim() ?? "");
    return !list || list.map((entry) => entry.toLowerCase()).includes(slug.toLowerCase());
  });
}

type MessageShape = { at: number; kind: string; tool?: { name: string; spoken?: string } };

/** The newest tool call that names this app (Composio tools carry the toolkit
 * in their name, e.g. GITHUB_CREATE_ISSUE). */
export function lastAppUse(
  slug: string,
  bots: ReadonlyArray<{ id: string; messages: readonly MessageShape[] }>,
): { botId: string; at: number; tool: string } | null {
  const needle = slug.toLowerCase();
  let best: { botId: string; at: number; tool: string } | null = null;
  for (const bot of bots) {
    for (const message of bot.messages) {
      if (message.kind !== "activity" || !message.tool) continue;
      const name = message.tool.name.toLowerCase();
      if (!name.includes(needle)) continue;
      if (!best || message.at > best.at) best = { botId: bot.id, at: message.at, tool: message.tool.name };
    }
  }
  return best;
}
