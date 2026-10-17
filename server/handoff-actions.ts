// Handoff「接收 / 退回 / 重发」的动作服务：路由与 UI 共用的纯逻辑。
//
// 不写存储：路由把返回的 ack / handoff 落回 subtask（Lead 负责接线）。所有
// 状态转移都复用 handoff-ack.ts 的 transitionAck / ackWaiting，保证与
// sweeper、隐式 receive（子任务开跑即签收依赖）是同一套语义：
//   sent ──receive──▶ received        sent ──return──▶ returned
//   sent/expired ──(超时)──▶ expired   returned/expired ──resend──▶ sent(round+1)
import type {
  DispatchHandoff,
  HandoffAck,
  HandoffAckState,
  HandoffReturnReasonCode,
} from "../shared/dispatch-types.ts";
import { ackWaiting, transitionAck, type AckResult } from "./handoff-ack.ts";

/** 默认回执超时：10 分钟没人接收算过期（与 dispatch.ts 初始化、sweeper 一致）。 */
export const DEFAULT_HANDOFF_ACK_TTL_MS = 10 * 60_000;
/** 重发时保留的旧 ack 条数上限（一轮一条，够审计，不无界增长）。 */
export const HANDOFF_ACK_HISTORY_LIMIT = 10;

/** 退回原因码：路由校验 body 用，避免 UI 传自由字符串。 */
export const HANDOFF_RETURN_REASON_CODES: readonly HandoffReturnReasonCode[] = [
  "missing_input",
  "wrong_scope",
  "blocked",
  "overload",
  "other",
];

export const isHandoffReturnReasonCode = (value: unknown): value is HandoffReturnReasonCode =>
  typeof value === "string" && (HANDOFF_RETURN_REASON_CODES as readonly string[]).includes(value);

/** transitionAck 的错误码 + 本层新增的 missing_handoff（没有交接可动）。 */
export type HandoffActionErrorCode = Extract<AckResult, { ok: false }>["code"] | "missing_handoff";

export interface HandoffActionReason {
  code: HandoffReturnReasonCode;
  /** 一句人话：会进退回记录，重发时下一轮 worker 会读到 */
  text?: string;
}

export type AckHandoffResult =
  | { ok: true; ack: HandoffAck; noop: boolean }
  | { ok: false; code: HandoffActionErrorCode; from?: HandoffAckState; to?: HandoffAckState };

export interface AckHandoffInput {
  handoff: DispatchHandoff | undefined;
  subtaskId: string;
  action: "receive" | "return";
  /** 做动作的人（botId 或 "owner"），进 receivedBy/returnedBy 审计 */
  actor: string;
  /** action=return 必填 */
  reason?: HandoffActionReason;
  /** 不传 = 当前 ack 的 round（UI 不需要自己追踪轮次） */
  round?: number;
  now?: number;
  /** 可选 CAS：路由把读到的 ack.v 带回来，竞态下旧版本会 version_conflict */
  expectedVersion?: number;
}

/** 老数据（ack 出现之前写的 handoff）没有回执时，把它当作「已发出」的当前轮，
 * 让老板的第一次接收/退回能建立 ack。v=0：第一次转移后变为 v=1。 */
function legacyAckFor(handoff: DispatchHandoff, now: number): HandoffAck {
  return {
    state: "sent",
    round: handoff.round ?? 1,
    sentAt: handoff.sentAt ?? now,
    sentBy: handoff.sentBy ?? "",
    nudgeCount: 0,
    v: 0,
  };
}

/**
 * 接收或退回一轮交接。纯函数：不改 input.handoff，返回新的 ack 交给调用方写回。
 * 语义全部委托 transitionAck：receive 幂等（noop=true）、return 必须给 reason、
 * round 不匹配 → stale_round、终态再转移 → illegal_transition。
 */
export function ackHandoff(input: AckHandoffInput): AckHandoffResult {
  const { handoff } = input;
  if (!handoff) return { ok: false, code: "missing_handoff" };
  const now = input.now ?? Date.now();
  const current = handoff.ack ?? legacyAckFor(handoff, now);
  return transitionAck({
    current,
    action: input.action,
    // 缺 round 用当前轮：UI 只按卡片上的按钮，不需要知道轮次
    round: input.round ?? current.round,
    actor: input.actor,
    now,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  });
}

/** history 是向前兼容的额外字段：shared/dispatch-types 还没声明它，但 dispatch
 * 把 handoff 原样 JSON 持久化，所以重发的旧 ack 不会丢。 */
export type HandoffWithHistory = DispatchHandoff & { history?: HandoffAck[] };

export type ResendHandoffResult =
  | { ok: true; handoff: HandoffWithHistory; round: number }
  | { ok: false; code: HandoffActionErrorCode; from?: HandoffAckState };

export interface ResendHandoffInput {
  handoff: DispatchHandoff | undefined;
  subtaskId: string;
  /** 重发的人（一般是项目负责人/派单层） */
  actor: string;
  now?: number;
  ttlMs?: number;
}

