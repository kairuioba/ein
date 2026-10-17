// Which bots are working with nobody at the keyboard — a webhook turn, or a
// turn such a bot handed on. Auto mode is a decision someone made for turns
// they were present for, so these turns do not inherit it: the guard behind
// auto mode is a pattern list, not a security boundary, and it must not stand
// in for a human at 3am.
//
// Keyed by BOT rather than thread because a bot runs one turn at a time, so
// the identity is exact, and because the peer-comms paths know who is asking
// but not always from which thread. A mark ages out: only a LIVE turn keeps
// its window alive, because every read used to refresh it — an idle bot's
// stale mark then lingered for as long as anything looked at it. A stale mark
// only ever means "ask a human", so this fails closed.
export const UNATTENDED_TTL_MS = 30 * 60_000;

export class UnattendedBots {
  private readonly marks = new Map<string, number>();
  private readonly busy: (botId: string) => boolean;
  private readonly now: () => number;
  private readonly ttlMs: number;

  // no TS parameter properties: the server runs under Node's strip-only mode
  constructor(busy: (botId: string) => boolean, now: () => number = Date.now, ttlMs = UNATTENDED_TTL_MS) {
    this.busy = busy;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /** An unattended turn started (or was inherited). */
  mark(botId: string): void {
    this.marks.set(botId, this.now());
  }

  /** A person typed into the bot: the unattended window ends now. */
  clear(botId: string): void {
    this.marks.delete(botId);
  }

  /** A turn failed or was stopped before it dispatched: it never became an
   * unattended turn, so its mark must not outlive it. */
  settle(botId: string): void {
    if (!this.busy(botId)) this.marks.delete(botId);
  }

  is(botId?: string | null): boolean {
    if (!botId) return false;
    const at = this.marks.get(botId);
    if (at === undefined) return false;
    const running = this.busy(botId);
    if (this.now() - at > this.ttlMs && !running) {
      this.marks.delete(botId);
      return false;
    }
    // a long-running turn is still unattended even if its next approval comes
    // more than the window after the previous one; an idle bot's mark is not
    // refreshed — it ages out from its last real unattended activity
    if (running) this.marks.set(botId, this.now());
    return true;
  }

  /** Test seam: how many marks are held. */
  size(): number {
    return this.marks.size;
  }
}
