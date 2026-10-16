// The "needs you" inbox: everything that is waiting on the owner right now,
// gathered from the conversations themselves so it can never disagree with
// what the chats show.
//
//   choice     an open options card (a bot's question with choices)
//   approval   an open approval card (a tool permission, a routine or skill
//              proposal, a peer hand-off), or a dispatch plan waiting to start
//   escalation a bot marked "waiting on you" with no card to show for it
//
// Provider asks live only as long as the process that raised them; a card
// left open by a previous run of the server can no longer be answered, so it
// is not listed (isLiveRequest decides).
import type { DispatchRun } from "../../shared/dispatch-types.ts";
import { allTranslations, t } from "../../shared/i18n.ts";
import type { InboxItem } from "../../shared/org-types.ts";
import { botThreads, clip, firstLine, groupThreads, type OrgBot, type OrgCard, type OrgGroup, type OrgMessage } from "./util.ts";

export interface InboxSource {
  bots: readonly OrgBot[];
  groups: readonly OrgGroup[];
  messages(threadId: string): readonly OrgMessage[];
  /** a provider ask raised by this process and not yet settled */
  isLiveRequest(threadId: string, requestId: string): boolean;
  runs: readonly DispatchRun[];
  /** the escalation rule (卡住多久往上报): a bot working without progress
   * moves up one level every `afterMin` minutes — its lead, the 主 Bot, then
   * you. Leave out to list no stuck bots. */
  escalation?: { afterMin: number; chiefId?: string; now?: number };
}

/** Who a stuck bot's problem goes to, in order: its department's lead, the
 * 主 Bot — whoever exists and is not the bot itself. */
export function escalationLadder(bot: OrgBot, bots: readonly OrgBot[], chiefId: string | undefined): string[] {
  const ladder: string[] = [];
  const section = (bot.section ?? "").trim();
  if (section && !bot.chiefOfStaff) {
    const lead = bots.find((other) => !other.hidden && other.chiefOfStaff && (other.section ?? "").trim() === section);
    if (lead && lead.id !== bot.id) ladder.push(lead.id);
  }
  if (chiefId && chiefId !== bot.id && !ladder.includes(chiefId)) ladder.push(chiefId);
  return ladder;
}

/** Bots working with no sign of progress whose problem has climbed past the
 * 主 Bot to you: one escalation each, with the path it took. */
export function stuckEscalations(source: InboxSource, listed: ReadonlySet<string>): InboxItem[] {
  const rule = source.escalation;
  if (!rule || !(rule.afterMin > 0)) return [];
  const now = rule.now ?? Date.now();
  const step = rule.afterMin * 60_000;
  const items: InboxItem[] = [];
  for (const bot of source.bots) {
    if (bot.hidden || listed.has(bot.id)) continue;
    const working = bot.activity === "working" || (bot.busy === true && bot.activity === undefined);
    if (!working) continue;
    const threads = [...botThreads(bot), ...source.groups.filter((group) => group.busyBotId === bot.id).flatMap((group) => groupThreads(group))];
    const lastAt = Math.max(0, ...threads.map((threadId) => source.messages(threadId).at(-1)?.at ?? 0));
    if (!lastAt) continue;
    const ladder = escalationLadder(bot, source.bots, rule.chiefId);
    // one level per step: the bot, then each rung, then you
    const levels = Math.floor((now - lastAt) / step);
    if (levels <= ladder.length) continue;
    const chain = [{ botId: bot.id, at: lastAt }, ...ladder.map((botId, index) => ({ botId, at: lastAt + (index + 1) * step }))];
    items.push({
      id: `stuck:${bot.id}`,
      kind: "escalation",
      title: t("{name} is stuck", { name: bot.name }),
      botId: bot.id,
      threadId: bot.threadId,
      since: lastAt + (ladder.length + 1) * step,
      detail: t("No progress for {minutes} min; nobody along the way could unblock it", { minutes: Math.floor((now - lastAt) / 60_000) }),
      chain,
    });
  }
  return items;
}

/** The first-run quiz every new bot opens with is not a decision. */
const ONBOARDING_TITLES = new Set(allTranslations("What do you mostly want help with?"));

/** Harness-owned asks that outlive a restart (or are cleaned up at boot). */
function durable(card: OrgCard): boolean {
  return Boolean(card.routineRequest || card.skillRequest || card.tool === "ask_bot" || card.tool === "delegate_bot");
}

