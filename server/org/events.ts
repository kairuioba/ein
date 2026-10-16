// The company event log: an append-only NDJSON file of what changed (runs
// started and finished, people added, decisions, approvals, library
// versions…), read back for "since you last looked" and the day's timeline.
// Fire-and-forget like the decision log: recording an event must never take
// down the thing it records.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { OrgEvent } from "../../shared/org-types.ts";

const FILE_NAME = "org-events.ndjson";
const MAX_BYTES = 2_000_000;
const MEMORY = 500;

type Listener = (event: OrgEvent) => void;

export class OrgEventLog {
  private recent: OrgEvent[] = [];
  private listeners = new Set<Listener>();
  private loaded = false;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private get file() {
    return join(this.dataDir, FILE_NAME);
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-MEMORY);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as OrgEvent;
          if (event && typeof event.at === "number" && typeof event.kind === "string") this.recent.push(event);
        } catch {
          /* a torn line from a crash — skip it */
        }
      }
    } catch {
      /* unreadable — start empty */
    }
  }

  /** Record an event; returns it with its id and time. */
  append(input: Omit<OrgEvent, "id" | "at"> & { at?: number }): OrgEvent {
    this.load();
    const event: OrgEvent = { ...input, id: randomUUID(), at: input.at ?? Date.now() };
    this.recent.push(event);
    if (this.recent.length > MEMORY) this.recent.splice(0, this.recent.length - MEMORY);
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch {
      /* best effort */
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a listener's failure is its own */
      }
    }
    return event;
  }

  /** Events at or after `since`, oldest first. */
  since(since: number): OrgEvent[] {
    this.load();
    return this.recent.filter((event) => event.at >= since);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
