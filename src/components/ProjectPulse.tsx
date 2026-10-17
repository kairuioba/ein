// 项目页顶部「此刻」：谁在等谁、等了多久、有没有异常。
// 数据全部来自 dispatch subtasks/Handoff 的推导，不接受成员自述。
import { useState } from "react";
import { AlertTriangle, ChevronDown, Clock } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useProjectOffice } from "@/lib/office";

const MINUTES = (value: number) => (value >= 60 ? `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ""}` : `${Math.max(1, Math.round(value))}m`);

export function ProjectPulse({ folderId, waitingOnYou }: { folderId?: string; waitingOnYou?: number }) {
  const office = useProjectOffice(folderId);
  const [open, setOpen] = useState(false);
  if (!office) return null;
  const waiting = office.now.waiting ?? [];
  const first = waiting[0];
  const anomalies = office.anomalies ?? [];
  const late = first ? first.minutes >= 15 : false;
  const line = first
    ? `${first.from.name} → ${first.to.name} · ${first.item} · ${t("waiting {time}", { time: MINUTES(first.minutes) })}`
    : t("The team is moving — nobody is waiting on anyone.");
  return (
    <section className="mx-3 mt-1 mb-1 shrink-0 overflow-hidden rounded-xl bg-raised/70 px-3 py-1.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 text-left">
        <Clock size={13} className={cn("shrink-0", late ? "text-danger" : "text-ink-secondary")} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">
          <b className="font-semibold text-ink">{t("Right now")}</b> · {line}
        </span>
        {(waiting.length > 1 || anomalies.length > 0) && (
          <span className="shrink-0 text-[10.5px] text-ink-secondary/70">
            {waiting.length > 1 ? `+${waiting.length - 1}` : ""}
            {anomalies.length > 0 && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-warning">
                <AlertTriangle size={10} /> {anomalies.length}
              </span>
            )}
          </span>
        )}
        <ChevronDown size={12} className={cn("shrink-0 text-ink-secondary/60 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1.5 border-t border-hairline/25 pt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
          {waiting.length === 0 ? <p>{t("No waiting chain — work is flowing.")}</p> : (
            <ul className="space-y-0.5">
              {waiting.slice(0, 6).map((entry, index) => (
                <li key={`${entry.from.name}-${entry.item}-${index}`}>
                  {entry.from.name} → {entry.to.name} · <span className="text-ink">{entry.item}</span> ·{" "}
                  <span className={cn(entry.minutes >= 15 && "text-danger")}>{MINUTES(entry.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
          {anomalies.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {anomalies.slice(0, 4).map((entry) => (
                <li key={entry.subtaskId} className="text-warning">
                  ⚠ {entry.title} · {entry.detail}
                </li>
              ))}
            </ul>
          )}
          {typeof waitingOnYou === "number" && waitingOnYou > 0 && (
            <p className="mt-1 text-ink">{t("{count} thing(s) need your decision", { count: waitingOnYou })}</p>
          )}
        </div>
      )}
    </section>
  );
}
