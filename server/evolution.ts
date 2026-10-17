// 自我进化 · 阶段 3：失败模式 → 改进提案闭环。
//
// 只读真实运行事实（派单复盘 + 进行中的派单/子任务），把它归并成可复用的
// 失败模式，再生成中文可读的改进提案交给老板批准/拒绝/缓办。本模块：
//   - 不调用任何模型，不做判断，不自动改代码、不自动发版；
//   - 提案只是「证据 + 建议」，决定权永远在老板；
//   - 同一种失败模式只会有一条未处理的提案（幂等），老板处理完才可能再提。
//
// 数据来源：
//   · retros —— server/dispatch.ts 的 recordRetro()：每次派单结束写入
//     ~/.ein/dispatch-retros.ndjson 的硬事实（状态/重试/模型/耗时）；
//   · runs —— 内存里的 DispatchRun：带 gate（验收闸门）、handoff（结构化
//     交接单）、criteria（验收标准）、reworkCount（被退回次数）等，复盘
//     记录里没有的字段以它为准。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DispatchRun, SubtaskGate } from "../shared/dispatch-types.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import type { DispatchRetro } from "./dispatch.ts";

/** 从真实数据里归并出的失败模式。 */
export type EvolutionPattern =
  | "missing_acceptance"
  | "missing_handoff"
  | "artifact_missing"
  | "rework_loop"
  | "stalled"
  | "failed_exhausted"
  | "model_mismatch";

/** 一条失败模式信号：同一 pattern 的所有证据归并在一起。 */
export interface EvolutionSignal {
  /** 稳定 id：同一 pattern 每次派生都相同，提案靠它做幂等 */
  id: string;
  pattern: EvolutionPattern;
  /** 可读的证据，最多 5 条 */
  evidence: string[];
  /** 命中次数（证据条数之外还可能是被折叠的同类） */
  count: number;
  lastSeenAt: number;
}

export type EvolutionArea = "prompt" | "plan_template" | "code" | "ui" | "process";
export type EvolutionRisk = "low" | "medium" | "high";
export type EvolutionStatus = "open" | "accepted" | "rejected" | "deferred";

/** 一个待老板处理的改进提案。proposeImprovements() 只产出 open 的。 */
export interface EvolutionProposal {
  id: string;
  signal: EvolutionPattern;
  title: string;
  why: string;
  suggestedChange: string;
  area: EvolutionArea;
  risk: EvolutionRisk;
  evidence: string[];
  status: "open";
}

/** 落盘后的一条提案：老板的决定（accepted/rejected/deferred）也记在这里。 */
export interface EvolutionItem extends Omit<EvolutionProposal, "status"> {
  status: EvolutionStatus;
  createdAt: number;
  resolvedAt?: number;
  note?: string;
}

const MAX_SIGNALS = 20;
const MAX_EVIDENCE = 5;
/** 与 server/state-doc.ts 的停滞口径一致：2 小时没有任何动静。 */
const STALL_MS = 2 * 60 * 60 * 1000;
/** dispatch 的默认重试上限（shared/dispatch-types.ts DEFAULT_DISPATCH_SETTINGS.maxAttempts）。 */
const DEFAULT_MAX_ATTEMPTS = 2;

export interface DeriveInput {
  retros?: readonly DispatchRetro[];
  runs?: readonly DispatchRun[];
  now?: number;
}

const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
};

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** 验收闸门 needs_human 的具体成因：产物找不到 / 没写交接单 / 标准没法判。 */
function gatePattern(gate: SubtaskGate | undefined): EvolutionPattern | null {
  if (gate?.status !== "needs_human") return null;
  if ((gate.deterministic ?? []).some((check) => check.name === "artifacts" && !check.ok)) return "artifact_missing";
  if ((gate.reason ?? "").includes("handoff envelope")) return "missing_handoff";
  return "missing_acceptance";
}

