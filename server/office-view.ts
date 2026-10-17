// 项目内「AI 协同办公」只读投影：老板打开一个项目（task folder）时看到的
// 目标/进度、部门+成员实时状态、此刻谁在等谁、待拍板、活动流、异常。
//
// 纪律：所有状态一律由 dispatch 的事实字段推导（subtask.status / gate /
// dependsOn / startedAt·finishedAt / attempts·reworkCount / inbox），绝不放
// bot 自述的「我在忙」。纯函数：路由只把 store 快照传进来，测试直接造数据。
import type { DispatchRun, InboxItem } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";
import { buildDecisionStack, type DecisionRisk } from "./decision-stack.ts";

/** 成员状态：由数据推导，不落库、不允许自述。 */
export type OfficePresence = "working" | "waiting" | "reviewing" | "blocked" | "idle";

/** 参与投影的最小 bot 形状（store.bots 的投影）。 */
export interface OfficeBot {
  id: string;
  name: string;
  title?: string;
  /** bot.section：部门就是侧栏的 section */
  section?: string;
  chiefOfStaff?: boolean;
  /** 当前所属任务；有值时说明这个 bot 正在这个项目里 */
  currentTaskId?: string;
}

export interface OfficeMember {
  botId: string;
  name: string;
  title?: string;
  presence: OfficePresence;
  /** 此刻在做的事（子任务标题 / 项目统筹） */
  current?: string;
  /** presence=waiting/reviewing 时在等谁 */
  waitingOn?: string;
}

export interface OfficeDepartment {
  /** 部门名 = bot.section；没有 section 的归「未分组」 */
  name: string;
  members: OfficeMember[];
}

/** 「此刻谁在等谁」的一行：from 在等 to 接手 item 这件事。 */
export interface OfficeWait {
  from: { botId?: string; name: string };
  to: { botId?: string; name: string };
  /** 等的那件事（下游子任务标题） */
  item: string;
  /** 依赖项当前状态（running/pending/failed…），或 "handoff" = 交接已交出等下游接收 */
  status: string;
  since: number;
  minutes: number;
}

/** 待拍板卡：字段从 InboxItem 投影（风险规则复用 decision-stack）。 */
export interface OfficeDecision {
  id: string;
  kind: InboxItem["kind"];
  title: string;
  reason: string;
  evidence: string[];
  risk: DecisionRisk;
}

export type OfficeActivityKind = "started" | "done" | "failed" | "gate" | "rework" | "retry" | "finished";

export interface OfficeActivity {
  at: number;
  kind: OfficeActivityKind;
  actor: string;
  summary: string;
}

export type OfficeAnomalyKind = "failed" | "needs_human" | "rework" | "stalled";

export interface OfficeAnomaly {
  subtaskId: string;
  title: string;
  kind: OfficeAnomalyKind;
  detail: string;
}

export interface ProjectOffice {
  project: {
    id: string;
    title: string;
    /** 与侧栏 task folder 的 status 同一口径：draft/running/done/failed/canceled */
    status: string;
    goal?: string;
    leadBotId?: string;
    leadName?: string;
    progress: { done: number; total: number };
    closedAt?: number;
    acceptedAt?: number;
  };
  departments: OfficeDepartment[];
  now: { waiting: OfficeWait[] };
  decisions: OfficeDecision[];
  activity: OfficeActivity[];
  anomalies: OfficeAnomaly[];
}

export interface ProjectOfficeInput {
  folder: TaskFolderRecord;
  run?: DispatchRun;
  /** 全公司 bot 的轻量投影；投影自己挑出这个项目的成员 */
  bots: OfficeBot[];
  /** 已经按 taskId 过滤好、或没过滤都行：这里会再按 folder.id 过滤一次 */
  inboxItems: InboxItem[];
  now?: number;
}

type Subtask = DispatchRun["subtasks"][number];

/** 30 分钟没活动就算停滞（与首页决策栈同一口径）。 */
const STALL_MS = 30 * 60 * 1000;
const MAX_ACTIVITY = 20;
const UNGROUPED = "未分组";
const NO_LEAD = "?";

const clip = (text: string, max: number): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** 和 index.ts 的 taskFolderStatus 保持同一口径（侧栏/首页/项目页共用一个状态）。 */
function taskFolderStatus(run: DispatchRun | undefined): string {
  if (!run) return "draft";
  switch (run.status) {
    case "running":
    case "awaiting-approval":
    case "synthesizing":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "draft";
  }
}