function isApproval(card: OrgCard): boolean {
  return Boolean(card.requestId && (card.tool || card.routineRequest || card.skillRequest));
}

/** What a card asks, in one line: a provider question's text is its
 * subtitle (the title is the generic "Your bot has a question"). */
export function questionOf(card: Pick<OrgCard, "title" | "subtitle" | "requestId" | "tool">): string {
  const asked = card.requestId && !card.tool ? card.subtitle || card.title : card.title || card.subtitle;
  return clip(asked.replace(/\s+/g, " "), 200);
}

/** Can answering this card make a decision (决议)? Approvals cannot; the
 * onboarding quiz cannot; a card without choices cannot. */
export function isDecisionCard(card: OrgCard | undefined): card is OrgCard {
  if (!card || !card.options?.length) return false;
  if (isApproval(card)) return false;
  if (!card.requestId && ONBOARDING_TITLES.has(card.title)) return false;
  return true;
}

export function collectInbox(source: InboxSource): InboxItem[] {
  const items: InboxItem[] = [];
  const visible = source.bots.filter((bot) => !bot.hidden);
  const botIds = new Set(visible.map((bot) => bot.id));

  const scan = (threadId: string, owner: { botId?: string; groupId?: string }) => {
    for (const message of source.messages(threadId)) {
      const card = message.card;
      if (message.kind !== "options" || !card || card.answered || card.dismissed) continue;
      if (card.requestId && !durable(card) && !source.isLiveRequest(threadId, card.requestId)) continue;
      const botId = message.from?.botId ?? owner.botId;
      if (!botId || !botIds.has(botId)) continue;
      const base = {
        botId,
        threadId,
        ...(owner.groupId ? { groupId: owner.groupId } : {}),
        messageId: message.id,
        since: message.at,
        ...(card.rule ? { rule: card.rule } : {}),
      };
      if (isApproval(card)) {
        items.push({
          ...base,
          id: card.requestId!,
          kind: "approval",
          title: card.rule ? t("Needs your own approval (external)") : firstLine(card.title, 60) || t("Approval needed"),
          detail: clip(card.subtitle ?? "", 400),
          requestId: card.requestId,
        });
      } else if (card.requestId || isDecisionCard(card)) {
        // a question asked through a provider (answer with behavior "answer"),
        // or a choice card the harness put in the chat
        items.push({
          ...base,
          id: message.id,
          kind: "choice",
          title: questionOf(card),
          ...(card.requestId ? { requestId: card.requestId } : {}),
          ...(card.options.length ? { options: card.options.slice(0, 8) } : {}),
          ...(!card.requestId && card.subtitle ? { detail: clip(card.subtitle, 400) } : {}),
        });
      }
    }
  };

  for (const bot of visible) for (const threadId of botThreads(bot)) scan(threadId, { botId: bot.id });
  for (const group of source.groups) for (const threadId of groupThreads(group)) scan(threadId, { groupId: group.id });

  // a plan the dispatcher holds until the owner starts it
  for (const run of source.runs) {
    if (run.status !== "awaiting-approval" || !botIds.has(run.chiefBotId)) continue;
    items.push({
      id: `run:${run.id}`,
      kind: "approval",
      title: t("Start “{goal}”?", { goal: firstLine(run.goal, 40) }),
      botId: run.chiefBotId,
      threadId: run.sourceThreadId,
      since: run.createdAt,
      detail: run.subtasks.map((subtask) => subtask.title).join(" · ").slice(0, 400),
      runId: run.id,
    });
  }

  // a bot that says it is waiting on the owner, with nothing above to answer
  const listed = new Set(items.map((item) => item.botId));
  // a bot stuck long enough for its problem to climb all the way to you
  items.push(...stuckEscalations(source, listed));
  for (const bot of visible) {
    if (bot.activity !== "waiting-on-you" || listed.has(bot.id)) continue;
    const last = source.messages(bot.threadId).at(-1);
    const since = last?.at ?? Date.now();
    items.push({
      id: `bot:${bot.id}`,
      kind: "escalation",
      title: t("{name} is waiting for you", { name: bot.name }),
      botId: bot.id,
      threadId: bot.threadId,
      since,
      ...(last?.role === "bot" && last.text ? { detail: firstLine(last.text, 200) } : {}),
      chain: [{ botId: bot.id, at: since }],
    });
  }

  return items.sort((a, b) => a.since - b.since);
}
