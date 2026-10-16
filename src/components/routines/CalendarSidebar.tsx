import { useMemo, useState, type DragEvent } from "react";
import { GripVertical, Plus, Search, UsersRound } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { getLocale, t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { MiniMonth } from "./MiniMonth";

export const BOT_CALENDAR_DRAG_TYPE = "application/x-openmaus-bot";

export interface CalendarSidebarProps {
  bots: Bot[];
  anchor: number;
  onSelectDate: (at: number) => void;
  /** a big Create button on top; the calendar header has its own 新建, so the
   * drawer leaves it out */
  onCreate?: () => void;
}

export function CalendarSidebar({ bots, anchor, onSelectDate, onCreate }: CalendarSidebarProps) {
  const [query, setQuery] = useState("");
  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return bots;
    return bots.filter((bot) =>
      `${bot.name} ${bot.title} ${bot.description}`.toLocaleLowerCase().includes(normalized),
    );
  }, [bots, query]);

  const beginBotDrag = (event: DragEvent<HTMLDivElement>, bot: Bot) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(BOT_CALENDAR_DRAG_TYPE, bot.id);
    event.dataTransfer.setData("text/plain", bot.id);
  };

  return (
    <aside
      aria-label={t("Calendar sidebar")}
      className="flex h-full w-[264px] shrink-0 flex-col overflow-hidden border-r border-hairline/40 bg-inset/60"
    >
      {onCreate && <div className="px-4 pb-2 pt-4">
        <button
          type="button"
          onClick={onCreate}
          className="group flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-[13px] font-semibold text-primary-ink shadow-lg shadow-accent/15 transition hover:-translate-y-px hover:brightness-110 hover:shadow-xl hover:shadow-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:translate-y-0"
        >
          <Plus size={17} strokeWidth={2.5} aria-hidden="true" />
          {t("Create")}
        </button>
      </div>}

      <MiniMonth anchor={anchor} onSelect={onSelectDate} />

      <div className="mx-4 border-t border-hairline/40" />

      <section aria-labelledby="calendar-bots-heading" className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <div id="calendar-bots-heading" className="flex items-center gap-2 text-[12px] font-semibold text-ink-secondary">
            <UsersRound size={13} aria-hidden="true" />
            {t("My bots")}
          </div>
          <span className="rounded-full bg-control/70 px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-ink-secondary">
            {bots.length}
          </span>
        </div>

        <label className="relative mb-2 block">
          <span className="sr-only">{t("Search bots")}</span>
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-secondary/70"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            placeholder={t("Search bots")}
            className="h-8 w-full rounded-lg bg-stage pl-8 pr-2.5 text-[12px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_50%,transparent)] outline-none placeholder:text-ink-secondary/55 focus:shadow-[inset_0_0_0_1.5px_var(--color-select)]"
          />
        </label>

        <div role="list" aria-label={t("Bots available to schedule")} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
          {filteredBots.map((bot) => (
            <div
              key={bot.id}
              draggable
              onDragStart={(event) => beginBotDrag(event, bot)}
              role="listitem"
              className="group flex cursor-grab items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-raised-hover active:cursor-grabbing"
              aria-label={t("Drag {name} onto the calendar", { name: bot.name })}
              title={t("Drag {name} onto a time slot", { name: bot.name })}
            >
              <GripVertical
                size={13}
                className="shrink-0 text-ink-secondary/35 transition-colors group-hover:text-ink-secondary"
                aria-hidden="true"
              />
              <BotAvatar bot={bot} size={26} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-ink">{bot.name}</div>
                <div className="truncate text-[11px] text-ink-secondary/80">
                  {bot.title || (getLocale() === "en" ? "BotAgent" : t("Bot"))}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-control/70 px-1.5 py-0.5 text-[10px] text-ink-secondary opacity-0 transition-opacity group-hover:opacity-100">
                {t("Drag")}
              </span>
            </div>
          ))}

          {filteredBots.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] leading-relaxed text-ink-secondary">
              {bots.length === 0 ? t("Create a bot to schedule work.") : t("No bots match your search.")}
            </div>
          )}
        </div>

        <p className="mt-2 px-2 text-[11px] leading-relaxed text-ink-secondary/80">
          {t("Drag a bot onto any time to schedule it.")}
        </p>
      </section>
    </aside>
  );
}
