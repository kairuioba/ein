// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";
import { msg, t } from "../../shared/i18n.ts";

const INCOMPLETE_LOG_MESSAGE = msg(
  "Canonical event history is incomplete: Ein could not write one or more events to disk. Live updates will continue.",
);

export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  /** per instance id, so one rebuilt engine can be detached without the rest */
  private unsubscribes = new Map<string, Array<() => void>>();
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  private readonly appendLog: typeof appendFileSync;

  constructor(appendLog: typeof appendFileSync = appendFileSync) {
    this.appendLog = appendLog;
  }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      const unsub = instance.adapter.onEvent((event) => {
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      const existing = this.unsubscribes.get(instance.instanceId) ?? [];
      existing.push(unsub);
      this.unsubscribes.set(instance.instanceId, existing);
    }
  }

  /** Stop listening to these instances (they are about to be disposed). */
  detach(instanceIds: Iterable<string>) {
    for (const instanceId of instanceIds) {
      for (const unsub of this.unsubscribes.get(instanceId) ?? []) unsub();
      this.unsubscribes.delete(instanceId);
    }
  }

  publish(event: RuntimeEvent) {
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    const persistedEvents = pendingWarning ? [pendingWarning, redactSecrets(event)] : [redactSecrets(event)];
    try {
      // the canonical log is a file people paste into bug reports; scrub
      // credential-shaped content (tool titles, request summaries, reply
      // text) the same way the native tee does
      this.appendLog(
        join(EVENTS_DIR, `${event.threadId}.ndjson`),
        persistedEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { mode: 0o600 },
      );
      if (pendingWarning) this.pendingLogWarnings.delete(event.threadId);
    } catch (error) {
      // Never feed this warning back through publish(): that would retry the
      // same failed write and recurse. Deliver it once for this outage, then
      // persist the same marker before the first event written after recovery.
      if (!pendingWarning) {
        const warning: RuntimeEvent = {
          eventId: newId(),
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          createdAt: new Date().toISOString(),
          turnId: event.turnId,
          type: "runtime.error",
          message: t(INCOMPLETE_LOG_MESSAGE),
        };
        this.pendingLogWarnings.set(event.threadId, warning);
        console.error("bus: canonical event log write failed", error);
        this.deliver(warning);
      }
    }
    this.deliver(event);
  }

  private deliver(event: RuntimeEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detachAll() {
    const all = [...this.unsubscribes.values()].flat();
    this.unsubscribes.clear();
    for (const unsub of all) unsub();
  }
}
