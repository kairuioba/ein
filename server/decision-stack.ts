// 工作台 v2 首页「决策栈」：把「需要你」收件箱 + 进行中的派单 run + 任务文件夹
// 投影成首页要的东西 —— 一句状态句、一叠按「风险 × 等待时长」排好的决策卡、
// 进行中/停滞的任务、以及口径统一的计数。
//
// 纯函数：不读文件、不碰 store、不调模型。路由只负责把三份快照传进来，
// 测试可以直接造数据。首页拿不到数据时宁可是空栈，也不能抛异常。
import type { DispatchRun, InboxItem } from "../shared/dispatch-types.ts";
import type { TaskFolderRecord } from "../shared/task-folders.ts";

export type DecisionRisk = "low" | "medium" | "high";
export type DecisionAction = "approve" | "reject" | "snooze";

/** 一张决策卡：老板要拍的一件事。 */
export interface DecisionCard {
  id: string;
  taskId?: string;
  runId?: string;
  subtaskId?: string;
  kind: InboxItem["kind"];
  title: string;
  reason: string;
  evidence: string[];
  risk: DecisionRisk;
  /** 已经等了多久（毫秒，按传入的 now 算，最小 0） */
  waitedMs: number;
  /** 批准后不可撤回（签收 / 接受门禁结果）：UI 应该用长按确认这类动作 */
  irreversible: boolean;
  actions: DecisionAction[];
  /** 通过之后会发生什么，给卡片上的一句人话 */
  approveEffect: string;
}

/** 一个还在跑的任务（首页「进行中」，异常单独标 stalled）。 */
export interface DecisionRunning {
  taskId?: string;
  title: string;
  status: string;
  progress: { done: number; total: number };
  stalled: boolean;
}

export interface DecisionStack {
  generatedAt: number;
  statusLine: string;
  cards: DecisionCard[];
  running: DecisionRunning[];
  counts: { waiting: number; running: number; stalled: number };
}

/** 30 分钟没动静就算停滞（和首页「卡住 35 分钟」那行一致）。 */
const STALL_MS = 30 * 60 * 1000;

const RISK_RANK: Record<DecisionRisk, number> = { high: 0, medium: 1, low: 2 };


/** 收件箱条目没带标题时的兜底文案 */
const KIND_TITLE: Record<InboxItem["kind"], string> = {
  signoff: "任务待签收",
  gate_failed: "验收未通过",
  question: "有一个问题等你回答",
  failed_exhausted: "任务重试已用尽",
  handoff_stuck: "交接卡住了",
};

/** 通过后会发生什么（门禁/签收两句是产品定稿文案，其余给一句合理的）。 */
const APPROVE_EFFECT: Record<InboxItem["kind"], string> = {
  signoff: "通过即完成",
  gate_failed: "通过后接受此结果",
  question: "通过即视为已答复，公司继续推进",
  failed_exhausted: "通过即接受失败，不再重试",
  handoff_stuck: "通过即视为已知悉；重发请在对话里让负责人处理",
};

/** 三种动作对四类条目都能落到现有的 resolve 语义上（approve/reject/abandon）。 */
const ACTIONS: DecisionAction[] = ["approve", "reject", "snooze"];

type Subtask = DispatchRun["subtasks"][number];

/** 门禁失败里「不是一句话能确认」的信号：证据链断了或已经送回重做过。 */
const GATE_SEVERE = /artifacts?|cannot verify|rework/i;

/** 按「风险 × 等待时长」给条目定风险。规则刻意简单、可由测试钉住。 */
function riskFor(item: InboxItem, subtask: Subtask | undefined): DecisionRisk {
  switch (item.kind) {
    case "signoff":
      // 签收是最后一道门：点通过就收工、任务窗口关掉，排最前。
      return "high";
    case "gate_failed": {
      // 门禁失败默认中风险；但当证据指向产物缺失/无法验证，或这个子任务
      // 已经被送回重做过（rework），说明结论不可靠，按高风险处理。
      const text = [item.title, item.reason, ...(item.evidence ?? []), subtask?.gate?.reason ?? ""].join("\n");
      if (GATE_SEVERE.test(text) || (subtask?.reworkCount ?? 0) > 0) return "high";
      return "medium";
    }
    case "question":
      // 只是问一句：答完就过，不会让公司停摆，中风险。
      return "medium";
    case "failed_exhausted":
      // 重试已用尽：dispatcher 已经自己停了，没有在等一个不可逆动作，
      // 老板可以放弃或重开（两者都可逆），所以排最低。
      return "low";
    default:
      return "medium";
  }
}

/** 通过后收不回来：签收会关掉任务，接受门禁会写 override 让结果算数。 */
function irreversibleFor(kind: InboxItem["kind"]): boolean {
  return kind === "signoff" || kind === "gate_failed";
}

