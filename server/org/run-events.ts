// Dispatch runs → company events. The dispatcher broadcasts the whole run on
// every change; this keeps the previous statuses of each run and its
// subtasks and turns the differences into events, once each:
//
//   run first seen running, or approved  → run.started (+ people.added for
//                                           specialists the plan created)
//   run → done / failed                  → run.done / run.failed
//   subtask → failed                     → subtask.failed
//   subtask back to pending after a try  → subtask.retry
//   subtask → done                       → report (it handed its result in)
//   a specialist joins a running run     → people.added
//
// Seed it with the runs already on disk at boot, so a restart never replays
// a run's history as if it were new.
import type { DispatchRun, RunStatus, SubtaskStatus } from "../../shared/dispatch-types.ts";
import type { OrgEvent } from "../../shared/org-types.ts";
import { t, tn } from "../../shared/i18n.ts";
import { clip, firstLine } from "./util.ts";

export type OrgEventInput = Omit<OrgEvent, "id" | "at"> & { at?: number };

export interface RunEventContext {
  botName(botId: string): string | undefined;
  botSection(botId: string): string | undefined;
  /** dispatch's attempts per subtask, for "retry 1/2" */
  maxAttempts: number;
}

interface SubtaskSnap {
  status: SubtaskStatus;
  attempts: number;
}

interface RunSnap {
  status: RunStatus;
  subtasks: Map<string, SubtaskSnap>;
  /** specialists already announced with people.added */
  announced: Set<string>;
}

const goalOf = (run: DispatchRun) => firstLine(run.goal, 40) || t("Untitled run");

const createdBots = (run: DispatchRun) => [
  ...new Set(run.subtasks.filter((subtask) => subtask.createdBot).map((subtask) => subtask.assigneeBotId)),
];

function snapshot(run: DispatchRun, announced: Set<string>): RunSnap {
  return {
    status: run.status,
    subtasks: new Map(run.subtasks.map((subtask) => [subtask.id, { status: subtask.status, attempts: subtask.attempts }])),
    announced,
  };
}

export class RunWatcher {
  private readonly snaps = new Map<string, RunSnap>();

  /** Remember runs as they are now, without events (call once at boot). A
   * plan still waiting for approval announces its specialists when it starts. */
  seed(runs: readonly DispatchRun[]): void {
    for (const run of runs) {
      this.snaps.set(run.id, snapshot(run, new Set(run.status === "awaiting-approval" ? [] : createdBots(run))));
    }
  }

  /** The events this broadcast of `run` means, oldest first. */
  diff(run: DispatchRun, ctx: RunEventContext): OrgEventInput[] {
    const prev = this.snaps.get(run.id);
    const events: OrgEventInput[] = [];
    const chiefName = ctx.botName(run.chiefBotId) ?? "?";
    const runBase = {
      runId: run.id,
      botId: run.chiefBotId,
      threadId: run.sourceThreadId,
      ...(ctx.botSection(run.chiefBotId) ? { section: ctx.botSection(run.chiefBotId) } : {}),
    };
    const active = (status: RunStatus) => status === "running" || status === "synthesizing";
    const started = active(run.status) && (!prev || prev.status === "awaiting-approval");

    if (started) {
      events.push({
        ...runBase,
        kind: "run.started",
        title: tn(run.subtasks.length, "{name} started “{goal}” — {count} subtask", "{name} started “{goal}” — {count} subtasks", {
          name: chiefName,
          goal: goalOf(run),
        }),
        severity: "info",
      });
    }

    // specialists the dispatcher created for this run, announced once — when
    // the run starts, or when they join a run already under way
    const announced = new Set(prev?.announced ?? []);
    if (started || (prev && active(run.status))) {
      const fresh = createdBots(run).filter((id) => !announced.has(id));
      if (fresh.length) {
        const names = fresh.map((id) => ctx.botName(id) ?? "?");
        events.push({
          ...runBase,
          kind: "people.added",
          title: tn(fresh.length, "{name} added {count} person: {names}", "{name} added {count} people: {names}", {
            name: chiefName,
            names: clip(names.join(t(", ")), 80),
          }),
          detail: names.join(t(", ")),
          severity: "info",
        });
        for (const id of fresh) announced.add(id);
      }
    }

    if (prev) {
      for (const subtask of run.subtasks) {
        const before = prev.subtasks.get(subtask.id);
        if (!before || before.status === subtask.status) continue;
        const base = {
          runId: run.id,
          botId: subtask.assigneeBotId,
          threadId: subtask.threadId ?? run.sourceThreadId,
          ...(ctx.botSection(subtask.assigneeBotId) ? { section: ctx.botSection(subtask.assigneeBotId) } : {}),
        };
        const title = firstLine(subtask.title, 40) || subtask.id;
        const who = ctx.botName(subtask.assigneeBotId) ?? "?";
        if (subtask.status === "failed") {
          const reason = firstLine(subtask.error, 60) || t("did not finish");
          events.push({ ...base, kind: "subtask.failed", title: t("“{title}” failed — {reason}", { title, reason }), detail: reason, severity: "error" });
        } else if (subtask.status === "pending" && (before.status === "running" || before.status === "failed" || before.status === "canceled")) {
          // the dispatcher's own retry keeps the attempt count; a retry the
          // owner asked for starts the count again
          const automatic = before.status === "running";
          events.push({
            ...base,
            kind: "subtask.retry",
            title: automatic
              ? t("Retrying “{title}” ({attempt}/{max})", { title, attempt: subtask.attempts, max: ctx.maxAttempts })
              : t("Retrying “{title}”", { title }),
            ...(subtask.error ? { detail: firstLine(subtask.error, 60) } : {}),
            severity: "warn",
          });
        } else if (subtask.status === "done") {
          events.push({ ...base, kind: "report", title: t("{name} handed in “{title}”", { name: who, title }), severity: "info" });
        }
      }
    }

    if (prev && prev.status !== run.status) {
      const done = run.subtasks.filter((subtask) => subtask.status === "done").length;
      if (run.status === "done") {
        events.push({
          ...runBase,
          kind: "run.done",
          title: t("Finished “{goal}”: {done}/{total} done", { goal: goalOf(run), done, total: run.subtasks.length }),
          severity: "info",
        });
      } else if (run.status === "failed") {
        events.push({ ...runBase, kind: "run.failed", title: t("“{goal}” finished without results", { goal: goalOf(run) }), severity: "error" });
      }
    }

    this.snaps.set(run.id, snapshot(run, announced));
    return events;
  }
}
