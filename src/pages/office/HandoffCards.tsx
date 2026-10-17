// 项目页「交接回执」：部门之间交接的接收 / 退回 / 重发。
//
// 数据来自 GET /api/task-folders/:id/handoffs（server/handoff-actions.ts 的
// handoffCard：状态、等了多久、是否超时、现在能给哪些按钮）。
// 动作：ack receive / ack return（原因码 + 一句必填）/ resend。
// 语义要点：
//  · 按钮只按 can* 渲染——状态机不允许的动作，UI 也不该出现；
//  · 409（已被别人处理 / 已过期 / 版本冲突）→ 提示并刷新，不是报错墙；
//  · 422（缺原因）→ 提示补一句原因；
//  · 无数据不占位：交接全部处理完时整块消失；轮询失败保留上一份数据、不挡
//    其他区块。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ChevronDown, Clock3 } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export type HandoffAckState = "sent" | "received" | "returned" | "expired";
export type HandoffReturnReasonCode = "missing_input" | "wrong_scope" | "blocked" | "overload" | "other";

/** GET /api/task-folders/:id/handoffs 的 handoff 行（handoffCard + runId）。 */
export interface HandoffCardData {
  runId: string;
  subtaskId: string;
  title: string;
  state: HandoffAckState;
  round: number;
  sentAt: number;
  expiresAt?: number;
  waitedMs: number;
  overdue: boolean;
  canReceive: boolean;
  canReturn: boolean;
  canResend: boolean;
  returnReason?: { code: HandoffReturnReasonCode; text?: string };
  nudgeCount: number;
  legacy?: boolean;
  assigneeName?: string;
}

export interface HandoffCardsProps {
  folderId: string;
  /** 任何回执动作成功后调用（页面可顺手刷新等待链/团队状态） */
  onChanged?: () => void;
  intervalMs?: number;
}

const REASON_CODES: readonly HandoffReturnReasonCode[] = [
  "missing_input",
  "wrong_scope",
  "blocked",
  "overload",
  "other",
];

/** 退回原因码 → i18n 源文案（t() 的 key）。 */
export function handoffReasonLabel(code: HandoffReturnReasonCode): string {
  switch (code) {
    case "missing_input":
      return "Missing input";
    case "wrong_scope":
      return "Wrong scope";
    case "blocked":
      return "Blocked";
    case "overload":
      return "Overloaded";
    case "other":
      return "Other";
  }
}

/** 状态词（i18n 源文案）：超时的 sent 也显示「已超时」，legacy 显示「历史交接」。 */
export function handoffStateKey(card: Pick<HandoffCardData, "state" | "overdue" | "legacy">): string {
  if (card.legacy) return "Legacy handoff";
  if (card.state === "expired" || card.overdue) return "Expired";
  switch (card.state) {
    case "received":
      return "Received";
    case "returned":
      return "Returned";
    default:
      return "Waiting to receive";
  }
}

/** 等待分钟数：服务端给的 waitedMs → 至少 1 分钟，四舍五入。 */
export function handoffMinutes(waitedMs: number): number {
  return Math.max(1, Math.round((Number.isFinite(waitedMs) ? waitedMs : 0) / 60_000));
}

/** 排序：超时的最前，然后按已等最久（waitedMs 降序）；同值保持稳定顺序。 */
export function sortHandoffCards<T extends Pick<HandoffCardData, "overdue" | "waitedMs" | "subtaskId">>(
  cards: readonly T[],
): T[] {
  return [...cards].sort((a, b) => {
    const overdue = Number(b.overdue) - Number(a.overdue);
    if (overdue !== 0) return overdue;
    const waited = (Number.isFinite(b.waitedMs) ? b.waitedMs : 0) - (Number.isFinite(a.waitedMs) ? a.waitedMs : 0);
    if (waited !== 0) return waited;
    return a.subtaskId.localeCompare(b.subtaskId);
  });
}

