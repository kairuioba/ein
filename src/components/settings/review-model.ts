// Settings › Auto-review: the rules that decide whether a bot's action runs on
// its own or waits for you, gathered from where they actually live — the org
// rules (owner-set), the harness's built-in backstops (server/auto-approve.ts)
// and each bot's own permissions. "Ask first" always beats "approve".
import type { OrgRules } from "../../../shared/org-types";
import { msg, t } from "@/lib/i18n";

export interface ReviewBot {
  id: string;
  name: string;
  hidden?: boolean;
  autoApprove?: boolean;
  autoReview?: "off" | "shadow" | "enforce";
  approvePeerComms?: boolean;
  alwaysAllow?: string[];
}

export type RuleSource = "owner" | "builtin" | "bot" | "org";

export interface ReviewRule {
  id: string;
  kind: "ask" | "allow";
  /** English source; shown through t() with `params` */
  title: string;
  detail: string;
  params?: Record<string, string | number>;
  source: RuleSource;
  /** owner-set or built in: no bot can change it */
  locked: boolean;
  /** bots it applies to; undefined = everyone */
  botIds?: string[];
}

const visible = <B extends ReviewBot>(bots: readonly B[]) => bots.filter((bot) => !bot.hidden);

/** Every rule, ask-first rules before approvals. */
export function reviewRules<B extends ReviewBot>(bots: readonly B[], rules: OrgRules): ReviewRule[] {
  const team = visible(bots);
  const out: ReviewRule[] = [
    {
      id: "external-publish",
      kind: "ask",
      title: msg("Publishing outside always needs you"),
      detail: msg("Posts, emails and going live; unattended, an approval nobody answers in {minutes} minutes is voided and never runs"),
      params: { minutes: rules.unattendedExpiryMin },
      source: "owner",
      locked: true,
    },
    {
      id: "over-budget",
      kind: "ask",
      title: msg("Anything over the budget line asks you first"),
      detail: msg("The company's line is ¥{budget} a day; inside it the Chief acts and tells you afterwards"),
      params: { budget: rules.budgetPerDay },
      source: "org",
      locked: false,
    },
    {
      id: "destructive",
      kind: "ask",
      title: msg("Destructive commands stop and ask"),
      detail: msg("Deleting files recursively, force-pushing, dropping tables, shutting down — even in auto mode"),
      source: "builtin",
      locked: true,
    },
    {
      id: "secrets",
      kind: "ask",
      title: msg("Reading keys and credentials stops and asks"),
      detail: msg(".env files, SSH keys, cloud credentials and the keychain — even in auto mode"),
      source: "builtin",
      locked: true,
    },
  ];
  const peers = team.filter((bot) => bot.approvePeerComms);
  if (peers.length) {
    out.push({
      id: "peer-comms",
      kind: "ask",
      title: msg("Ask before contacting other bots"),
      detail: msg("Switched on for {names}"),
      params: { names: listNames(peers) },
      source: "bot",
      locked: false,
      botIds: peers.map((bot) => bot.id),
    });
  }
  const manual = team.filter((bot) => !bot.autoApprove);
  if (manual.length) {
    out.push({
      id: "manual",
      kind: "ask",
      title: msg("Every action waits for you"),
      detail: msg("Auto mode is off for {names}"),
      params: { names: listNames(manual) },
      source: "bot",
      locked: false,
      botIds: manual.map((bot) => bot.id),
    });
  }
  const auto = team.filter((bot) => bot.autoApprove);
  if (auto.length) {
    out.push({
      id: "auto-mode",
      kind: "allow",
      title: msg("Low-risk actions run without waiting"),
      detail: msg("Auto mode is on for {names}"),
      params: { names: listNames(auto) },
      source: "bot",
      locked: false,
      botIds: auto.map((bot) => bot.id),
    });
  }
  const reviewed = team.filter((bot) => bot.autoReview === "enforce" || bot.autoReview === "shadow");
  if (reviewed.length) {
    out.push({
      id: "auto-review",
      kind: "allow",
      title: msg("A second look answers routine approvals"),
      detail: msg("The bot's own engine reviews ordinary approval cards for {names}"),
      params: { names: listNames(reviewed) },
      source: "bot",
      locked: false,
      botIds: reviewed.map((bot) => bot.id),
    });
  }
  const grants = team.flatMap((bot) => (bot.alwaysAllow ?? []).map((key) => ({ bot, key })));
  if (grants.length) {
    out.push({
      id: "always-allow",
      kind: "allow",
      title: msg("Tools you said to always allow"),
      detail: msg("{count} remembered grants, such as {example}"),
      params: { count: grants.length, example: `${grants[0]!.bot.name} · ${grants[0]!.key}` },
      source: "bot",
      locked: false,
      botIds: [...new Set(grants.map((grant) => grant.bot.id))],
    });
  }
  const chief = rules.chiefMay;
  const powers = [chief.addPeople && "add-people", chief.newSpecialist && "new-specialist", chief.switchModel && "switch-model"].filter(Boolean) as string[];
  if (powers.length) {
    out.push({
      id: "chief-within-budget",
      kind: "allow",
      title: msg("Inside the budget line the Chief acts on its own"),
      detail: msg("{count} of 3 powers on: adding people, new specialists, switching models"),
      params: { count: powers.length },
      source: "org",
      locked: false,
    });
  }
  return out;
}

export function reviewCounts(rules: readonly ReviewRule[]): { ask: number; allow: number; locked: number } {
  return {
    ask: rules.filter((rule) => rule.kind === "ask").length,
    allow: rules.filter((rule) => rule.kind === "allow").length,
    locked: rules.filter((rule) => rule.locked).length,
  };
}

function listNames(bots: ReadonlyArray<{ name: string }>, max = 3): string {
  const names = bots.slice(0, max).map((bot) => bot.name);
  return bots.length > max ? `${names.join(t(", "))} +${bots.length - max}` : names.join(t(", "));
}
