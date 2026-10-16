// A question with choices (design U8/U9 options card): the question, the
// choices as chips — a value in bold and its note in small type ("799 按渠道
// 报价和参数页") — and once answered the chosen chip in black with
// "You chose 799" (or "Decision #n · 799" when the org layer recorded it as a
// decision: it stamps the card's decisionId; what the decision produced comes
// from the decision log). Rooms pass onAnswer to route answers themselves.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { visibleMessages, type Message, type OptionCardData } from "@/state/store";
import { useDecisions } from "@/state/org-api";
import { cn } from "@/lib/cn";
import { msg, t, tn } from "@/lib/i18n";
import { isQuizCard } from "@/lib/onboarding-quiz";
import { ChatCard, MetaDot, RING, StatusPill, type StatusTone } from "./chat/primitives";
import { IconX } from "./chat/icons";
import { useOptionalStore } from "./chat/use-optional-store";

/** First-run quiz, not a live provider ask (those carry requestId) and not
 * an org question card (those are recorded as decisions). */
export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && decisionIdOf(message.card) === undefined && isQuizCard(message.card);
}

/** Hide the quiz once they have talked past it — picked an option, typed in
 * the composer, or dismissed it. Live asks are never this card. */
export function shouldHideOnboardingCard(message: Message, transcript: Message[]): boolean {
  if (!isOnboardingCard(message) || !message.card) return false;
  if (message.card.dismissed || message.card.answered) return true;
  const index = transcript.findIndex((entry) => entry.id === message.id);
  if (index < 0) return false;
  return transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

/** The decision number (决议 #n) the org layer stamped on an answered card. */
export function decisionIdOf(card: OptionCardData | undefined): number | undefined {
  const value = card?.decisionId;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A live question from the bot: the question itself is the subtitle, under
 * a generic title ("Your bot has a question") — the org layer's decision log
 * reads it the same way (server/org/inbox.ts questionOf). */
export function isLiveQuestion(card: Pick<OptionCardData, "subtitle" | "requestId" | "tool">): boolean {
  return Boolean(card.requestId && !card.tool && card.subtitle.trim());
}

const QUESTION_TITLE_LIMIT = 40;

/** A live question's text as the card shows it: its first sentence (or
 * short first line) as the title — "请你裁决：旗舰款首发价用哪个？" — and the
 * rest underneath. Null when even the first line is too long for a title;
 * the card then keeps its generic title and shows all of it as the body. */
export function questionParts(text: string): { title: string; body?: string } | null {
  const [first = "", ...more] = text.trim().split(/\n+/);
  const line = first.trim();
  if (!line) return null;
  const rest = more.join("\n").trim();
  // a sentence ends at ？ ? ！ ! 。 — not at an ASCII full stop, so "v2.1" stays whole
  const sentence = /^(.+?[？?！!。])\s*(.*)$/.exec(line);
  if (sentence && sentence[1]!.length <= QUESTION_TITLE_LIMIT) {
    const body = [sentence[2]!.trim(), rest].filter(Boolean).join("\n");
    return { title: sentence[1]!, ...(body ? { body } : {}) };
  }
  if (line.length <= QUESTION_TITLE_LIMIT) return { title: line, ...(rest ? { body: rest } : {}) };
  return null;
}

const CJK = /[㐀-鿿豈-﫿]/;

/** A choice the way the design draws it: "799 按渠道报价和参数页" is a value
 * ("799") and a note. Split only when the first word reads as a value — it
 * has a digit, or it is a Latin word ahead of Chinese prose ("Kimi 负责前端")
 * — so ordinary sentences ("Work & projects") stay whole. */
export function optionParts(option: string): { head: string; rest?: string } {
  const text = option.trim();
  const match = /^(\S{1,12})\s+(\S[\s\S]*)$/.exec(text);
  if (!match) return { head: text };
  const head = match[1]!.replace(/[,，:：;；、.。]+$/, "");
  const rest = match[2]!.trim();
  if (!head) return { head: text };
  if (/\d/.test(head) || (!CJK.test(head) && CJK.test(rest))) return { head, rest };
  return { head: text };
}

const PILL_CHOICE_LIMIT = 16;
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

/** How a card was settled. `answered` carries the choice, or a word the
 * harness writes when nobody chose: "expired" (unattended too long),
 * "unavailable" (the ask closed before an answer could reach it), "deny"
 * (dismissed) — or a bare "answer" when the reply text was not kept. An
 * option that happens to be one of those words is still a choice. */
export type CardOutcome =
  | { kind: "open" }
  | { kind: "choice"; choice: string }
  | { kind: "void"; reason: "expired" | "unavailable" | "deny" }
  | { kind: "answered" };

export function cardOutcome(card: Pick<OptionCardData, "answered" | "options">): CardOutcome {
  const answered = card.answered;
  if (!answered) return { kind: "open" };
  if (card.options.includes(answered)) return { kind: "choice", choice: answered };
  if (answered === "expired" || answered === "unavailable" || answered === "deny") return { kind: "void", reason: answered };
  if (answered === "answer") return { kind: "answered" };
  return { kind: "choice", choice: answered };
}

const VOID_LABEL = {
  expired: msg("Voided"),
  unavailable: msg("Closed"),
  deny: msg("Dismissed"),
} as const;

/** The pill an options card wears: the decision and choice once answered
 * (just the value of a "value + note" choice, as the design does), a quiet
 * grey word when nobody chose, else waiting on you. */
export function optionCardStatus(
  card: OptionCardData,
  options: { showDecision?: boolean } = {},
): { tone: StatusTone; label: string; title?: string } {
  const outcome = cardOutcome(card);
  if (outcome.kind === "void") return { tone: "grey", label: t(VOID_LABEL[outcome.reason]) };
  if (outcome.kind === "answered") return { tone: "green", label: t("Answered") };
  if (outcome.kind === "choice") {
    const decision = options.showDecision === false ? undefined : decisionIdOf(card);
    const parts = optionParts(outcome.choice);
    const choice = parts.rest ? parts.head : clip(outcome.choice, PILL_CHOICE_LIMIT);
    const title = choice === outcome.choice ? undefined : outcome.choice;
    return decision !== undefined
      ? { tone: "green", label: t("Decision #{id} · {choice}", { id: decision, choice }), title }
      : { tone: "green", label: t("You chose {choice}", { choice }), title };
  }
  return { tone: "amber", label: t("Your call") };
}

/** How long a click waits for the answer to land before the card unlocks. */
const ANSWER_GRACE_MS = 10_000;

export function OptionCard({
  botId,
  message,
  onAnswer,
  showDecision = true,
}: {
  botId: string;
  message: Message;
  /** Route an answer yourself (rooms). Absent: the 1:1 default — answer the
   * live ask, or post the choice to this bot's chat. */
  onAnswer?: (answer: string) => void;
  /** Name the recorded decision ("Decision #3 · 799") and what it set going.
   * A room that draws the decision card right below passes false and gets
   * the U9 "You chose 799". */
  showDecision?: boolean;
}) {
  // without the app's store (a static render) the card still shows what was
  // asked and answered; only the default answer path needs it
  const store = useOptionalStore();
  const [custom, setCustom] = useState("");
  // the choice just sent, shown as chosen until the card itself says so; if
  // nothing lands (a failed send) the card unlocks again
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(null), ANSWER_GRACE_MS);
    return () => clearTimeout(timer);
  }, [sent]);
  const card = message.card;
  const bot = store?.state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  // Full thread, not the mounted window: a search-focus slice can omit the
  // later user message that means they already talked past this quiz.
  if (!card || shouldHideOnboardingCard(message, transcript)) return null;

  const outcome = cardOutcome(card);
  const expired = outcome.kind === "void" && outcome.reason === "expired";
  // the option drawn as chosen: what was picked, else what was just sent
  const answered = outcome.kind === "choice" ? outcome.choice : outcome.kind === "open" ? (sent ?? undefined) : undefined;
  const settled = outcome.kind !== "open" || Boolean(sent);
  const answer = (text: string) => {
    const value = text.trim();
    if (!value || settled || (!onAnswer && !store)) return;
    setSent(value);
    if (onAnswer) onAnswer(value);
    else store?.dispatch({ type: "answerCard", botId, messageId: message.id, answer: value });
  };
  const decision = showDecision ? decisionIdOf(card) : undefined;
  const status = optionCardStatus(card.answered || !sent ? card : { ...card, answered: sent }, { showDecision });
  // a live question's own title is generic ("Your bot has a question"): the
  // question leads instead, and the meta says who asks
  const liveQuestion = isLiveQuestion(card);
  const parts = liveQuestion ? questionParts(card.subtitle) : null;
  const heading = parts?.title ?? card.title;
  const question = liveQuestion ? (parts ? parts.body : card.subtitle.trim()) : undefined;
  const asker = message.from?.name ?? bot?.name;
  const subtitle = liveQuestion ? (asker ? t("Asked by {name}", { name: asker }) : undefined) : card.subtitle;

  return (
    <ChatCard
      label={liveQuestion ? card.subtitle.trim() : card.title}
      title={heading}
      live
      pill={
        <span className="flex items-center gap-1.5">
          <StatusPill tone={status.tone} title={status.title}>
            {status.label}
          </StatusPill>
          {isOnboardingCard(message) && !settled && store && (
            <button
              type="button"
              onClick={() => store.dispatch({ type: "dismissCard", botId, messageId: message.id })}
              aria-label={t("Dismiss")}
              title={t("Dismiss")}
              className="grid size-6 place-items-center rounded-md text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              <IconX size={13} />
            </button>
          )}
        </span>
      }
      meta={
        expired ? (
          <span>{t("Nobody answered in time while unattended")}</span>
        ) : subtitle || decision !== undefined ? (
          <>
            {subtitle && <span>{subtitle}</span>}
            {decision !== undefined && <DecisionMeta id={decision} separated={Boolean(subtitle)} />}
          </>
        ) : undefined
      }
    >
      {question && <p className="text-[13.5px] leading-[1.6] whitespace-pre-wrap break-words text-ink">{question}</p>}
      {card.options.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-2" role="group" aria-label={heading}>
          {card.options.map((option) => {
            const chosen = answered === option;
            const parts = optionParts(option);
            return (
              <button
                key={option}
                type="button"
                disabled={settled}
                aria-pressed={chosen}
                onClick={() => answer(option)}
                className={cn(
                  "inline-flex min-h-8 max-w-full items-center gap-[7px] rounded-[10px] px-3 py-1 text-left transition-colors",
                  chosen
                    ? "bg-primary text-primary-ink"
                    : cn("bg-raised text-ink-secondary", RING, !settled && "hover:bg-raised-hover"),
                )}
              >
                {chosen && <Check size={13} strokeWidth={2.6} className="shrink-0" />}
                {parts.rest ? (
                  <>
                    <b className={cn("shrink-0 text-[14px] font-bold", chosen ? "text-primary-ink" : "text-ink")}>{parts.head}</b>
                    <span className={cn("min-w-0 break-words text-[12px]", chosen && "text-primary-ink/65")}>{parts.rest}</span>
                  </>
                ) : (
                  <span className={cn("min-w-0 break-words text-[13px] font-semibold", chosen ? "text-primary-ink" : "text-ink")}>
                    {parts.head}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!settled && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && answer(custom)}
          placeholder={t("Type your own answer")}
          className={cn(
            "mt-1 w-full rounded-[10px] bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary/70 focus:outline-none",
            RING,
          )}
        />
      )}
    </ChatCard>
  );
}

/** What a recorded decision set going, from the org layer's decision log:
 * "3 action items sent out · 1 done". Nothing while the log is loading. */
function DecisionMeta({ id, separated }: { id: number; separated: boolean }) {
  const { data } = useDecisions();
  const decision = data.decisions.find((entry) => entry.id === id);
  if (!decision) return null;
  const items = decision.actionItems.length;
  const done = decision.actionItems.filter((item) => item.status === "done").length;
  return (
    <>
      {separated && <MetaDot />}
      <span>
        {items > 0
          ? tn(items, "{count} action item sent out", "{count} action items sent out")
          : t("Recorded as decision #{id}", { id })}
      </span>
      {done > 0 && (
        <>
          <MetaDot />
          <span>{t("{count} done", { count: done })}</span>
        </>
      )}
    </>
  );
}
