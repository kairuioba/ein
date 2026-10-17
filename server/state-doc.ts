// StateDoc Tier 0：零成本的事实与漂移视图。
//
// 只由代码生成，不调用模型：任务现在到哪一步、有没有停滞、有多少需要人
// 处理的事。模型写的「判断」（进度叙述、风险、下一步）不在这里，避免把
// 过期意见当事实注入。供任务窗口/复盘/未来对表 routine 读取。
import type { DispatchRun } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";

export interface StateDocDriftFlag {
  type: "stalled" | "gates_waiting" | "deadline_risk" | "budget_risk";
  since?: number;
  detail: string;
}

export interface StateDoc {
  version: 1;
  generatedAt: number;
  facts: {
    status: string;
    startedAt?: number;
    elapsedMs?: number;
    lastActivityAt?: number;
    progress: { done: number; total: number };
    subtasks: Array<{ id: string; title: string; status: string; attempts: number; gate?: string }>;
    gates: { pass: number; fail: number; needsHuman: number };
    artifacts: string[];
    closedAt?: number;
    acceptedAt?: number;
    inboxOpen: number;
    charter?: { successCriteria?: string; nonGoals?: string; constraints?: string; deadline?: string; budgetCny?: number };
  };
  drift: StateDocDriftFlag[];
}

const STALL_MS = 2 * 60 * 60 * 1000;

export function buildStateDoc(input: {
  folder: TaskFolderRecord;
  run?: DispatchRun;
  inboxOpen?: number;
  now?: number;
  /** the conversation window's close time (lives on the task record) */
  closedAt?: number;
  /** the owner's sign-off time */
  acceptedAt?: number;
}): StateDoc {
  const now = input.now ?? Date.now();
  const { run } = input;
  const leaves = (run?.subtasks ?? []).filter((subtask) => !subtask.childRunId);
  const done = leaves.filter((subtask) => subtask.status === "done").length;
  const gates = { pass: 0, fail: 0, needsHuman: 0 };
  const artifacts = new Set<string>();
  for (const subtask of leaves) {
    if (subtask.gate?.status === "pass") gates.pass += 1;
    else if (subtask.gate?.status === "fail") gates.fail += 1;
    else if (subtask.gate?.status === "needs_human") gates.needsHuman += 1;
    for (const path of subtask.handoff?.artifacts ?? []) artifacts.add(path);
  }
  const lastActivityAt = Math.max(run?.updatedAt ?? 0, ...leaves.map((subtask) => subtask.finishedAt ?? subtask.startedAt ?? 0));
  const drift: StateDocDriftFlag[] = [];
  if (run && (run.status === "running" || run.status === "synthesizing") && lastActivityAt && now - lastActivityAt > STALL_MS) {
    drift.push({ type: "stalled", since: lastActivityAt, detail: `no activity for ${Math.round((now - lastActivityAt) / 60000)} minutes` });
  }
  if (gates.needsHuman > 0 || (input.inboxOpen ?? 0) > 0) {
    drift.push({
      type: "gates_waiting",
      detail: `${Math.max(gates.needsHuman, input.inboxOpen ?? 0)} item(s) waiting for the owner`,
    });
  }
  return {
    version: 1,
    generatedAt: now,
    facts: {
      status: run?.status ?? "draft",
      ...(run?.createdAt ? { startedAt: run.createdAt } : {}),
      ...(run?.createdAt ? { elapsedMs: now - run.createdAt } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      progress: { done, total: leaves.length },
      subtasks: leaves.map((subtask) => ({
        id: subtask.id,
        title: subtask.title,
        status: subtask.status,
        attempts: subtask.attempts,
        ...(subtask.gate?.status ? { gate: subtask.gate.status } : {}),
      })),
      gates,
      artifacts: [...artifacts].slice(0, 50),
      ...(input.closedAt ? { closedAt: input.closedAt } : {}),
      ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
      inboxOpen: input.inboxOpen ?? 0,
      ...(run?.charter
        ? {
            charter: {
              ...(run.charter.successCriteria ? { successCriteria: run.charter.successCriteria } : {}),
              ...(run.charter.nonGoals ? { nonGoals: run.charter.nonGoals } : {}),
              ...(run.charter.constraints ? { constraints: run.charter.constraints } : {}),
              ...(run.charter.deadline ? { deadline: run.charter.deadline } : {}),
              ...(run.charter.budgetCny ? { budgetCny: run.charter.budgetCny } : {}),
            },
          }
        : {}),
    },
    drift,
  };
}
