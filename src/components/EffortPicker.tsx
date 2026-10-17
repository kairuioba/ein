// How hard a bot — or one dispatched subtask — thinks. A chip that opens a
// menu of every level the engine offers, lightest first, with the unset
// choice on top: "Auto" (each task as hard as its difficulty calls for) or
// the engine's own default.
import { useRef, useState } from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";

import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import { MacMenu, type MacMenuItem } from "@/components/workbench/MacMenu";
import { effortLabel, type Effort } from "../../shared/model-recommender";

/** One line on what each level is for. */
const EFFORT_HINT: Record<Effort, string> = {
  none: msg("No thinking, fastest"),
  low: msg("Quick and cheap"),
  medium: msg("Everyday work"),
  high: msg("Code and careful work"),
  xhigh: msg("Hard problems"),
  max: msg("The hardest problems, slowest"),
};

export function effortHint(level: Effort): string {
  return t(EFFORT_HINT[level]);
}

/** The same choice as a row of segments, for places a menu cannot open from
 * (inside another menu): the unset choice, then every level. */
export function EffortSegments({
  levels,
  value,
  unsetLabel,
  unsetTitle,
  onChange,
  label,
  className,
}: {
  levels: readonly Effort[];
  value: Effort | undefined;
  unsetLabel: string;
  unsetTitle?: string;
  onChange: (level: Effort | undefined) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex overflow-hidden rounded-lg border border-hairline/40", className)}>
      {([undefined, ...levels] as const).map((level, index) => {
        const selected = value === level;
        return (
          <button
            key={level ?? "unset"}
            type="button"
            role="radio"
            aria-checked={selected}
            title={level ? effortHint(level) : unsetTitle}
            onClick={() => onChange(level)}
            className={cn(
              "min-w-0 flex-auto truncate px-1 py-1.5 text-[11.5px] whitespace-nowrap",
              index > 0 && "border-l border-hairline/40",
              selected ? "bg-control font-semibold text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {level ? effortLabel(level) : unsetLabel}
          </button>
        );
      })}
    </div>
  );
}

export function EffortPicker({
  levels,
  value,
  unsetLabel,
  unsetLevel,
  recommended,
  onChange,
  disabled = false,
  className,
  label = t("How hard it thinks"),
}: {
  /** the engine's levels, lightest first */
  levels: readonly Effort[];
  /** a fixed level, or undefined for the unset choice */
  value: Effort | undefined;
  /** what the unset choice is called: "Auto" or "Default" */
  unsetLabel: string;
  /** what the unset choice comes to right now ("Auto · High") */
  unsetLevel?: Effort;
  /** the recommender's level for the task at hand */
  recommended?: Effort;
  onChange: (level: Effort | null) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // the menu closes on the pointerdown that lands on this chip; that click
  // must not reopen it
  const closedAt = useRef(0);
  const shown = value
    ? effortLabel(value)
    : unsetLevel
      ? `${unsetLabel} · ${effortLabel(unsetLevel)}`
      : unsetLabel;
  const items: MacMenuItem[] = [
    { kind: "header", label },
    {
      label: unsetLevel ? `${unsetLabel} · ${effortLabel(unsetLevel)}` : unsetLabel,
      icon: value === undefined ? <Check size={13} /> : undefined,
      onSelect: () => onChange(null),
    },
    { kind: "separator" },
    ...levels.map(
      (level): MacMenuItem => ({
        label: level === recommended ? `${effortLabel(level)} · ${t("Recommended")}` : effortLabel(level),
        icon: value === level ? <Check size={13} /> : undefined,
        shortcut: effortHint(level),
        onSelect: () => onChange(level),
      }),
    ),
  ];
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || levels.length === 0}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        aria-label={`${label}: ${shown}`}
        title={levels.length === 0 ? t("This engine has no effort setting") : `${label}: ${shown}`}
        onClick={() => {
          if (menu || Date.now() - closedAt.current < 250) return;
          const rect = triggerRef.current!.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        className={cn(
          "inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-hairline/40 bg-control/60 pr-2 pl-2 text-[12px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-control/60",
          className,
        )}
      >
        <Gauge size={13} className="shrink-0 text-ink-secondary" />
        <span className="truncate">{shown}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-secondary" />
      </button>
      {menu && (
        <MacMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => {
            closedAt.current = Date.now();
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
