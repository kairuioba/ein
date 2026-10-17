// Which sends from the composer go INTO a running turn.
//
// The harness takes a message sent while a bot is busy into the running turn
// when the engine says it can steer (adapter.capabilities.queueing, surfaced
// on the instance as capabilities.queueing — see server/index.ts). That is
// true for 1:1 bots AND for rooms: a room message with no @mention of another
// bot is steered into the current speaker's turn (steerIntoRoom). The composer
// used to hold room sends locally whenever the room was busy; it must POST
// them instead so the server can steer — and keep the local hold for engines
// that cannot steer, which is the fallback the server itself uses.
//
// Kept as pure functions over structural types so the composer and its test
// do not need the whole store.

/** The slice of a bot/room member this decision needs. */
export interface ComposerSteeringTarget {
  id: string;
  modelSelection: { instanceId: string };
}

/** The slice of an engine instance this decision needs. */
export interface ComposerSteeringInstance {
  instanceId: string;
  capabilities?: { queueing?: boolean };
}

/** The engine instance that owns the running turn: the room's current
 *  speaker, or the 1:1 bot. null when nobody is running (or the speaker is
 *  not one of the members we know about). */
export function busyEngineInstance(
  group: { busyBotId?: string | null } | undefined,
  members: readonly ComposerSteeringTarget[] | undefined,
  bot: ComposerSteeringTarget | undefined,
): string | null {
  if (group) {
    if (!group.busyBotId) return null;
    return members?.find((member) => member.id === group.busyBotId)?.modelSelection.instanceId ?? null;
  }
  return bot?.modelSelection.instanceId ?? null;
}

/** True when a send while busy goes to the server as a steerable message
 *  instead of waiting in the composer. Unknown engines count as unable to
 *  steer: the local hold is the safe fallback. */
export function canSteerBusyTarget(
  group: { busyBotId?: string | null } | undefined,
  members: readonly ComposerSteeringTarget[] | undefined,
  bot: ComposerSteeringTarget | undefined,
  instances: readonly ComposerSteeringInstance[],
): boolean {
  const instanceId = busyEngineInstance(group, members, bot);
  if (!instanceId) return false;
  return instances.some(
    (instance) => instance.instanceId === instanceId && instance.capabilities?.queueing === true,
  );
}
