// 复盘读模型：一个已完成任务当时发生了什么。
//
// 只读、确定性聚合，不调用模型：会话（任务窗口 + 员工子任务会话）、
// attempt 时间线、产物清单、Handoff 信封。数据来源是任务文件夹、dispatch
// run 和 Bot 的任务记录；旧任务窗口不搬动，所以这里只是"按 folderId 查"。
import type { DispatchRun, DispatchSubtask } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";

export interface RetroConversation {
  threadId: string;
  role: "main" | "worker";
  title: string;
  botId?: string;
  botName?: string;
  createdAt?: number;
  closedAt?: number;
  attemptId?: string;
}

export interface RetroAttempt {
  subtaskId: string;
  title: string;
  status: string;
  attempts: number;
  assigneeBotId: string;
  assigneeName?: string;
  model?: { instanceId: string; model: string; effort?: string };
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  /** the worker's structured envelope, when it sent one */
  handoff?: DispatchSubtask["handoff"];
}

export interface RetroArtifact {
  path: string;
  fromSubtaskId: string;
}

export interface TaskRetro {
  folder: TaskFolderRecord;
  runId?: string;
  goal?: string;
  status: string;
  conversations: RetroConversation[];
  attempts: RetroAttempt[];
  artifacts: RetroArtifact[];
  sharedFromTaskIds: string[];
  createdAt: number;
}

/** Look up one conversation by its thread id (the caller owns the store). */
export type ConversationLookup = (threadId: string) =>
  | { title: string; botId?: string; botName?: string; createdAt?: number; closedAt?: number; attemptId?: string }
  | undefined;

export function buildTaskRetro(input: {
  folder: TaskFolderRecord;
  run?: DispatchRun;
  conversation?: ConversationLookup;
  botName?: (botId: string) => string | undefined;
}): TaskRetro {
  const { folder, run } = input;
  const conversations: RetroConversation[] = [];
  const seen = new Set<string>();
  const addConversation = (threadId: string | undefined, role: RetroConversation["role"], fallbackTitle: string, botId?: string, attemptId?: string) => {
    if (!threadId || seen.has(threadId)) return;
    seen.add(threadId);
    const found = input.conversation?.(threadId);
    conversations.push({
      threadId,
      role,
      title: found?.title ?? fallbackTitle,
      ...(botId ?? found?.botId ? { botId: botId ?? found?.botId } : {}),
      ...(found?.botName ? { botName: found.botName } : {}),
      ...(found?.createdAt ? { createdAt: found.createdAt } : {}),
      ...(found?.closedAt ? { closedAt: found.closedAt } : {}),
      ...(attemptId ?? found?.attemptId ? { attemptId: attemptId ?? found?.attemptId } : {}),
    });
  };
  addConversation(folder.conversationId, "main", folder.title);
  const attempts: RetroAttempt[] = [];
  const artifacts: RetroArtifact[] = [];
  for (const subtask of run?.subtasks ?? []) {
    addConversation(subtask.threadId, "worker", subtask.title, subtask.assigneeBotId, subtask.currentAttemptId);
    attempts.push({
      subtaskId: subtask.id,
      title: subtask.title,
      status: subtask.status,
      attempts: subtask.attempts,
      assigneeBotId: subtask.assigneeBotId,
      ...(input.botName?.(subtask.assigneeBotId) ? { assigneeName: input.botName!(subtask.assigneeBotId) } : {}),
      ...(subtask.ranWith ? { model: subtask.ranWith } : {}),
      ...(subtask.startedAt ? { startedAt: subtask.startedAt } : {}),
      ...(subtask.finishedAt ? { finishedAt: subtask.finishedAt } : {}),
      ...(subtask.startedAt && subtask.finishedAt ? { durationMs: subtask.finishedAt - subtask.startedAt } : {}),
      ...(subtask.error ? { error: subtask.error } : {}),
      ...(subtask.handoff ? { handoff: subtask.handoff } : {}),
    });
    for (const path of subtask.handoff?.artifacts ?? []) artifacts.push({ path, fromSubtaskId: subtask.id });
  }
  return {
    folder,
    ...(run ? { runId: run.id } : {}),
    ...(run?.goal ? { goal: run.goal } : {}),
    status: run?.status ?? "draft",
    conversations,
    attempts,
    artifacts,
    sharedFromTaskIds: folder.sharedFromTaskIds ?? [],
    createdAt: folder.createdAt,
  };
}
