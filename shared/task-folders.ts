// 任务文件夹：用户视角的最外层容器（一个任务 = 一个文件夹）。
//
// 侧栏按「任务文件夹 → 总负责人 → 部门 → Bot 会话」分层；派单 run 是任务
// 的执行体，文件夹存的是用户自己的整理（颜色/序号/折叠/归档）和任务负责人。
// 一个 Bot 同一时间只属于一个任务，这条硬规则由派单层保证，不在这里。

/** One task folder, as persisted. */
export interface TaskFolderRecord {
  id: string;
  title: string;
  /** display colour, "#RRGGBB" */
  color: string;
  /** sidebar order; smaller first, ties by createdAt */
  order: number;
  /** the user folded this folder in the sidebar */
  collapsed: boolean;
  /** 任务总负责人: this task's owner. Not the company chief — the chief sits
   * above every task. Absent only for folders made before the field existed. */
  leadBotId?: string;
  /** the dispatch run executing this task, when it has one */
  runId?: string;
  createdAt: number;
  archivedAt?: number;
}

/** A department inside one task, as the sidebar/workbench shows it. */
export interface TaskFolderDepartment {
  section: string;
  /** how many of this task's people are in it */
  people: number;
  color?: string;
  leadBotId?: string;
  leadName?: string;
}

export type TaskFolderStatus = "draft" | "running" | "done" | "failed" | "canceled";

/** A folder plus what the dispatch layer knows about its run (read-only). */
export interface TaskFolderView extends TaskFolderRecord {
  status: TaskFolderStatus;
  progress: { done: number; total: number };
  memberCount: number;
  departments: TaskFolderDepartment[];
  leadName?: string;
}

export const TASK_FOLDER_COLORS = ["#0EA5E9", "#EC4899", "#8B5CF6", "#F59E0B", "#14B8A6", "#F97316", "#65A30D", "#475467"] as const;

export const DEFAULT_TASK_FOLDER_COLOR = TASK_FOLDER_COLORS[0];