/** 某个子任务最近一次有动静的时间：完成 > 开始 > run 的最后活动 > 项目创建。 */
function lastActivityOf(subtask: Subtask, run: DispatchRun | undefined, folder: TaskFolderRecord, now: number): number {
  return subtask.finishedAt ?? subtask.startedAt ?? run?.updatedAt ?? folder.createdAt ?? now;
}

/** 成员状态推导（唯一入口：不由任何自述字段决定）。 */
function presenceFor(
  botId: string,
  subtasks: readonly Subtask[],
  leadBotId: string | undefined,
  run: DispatchRun | undefined,
  nameOf: (botId?: string) => string,
): { presence: OfficePresence; current?: string; waitingOn?: string } {
  const own = subtasks.filter((subtask) => subtask.assigneeBotId === botId);
  // 1) 有正在跑的子任务 → 工作中
  const running = own.find((subtask) => subtask.status === "running");
  if (running) return { presence: "working", current: running.title };
  // 项目负责人没有自己的子任务时，run 还活着就说明它在统筹/汇总/等批准
  if (!own.length && botId === leadBotId && run && taskFolderStatus(run) === "running") {
    return { presence: "working", current: "统筹项目" };
  }
  // 2) 做完了但下游还没开工 → 等待（等下游接手）；产出还在等评审 → 等待
  for (const subtask of own) {
    if (subtask.status !== "done") continue;
    const dependent = subtasks.find(
      (entry) => entry.dependsOn.includes(subtask.id) && (entry.status === "pending" || entry.status === "running"),
    );
    if (dependent) return { presence: "waiting", current: subtask.title, waitingOn: nameOf(dependent.assigneeBotId) };
  }
  for (const subtask of own) {
    if (subtask.status !== "done") continue;
    // 门禁判定没过 / 还没人评审：产出自检没过在等老板拍板，provisional 在等评审
    if (subtask.gate?.status === "fail") return { presence: "waiting", current: subtask.title, waitingOn: "老板" };
    if (subtask.gate?.provisional) return { presence: "waiting", current: subtask.title, waitingOn: subtask.reviewer || "评审" };
  }
  // 3) gate needs_human → 评审中（等人工评审）
  const review = own.find((subtask) => subtask.status === "done" && subtask.gate?.status === "needs_human");
  if (review) return { presence: "reviewing", current: review.title, waitingOn: review.reviewer || "评审" };
  // 4) 失败 → 受阻
  const failed = own.find((subtask) => subtask.status === "failed");
  if (failed) return { presence: "blocked", current: failed.title };
  return { presence: "idle" };
}

