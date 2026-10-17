// Shared pieces of "steer anywhere": a message the user sends while a turn
// is running is accepted at once and reaches the model inside that same turn.
// Engines with a native mid-turn input (Claude's stream-json stdin, Codex
// turn/steer, pi's steer command, the ACP _session/steering extension) take
// it as-is. The others get it at the next safe boundary as a fresh prompt in
// the same session, framed so the model reads it as more input for the task
// it is already doing — never as a request to stop or to start over.

/** A message the turn has accepted but not yet put in front of the model. */
export interface PendingSteer {
  text: string;
  /** The harness's handle for it, echoed in turn.completed.undeliveredSteers. */
  steerId?: string;
}

/** The steerIds of messages a turn is ending without delivering. */
export function undeliveredSteerIds(items: readonly PendingSteer[]): string[] {
  return items.flatMap((item) => (item.steerId ? [item.steerId] : []));
}

/** The turn.completed field for those, omitted when there are none. */
export function undeliveredField(items: readonly PendingSteer[]): { undeliveredSteers?: string[] } {
  const ids = undeliveredSteerIds(items);
  return ids.length ? { undeliveredSteers: ids } : {};
}

/** Messages that arrive before the turn's first prompt went out simply join
 * that prompt: the model has not started, so there is nothing to continue. */
export function withEarlySteers(text: string, steers: readonly PendingSteer[]): string {
  const extra = steers.map((steer) => steer.text.trim()).filter(Boolean);
  return extra.length ? [text, ...extra].join("\n\n") : text;
}

/** Model-facing framing (English on purpose — it is prompt text, not UI) for
 * steered messages delivered as a follow-up prompt after a safe boundary.
 * Several messages sent close together travel together, in order. */
export function steerContinuationPrompt(steers: readonly PendingSteer[]): string {
  const texts = steers.map((steer) => steer.text.trim()).filter(Boolean);
  const many = texts.length > 1;
  return [
    many
      ? "[Messages from the user while you were working — not a request to stop]"
      : "[Message from the user while you were working — not a request to stop]",
    texts.join("\n\n"),
    `[Take ${many ? "them" : "it"} into account and continue the task you were doing; do not start over.]`,
  ].join("\n");
}
