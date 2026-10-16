// A plain month view (周 / 月 switch in the calendar header): six Monday-first
// weeks, up to three entries per day, "+N" opens that day.
import { Phone } from "lucide-react";

import { clockTime, monthGridDays } from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { addDays, atLocalTime, startOfDay } from "@/lib/routine-calendar";
import type { Bot } from "@/state/store";
import { isSelected, selectionFor, type CalendarEventItem, type CalendarSelection, type EventSeed } from "./calendar-model";

const PER_DAY = 3;

export function MonthGrid({
  anchor,
  items,
  bots,
  colorFor,
  selection,
  now,
  onOpen,
  onPickDay,
  onCreate,
}: {
  anchor: number;
  items: CalendarEventItem[];
  bots: Bot[];
  colorFor: (botId: string | undefined) => string;
  selection: CalendarSelection | null;
  now: number;
  onOpen: (selection: CalendarSelection) => void;
  onPickDay: (day: number) => void;
  onCreate: (seed: EventSeed) => void;
}) {
  const days = monthGridDays(anchor);
  const month = new Date(anchor).getMonth();
  const today = startOfDay(now);
  const weekdayFormat = new Intl.DateTimeFormat(intlLocale(), { weekday: "short" });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-4">
      <div className="grid shrink-0 grid-cols-7 border-b border-hairline/45">
        {days.slice(0, 7).map((day) => (
          <div key={day} className="py-2 text-center text-[12px] text-ink-secondary">{weekdayFormat.format(new Date(day))}</div>
        ))}
      </div>
      <div className="grid min-h-[540px] flex-1 grid-cols-7 grid-rows-6">
        {days.map((day) => {
          const date = new Date(day);
          const inMonth = date.getMonth() === month;
          const isToday = day === today;
          const dayItems = items.filter((item) => item.at >= day && item.at < addDays(day, 1)).sort((a, b) => a.at - b.at);
          const shown = dayItems.slice(0, PER_DAY);
          const more = dayItems.length - shown.length;
          return (
            <div
              key={day}
              role="gridcell"
              aria-label={date.toLocaleDateString(intlLocale(), { month: "long", day: "numeric", weekday: "long" })}
              onClick={(event) => {
                if (event.target !== event.currentTarget) return;
                onCreate({ kind: "routine", at: atLocalTime(day, "09:00"), durationMinutes: 30, botIds: [], anchor: { x: event.clientX, y: event.clientY } });
              }}
              className={cn(
                "flex min-h-0 min-w-0 flex-col gap-0.5 border-b border-l border-hairline/25 p-1.5",
                !inMonth && "bg-inset/50",
                isToday && "bg-select/[0.045]",
              )}
            >
              <button
                type="button"
                onClick={() => onPickDay(day)}
                className={cn(
                  "mb-0.5 inline-grid h-6 min-w-6 place-items-center self-start rounded-full px-1 text-[12.5px] font-semibold tabular-nums",
                  isToday ? "bg-select text-white" : inMonth ? "text-ink hover:bg-raised-hover" : "text-ink-secondary/50 hover:bg-raised-hover",
                )}
                aria-label={t("Open {date}", { date: date.toLocaleDateString(intlLocale(), { month: "long", day: "numeric" }) })}
              >
                {date.getDate()}
              </button>
              {shown.map((item) => {
                const isCall = item.kind === "call";
                const name = isCall ? item.call.name : item.routine?.name ?? item.run?.routineName ?? t("Routine");
                const botId = isCall ? item.call.botIds[0] : item.routine?.botId ?? item.run?.botId;
                const selected = isSelected(item, selection);
                const failed = !isCall && (item.run?.status === "failed" || item.run?.status === "missed");
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onOpen(selectionFor(item))}
                    className={cn(
                      "flex h-[20px] min-w-0 items-center gap-1 rounded-[5px] pl-1.5 pr-1 text-left text-[11px] whitespace-nowrap",
                      selected ? "bg-select/12 text-accent-text" : failed ? "bg-danger/10 text-danger" : "bg-control/60 text-ink hover:bg-raised-hover",
                      item.at + item.durationMinutes * 60_000 < now && !selected && "opacity-60",
                    )}
                    style={{ boxShadow: `inset 2px 0 0 ${isCall ? "var(--color-ink)" : colorFor(botId)}` }}
                  >
                    {isCall && <Phone size={10} className="shrink-0 text-ink-secondary" />}
                    <span className="shrink-0 tabular-nums text-ink-secondary">{clockTime(item.at)}</span>
                    <span className="min-w-0 truncate font-medium">{name}</span>
                  </button>
                );
              })}
              {more > 0 && (
                <button type="button" onClick={() => onPickDay(day)} className="self-start rounded px-1 text-[11px] font-semibold text-ink-secondary hover:bg-raised-hover hover:text-ink">
                  {t("+{count} more", { count: more })}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {bots.length === 0 && <div className="pt-3 text-center text-[12px] text-ink-secondary">{t("Create a bot to schedule work.")}</div>}
    </div>
  );
}
