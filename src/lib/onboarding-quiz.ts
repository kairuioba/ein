// The first-run quiz the harness posts under a new bot's greeting (see
// server/store.ts onboardingCard), recognised in whichever language it was
// written. Only this card is hidden once the person talks past it; every
// other request-less options card (an org question, a proposal) stays.
import { allTranslations } from "@/lib/i18n";

const QUIZ_TITLES = new Set(allTranslations("What do you mostly want help with?"));

export function isQuizCard(card: { title: string; requestId?: string; decisionId?: number } | undefined): boolean {
  return Boolean(card) && !card!.requestId && card!.decisionId === undefined && QUIZ_TITLES.has(card!.title);
}
