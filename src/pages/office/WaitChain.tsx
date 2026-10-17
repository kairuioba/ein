// 谁被谁卡住：单行 `A 等 B · 交付物 · 时长`，≥15 分钟标红。数据全部来自
// 服务端推导的 waiting（谁等谁、等什么、已等分钟数），前端不自己估算时间。
import { Clock3 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatWaitMinutes, type OfficeWaiting } from "@/lib/office";

const LATE_MINUTES = 15;

export function WaitChain({ waiting }: { waiting: OfficeWaiting[] }) {
  return (
    <section aria-label={t("Who is blocked by whom right now")} className="rounded-[14px] bg-raised px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Clock3 size={14} className="text-ink-secondary" />
        {t("Who is blocked by whom right now")}
        {waiting.length > 0 && <span className="ml-auto text-[11.5px] font-medium text-ink-secondary/70">{waiting.length}</span>}
      </div>
      {waiting.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">{t("Nobody is waiting on anybody.")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {waiting.map((entry, index) => {
            const late = entry.minutes >= LATE_MINUTES;
            return (
              <li
                key={`${entry.from.name}-${entry.to.name}-${index}`}
                className="flex min-h-9 items-center gap-2 rounded-lg bg-inset px-2.5 py-1.5 text-[12.5px]"
              >
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", late ? "bg-danger" : "bg-warning")} />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {t("{from} waits on {to}", { from: entry.from.name, to: entry.to.name })}
                  {entry.item && <span className="text-ink-secondary"> · {entry.item}</span>}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[11.5px] tabular-nums",
                    late ? "font-semibold text-danger" : "text-ink-secondary",
                  )}
                  title={t("waiting {time}", { time: formatWaitMinutes(entry.minutes) })}
                >
                  {t("waiting {time}", { time: formatWaitMinutes(entry.minutes) })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
