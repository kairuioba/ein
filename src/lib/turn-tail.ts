import type { Message } from "@/state/store";

/** Whether the transcript tail should show the "working" dots.
 *
 * A turn ends across three server frames: the settled reply (`message`),
 * `turn.completed`, then the bot patch that flips `busy` off. Deriving the
 * dots from `busy && !streaming` alone re-shows them in that window — the
 * reply lands, the dots pop back under it for a beat, then vanish — and the
 * pinned scroll re-anchors around each height change. That grow-shrink-jump
 * is the end-of-stream jitter. A settled reply at the tail means there is
 * nothing to wait for, so the dots stay hidden until something actually new
 * starts: a tool chip, the user's next prompt, or (in rooms) a different
 * speaker taking the floor.
 */
export function showWorkingDots(
  busy: boolean | undefined,
  lastMessage: Message | undefined,
  /** rooms: the bot currently speaking. A settled reply from a PREVIOUS
   * speaker doesn't cover this one — its dots are real information. */
  speakerBotId?: string,
): boolean {
  if (!busy) return false;
  if (!lastMessage) return true;
  const settledReply = lastMessage.role === "bot" && lastMessage.kind === "text";
  if (!settledReply) return true;
  return speakerBotId !== undefined && lastMessage.from?.botId !== speakerBotId;
}

/** What the transcript tail looked like on the previous render. */
export interface TailState {
  lastId: string | undefined;
  /** the working dots were on screen since the last reply popped in */
  armed: boolean;
  /** the reply popping in right now, if any */
  arrivingId: string | null;
}

export function initialTail(lastMessage: Message | undefined, waiting: boolean): TailState {
  return { lastId: lastMessage?.id, armed: waiting, arrivingId: null };
}

/** Advance the tail by one render. A bot reply that lands after the working
 * dots were shown takes their place and pops in — decided during the render
 * that brings the reply, so the reply is drawn once, in its final row, with
 * no frame where it is missing, duplicated, or below the typing line.
 * Returns `previous` itself when nothing changed. */
export function nextTail(previous: TailState, waiting: boolean, lastMessage: Message | undefined): TailState {
  const lastId = lastMessage?.id;
  const replyLanded =
    lastMessage !== undefined && lastId !== previous.lastId && lastMessage.role === "bot" && lastMessage.kind === "text";
  if (replyLanded && previous.armed) return { lastId, armed: waiting, arrivingId: lastId ?? null };
  const armed = previous.armed || waiting;
  if (lastId === previous.lastId && armed === previous.armed) return previous;
  return { lastId, armed, arrivingId: previous.arrivingId };
}
