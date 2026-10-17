// 注意力徽标：把「需要你」按注意力闸门分两类展示。
//   · push > 0  → 「⚡ 现在就要你 N 件」（只有真的等不起的才打扰）
//   · push = 0  → 「需要你 N 件」（普通收件箱）
// 数据来自 GET /api/attention/queue（server/attention-inbox.ts 的分类结果）。
// 接口不存在 / 失败 / 没数据时整个组件隐藏：徽标是辅助提醒，绝不能挡路。
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";

export interface AttentionCounts {
  push: number;
  inbox: number;
}

/** 从 /api/attention/queue 的响应里取两类计数；形状不对按 0 处理。 */
export function attentionCountsFromPayload(payload: unknown): AttentionCounts {
  const counts = (payload as { counts?: Record<string, unknown> } | null | undefined)?.counts;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return { push: count(counts?.push), inbox: count(counts?.inbox) };
}

export function AttentionBadge({
  onOpen,
  className,
  intervalMs = 15_000,
}: {
  /** 点击打开「需要你」面板（Sidebar 接线） */
  onOpen: () => void;
  className?: string;
  intervalMs?: number;
}) {
  const [counts, setCounts] = useState<AttentionCounts | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const payload = await api("/api/attention/queue");
        if (alive) setCounts(attentionCountsFromPayload(payload));
      } catch {
        // no endpoint / harness down: hide the badge (never block the sidebar)
        if (alive) setCounts(null);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  if (!counts) return null;
  const urgent = counts.push > 0;
  const count = urgent ? counts.push : counts.inbox;
  if (count <= 0) return null;
  const label = urgent ? t("Need you now · {count}", { count }) : t("Needs you · {count} items", { count });

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-semibold whitespace-nowrap transition-colors max-sm:h-11",
        urgent
          ? "bg-warning/15 text-warning hover:bg-warning/20"
          : "bg-control text-ink-secondary hover:text-ink",
        className,
      )}
    >
      {urgent && (
        <span aria-hidden className="text-[12px] leading-none">
          ⚡
        </span>
      )}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