/** 等待链：pending 子任务被哪些依赖挡着 + 已交出的 handoff 在等谁接收。 */
function waitingChains(
  subtasks: readonly Subtask[],
  run: DispatchRun | undefined,
  folder: TaskFolderRecord,
  now: number,
  nameOf: (botId?: string) => string,
): OfficeWait[] {
  const rows: OfficeWait[] = [];
  const seen = new Set<string>();
  for (const pending of subtasks) {
    if (pending.status !== "pending") continue;
    for (const dependencyId of pending.dependsOn) {
      const dependency = subtasks.find((entry) => entry.id === dependencyId);
      if (!dependency) continue;
      const incomplete = dependency.status !== "done" && dependency.status !== "skipped";
      const handoff = !incomplete && dependency.status === "done" && Boolean(dependency.handoff);
      if (!incomplete && !handoff) continue;
      const key = `${dependency.id}->${pending.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const since = lastActivityOf(dependency, run, folder, now);
      rows.push({
        from: { botId: dependency.assigneeBotId, name: nameOf(dependency.assigneeBotId) },
        to: { botId: pending.assigneeBotId, name: nameOf(pending.assigneeBotId) },
        item: pending.title,
        status: handoff ? "handoff" : dependency.status,
        since,
        minutes: Math.max(0, Math.round((now - since) / 60_000)),
      });
    }
  }
  // 等得最久的先露出来
  return rows.sort((a, b) => b.minutes - a.minutes || a.item.localeCompare(b.item));
}

/** 待拍板：复用首页决策栈的风险/排序规则，只留项目页要的字段。 */
function decisionsFor(
  folder: TaskFolderRecord,
  run: DispatchRun | undefined,
  inboxItems: readonly InboxItem[],
  now: number,
): OfficeDecision[] {
  const open = inboxItems.filter((item) => !item.resolvedAt && item.taskId === folder.id);
  if (!open.length) return [];
  return buildDecisionStack({
    items: open,
    ...(run ? { runs: [run] } : {}),
    folders: [folder],
    now,
  }).cards.map((card) => ({
    id: card.id,
    kind: card.kind,
    title: card.title,
    reason: card.reason,
    evidence: card.evidence,
    risk: card.risk,
  }));
}

/** 活动流：从生命周期字段推导，最多 20 条，新→旧。 */
function activityFor(
  run: DispatchRun | undefined,
  subtasks: readonly Subtask[],
  nameOf: (botId?: string) => string,
): OfficeActivity[] {
  const rows: OfficeActivity[] = [];
  const push = (at: number | undefined, kind: OfficeActivityKind, actor: string, summary: string) => {
    if (!at || !Number.isFinite(at)) return;
    rows.push({ at, kind, actor, summary });
  };
  if (run) {
    const chief = nameOf(run.chiefBotId);
    push(run.createdAt, "started", chief, `项目启动：${clip(run.goal, 100)}`);
    if (run.finishedAt) {
      const summary =
        run.status === "done"
          ? `项目完成${run.report ? `：${clip(run.report, 120)}` : ""}`
          : run.status === "failed"
            ? "项目失败"
            : "项目已取消";
      push(run.finishedAt, "finished", chief, summary);
    }
  }
  for (const subtask of subtasks) {
    const actor = nameOf(subtask.assigneeBotId);
    const title = clip(subtask.title, 60);
    push(subtask.startedAt, "started", actor, `开始「${title}」`);
    if (subtask.attempts > 1) {
      push(subtask.startedAt ?? subtask.finishedAt, "retry", actor, `「${title}」第 ${subtask.attempts} 次尝试`);
    }
    if ((subtask.reworkCount ?? 0) > 0) {
      push(subtask.finishedAt ?? subtask.startedAt, "rework", actor, `「${title}」被打回 ${subtask.reworkCount} 次`);
    }
    if (subtask.finishedAt && subtask.status === "done") {
      const handoff = subtask.handoff;
      push(
        subtask.finishedAt,
        "done",
        actor,
        handoff?.summary ? `完成「${title}」：${clip(handoff.summary, 100)}` : `完成「${title}」`,
      );
    } else if (subtask.finishedAt && subtask.status === "failed") {
      push(
        subtask.finishedAt,
        "failed",
        actor,
        `「${title}」失败${subtask.error ? `：${clip(subtask.error, 80)}` : ""}`,
      );
    }
    if (subtask.gate && subtask.gate.status !== "pass") {
      const verdict = subtask.gate.status === "needs_human" ? "需要人看" : "未通过";
      push(
        subtask.gate.at,
        "gate",
        subtask.reviewer || actor,
        `「${title}」验收${verdict}${subtask.gate.reason ? `：${clip(subtask.gate.reason, 80)}` : ""}`,
      );
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY);
}

/** 异常：失败 / 门禁没过 / 打回未解决 / 停滞。每条都带原因字段供「看原因」。 */
function anomaliesFor(
  folder: TaskFolderRecord,
  run: DispatchRun | undefined,
  subtasks: readonly Subtask[],
  now: number,
): OfficeAnomaly[] {
  const rows: OfficeAnomaly[] = [];
  const active = run?.status === "running" || run?.status === "synthesizing";
  for (const subtask of subtasks) {
    if (subtask.status === "failed") {
      rows.push({
        subtaskId: subtask.id,
        title: subtask.title,
        kind: "failed",
        detail: subtask.error ? clip(subtask.error, 160) : "子任务失败",
      });
    }
    if (subtask.gate && subtask.gate.status !== "pass") {
      rows.push({
        subtaskId: subtask.id,
        title: subtask.title,
        kind: "needs_human",
        detail:
          subtask.gate.reason?.trim() ||
          (subtask.gate.status === "needs_human" ? "验收需要人工决定" : "验收未通过"),
      });
    }
    // 打回过的记录本身不是异常；只有「还没干净通过」时才值得老板看
    const reworkCount = subtask.reworkCount ?? 0;
    const clean = subtask.status === "done" && (!subtask.gate || subtask.gate.status === "pass");
    if (reworkCount > 0 && !clean) {
      rows.push({
        subtaskId: subtask.id,
        title: subtask.title,
        kind: "rework",
        detail: `被打回 ${reworkCount} 次，仍未通过`,
      });
    }
    if (active && subtask.status === "running") {
      const since = Math.max(subtask.startedAt ?? 0, run?.updatedAt ?? 0, folder.createdAt ?? 0);
      if (since > 0 && now - since > STALL_MS) {
        rows.push({
          subtaskId: subtask.id,
          title: subtask.title,
          kind: "stalled",
          detail: `已 ${Math.round((now - since) / 60_000)} 分钟没有进展`,
        });
      }
    }
  }
  return rows;
}

/**
 * 生成项目内办公工作台的数据。`bots` 传全公司快照即可：成员 = 项目负责人 +
 * 所有子任务执行人 + 中途加入的小组（数据里查不到的 bot 用 id 占位，不静默
 * 丢人）。没有 run 的手工项目（draft）也能返回可渲染的空骨架。
 */
export function buildProjectOffice(input: ProjectOfficeInput): ProjectOffice {
  const now = input.now ?? Date.now();
  const { folder, run } = input;
  const subtasks = run?.subtasks ?? [];
  const botById = new Map(input.bots.map((bot) => [bot.id, bot]));
  const nameOf = (botId?: string): string => (botId ? botById.get(botId)?.name || botId : NO_LEAD);

  // 成员顺序：负责人 → 子任务执行人（计划顺序）→ 中途加入的小组
  const memberIds: string[] = [];
  const addMember = (botId?: string) => {
    if (botId && !memberIds.includes(botId)) memberIds.push(botId);
  };
  addMember(folder.leadBotId);
  for (const subtask of subtasks) addMember(subtask.assigneeBotId);
  for (const squad of run?.squads ?? []) for (const botId of squad.botIds) addMember(botId);

  const departments: OfficeDepartment[] = [];
  const byDepartment = new Map<string, OfficeDepartment>();
  for (const botId of memberIds) {
    const bot = botById.get(botId);
    const name = bot?.name || botId;
    const department = bot?.section?.trim() || UNGROUPED;
    const derived = presenceFor(botId, subtasks, folder.leadBotId, run, nameOf);
    let group = byDepartment.get(department);
    if (!group) {
      group = { name: department, members: [] };
      byDepartment.set(department, group);
      departments.push(group);
    }
    group.members.push({
      botId,
      name,
      ...(bot?.title ? { title: bot.title } : {}),
      presence: derived.presence,
      ...(derived.current ? { current: derived.current } : {}),
      ...(derived.waitingOn ? { waitingOn: derived.waitingOn } : {}),
    });
  }

  // 进度与侧栏同一口径：只数叶子（子 run 的那条由子 run 自己汇报，避免双算）
  const leaves = subtasks.filter((subtask) => !subtask.childRunId);
  const progress = {
    done: leaves.filter((subtask) => subtask.status === "done").length,
    total: leaves.length,
  };

  const lead = folder.leadBotId ? botById.get(folder.leadBotId) : undefined;
  return {
    project: {
      id: folder.id,
      title: folder.title,
      status: taskFolderStatus(run),
      ...(run?.goal ? { goal: run.goal } : {}),
      ...(folder.leadBotId ? { leadBotId: folder.leadBotId } : {}),
      ...(lead?.name ? { leadName: lead.name } : {}),
      progress,
      ...(run?.finishedAt && run.status !== "running" && run.status !== "synthesizing" && run.status !== "awaiting-approval"
        ? { closedAt: run.finishedAt }
        : {}),
      ...(folder.acceptedAt ? { acceptedAt: folder.acceptedAt } : {}),
    },
    departments,
    now: { waiting: waitingChains(subtasks, run, folder, now, nameOf) },
    decisions: decisionsFor(folder, run, input.inboxItems, now),
    activity: activityFor(run, subtasks, nameOf),
    anomalies: anomaliesFor(folder, run, subtasks, now),
  };
}

/** 投影失败/手工空项目时的骨架：项目页永远有东西可渲染。 */
export function emptyProjectOffice(folder: TaskFolderRecord): ProjectOffice {
  return {
    project: {
      id: folder.id,
      title: folder.title,
      status: "draft",
      progress: { done: 0, total: 0 },
      ...(folder.leadBotId ? { leadBotId: folder.leadBotId } : {}),
    },
    departments: [],
    now: { waiting: [] },
    decisions: [],
    activity: [],
    anomalies: [],
  };
}
