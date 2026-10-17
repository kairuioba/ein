// 侧栏的任务文件夹：进行中在上、已完成折叠、点一下打开任务窗口。
import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { createTask, forkTask, useTaskFolders } from "@/lib/task-folders";
import type { TaskFolderView } from "../../shared/task-folders";

const DONE = new Set(["done", "failed", "canceled"]);

const statusLabel = (task: TaskFolderView): string => {
  switch (task.status) {
    case "running":
      return t("In progress");
    case "done":
      return t("Done");
    case "failed":
      return t("Failed");
    case "canceled":
      return t("Canceled");
    default:
      return t("Waiting to start");
  }
};

export function TaskFolderList({
  needsYouByTask,
  onOpenTask,
}: {
  needsYouByTask: Record<string, number>;
  onOpenTask: (botId: string, threadId: string) => void;
}) {
  const { tasks, refresh } = useTaskFolders();
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useMemo(() => tasks.filter((task) => !DONE.has(task.status)), [tasks]);
  const done = useMemo(() => tasks.filter((task) => DONE.has(task.status)), [tasks]);

  const open = (task: TaskFolderView) => {
    if (!task.conversationId || !task.conversationBotId) return;
    onOpenTask(task.conversationBotId, task.conversationId);
  };

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createTask(t("New task"));
      await refresh();
      onOpenTask(created.botId, created.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const fork = async (task: TaskFolderView) => {
    setBusy(true);
    setError(null);
    try {
      const created = await forkTask(task.id);
      await refresh();
      onOpenTask(created.botId, created.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const row = (task: TaskFolderView) => {
    const badge = needsYouByTask[task.id] ?? 0;
    return (
      <div key={task.id} className="group/task flex flex-col">
        <button
          type="button"
          onClick={() => open(task)}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-[7px] text-left hover:bg-raised-hover/70"
          title={`${task.title} · ${statusLabel(task)}`}
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: task.color }} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{task.title}</span>
          {badge > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-bold text-white">
              {badge}
            </span>
          )}
          <span className="shrink-0 text-[10.5px] text-ink-secondary/70 group-hover/task:hidden">{task.leadName ?? statusLabel(task)}</span>
        </button>
        {DONE.has(task.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void fork(task)}
            className="ml-6 mb-1 hidden w-max items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-accent-text hover:bg-raised group-hover/task:flex"
          >
            <CheckCircle2 size={11} /> {t("Based on this, start a new task")}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="mb-1 flex flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-1">
        <span className="text-[11px] font-semibold tracking-wide text-ink-secondary/70">{t("Tasks")}</span>
        <span className="flex-1" />
        <button
          type="button"
          disabled={busy}
          onClick={() => void begin()}
          title={t("New task")}
          className="grid size-5 place-items-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
      </div>
      {error && <div className="mx-2 mb-1 rounded-md bg-danger/[0.08] px-2 py-1 text-[11px] text-danger">{error}</div>}
      {active.length === 0 && done.length === 0 ? (
        <p className="px-2 pb-1 text-[11.5px] text-ink-secondary/70">{t("No tasks yet — + starts one in a new window.")}</p>
      ) : (
        active.map(row)
      )}
      {done.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDone((open) => !open)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] font-semibold text-ink-secondary/80 hover:bg-raised-hover/60"
          >
            <ChevronDown size={12} className={cn("transition-transform", showDone && "rotate-180")} />
            {t("Completed ({count})", { count: done.length })}
          </button>
          {showDone && done.map(row)}
        </>
      )}
    </div>
  );
}