function statusLineFor(waiting: number, running: number, stalled: number): string {
  if (waiting === 0 && running === 0) return "今天没有事找你了。";
  if (waiting === 0) {
    return stalled > 0
      ? `公司在自己运转。${running} 个任务在跑，其中 ${stalled} 个卡住了。`
      : `公司在自己运转。${running} 个任务在跑，没有事需要你拍板。`;
  }
  if (running === 0) return `公司安静下来了。${waiting} 件事等你拍板。`;
  const line = `公司在自己运转。${running} 个任务在跑，${waiting} 件事等你拍板。`;
  return stalled > 0 ? `${line}其中 ${stalled} 个任务停滞了。` : line;
}

/**
 * 从三份快照生成首页决策栈。`items` 按现有语义传 open 条目即可，这里也会
 * 滤掉 resolvedAt 的（幂等，路由传 all 也不会画出已处理的卡）。排序：
 * 风险 high→medium→low；同风险等待越久越靠前（waitedMs 降序）；再同则按
 * id 稳定排序，保证每次渲染顺序一致、测试可复现。
 */
export function buildDecisionStack(input: {
  items: InboxItem[];
  runs?: DispatchRun[];
  folders?: TaskFolderRecord[];
  now?: number;
}): DecisionStack {
  const now = input.now ?? Date.now();
  const runs = input.runs ?? [];
  const folders = input.folders ?? [];

  const runById = new Map(runs.map((run) => [run.id, run]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const folderByRun = new Map<string, TaskFolderRecord>();
  for (const folder of folders) if (folder.runId) folderByRun.set(folder.runId, folder);

  const cards: DecisionCard[] = [];
  for (const item of input.items) {
    if (item.resolvedAt) continue;
    const run = item.runId ? runById.get(item.runId) : undefined;
    const subtask = item.subtaskId ? run?.subtasks.find((entry) => entry.id === item.subtaskId) : undefined;
    // taskId 在收件箱里是「任务文件夹」id；老条目没带就顺着 run 找文件夹
    const folder = (item.taskId ? folderById.get(item.taskId) : undefined) ?? (item.runId ? folderByRun.get(item.runId) : undefined);
    const taskId = item.taskId ?? folder?.id;
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : now;
    cards.push({
      id: item.id,
      ...(taskId ? { taskId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.subtaskId ? { subtaskId: item.subtaskId } : {}),
      kind: item.kind,
      title: item.title || folder?.title || KIND_TITLE[item.kind],
      reason: item.reason,
      evidence: [...(item.evidence ?? [])],
      risk: riskFor(item, subtask),
      waitedMs: Math.max(0, now - createdAt),
      irreversible: irreversibleFor(item.kind),
      actions: [...ACTIONS],
      approveEffect: APPROVE_EFFECT[item.kind],
    });
  }
  cards.sort(
    (a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk] || b.waitedMs - a.waitedMs || a.id.localeCompare(b.id),
  );

  const running = runs
    .filter((run) => run.status === "running" || run.status === "synthesizing")
    .map((run) => {
      const folder = folderByRun.get(run.id);
      const updatedAt = Number.isFinite(run.updatedAt) ? run.updatedAt : 0;
      return {
        taskId: folder?.id,
        title: folder?.title || run.goal,
        status: run.status,
        progress: {
          done: run.subtasks.filter((subtask) => subtask.status === "done").length,
          total: run.subtasks.length,
        },
        // 只认 updatedAt：派单层每次推进都会 touch，30 分钟没动就是停滞
        stalled: updatedAt > 0 && now - updatedAt > STALL_MS,
        updatedAt,
      };
    })
    // 卡住的排前面（首页「异常」那一行），其余按最近活动排
    .sort((a, b) => Number(b.stalled) - Number(a.stalled) || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
    .map(({ taskId, title, status, progress, stalled }) => ({
      ...(taskId ? { taskId } : {}),
      title,
      status,
      progress,
      stalled,
    }));

  const waiting = cards.length;
  const stalled = running.filter((entry) => entry.stalled).length;
  return {
    generatedAt: now,
    statusLine: statusLineFor(waiting, running.length, stalled),
    cards,
    running,
    counts: { waiting, running: running.length, stalled },
  };
}

/** 首页的空栈兜底：路由出错时也返回一个可以渲染的首页，而不是 500。 */
export function emptyDecisionStack(now = Date.now()): DecisionStack {
  return {
    generatedAt: now,
    statusLine: "今天没有事找你了。",
    cards: [],
    running: [],
    counts: { waiting: 0, running: 0, stalled: 0 },
  };
}
