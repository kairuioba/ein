// Every dispatch run with its subtasks, progress and the controls to start,
// cancel, retry or open the work. Shown in the work tree's drawer when the
// 总控 node is selected.
import { useState } from "react";
import { ChevronDown, ChevronRight, CirclePlay, ExternalLink, RotateCcw, Square } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { formatDateTime, t } from "@/lib/i18n";
import { runProgress } from "@/lib/workbench";
import type { Bot } from "@/state/store";
import type { DispatchRun, DispatchSubtask } from "../../../shared/dispatch-types";

const RUN_TONE: Record<DispatchRun["status"], string> = {
  "awaiting-approval": "bg-warning/12 text-warning",
  running: "bg-select/12 text-accent-text",
  synthesizing: "bg-select/12 text-accent-text",
  done: "bg-success/12 text-success",
  failed: "bg-danger/10 text-danger",
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

const SUBTASK_TONE: Record<DispatchSubtask["status"], string> = {
  pending: "bg-control text-ink-secondary",
  running: "bg-select/12 text-accent-text",
  done: "bg-success/12 text-success",
  failed: "bg-danger/10 text-danger",
  skipped: "bg-control text-ink-secondary",
  canceled: "bg-control text-ink-secondary",
};

export function subtaskStatusLabel(status: DispatchSubtask["status"]): string {
  return {
    pending: t("Waiting"),
    running: t("Running"),
    done: t("Done"),
    failed: t("Failed"),
    skipped: t("Skipped"),
    canceled: t("Canceled"),
  }[status];
}

export function SubtaskPill({ status }: { status: DispatchSubtask["status"] }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", SUBTASK_TONE[status])}>{subtaskStatusLabel(status)}</span>;
}

interface Props {
  runs: DispatchRun[];
  bots: Bot[];
  onApprove: (runId: string) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string, subtaskId: string) => void;
  onOpenSubtask: (subtask: DispatchSubtask) => void;
  onOpenChat: (botId: string) => void;
}

export function RunList(props: Props) {
  // a department lead's own plan shows under the subtask it belongs to
  const top = props.runs.filter((run) => !run.parentRunId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(top.slice(0, 1).map((run) => run.id)));
  const botOf = (id: string) => props.bots.find((bot) => bot.id === id);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (top.length === 0) {
    return (
      <div className="rounded-[14px] bg-inset px-4 py-6 text-center text-[12.5px] leading-relaxed text-ink-secondary">
        {t("No dispatches yet. Give a Chief a multi-step task — its plan and every subtask will show up here live.")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {top.map((run) => {
        const chief = botOf(run.chiefBotId);
        const progress = runProgress(run);
        const open = expanded.has(run.id);
        const active = run.status === "running" || run.status === "awaiting-approval" || run.status === "synthesizing";
        return (
          <div key={run.id} className="overflow-hidden rounded-[14px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <button type="button" onClick={() => toggle(run.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
                {open ? <ChevronDown size={14} className="shrink-0 text-ink-secondary" /> : <ChevronRight size={14} className="shrink-0 text-ink-secondary" />}
                {chief && <BotAvatar bot={chief} size={20} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{run.goal}</span>
                  <span className="block truncate text-[11px] text-ink-secondary">
                    {chief?.name ?? "?"} · {formatDateTime(run.createdAt, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ·{" "}
                    {progress.done}/{progress.total}
                    {progress.failed ? ` · ${t("{count} failed", { count: progress.failed })}` : ""}
                  </span>
                </span>
              </button>
              <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", RUN_TONE[run.status])}>{runStatusLabel(run.status)}</span>
            </div>
            {(run.status === "awaiting-approval" || active) && (
              <div className="flex items-center gap-1.5 px-3 pb-2.5">
                {run.status === "awaiting-approval" && (
                  <button type="button" onClick={() => props.onApprove(run.id)} className="flex h-7 items-center gap-1 rounded-lg bg-primary px-2.5 text-[12px] font-semibold text-primary-ink hover:brightness-110">
                    <CirclePlay size={12} /> {t("Start")}
                  </button>
                )}
                {active && (
                  <button type="button" onClick={() => props.onCancel(run.id)} className="flex h-7 items-center gap-1 rounded-lg bg-control px-2.5 text-[12px] font-semibold text-ink hover:bg-raised-hover" title={t("Cancel this dispatch")}>
                    <Square size={10} /> {t("Cancel")}
                  </button>
                )}
              </div>
            )}
            {open && run.report && (
              <div className="border-t border-hairline/30 px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
                <div className="mb-0.5 text-[11.5px] font-semibold text-ink-secondary">{t("The chief's report")}</div>
                {run.report.length > 600 ? `${run.report.slice(0, 600)}…` : run.report}
              </div>
            )}
            {open && (
              <div className="border-t border-hairline/30">
                {run.subtasks.map((subtask) => {
                  const assignee = botOf(subtask.assigneeBotId);
                  const child = subtask.childRunId ? props.runs.find((entry) => entry.id === subtask.childRunId) : undefined;
                  return (
                    <div key={subtask.id} className="flex items-center gap-2 border-b border-hairline/20 px-3 py-1.5 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-ink">{subtask.title}</div>
                        <div className="truncate text-[11px] text-ink-secondary">
                          {assignee?.name ?? "?"}
                          {subtask.dependsOn.length ? ` · ${t("After {ids}", { ids: subtask.dependsOn.join(t(", ")) })}` : ""}
                          {child ? ` · ${t("Team plan {done}/{total}", { done: child.subtasks.filter((entry) => entry.status === "done").length, total: child.subtasks.length })}` : ""}
                          {subtask.error && subtask.status !== "done" ? ` · ${subtask.error}` : ""}
                        </div>
                      </div>
                      <SubtaskPill status={subtask.status} />
                      {(subtask.status === "failed" || subtask.status === "canceled") && run.status !== "canceled" && (
                        <button type="button" onClick={() => props.onRetry(run.id, subtask.id)} className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" title={t("Retry")} aria-label={t("Retry")}>
                          <RotateCcw size={12} />
                        </button>
                      )}
                      {subtask.threadId && (
                        <button type="button" onClick={() => props.onOpenSubtask(subtask)} className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" title={t("Open this subtask's conversation")} aria-label={t("Open this subtask's conversation")}>
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
  );
}
