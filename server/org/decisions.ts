// Decisions (决议 #n): what the owner chose when a bot or a meeting put options
// in front of them. Numbered from 1 and never reused, persisted in
// DATA_DIR/org-decisions.json.
//
// A decision is only worth recording if the work it starts can point back at
// it, so a dispatch run that starts from the same conversation shortly after
// a decision becomes that decision's action items ("from decision #3"), and
// the items follow the run's subtasks as they move.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DispatchRun, SubtaskStatus } from "../../shared/dispatch-types.ts";
import type { DecisionLevel, OrgDecision } from "../../shared/org-types.ts";
import { writeFileAtomic } from "../atomic.ts";
import { clip, readJson } from "./util.ts";

const FILE_NAME = "org-decisions.json";
const MAX_KEPT = 1_000;
/** A run that starts this long after a decision in the same conversation is its follow-up. */
export const DECISION_LINK_WINDOW_MS = 30 * 60_000;

type ActionStatus = OrgDecision["actionItems"][number]["status"];

export function actionStatus(status: SubtaskStatus): ActionStatus {
  if (status === "done") return "done";
  if (status === "running") return "running";
  if (status === "pending") return "pending";
  // failed, skipped (a dependency failed) and canceled all mean "not delivered"
  return "failed";
}

export interface NewDecision {
  title: string;
  options: string[];
  choice: string;
  source: OrgDecision["source"];
  decidedBy?: DecisionLevel;
  basis?: string[];
  at?: number;
}

interface DecisionsFile {
  version: 1;
  nextId: number;
  decisions: OrgDecision[];
}

const isDecision = (value: unknown): value is OrgDecision => {
  const entry = value as OrgDecision;
  return (
    Boolean(entry) &&
    typeof entry.id === "number" &&
    typeof entry.title === "string" &&
    typeof entry.choice === "string" &&
    Array.isArray(entry.options) &&
    typeof entry.at === "number" &&
    Boolean(entry.source) &&
    typeof entry.source.id === "string" &&
    Array.isArray(entry.actionItems)
  );
};

export class OrgDecisionStore {
  private readonly file: string;
  private data: DecisionsFile | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, FILE_NAME);
  }

  private load(): DecisionsFile {
    if (this.data) return this.data;
    const raw = readJson(this.file) as Partial<DecisionsFile> | undefined;
    const decisions = Array.isArray(raw?.decisions) ? raw.decisions.filter(isDecision) : [];
    const highest = decisions.reduce((max, decision) => Math.max(max, decision.id), 0);
    const nextId = typeof raw?.nextId === "number" && raw.nextId > highest ? Math.floor(raw.nextId) : highest + 1;
    this.data = { version: 1, nextId, decisions };
    return this.data;
  }

  private save(): void {
    const data = this.load();
    if (data.decisions.length > MAX_KEPT) data.decisions.splice(0, data.decisions.length - MAX_KEPT);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("org: could not persist decisions", error);
    }
  }

  /** Newest first. */
  list(): OrgDecision[] {
    return this.load()
      .decisions.slice()
      .reverse()
      .map((decision) => structuredClone(decision));
  }

  get(id: number): OrgDecision | undefined {
    const found = this.load().decisions.find((decision) => decision.id === id);
    return found ? structuredClone(found) : undefined;
  }

  create(input: NewDecision): OrgDecision {
    const data = this.load();
    const decision: OrgDecision = {
      id: data.nextId,
      title: clip(input.title, 200) || "—",
      choice: clip(input.choice, 200),
      options: input.options.map((option) => clip(option, 200)).slice(0, 12),
      decidedBy: input.decidedBy ?? "owner",
      at: input.at ?? Date.now(),
      source: { ...input.source },
      ...(input.basis?.length ? { basis: input.basis.slice(0, 8) } : {}),
      actionItems: [],
    };
    data.nextId += 1;
    data.decisions.push(decision);
    this.save();
    return structuredClone(decision);
  }

  /** The decision a run's subtasks already belong to, if any. */
  decisionForRun(runId: string): number | undefined {
    return this.load().decisions.find((decision) => decision.actionItems.some((item) => item.runId === runId))?.id;
  }

  /** Attach a run that just started to the newest decision taken in the same
   * conversation (`sameConversation` decides) within the link window before
   * it. Returns the decision's id, or undefined when none fits. */
  linkRun(run: DispatchRun, sameConversation: (decision: OrgDecision) => boolean): number | undefined {
    const existing = this.decisionForRun(run.id);
    if (existing !== undefined) return existing;
    const candidates = this.load().decisions.filter(
      (decision) =>
        decision.at <= run.createdAt &&
        run.createdAt - decision.at <= DECISION_LINK_WINDOW_MS &&
        sameConversation(decision),
    );
    const decision = candidates.sort((a, b) => b.at - a.at)[0];
    if (!decision) return undefined;
    for (const subtask of run.subtasks) {
      decision.actionItems.push({
        title: subtask.title,
        botId: subtask.assigneeBotId,
        runId: run.id,
        subtaskId: subtask.id,
        status: actionStatus(subtask.status),
      });
    }
    this.save();
    return decision.id;
  }

  /** Keep a linked run's action items in step with its subtasks (new ones —
   * people added mid-run — join the list). Returns true when anything changed. */
  syncRun(run: DispatchRun): boolean {
    const decision = this.load().decisions.find((entry) => entry.actionItems.some((item) => item.runId === run.id));
    if (!decision) return false;
    let changed = false;
    for (const subtask of run.subtasks) {
      const status = actionStatus(subtask.status);
      const item = decision.actionItems.find((entry) => entry.runId === run.id && entry.subtaskId === subtask.id);
      if (!item) {
        decision.actionItems.push({ title: subtask.title, botId: subtask.assigneeBotId, runId: run.id, subtaskId: subtask.id, status });
        changed = true;
      } else if (item.status !== status || item.botId !== subtask.assigneeBotId) {
        item.status = status;
        item.botId = subtask.assigneeBotId;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }
}
