// Small shared building blocks for the redesigned screens. They read only skin
// tokens, so every skin draws them correctly; Fog is what they were designed in.
//   Button · Pill · Diamond · Segmented · Panel · SidePanel · Dialog · AvatarStack · Progress · Kbd · Empty
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar, type BotAvatarProps } from "@/components/Avatar";

// ── Button ───────────────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "ghost" | "soft" | "danger" | "link" | "warn";
type ButtonSize = "sm" | "md" | "lg";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-ink hover:brightness-110",
  ghost: "bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] hover:bg-raised-hover",
  soft: "bg-control text-ink hover:bg-raised-hover",
  danger: "bg-raised text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-danger)_35%,transparent)] hover:bg-raised-hover",
  link: "bg-transparent px-0 text-accent-text hover:underline",
  warn: "bg-[#D97706] text-white hover:brightness-110",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-lg px-2.5 text-[12.5px]",
  md: "h-[34px] gap-1.5 rounded-[10px] px-3.5 text-[13.5px]",
  lg: "h-10 gap-2 rounded-xl px-[18px] text-[14.5px]",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-[filter,background-color] disabled:pointer-events-none disabled:opacity-40",
        BUTTON_SIZE[size],
        BUTTON_VARIANT[variant],
        variant === "link" && "h-auto",
        className,
      )}
    />
  );
}

// ── Pill: a status word with its colour ───────────────────────────────────────
export type PillTone = "green" | "amber" | "blue" | "grey" | "red" | "violet" | "teal";
const PILL_TONE: Record<PillTone, string> = {
  green: "bg-success/12 text-success",
  amber: "bg-warning/12 text-warning",
  blue: "bg-select/12 text-accent-text",
  grey: "bg-control text-ink-secondary",
  red: "bg-danger/10 text-danger",
  violet: "bg-[#8B5CF6]/12 text-[#6D3FE0]",
  teal: "bg-[#14B8A6]/12 text-[#0F766E]",
};
const DOT_TONE: Record<PillTone, string> = {
  green: "bg-success",
  amber: "bg-warning",
  blue: "bg-select",
  grey: "bg-ink-secondary/60",
  red: "bg-danger",
  violet: "bg-[#8B5CF6]",
  teal: "bg-[#14B8A6]",
};

export function Pill({ tone = "grey", dot = false, className, children }: { tone?: PillTone; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold whitespace-nowrap", PILL_TONE[tone], className)}>
      {dot && <span className={cn("size-[7px] rounded-full", DOT_TONE[tone])} />}
      {children}
    </span>
  );
}

export function Dot({ tone = "grey", size = 8, className }: { tone?: PillTone; size?: number; className?: string }) {
  return <span aria-hidden className={cn("inline-block shrink-0 rounded-full", DOT_TONE[tone], className)} style={{ width: size, height: size }} />;
}

/** The amber diamond that means "this is waiting on you". */
export function Diamond({ size = 10, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={cn("shrink-0 text-[#D97706]", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect x="3" y="3" width="10" height="10" rx="2" transform="rotate(45 8 8)" fill="currentColor" />
    </svg>
  );
}

// ── Segmented control ─────────────────────────────────────────────────────────
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  className,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; icon?: ReactNode; disabled?: boolean }>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-[10px] bg-track p-0.5", className)}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-40",
              size === "sm" ? "h-6 px-2.5 text-[12px]" : "h-7 px-3 text-[13px]",
              on ? "bg-raised font-semibold text-ink shadow-[0_1px_2px_rgb(16_24_40/0.12)]" : "text-ink-secondary hover:text-ink",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────────────
/** A white card on the stage with the hairline edge. */
export function Panel({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section {...props} className={cn("rounded-[14px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]", className)}>
      {children}
    </section>
  );
}

/** The right-hand detail panel (routine, bot settings, minutes …). */
export function SidePanel({
  title,
  onBack,
  onClose,
  actions,
  width = 340,
  className,
  children,
  label,
}: {
  title: ReactNode;
  onBack?: () => void;
  onClose?: () => void;
  actions?: ReactNode;
  width?: number;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <aside
      aria-label={label}
      className={cn("animate-panel-in relative z-20 flex h-full shrink-0 flex-col border-l border-hairline/40 bg-stage", className)}
      style={{ width }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        {onBack && (
          <button type="button" onClick={onBack} aria-label={t("Back")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
          </button>
        )}
        <div className="min-w-0 flex-1 truncate text-[15.5px] font-bold">{title}</div>
        {actions}
        {onClose && (
          <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
            <X size={16} />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
    </aside>
  );
}

/** A centred modal sheet with a dimmed backdrop, Esc to close and focus kept inside. */
export function Dialog({
  open,
  onClose,
  label,
  width = 640,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute("disabled")) : [];
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(20_22_28/0.38)] p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn("animate-pop-in flex max-h-full w-full flex-col overflow-hidden rounded-2xl bg-raised shadow-[0_2px_6px_rgb(16_24_40/0.06),0_28px_64px_-24px_rgb(16_24_40/0.42)]", className)}
        style={{ maxWidth: width }}
      >
        {children}
      </div>
    </div>
  );
}

// ── people ────────────────────────────────────────────────────────────────────
export function AvatarStack({
  bots,
  size = 20,
  max = 5,
  className,
}: {
  bots: ReadonlyArray<BotAvatarProps["bot"] & { id: string }>;
  size?: number;
  max?: number;
  className?: string;
}) {
  const shown = bots.slice(0, max);
  const extra = bots.length - shown.length;
  return (
    <span className={cn("inline-flex items-center", className)}>
      {shown.map((bot, index) => (
        <span key={bot.id} className="rounded-[30%] ring-2 ring-raised" style={{ marginLeft: index === 0 ? 0 : -size * 0.28 }}>
          <BotAvatar bot={bot} size={size} />
        </span>
      ))}
      {extra > 0 && <span className="ml-1 text-[11.5px] font-semibold text-ink-secondary">+{extra}</span>}
    </span>
  );
}

// ── misc ──────────────────────────────────────────────────────────────────────
export function Progress({ value, total, tone = "blue", className }: { value: number; total: number; tone?: PillTone; className?: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <span className={cn("block h-[5px] overflow-hidden rounded-full bg-control", className)} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
      <span className={cn("block h-full rounded-full", DOT_TONE[tone])} style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-grid h-5 min-w-5 place-items-center rounded-md bg-raised px-1.5 font-mono text-[11px] text-ink-secondary shadow-[inset_0_0_0_1px_var(--color-hairline),0_1px_0_var(--color-hairline)]", className)}>
      {children}
    </kbd>
  );
}

export function Empty({ title, detail, action, className }: { title: string; detail?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center", className)}>
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {detail && <div className="max-w-[46ch] text-[13px] leading-relaxed text-ink-secondary">{detail}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
