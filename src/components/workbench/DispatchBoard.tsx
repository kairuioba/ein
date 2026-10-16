// The task board under the canvas: every dispatch run with its subtasks,
// progress, and the controls to approve, cancel, retry, or open the work.
import { useState } from "react";
import { ChevronDown, ChevronRight, CirclePlay, ExternalLink, RotateCcw, Square } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { formatDateTime, t } from "@/lib/i18n";
import { runProgress } from "@/lib/workbench";
import type { Bot } from "@/state/store";
import type { DispatchRun, DispatchSubtask } from "../../../shared/dispatch-types";

import { SubtaskPill } from "./WorkbenchInspector";

interface Props {
  runs: DispatchRun[];
  bots: Bot[];
  height: number;
  onApprove: (runId: string) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string, subtaskId: string) => void;
  onOpenSubtask: (subtask: DispatchSubtask) => void;
  onOpenChat: (botId: string) => void;
}

const RUN_TONE: Record<DispatchRun["status"], string> = {
  "awaiting-approval": "bg-warning/15 text-warning",
  running: "bg-accent/15 text-accent-text",
  synthesizing: "bg-accent/15 text-accent-text",
  done: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  canceled: "bg-control text-ink-secondary",
};

export function runStatusLabel(status: DispatchRun["status"]): string {
  return {
    "awaiting-approval": t("Waiting for approval"),
    running: t("Running"),
    synthesizing: t("Summarizing"),
    done: t("Done"),
    failed: t("Failed"),
    canceled: t("Canceled"),
  }[status];
}

export function DispatchBoard(props: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(props.runs.slice(0, 1).map((run) => run.id)));
  const botName = (id: string) => props.bots.find((bot) => bot.id === id);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="flex shrink-0 flex-col border-t border-hairline/40 bg-panel/85 backdrop-blur-xl" style={{ height: props.height }}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline/30 px-4">
        <h2 className="text-[12px] font-semibold text-ink">{t("Dispatch board")}</h2>
        <span className="text-[11px] text-ink-secondary">{t("Newest first")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {props.runs.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-ink-secondary">
            {t("No dispatches yet. Give a Chief a multi-step task — its plan and every subtask will show up here live.")}
          </div>
        )}
        {props.runs.map((run) => {
          const chief = botName(run.chiefBotId);
          const progress = runProgress(run);
          const open = expanded.has(run.id);
          const active = run.status === "running" || run.status === "awaiting-approval" || run.status === "synthesizing";
          return (
            <div key={run.id} className="mb-1.5 overflow-hidden rounded-xl border border-hairline/40 bg-card">
              <div className="flex items-center gap-2.5 px-3 py-2">
                <button type="button" onClick={() => toggle(run.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={open}>
                  {open ? <ChevronDown size={14} className="shrink-0 text-ink-secondary" /> : <ChevronRight size={14} className="shrink-0 text-ink-secondary" />}
                  {chief && <BotAvatar bot={chief} size={22} motion="none" motionKey={0} animated={false} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{run.goal}</span>
                    <span className="block truncate text-[10.5px] text-ink-secondary">
                      {chief?.name ?? "?"} · {formatDateTime(run.createdAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                </button>
                <div className="hidden w-28 shrink-0 sm:block">
                  <div className="h-1.5 overflow-hidden rounded-full bg-control">
                    <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                  </div>
                  <div className="mt-0.5 text-right text-[10px] tabular-nums text-ink-secondary">
                    {progress.done}/{progress.total}
                    {progress.failed ? ` · ${t("{count} failed", { count: progress.failed })}` : ""}
                  </div>
                </div>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium", RUN_TONE[run.status])}>{runStatusLabel(run.status)}</span>
                {run.status === "awaiting-approval" && (
                  <button type="button" onClick={() => props.onApprove(run.id)} className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white hover:brightness-110">
                    <CirclePlay size={12} /> {t("Start")}
                  </button>
                )}
                {active && (
                  <button type="button" onClick={() => props.onCancel(run.id)} className="flex shrink-0 items-center gap-1 rounded-md border border-hairline/60 px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink" title={t("Cancel this dispatch")}>
                    <Square size={10} /> {t("Cancel")}
                  </button>
                )}
              </div>
              {open && (
                <div className="border-t border-hairline/30">
                  {run.subtasks.map((subtask) => {
                    const assignee = botName(subtask.assigneeBotId);
                    return (
                      <div key={subtask.id} className="flex items-center gap-2.5 border-b border-hairline/20 px-3 py-1.5 last:border-b-0">
                        <span className="w-6 shrink-0 text-center text-[10px] tabular-nums text-ink-secondary">{subtask.id}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] text-ink">{subtask.title}</div>
                          <div className="truncate text-[10.5px] text-ink-secondary">
                            {subtask.dependsOn.length ? `${t("After {ids}", { ids: subtask.dependsOn.join(t(", ")) })} · ` : ""}
                            {subtask.error && subtask.status !== "done" ? subtask.error : subtask.result ? subtask.result.replace(/\s+/g, " ").slice(0, 120) : subtask.role}
                          </div>
                        </div>
                        {assignee && (
                          <button type="button" onClick={() => props.onOpenChat(assignee.id)} className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-raised" title={t("Open {name}'s chat", { name: assignee.name })}>
                            <BotAvatar bot={assignee} size={18} motion="none" motionKey={0} animated={false} />
                            <span className="max-w-[96px] truncate text-[11px] text-ink-secondary">{assignee.name}</span>
                            {subtask.createdBot && <span className="rounded bg-accent/15 px-1 text-[9.5px] text-accent-text">{t("New")}</span>}
                          </button>
                        )}
                        <SubtaskPill status={subtask.status} />
                        {(subtask.status === "failed" || subtask.status === "canceled") && run.status !== "canceled" && (
                          <button type="button" onClick={() => props.onRetry(run.id, subtask.id)} className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" title={t("Retry")} aria-label={t("Retry")}>
                            <RotateCcw size={12} />
                          </button>
                        )}
                        {subtask.threadId && (
                          <button type="button" onClick={() => props.onOpenSubtask(subtask)} className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" title={t("Open this subtask's conversation")} aria-label={t("Open this subtask's conversation")}>
                            <ExternalLink size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