/**
 * 重发一轮交接：只有「被退回」或「已过期」才能重发（已接收/还在等接收都不行）。
 * round+1，旧 ack 追加进 history（最多 10 条），新 ack 重新计时并清空 nudge。
 * handoff 的 id/round/sentAt/sentBy 同步到新一轮，方便 UI 与日志对齐身份。
 */
export function resendHandoff(input: ResendHandoffInput): ResendHandoffResult {
  const { handoff } = input;
  if (!handoff) return { ok: false, code: "missing_handoff" };
  const ack = handoff.ack;
  // 没有回执的 legacy handoff 没有「退回/过期」状态可续，不做隐式发明
  if (!ack) return { ok: false, code: "illegal_transition" };
  if (ack.state !== "returned" && ack.state !== "expired") {
    return { ok: false, code: "illegal_transition", from: ack.state };
  }
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_HANDOFF_ACK_TTL_MS;
  const round = ack.round + 1;
  const prior = (handoff as HandoffWithHistory).history ?? [];
  const next: HandoffWithHistory = {
    ...handoff,
    // handoff 身份 = subtaskId#round（与 dispatch.ts 的初始化同一格式）
    id: `${input.subtaskId}#${round}`,
    round,
    sentAt: now,
    sentBy: input.actor,
    history: [...prior, ack].slice(-HANDOFF_ACK_HISTORY_LIMIT),
    ack: {
      state: "sent",
      round,
      sentAt: now,
      sentBy: input.actor,
      expiresAt: now + ttl,
      nudgeCount: 0,
      v: 1,
    },
  };
  return { ok: true, handoff: next, round };
}

/** UI 交接卡：状态、轮次、等了多久、现在能给哪些按钮。全部由 ack 推导。 */
export interface HandoffCard {
  subtaskId: string;
  title: string;
  state: HandoffAckState;
  round: number;
  sentAt: number;
  expiresAt: number;
  /** 本轮从发出到现在的时间（毫秒），最小 0 */
  waitedMs: number;
  /** 只有还没接收的轮次才会超时 */
  overdue: boolean;
  canReceive: boolean;
  canReturn: boolean;
  canResend: boolean;
  returnReason?: { code: HandoffReturnReasonCode; text?: string };
  nudgeCount: number;
  /** 写在 ack 之前的老 handoff：按「已接收」渲染，不给动作 */
  legacy?: boolean;
  /** 交接人的显示名（展示用，不参与状态推导） */
  assigneeName?: string;
}

export interface HandoffCardInput {
  subtaskId: string;
  title: string;
  handoff?: DispatchHandoff;
  assigneeName?: string;
  now?: number;
}

export function handoffCard(input: HandoffCardInput): HandoffCard {
  const now = input.now ?? Date.now();
  const ack = input.handoff?.ack;
  if (!ack) {
    // legacy：没有回执的年代，交接已经被消费了；不让 UI 去点一个不存在的动作
    const sentAt = input.handoff?.sentAt ?? 0;
    return {
      subtaskId: input.subtaskId,
      title: input.title,
      state: "received",
      round: input.handoff?.round ?? 1,
      sentAt,
      expiresAt: sentAt,
      waitedMs: sentAt > 0 ? Math.max(0, now - sentAt) : 0,
      overdue: false,
      canReceive: false,
      canReturn: false,
      canResend: false,
      nudgeCount: 0,
      legacy: true,
      ...(input.assigneeName ? { assigneeName: input.assigneeName } : {}),
    };
  }
  const expiresAt = ack.expiresAt ?? ack.sentAt + DEFAULT_HANDOFF_ACK_TTL_MS;
  const awaitingReceipt = ack.state === "sent" || ack.state === "expired";
  return {
    subtaskId: input.subtaskId,
    title: input.title,
    state: ack.state,
    round: ack.round,
    sentAt: ack.sentAt,
    expiresAt,
    waitedMs: Math.max(0, now - ack.sentAt),
    overdue: awaitingReceipt && now > expiresAt,
    canReceive: awaitingReceipt,
    canReturn: awaitingReceipt,
    canResend: ack.state === "returned" || ack.state === "expired",
    ...(ack.returnReason ? { returnReason: { ...ack.returnReason } } : {}),
    nudgeCount: ack.nudgeCount,
    ...(input.assigneeName ? { assigneeName: input.assigneeName } : {}),
  };
}

export type OfficeAckSummary = NonNullable<ReturnType<typeof ackWaiting>>;

/**
 * 项目页「此刻谁在等谁」用：把 handoff 的 ack 映射成 ackWaiting 的等待行；
 * 没有回执（legacy）或已接收 → null（office-view 同样跳过这两种，不渲染假阻塞）。
 */
export function ackSummaryForOffice(
  handoff: DispatchHandoff | undefined,
  assigneeName?: string,
): OfficeAckSummary | null {
  const ack = handoff?.ack;
  if (!ack) return null;
  return ackWaiting({ ack, ...(assigneeName ? { assignee: assigneeName } : {}) });
}
