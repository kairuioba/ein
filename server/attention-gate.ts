// 注意力闸门：老板的手机每天只该被打断 3 次。所有判断都是代码规则，
// 不调用模型；模型只允许写「一句话摘要」，不允许决定是否打扰老板。
//
// 分流四类：push（推送打扰）/ inbox（进收件箱）/ auto（可自动处理）/
// archive（无下游依赖的建议，24h 后归档）。推送必须同时满足「不可逆或高影响」
// 和「超时没有无害默认动作」；自动处理必须有历史批准、可回滚、当天额度未满。
export type AttentionClass = "push" | "inbox" | "auto" | "archive";
export type CardRisk = "low" | "medium" | "high" | "critical";
export type BlastRadius = "internal" | "external" | "money" | "prod";

export interface AttentionCard {
  id: string;
  risk: CardRisk;
  irreversible?: boolean;
  blastRadius?: BlastRadius;
  /** 超时后是否存在无害默认动作（存在 = 不值得打扰） */
  hasSafeDefault?: boolean;
  waitAgeMs?: number;
  slaMs?: number;
  /** 有多少条下游在等这张卡 */
  blockedDownstream?: number;
  /** 同一动作类型 + 项目的历史（用于自动批准规则） */
  actionType?: string;
  projectId?: string;
  causeFingerprint?: string;
  createdAt?: number;
  /** 可程序化回滚；默认 = 不可逆取反 */
  reversible?: boolean;
  /** 建议型卡片（无下游依赖），24h 无动作可归档 */
  suggestion?: boolean;
}

export interface AttentionHistory {
  approvals?: number;
  rejections?: number;
  reverted?: boolean;
  autoApprovedToday?: number;
  autoApprovalCap?: number;
}

const BLAST = new Set<BlastRadius>(["external", "money", "prod"]);
const RISK_ORDER: Record<CardRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const DAY = 24 * 60 * 60 * 1000;

const isReversible = (card: AttentionCard): boolean => card.reversible ?? !card.irreversible;
const highImpact = (card: AttentionCard): boolean => Boolean(card.irreversible) || (card.blastRadius ? BLAST.has(card.blastRadius) : false);

/** 每天 ≤3 次推送；预算耗尽后只有 critical 还能推。 */
export function classify(card: AttentionCard, history: AttentionHistory = {}): { kind: AttentionClass; reasons: string[] } {
  const reasons: string[] = [];
  const cap = history.autoApprovalCap ?? 20;
  const reversible = isReversible(card);
  const historyClean = (history.approvals ?? 0) >= 5 && (history.rejections ?? 0) === 0 && !history.reverted;
  const autoEligible =
    reversible &&
    (!card.blastRadius || card.blastRadius === "internal") &&
    !highImpact(card) &&
    historyClean &&
    (history.autoApprovedToday ?? 0) < cap;
  if (autoEligible) {
    reasons.push("reversible, internal, previously approved, under the daily cap");
    return { kind: "auto", reasons };
  }
  if (history.reverted) reasons.push("a previous automatic approval was reverted → back to manual");
  if (!reversible || highImpact(card)) {
    reasons.push("irreversible or external impact");
    if (card.hasSafeDefault === false) {
      reasons.push("no safe default on timeout → push");
      return { kind: "push", reasons };
    }
    reasons.push("safe default exists → inbox, do not interrupt");
    return { kind: "inbox", reasons };
  }
  const waitAge = card.waitAgeMs ?? 0;
  if (card.suggestion && (card.blockedDownstream ?? 0) === 0 && waitAge > DAY) {
    reasons.push("suggestion with no downstream and older than 24h → archive");
    return { kind: "archive", reasons };
  }
  if ((card.slaMs ?? 0) > 0 && waitAge > (card.slaMs ?? 0)) reasons.push("past its SLA");
  reasons.push("reversible internal matter → inbox");
  return { kind: "inbox", reasons };
}

/** 0–1 的注意力分数；排序时风险/影响/等待/不可逆各占一部分。 */
export function attentionScore(card: AttentionCard): number {
  const risk = RISK_ORDER[card.risk] / 3;
  const impact = Math.min(1, (card.blockedDownstream ?? 0) / 5);
  const waitNorm = card.slaMs && card.slaMs > 0 ? Math.min(1, (card.waitAgeMs ?? 0) / card.slaMs) : 0;
  const irreversibility = isReversible(card) ? 0 : 1;
  return 0.35 * risk + 0.25 * impact + 0.2 * waitNorm + 0.2 * irreversibility;
}

/** 决策卡的确定性比较器：critical 最前，其次超 SLA，再按分数，再下游数、创建时间。 */
export function compareCards(a: AttentionCard, b: AttentionCard): number {
  const ac = a.risk === "critical" ? 1 : 0;
  const bc = b.risk === "critical" ? 1 : 0;
  if (ac !== bc) return bc - ac;
  const aSla = (a.slaMs ?? 0) > 0 && (a.waitAgeMs ?? 0) > (a.slaMs ?? 0) ? 1 : 0;
  const bSla = (b.slaMs ?? 0) > 0 && (b.waitAgeMs ?? 0) > (b.slaMs ?? 0) ? 1 : 0;
  if (aSla !== bSla) return bSla - aSla;
  const diff = attentionScore(b) - attentionScore(a);
  if (Math.abs(diff) > 1e-9) return diff;
  const blockDiff = (b.blockedDownstream ?? 0) - (a.blockedDownstream ?? 0);
  if (blockDiff !== 0) return blockDiff;
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

/** 合并键：同项目 × 同因 × 同动作类型；跨项目永不合并。 */
export function mergeKey(card: AttentionCard): string {
  return `${card.projectId ?? "-"}|${card.causeFingerprint ?? "-"}|${card.actionType ?? "-"}`;
}

/** 允许把多张卡折叠成一张的边界：跨项目不合并；钱/对外永不批量。
 * 一键批量只允许可逆且风险 ≤ medium。 */
export function canMergeGroup(cards: AttentionCard[]): boolean {
  if (cards.length < 2) return false;
  const key = mergeKey(cards[0]!);
  if (!cards.every((card) => mergeKey(card) === key)) return false;
  return cards.every((card) => isReversible(card) && (card.risk === "low" || card.risk === "medium") && card.blastRadius !== "money" && card.blastRadius !== "external");
}