/** 交接卡列表（纯展示；容器负责取数与动作）。 */
export function HandoffList({
  handoffs,
  busyKey,
  returning,
  reasonCode,
  reasonText,
  notice,
  staleError,
  onReceive,
  onStartReturn,
  onCancelReturn,
  onReasonCode,
  onReasonText,
  onSubmitReturn,
  onResend,
}: {
  handoffs: readonly HandoffCardData[];
  busyKey?: string | null;
  returning?: string | null;
  reasonCode?: HandoffReturnReasonCode | "";
  reasonText?: string;
  notice?: { tone: "ok" | "error"; text: string } | null;
  staleError?: string | null;
  onReceive: (card: HandoffCardData) => void;
  onStartReturn: (card: HandoffCardData) => void;
  onCancelReturn: () => void;
  onReasonCode: (code: HandoffReturnReasonCode) => void;
  onReasonText: (text: string) => void;
  onSubmitReturn: (card: HandoffCardData) => void;
  onResend: (card: HandoffCardData) => void;
}) {
  return (
    <section
      aria-label={t("Handoffs")}
      className="rounded-[14px] bg-raised px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]"
    >
      <div className="flex items-center gap-1.5 text-[13px] font-semibold">
        <ArrowLeftRight size={14} className="text-ink-secondary" />
        {t("Handoffs")}
        <span className="ml-auto text-[11.5px] font-medium text-ink-secondary/70">{handoffs.length}</span>
      </div>

      {staleError && (
        <p className="mt-1.5 text-[11.5px] text-warning">
          {t("Could not refresh")} · {staleError}
        </p>
      )}
      {notice && (
        <p role="status" className={cn("mt-1.5 rounded-lg px-2.5 py-1.5 text-[12px]", notice.tone === "error" ? "bg-danger/[0.08] text-danger" : "bg-success/[0.09] text-success")}>
          {notice.text}
        </p>
      )}

      <ul className="mt-2 flex flex-col gap-2">
        {handoffs.map((card) => {
          const overdue = card.overdue || card.state === "expired";
          const readOnly = card.legacy || card.state === "received";
          const minutes = handoffMinutes(card.waitedMs);
          const stateKey = handoffStateKey(card);
          const editing = returning === card.subtaskId;
          const busy = busyKey?.startsWith(`${card.subtaskId}:`) === true;
          return (
            <li key={card.subtaskId} className={cn("rounded-xl bg-inset px-3 py-2.5", readOnly && "opacity-75")}>
              <div className="flex items-start gap-2">
                <b className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{card.title}</b>
                <span
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10.5px] font-semibold",
                    readOnly
                      ? "bg-control text-ink-secondary"
                      : overdue
                        ? "bg-danger/12 text-danger"
                        : card.state === "returned"
                          ? "bg-warning/12 text-warning"
                          : "bg-select/12 text-accent-text",
                  )}
                >
                  {t(stateKey)}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-secondary/80">
                <span className={cn("inline-flex items-center gap-1", overdue && "font-semibold text-danger")}>
                  <Clock3 size={11} />
                  {overdue ? t("Overdue by {minutes} min", { minutes }) : t("Waiting {minutes} min", { minutes })}
                </span>
                {card.assigneeName && <span>{t("Handed to {name}", { name: card.assigneeName })}</span>}
                {card.nudgeCount > 0 && <span>{t("Nudged {count} time(s)", { count: card.nudgeCount })}</span>}
              </div>

              {card.state === "returned" && card.returnReason && (
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary/85">
                  {t("Returned: {reason}", {
                    reason: `${t(handoffReasonLabel(card.returnReason.code))}${card.returnReason.text ? ` · ${card.returnReason.text}` : ""}`,
                  })}
                </p>
              )}

              {!readOnly && !editing && (card.canReceive || card.canReturn || card.canResend) && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {card.canReceive && (
                    <Button size="sm" className="max-sm:h-11" disabled={busy} onClick={() => onReceive(card)}>
                      {t("Receive")}
                    </Button>
                  )}
                  {card.canReturn && (
                    <Button size="sm" variant="soft" className="max-sm:h-11" disabled={busy} onClick={() => onStartReturn(card)}>
                      {t("Return…")}
                    </Button>
                  )}
                  {card.canResend && (
                    <Button size="sm" variant="ghost" className="max-sm:h-11" disabled={busy} onClick={() => onResend(card)}>
                      {t("Resend")}
                    </Button>
                  )}
                </div>
              )}

              {!readOnly && editing && (
                <div className="mt-2 flex flex-col gap-2 rounded-lg bg-raised px-2.5 py-2">
                  <label className="text-[12px] font-semibold text-ink-secondary" htmlFor={`handoff-reason-${card.subtaskId}`}>
                    {t("Why return it?")}
                  </label>
                  <div className="relative">
                    <select
                      id={`handoff-reason-${card.subtaskId}`}
                      value={reasonCode ?? ""}
                      onChange={(event) => onReasonCode(event.target.value as HandoffReturnReasonCode)}
                      className="h-10 w-full appearance-none rounded-lg bg-card px-2.5 pr-8 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] focus:outline-none max-sm:h-11"
                    >
                      <option value="">{t("Pick a reason")}</option>
                      {REASON_CODES.map((code) => (
                        <option key={code} value={code}>
                          {t(handoffReasonLabel(code))}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-secondary" />
                  </div>
                  <textarea
                    value={reasonText ?? ""}
                    onChange={(event) => onReasonText(event.target.value)}
                    maxLength={300}
                    placeholder={t("One sentence: why send it back (required)")}
                    aria-label={t("One sentence: why send it back (required)")}
                    className="min-h-[60px] w-full resize-y rounded-lg bg-card px-2.5 py-2 text-[13px] leading-relaxed text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] placeholder:text-ink-secondary/70 focus:outline-none"
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="soft" className="max-sm:h-11" disabled={busy} onClick={onCancelReturn}>
                      {t("Cancel")}
                    </Button>
                    <Button
                      size="sm"
                      className="max-sm:h-11"
                      disabled={busy || !reasonCode || !(reasonText ?? "").trim()}
                      onClick={() => onSubmitReturn(card)}
                    >
                      {t("Confirm return")}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 容器：10s 轮询交接回执，执行接收 / 退回 / 重发；无数据时不渲染。 */
export function HandoffCards({ folderId, onChanged, intervalMs = 10_000 }: HandoffCardsProps) {
  const [handoffs, setHandoffs] = useState<HandoffCardData[] | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<HandoffReturnReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/task-folders/${encodeURIComponent(folderId)}/handoffs`);
      if (!response.ok) throw new Error(`${response.status}`);
      const payload = (await response.json()) as { handoffs?: unknown };
      const rows = Array.isArray(payload.handoffs) ? (payload.handoffs as HandoffCardData[]) : [];
      setHandoffs(rows);
      setStaleError(null);
    } catch (cause) {
      // 轮询失败保留上一份（下一页/下一秒会再试），不把整块变成错误墙
      setStaleError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [folderId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [load, intervalMs]);

  const resetEditor = () => {
    setReturning(null);
    setReasonCode("");
    setReasonText("");
  };

  const act = async (card: HandoffCardData, kind: "receive" | "return" | "resend") => {
    setBusyKey(`${card.subtaskId}:${kind}`);
    setNotice(null);
    const base = `/api/dispatch/runs/${encodeURIComponent(card.runId)}/subtasks/${encodeURIComponent(card.subtaskId)}/handoff`;
    const body =
      kind === "resend"
        ? {}
        : kind === "receive"
          ? { action: "receive", round: card.round }
          : { action: "return", round: card.round, reason: { code: reasonCode as HandoffReturnReasonCode, text: reasonText.trim() } };
    try {
      const response = await fetch(`${base}/${kind === "resend" ? "resend" : "ack"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        // noop 也算成功（别人已经接收过，状态一致）
        setNotice({ tone: "ok", text: t("Handoff updated") });
        resetEditor();
        await load();
        onChanged?.();
      } else if (response.status === 409) {
        setNotice({ tone: "error", text: t("Already handled or expired — refreshed for you") });
        resetEditor();
        await load();
        onChanged?.();
      } else if (response.status === 422) {
        setNotice({ tone: "error", text: t("Pick a reason and add one sentence.") });
      } else {
        setNotice({ tone: "error", text: t("Could not update this handoff. Try again.") });
      }
    } catch {
      setNotice({ tone: "error", text: t("Could not update this handoff. Try again.") });
    } finally {
      setBusyKey(null);
    }
  };

  const sorted = useMemo(() => sortHandoffCards(handoffs ?? []), [handoffs]);

  // 无数据不占位：加载中/失败/全部处理完都整块消失，绝不挡其他区块
  if (!handoffs || sorted.length === 0) return null;

  return (
    <HandoffList
      handoffs={sorted}
      busyKey={busyKey}
      returning={returning}
      reasonCode={reasonCode}
      reasonText={reasonText}
      notice={notice}
      staleError={staleError}
      onReceive={(card) => void act(card, "receive")}
      onStartReturn={(card) => {
        setReturning(card.subtaskId);
        setReasonCode("");
        setReasonText("");
      }}
      onCancelReturn={resetEditor}
      onReasonCode={setReasonCode}
      onReasonText={setReasonText}
      onSubmitReturn={(card) => void act(card, "return")}
      onResend={(card) => void act(card, "resend")}
    />
  );
}