/** 从复盘记录与派单事实归并失败模式。没有数据时返回 []。 */
export function deriveSignals(input: DeriveInput = {}): EvolutionSignal[] {
  const now = input.now ?? Date.now();
  const retros = input.retros ?? [];
  const runs = input.runs ?? [];
  const found = new Map<EvolutionPattern, { evidence: string[]; count: number; lastSeenAt: number }>();
  const counted = new Set<string>();

  const add = (pattern: EvolutionPattern, evidence: string, at: number, key?: string) => {
    if (key) {
      if (counted.has(key)) return;
      counted.add(key);
    }
    const entry = found.get(pattern) ?? { evidence: [], count: 0, lastSeenAt: 0 };
    entry.count += 1;
    entry.lastSeenAt = Math.max(entry.lastSeenAt, at || now);
    if (entry.evidence.length < MAX_EVIDENCE && !entry.evidence.includes(evidence)) entry.evidence.push(evidence);
    found.set(pattern, entry);
  };

  // ── 进行中/最近的派单：带 gate/criteria/handoff/reworkCount 的一手事实 ──
  for (const run of runs) {
    const goal = clip(run.goal, 24);
    let lastActivityAt = run.updatedAt ?? run.createdAt ?? 0;
    let stalledSubtask = false;
    for (const subtask of run.subtasks) {
      // 部门主管的容器子任务不是叶子，它的团队子任务才是真正的活
      if (subtask.childRunId) continue;
      const title = clip(subtask.title, 30);
      const at = subtask.finishedAt ?? subtask.startedAt ?? run.updatedAt ?? now;
      lastActivityAt = Math.max(lastActivityAt, subtask.finishedAt ?? subtask.startedAt ?? 0);
      const key = (pattern: EvolutionPattern) => `${run.id}:${subtask.id}:${pattern}`;

      // 反复被老板退回：同一单退回 2 次以上就是派单/提示词的问题，不是运气
      const rework = subtask.reworkCount ?? 0;
      if (rework >= 2) {
        add(
          "rework_loop",
          `「${goal}」的「${title}」被退回 ${rework} 次${subtask.reworkNote ? `（最近一次：${clip(subtask.reworkNote, 40)}）` : ""}`,
          at,
          key("rework_loop"),
        );
      }

      // 重试耗尽仍失败：模型/难度/拆单需要调整
      if (subtask.status === "failed" && subtask.attempts >= DEFAULT_MAX_ATTEMPTS) {
        add(
          "failed_exhausted",
          `「${goal}」的「${title}」试了 ${subtask.attempts} 次仍失败${subtask.error ? `（${clip(subtask.error, 40)}）` : ""}`,
          at,
          key("failed_exhausted"),
        );
      }

      // 验收标准缺失：计划没写「怎么算完成」，或标准只能靠人判
      if ((subtask.status === "done" || subtask.status === "failed") && !subtask.criteria?.length && !subtask.acceptance?.trim()) {
        add("missing_acceptance", `「${goal}」的「${title}」没有写验收标准，只能人工判断算不算完成`, at, key("missing_acceptance"));
      } else if (gatePattern(subtask.gate) === "missing_acceptance") {
        add(
          "missing_acceptance",
          `「${goal}」的「${title}」的验收标准没法自动判定${subtask.gate?.reason ? `（${clip(subtask.gate.reason, 60)}）` : ""}`,
          at,
          key("missing_acceptance"),
        );
      }

      // 结构化交接单缺失：员工只给了自然语言，验收和后续接手都缺依据
      if (subtask.status === "done" && (!subtask.handoff || subtask.handoff.synthetic)) {
        add(
          "missing_handoff",
          `「${goal}」的「${title}」交付时没有写结构化交接单（小结/证据/产物/是否达标）`,
          at,
          key("missing_handoff"),
        );
      } else if (gatePattern(subtask.gate) === "missing_handoff") {
        add("missing_handoff", `「${goal}」的「${title}」因为没写结构化交接单，验收只能人工看`, at, key("missing_handoff"));
      }

      // 声明的产物找不到：交接单里写了路径，验收时不存在
      if (gatePattern(subtask.gate) === "artifact_missing") {
        const check = subtask.gate?.deterministic?.find((entry) => entry.name === "artifacts");
        add(
          "artifact_missing",
          `「${goal}」的「${title}」声明的产物找不到${check?.detail ? `（${clip(check.detail, 60)}）` : ""}`,
          at,
          key("artifact_missing"),
        );
      }

      // 单个子任务卡在同一处超过 2 小时
      if (subtask.status === "running" && subtask.startedAt && now - subtask.startedAt > STALL_MS) {
        stalledSubtask = true;
        add(
          "stalled",
          `「${goal}」的「${title}」已经跑了 ${minutes(now - subtask.startedAt)} 分钟没有任何进展`,
          now,
          key("stalled"),
        );
      }
    }

    // 整单停摆：还在进行中，但 2 小时没有任何活动（子任务已单独记过就不再重复）
    if (!stalledSubtask && (run.status === "running" || run.status === "synthesizing") && lastActivityAt && now - lastActivityAt > STALL_MS) {
      add("stalled", `「${goal}」已经 ${minutes(now - lastActivityAt)} 分钟没有任何进展`, lastActivityAt, `${run.id}:run:stalled`);
    }
  }

  // ── 复盘记录：历史硬事实（重试耗尽 / 超长任务 / 换模型才对） ──
  for (const retro of retros) {
    const goal = clip(retro.goal, 24);
    const at = retro.finishedAt || retro.at || now;
    for (const subtask of retro.subtasks) {
      const title = clip(subtask.title, 30);
      if (subtask.status === "failed" && subtask.attempts >= DEFAULT_MAX_ATTEMPTS) {
        add(
          "failed_exhausted",
          `复盘：「${goal}」的「${title}」试了 ${subtask.attempts} 次仍失败`,
          at,
          `${retro.runId}:${subtask.id}:failed_exhausted`,
        );
      }
    }
    if (retro.durationMs && retro.durationMs > STALL_MS) {
      add("stalled", `复盘：「${goal}」总共跑了 ${Math.round(retro.durationMs / 3_600_000)} 小时才结束`, at, `${retro.runId}:retro:stalled`);
    }
  }

  // ── 模型能力不匹配：同一角色在一个模型上失败、换另一个模型后成功 ──
  const byRole = new Map<string, { failed: Set<string>; done: Set<string> }>();
  for (const retro of retros) {
    for (const subtask of retro.subtasks) {
      const model = subtask.ranWith?.model;
      if (!model) continue;
      const role = (subtask.role || subtask.title).trim();
      if (!role) continue;
      const entry = byRole.get(role) ?? { failed: new Set<string>(), done: new Set<string>() };
      if (subtask.status === "failed") entry.failed.add(model);
      else if (subtask.status === "done") entry.done.add(model);
      byRole.set(role, entry);
    }
  }
  for (const [role, entry] of byRole) {
    const failedOnly = [...entry.failed].filter((model) => !entry.done.has(model));
    if (!failedOnly.length) continue;
    // 成功过的模型里挑一个和失败模型不同的（任一即可，证据里点名）
    const worked = [...entry.done].find((model) => model !== failedOnly[0]);
    if (!worked) continue;
    add(
      "model_mismatch",
      `「${clip(role, 20)}」在 ${clip(failedOnly[0]!, 24)} 上失败，换到 ${clip(worked, 24)} 后交付成功`,
      Math.max(...retros.map((retro) => retro.finishedAt || retro.at || 0)),
    );
  }

  return [...found.entries()]
    .map(([pattern, entry]) => ({
      id: `signal-${pattern}`,
      pattern,
      evidence: entry.evidence,
      count: entry.count,
      lastSeenAt: entry.lastSeenAt || now,
    }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, MAX_SIGNALS);
}

interface ProposalTemplate {
  title: string;
  /** why 里可以用 {count} 和 {first}（第一条证据） */
  why: string;
  suggestedChange: string;
  area: EvolutionArea;
  risk: EvolutionRisk;
}

const TEMPLATES: Record<EvolutionPattern, ProposalTemplate> = {
  missing_acceptance: {
    title: "计划缺少可验收的标准",
    why: "有 {count} 处交付在结束时没有可判定的验收标准，只能靠人反复确认，拖慢收尾也容易把「做完了」当成「做好了」。第一条证据：{first}",
    suggestedChange:
      "在规划提示词里要求每个子任务写 1–3 条可判定的验收标准（可运行命令 / 文件路径 / 字数 / 清单），提交计划前由总控自检；旧任务不追溯。",
    area: "prompt",
    risk: "low",
  },
  missing_handoff: {
    title: "员工交付缺少结构化交接单",
    why: "有 {count} 次交付只给了自然语言，没有交接单（小结/证据/产物/是否达标），验收和后续接手都缺依据。第一条证据：{first}",
    suggestedChange:
      "在员工提示词与退回反馈里固定要求交接单信封；没写就提示补交。对能力较弱的模型仍保留人工验收，不静默通过。",
    area: "prompt",
    risk: "low",
  },
  artifact_missing: {
    title: "交接单声明的产物找不到",
    why: "有 {count} 次交付声明了产物路径，但验收时路径不存在——多半是写到了别处或根本没写。第一条证据：{first}",
    suggestedChange:
      "规划时要求子任务写明产物相对工作目录的路径；验收前自动检查路径是否存在，缺失就以「产物缺失」为明确理由退回，并附上期望路径。",
    area: "code",
    risk: "low",
  },
  rework_loop: {
    title: "子任务反复被退回",
    why: "有 {count} 次子任务被退回两次以上：同一份要求反复返工，说明计划或提示词没把标准说清楚。第一条证据：{first}",
    suggestedChange:
      "退回时把老板的话转成结构化修改清单，注入下一次提示词；同一子任务退回 3 次自动升级为人工拆单或换模型，而不是原样重跑。",
    area: "process",
    risk: "medium",
  },
  stalled: {
    title: "任务长时间没有进展",
    why: "有 {count} 处任务超过 2 小时没有任何活动：要么卡住了没人知道，要么一开始就拆得太粗。第一条证据：{first}",
    suggestedChange:
      "超过 2 小时无活动的任务自动标记停滞并上报主管/老板；派单时给长任务设中途检查点（阶段交付 + 验收），别等最后才发现卡住。",
    area: "code",
    risk: "medium",
  },
  failed_exhausted: {
    title: "子任务重试耗尽后失败",
    why: "有 {count} 个子任务把重试次数用光仍然失败，继续原样重试没有意义。第一条证据：{first}",
    suggestedChange:
      "失败耗尽时自动附上最后一次错误 + 建议换用的模型/强度，让老板一键换人重试；推荐器按「角色 + 模型 + 历史成功率」优先选择成功过的组合。",
    area: "process",
    risk: "medium",
  },
  model_mismatch: {
    title: "同一角色换模型后才成功",
    why: "有 {count} 个角色在某个模型上失败、换另一个模型后交付成功：模型能力和任务难度不匹配。第一条证据：{first}",
    suggestedChange:
      "把「角色 + 模型 + 成功率」记入派单建议器：同一角色在某模型上连续失败时优先推荐成功过的模型，并在计划卡片里写明依据。",
    area: "code",
    risk: "medium",
  },
};

/** 每个信号生成一条中文可读的提案（证据原样带出，方便老板核对）。 */
export function proposeImprovements(signals: readonly EvolutionSignal[]): EvolutionProposal[] {
  return signals.map((signal) => {
    const template = TEMPLATES[signal.pattern];
    const first = signal.evidence[0] ?? "（无细节证据）";
    return {
      id: `evo-${newId()}`,
      signal: signal.pattern,
      title: template.title,
      why: template.why.replace("{count}", String(signal.count)).replace("{first}", first),
      suggestedChange: template.suggestedChange,
      area: template.area,
      risk: template.risk,
      evidence: signal.evidence.slice(0, MAX_EVIDENCE),
      status: "open" as const,
    };
  });
}

const FILE = "evolution.json";
const MAX_ITEMS = 200;

/** 提案的持久化：~/.ein/evolution.json，只追加 + 记录老板的决定。 */
export class EvolutionStore {
  private readonly file: string;
  private items: EvolutionItem[] = [];

  constructor(dataDir = DATA_DIR) {
    this.file = join(dataDir, FILE);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      this.items = Array.isArray(raw)
        ? (raw as EvolutionItem[]).filter(
            (item) =>
              Boolean(item) &&
              typeof item.id === "string" &&
              typeof item.signal === "string" &&
              typeof item.title === "string",
          )
        : [];
    } catch (error) {
      console.error("evolution: could not read the file, starting empty", error);
      this.items = [];
    }
  }

  private save(): void {
    this.items = this.items.slice(-MAX_ITEMS);
    try {
      writeFileAtomic(this.file, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("evolution: could not persist", error);
    }
  }

  /** 追加提案。同一失败模式已有未处理的提案时跳过（幂等，不重复打扰老板）。 */
  append(proposals: readonly EvolutionProposal[], now = Date.now()): { added: EvolutionItem[]; skipped: number } {
    const added: EvolutionItem[] = [];
    let skipped = 0;
    for (const proposal of proposals) {
      if (this.items.some((item) => item.status === "open" && item.signal === proposal.signal)) {
        skipped += 1;
        continue;
      }
      const item: EvolutionItem = { ...proposal, status: "open", createdAt: now };
      this.items.push(item);
      added.push(item);
    }
    if (added.length) this.save();
    return { added, skipped };
  }

  list(status: "all" | EvolutionStatus = "all"): EvolutionItem[] {
    return this.items.filter((item) => (status === "all" ? true : item.status === status));
  }

  byId(id: string): EvolutionItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** 记录老板的决定。已经处理过的提案保持第一次的决定（幂等）。 */
  resolve(id: string, status: Exclude<EvolutionStatus, "open">, note?: string): EvolutionItem | { error: string } {
    const item = this.byId(id);
    if (!item) return { error: "no such evolution proposal" };
    if (item.status !== "open") return item;
    item.status = status;
    item.resolvedAt = Date.now();
    const trimmed = note?.trim();
    if (trimmed) item.note = trimmed.slice(0, 500);
    this.save();
    return item;
  }
}
