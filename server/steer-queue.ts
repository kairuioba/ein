// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts joined with newlines.
//
// The queue is memory-only and is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart loses the queue
// (same as delegations / approvals). The composer shows a pending chip
// until drain appends the words.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.
//
// Most engines now take a busy send INTO the running turn instead ("steer",
// adapter.steer). Such a message is in the transcript at once (marked
// steered) and is remembered here until its turn settles: when the turn
// ends before the model ever saw it (a Stop, a failure, a crash — the
// driver names it in turn.completed.undeliveredSteers), it joins this queue
// as an already-recorded line and runs next, exactly like a queued send.

import { newId } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: Array<{
    messageId: string;
    text: string;
    prompt: string;
    replyToId?: string;
    sendId?: string;
    /** already in the transcript (a steered line handed back undelivered):
     * drain runs it without appending it a second time */
    message?: Message;
  }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

export interface QueuedSteer {
  id: string;
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  // A thread cannot legitimately change owners. Refuse to merge unrelated
  // queues even if a corrupt caller reuses a thread id.
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  entry.items.push({
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
  });
  queues.set(threadId, entry);
  return { id };
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
  ) => void | Promise<void>,
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      continue;
    }
    if (bot.busy) continue; // still working — the next settle tries again
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
    const appended: Message[] = [];
    for (const item of entry.items) {
      if (item.message) {
        appended.push(item.message);
        continue;
      }
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    const prompt = entry.items.map((item) => item.prompt).join("\n");
    void run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
    );
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId } : null;
}

/** Drop one waiting send owned by this bot so it never drains. The queue id
 * is stable even if the bot switches away from the task while the request is
 * in flight. Returns false when it was already drained, belongs to another
 * bot, or a restart lost the in-memory auto-run intent. */
export function cancelSteeredMessage(botId: string, messageId: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    return true;
  }
  return false;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

// ── steered messages, remembered until their turn settles ─────────────────

/** A message a running turn accepted through adapter.steer(). */
export interface LiveSteer {
  /** the id handed to steer(); turn.completed.undeliveredSteers echoes it */
  steerId: string;
  /** the bot whose turn took it */
  botId: string;
  /** set when the turn was a room member's turn on the room's thread */
  groupId?: string;
  /** what the model was to be sent (reply quoting included) */
  prompt: string;
  /** the transcript line, appended (marked steered) when it was accepted */
  message: Message;
}

const liveSteers = new Map<string, LiveSteer[]>(); // threadId → in send order

/** Remember an accepted steer until its turn settles. */
export function recordLiveSteer(threadId: string, steer: LiveSteer): void {
  const list = liveSteers.get(threadId) ?? [];
  list.push(steer);
  liveSteers.set(threadId, list);
}

/** The turn on this thread settled: forget its steers, and return — in send
 * order — the ones it handed back without delivering. An id the harness
 * never recorded (its send was refused after the driver took it) is
 * ignored: that sender still holds the text. */
export function settleLiveSteers(threadId: string, undelivered: readonly string[] | undefined): LiveSteer[] {
  const list = liveSteers.get(threadId) ?? [];
  liveSteers.delete(threadId);
  if (!undelivered?.length) return [];
  const wanted = new Set(undelivered);
  return list.filter((steer) => wanted.has(steer.steerId));
}

/** Queue steered lines that never reached the model to run next. They were
 * sent before anything still waiting here, so they go first. */
export function requeueSteeredMessages(botId: string, threadId: string, steers: readonly LiveSteer[]): void {
  if (!steers.length) return;
  const entry = queues.get(threadId) ?? { botId, items: [] };
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  entry.items.unshift(
    ...steers.map((steer) => ({
      messageId: newId(),
      text: steer.message.text ?? "",
      prompt: steer.prompt,
      replyToId: steer.message.replyToId,
      sendId: steer.message.sendId,
      message: steer.message,
    })),
  );
  queues.set(threadId, entry);
}

/** Test helper: how many steers a thread's running turn holds. */
export function _liveSteerCount(threadId: string): number {
  return liveSteers.get(threadId)?.length ?? 0;
}
