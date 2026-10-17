// 任务文件夹的前端数据层：侧栏最外层「任务」。
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";
import type { TaskFolderView } from "../../shared/task-folders";

const EMPTY: TaskFolderView[] = [];

export function useTaskFolders(intervalMs = 5000) {
  const [tasks, setTasks] = useState<TaskFolderView[]>(EMPTY);
  const refresh = useCallback(async () => {
    try {
      const next = (await api("/api/task-folders")) as { tasks?: TaskFolderView[] };
      setTasks(next.tasks ?? EMPTY);
    } catch {
      // keep the last snapshot; the sidebar stays usable offline
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);
  return { tasks, refresh };
}

export async function createTask(title?: string): Promise<{ task: TaskFolderView; conversationId: string; botId: string }> {
  return (await api("/api/tasks", { method: "POST", body: JSON.stringify(title ? { title } : {}) })) as {
    task: TaskFolderView;
    conversationId: string;
    botId: string;
  };
}

export async function forkTask(taskId: string, title?: string): Promise<{ task: TaskFolderView; conversationId: string; botId: string; draft?: string }> {
  return (await api(`/api/tasks/${taskId}/fork`, {
    method: "POST",
    body: JSON.stringify({ ...(title ? { title } : {}), clientRequestId: crypto.randomUUID() }),
  })) as { task: TaskFolderView; conversationId: string; botId: string; draft?: string };
}
