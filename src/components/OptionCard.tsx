// A question with choices (design U8/U9 options card): the question, the
// choices as buttons, and once answered the choice — as "Decision #n" when
// the org layer recorded it as a decision (it patches the card's decisionId).
import { useState } from "react";
import { Check } from "lucide-react";
import { useStore, visibleMessages, type Message, type OptionCardData } from "@/state/store";
import { cn } from "@/lib/cn";
import { allTranslations, t } from "@/lib/i18n";
import { ChatCard, RING, StatusPill } from "./chat/primitives";
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

/** The decision number the org layer stamped on an answered card, if any. */
export function decisionIdOf(card: OptionCardData | undefined): number | undefined {
  const value = (card as (OptionCardData & { decisionId?: unknown }) | undefined)?.decisionId;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

  const answer = (text: string) => {
    if (!text.trim() || card.answered) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };
  const decision = decisionIdOf(card);
  const answered = card.answered;

  return (
    <ChatCard
      label={card.title}
      title={card.title}
      live
      pill={
        <span className="flex items-center gap-1.5">
          {answered ? (
            <StatusPill tone="green">
              {decision !== undefined
                ? t("Decision #{id} · {choice}", { id: decision, choice: answered })
                : t("You chose {choice}", { choice: answered })}
            </StatusPill>
          ) : (
            <StatusPill tone="amber">{t("Your call")}</StatusPill>
          )}
          {isOnboardingCard(message) && !answered && (
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
      meta={card.subtitle ? <span>{card.subtitle}</span> : undefined}
    >
      {card.options.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label={card.title}>
          {card.options.map((option) => {
            const chosen = answered === option;
            return (
              <button
                key={option}
                type="button"
                disabled={Boolean(answered)}
                aria-pressed={chosen}
                onClick={() => answer(option)}
                className={cn(
                  "inline-flex min-h-[34px] max-w-full items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-left text-[13px] font-semibold transition-colors",
                  chosen
                    ? "bg-primary text-primary-ink"
                    : cn("bg-raised text-ink hover:bg-raised-hover disabled:hover:bg-raised", RING, answered && "opacity-60"),
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
      {!answered && !card.tool && (
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
