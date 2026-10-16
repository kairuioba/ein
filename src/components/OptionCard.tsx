// A question with choices (design U8/U9 options card): the question, the
// choices as buttons, and once answered the choice — as "Decision #n" when
// the org layer recorded it as a decision (it stamps the card's decisionId;
// what the decision produced comes from the decision log).
import { useState } from "react";
import { Check } from "lucide-react";
import { useStore, visibleMessages, type Message, type OptionCardData } from "@/state/store";
import { useDecisions } from "@/state/org-api";
import { cn } from "@/lib/cn";
import { allTranslations, t, tn } from "@/lib/i18n";
import { ChatCard, MetaDot, RING, StatusPill, type StatusTone } from "./chat/primitives";
import { IconX } from "./chat/icons";

/** The first-run quiz the harness posts under a new bot's greeting (see
 * server/store.ts onboardingCard), in whichever language it was written. */
const QUIZ_TITLES = new Set(allTranslations("What do you mostly want help with?"));

/** First-run quiz, not a live provider ask (those carry requestId) and not
 * an org question card (those are recorded as decisions). */
export function isOnboardingCard(message: Message): boolean {
  return (
    message.kind === "options" &&
    !!message.card &&
    !message.card.requestId &&
    decisionIdOf(message.card) === undefined &&
    QUIZ_TITLES.has(message.card.title)
  );
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

const PILL_CHOICE_LIMIT = 16;
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

/** The pill an options card wears: voided when nobody answered in time while
 * unattended, the decision and choice once answered, else waiting on you. */
export function optionCardStatus(card: OptionCardData): { tone: StatusTone; label: string; title?: string } {
  if (card.answered === "expired") return { tone: "grey", label: t("Voided") };
  if (card.answered) {
    const decision = decisionIdOf(card);
    const choice = clip(card.answered, PILL_CHOICE_LIMIT);
    const title = choice === card.answered ? undefined : card.answered;
    return decision !== undefined
      ? { tone: "green", label: t("Decision #{id} · {choice}", { id: decision, choice }), title }
      : { tone: "green", label: t("You chose {choice}", { choice }), title };
  }
  return { tone: "amber", label: t("Your call") };
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  // Full thread, not the mounted window: a search-focus slice can omit the
  // later user message that means they already talked past this quiz.
  if (!card || shouldHideOnboardingCard(message, transcript)) return null;

  const expired = card.answered === "expired";
  const answered = expired ? undefined : card.answered;
  const settled = Boolean(card.answered);
  const answer = (text: string) => {
    if (!text.trim() || settled) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };
  const decision = decisionIdOf(card);
  const status = optionCardStatus(card);
  // a live question is read as the card's body, and the meta says who asks
  const question = isLiveQuestion(card) ? card.subtitle.trim() : undefined;
  const asker = message.from?.name ?? bot?.name;
  const subtitle = question ? (asker ? t("Asked by {name}", { name: asker }) : undefined) : card.subtitle;

  return (
    <ChatCard
      label={question ?? card.title}
      title={card.title}
      live
      pill={
        <span className="flex items-center gap-1.5">
          <StatusPill tone={status.tone} title={status.title}>
            {status.label}
          </StatusPill>
          {isOnboardingCard(message) && !settled && (
            <button
              type="button"
              onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
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
        <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label={question ?? card.title}>
          {card.options.map((option) => {
            const chosen = answered === option;
            return (
              <button
                key={option}
                type="button"
                disabled={settled}
                aria-pressed={chosen}
                onClick={() => answer(option)}
                className={cn(
                  "inline-flex min-h-[34px] max-w-full items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-left text-[13px] font-semibold transition-colors",
                  chosen
                    ? "bg-primary text-primary-ink"
                    : cn("bg-raised text-ink hover:bg-raised-hover disabled:hover:bg-raised", RING, settled && "opacity-60"),
                )}
              >
                {chosen && <Check size={14} strokeWidth={2.4} className="shrink-0" />}
                <span className="min-w-0 break-words">{option}</span>
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
