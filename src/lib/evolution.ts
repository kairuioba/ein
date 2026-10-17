// 自我进化 · 阶段 3 的客户端数据层：读提案、记决定。
//
// 服务端（server/evolution.ts）已经从复盘与派单事实里归并出失败模式并生成
// 中文提案；这一层只做三件事：
//   - useEvolution()：轮询 GET /api/evolution（signals + proposals + open）；
//   - resolveEvolutionProposal()：老板拍板 POST /api/evolution/:id/resolve；
//   - 几个纯格式化/挑选函数，让卡片保持简单、可单测。
//
// 服务端类型刻意在客户端重写一份（而不是 import server/）：这里是 wire
// 契约，只保留卡片用得到的字段；字段名与服务端保持一致。
import { refreshApi, useApi } from "@/state/org-api";

export type EvolutionArea = "prompt" | "plan_template" | "code" | "ui" | "process";
export type EvolutionRisk = "low" | "medium" | "high";
export type EvolutionStatus = "open" | "accepted" | "rejected" | "deferred";

/** 一条失败模式信号（GET 返回的 signals；卡片目前只展示提案，保留类型完整性）。 */
export interface EvolutionSignal {
  id: string;
  pattern: string;
  evidence: string[];
  count: number;
  lastSeenAt: number;
}

/** 一条改进提案 + 老板的决定（服务端 EvolutionItem 的线上形状）。 */
export interface EvolutionProposal {
  id: string;
  signal: string;
  title: string;
  why: string;
  suggestedChange: string;
  area: EvolutionArea;
  risk: EvolutionRisk;
  evidence: string[];
  status: EvolutionStatus;
  createdAt: number;
  resolvedAt?: number;
  note?: string;
}

export interface EvolutionFeed {
  signals: EvolutionSignal[];
  proposals: EvolutionProposal[];
  /** 服务端算好的待决定数（proposals 里 status === "open" 的条数）。 */
  open: number;
}

export const EMPTY_EVOLUTION: EvolutionFeed = { signals: [], proposals: [], open: 0 };

/** 老板的三个决定。 */
export type EvolutionDecision = Exclude<EvolutionStatus, "open">;

/** 提案列表：简报页只有一张卡，靠它拿数据；写入后 refreshApi 会让所有
 * 挂载中的副本重新拉取，所以卡片自己不需要再管缓存。 */
export function useEvolution(intervalMs = 15_000) {
  return useApi<EvolutionFeed>("/api/evolution", EMPTY_EVOLUTION, intervalMs);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(typeof payload.error === "string" && payload.error ? payload.error : `${res.status}`);
  return payload as T;
}

/** 记下老板的决定（accepted / rejected / deferred，rejected 可带一句原因）。
 * 成功后立刻让挂载中的 /api/evolution 重新拉取：卡片会消失或换成下一条。 */
export async function resolveEvolutionProposal(
  id: string,
  status: EvolutionDecision,
  note?: string,
): Promise<void> {
  const trimmed = note?.trim();
  await postJson(`/api/evolution/${encodeURIComponent(id)}/resolve`, {
    status,
    ...(trimmed ? { note: trimmed } : {}),
  });
  await refreshApi("/api/evolution");
}

/** 所有待决定的提案，保持服务端顺序。 */
export function openProposals(feed: EvolutionFeed): EvolutionProposal[] {
  return feed.proposals.filter((proposal) => proposal?.status === "open");
}

const RISK_RANK: Record<EvolutionRisk, number> = { high: 0, medium: 1, low: 2 };

/** 卡片展示的那一条：风险高者优先，同风险先来先见（createdAt 早者优先）。
 * 后端目前没有 priority 字段，这是对「最高优先」的确定性解释；ties 时
 * 保持插入顺序（服务端按信号强度生成提案，越早入库越值得先看）。
 * `skip` 用来在拍板后、刷新返回前先隐藏刚处理的那条。 */
export function topOpenProposal(
  feed: EvolutionFeed,
  skip?: ReadonlySet<string>,
): EvolutionProposal | null {
  const open = openProposals(feed).filter((proposal) => !skip?.has(proposal.id));
  if (!open.length) return null;
  return [...open].sort(
    (a, b) =>
      (RISK_RANK[a.risk] ?? 3) - (RISK_RANK[b.risk] ?? 3) || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  )[0]!;
}

/** why 截断：折叠时最多 120 字（按 Unicode 字符计，英文/中文/emoji 一致），
 * 超出以省略号结尾；空白压成单空格，避免换行把卡片撑高。 */
export function clipWhy(why: string, max = 120): string {
  const flat = String(why ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** 证据列表：去掉空行与重复，最多 `max` 条（需求是 3 条）。 */
export function evidenceLines(
  proposal: Pick<EvolutionProposal, "evidence">,
  max = 3,
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of proposal?.evidence ?? []) {
    if (typeof raw !== "string") continue;
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= max) break;
  }
  return lines;
}
