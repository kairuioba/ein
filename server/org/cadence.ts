// The report cadence (汇报与节奏): the daily brief at its time, and a short
// progress report every N hours while work is running. This module only
// decides what is due and remembers what was posted (DATA_DIR/org-cadence.json);
// the org layer writes the reports into the 主 Bot's conversation.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { readJson, startOfDay } from "./util.ts";

const FILE_NAME = "org-cadence.json";
const HOUR_MS = 60 * 60_000;

export interface CadenceState {
  /** start of the day the daily brief was last posted for */
  dailyDay?: number;
  /** when the last progress report went out */
  progressAt?: number;
}

export interface CadenceInput {
  now: number;
  /** "18:00", local time */
  dailyBriefAt: string;
  /** 0 = no progress reports */
  everyHours: number;
  /** when the oldest run still in progress started; undefined = nothing running */
  activeSince?: number;
  state: CadenceState;
}

/** The daily brief time on `now`'s day, epoch ms; NaN for a malformed time. */
export function dailyBriefTime(now: number, at: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) return Number.NaN;
  const date = new Date(now);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date.getTime();
}

/** What is due now: the daily brief once a day from its time on (a late
 * start still gets today's), a progress report every `everyHours` while a
 * run is in progress — counted from the later of the run's start and the
 * last report. */
export function cadenceDue(input: CadenceInput): { daily: boolean; progress: boolean } {
  const { now, state } = input;
  const briefAt = dailyBriefTime(now, input.dailyBriefAt);
  const daily = Number.isFinite(briefAt) && now >= briefAt && state.dailyDay !== startOfDay(now);
  const every = input.everyHours > 0 ? input.everyHours * HOUR_MS : 0;
  const progress =
    every > 0 && input.activeSince !== undefined && now - Math.max(input.activeSince, state.progressAt ?? 0) >= every;
  return { daily, progress };
}

export class CadenceStore {
  private readonly file: string;
  private state: CadenceState | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, FILE_NAME);
  }

  get(): CadenceState {
    if (!this.state) {
      const raw = readJson(this.file) as CadenceState | undefined;
      this.state = {
        ...(typeof raw?.dailyDay === "number" ? { dailyDay: raw.dailyDay } : {}),
        ...(typeof raw?.progressAt === "number" ? { progressAt: raw.progressAt } : {}),
      };
    }
    return { ...this.state };
  }

  set(patch: CadenceState): void {
    this.state = { ...this.get(), ...patch };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 });
    } catch {
      /* best effort: at worst a report repeats after a restart */
    }
  }
}
