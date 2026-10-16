// Building blocks of the 1:1 chat's design (U8, Grok-Bot conventions): the
// soft grey card with its status pill and black/grey buttons, centred time
// separators and system lines, the thread link, the error strip above the
// composer, small popovers and the switch. Tokens only, so every skin draws
// them; Fog is what they were designed in.
import { useEffect, type ComponentProps, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { t, tn } from "@/lib/i18n";
import { IconBolt, IconReply, IconX } from "./icons";

/** A hairline ring that reads on every skin (the design's 1px --line). */
export const RING = "inset-ring inset-ring-hairline/55";

/** The soft grey surface bot bubbles and cards share. */
export const SOFT = "bg-control/60";

// ── card ─────────────────────────────────────────────────────────────────

export function ChatCard({
  title,
  pill,
  meta,
  actions,
  children,
  className,
  label,
  live,
}: {
  title: ReactNode;
  pill?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** accessible name of the card region */
  label?: string;
  /** announce pill changes (status) politely */
  live?: boolean;
}) {
  return (
    <section
      aria-label={label}
      className={cn("flex w-full max-w-[560px] flex-col gap-1.5 rounded-[14px] px-3.5 py-3 text-ink", SOFT, className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-bold leading-[1.45]">{title}</h3>
        {pill && <span aria-live={live ? "polite" : undefined}>{pill}</span>}
      </div>
      {meta && <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-[1.5] text-ink-secondary">{meta}</div>}
      {children}
      {actions && <div className="mt-1 flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

export type StatusTone = "green" | "amber" | "blue" | "grey" | "red";
const STATUS_TONE: Record<StatusTone, string> = {
  green: "bg-success/12 text-success",
  amber: "bg-warning/12 text-warning",
  blue: "bg-select/12 text-accent-text",
  grey: "bg-raised text-ink-secondary inset-ring inset-ring-hairline/40",
  red: "bg-danger/10 text-danger",
};

/** The status word on a card (the design's 20px pill with a dot): green done,
 * amber waiting on you, blue working, red failed, grey quiet. */
export function StatusPill({
  tone = "grey",
  dot = true,
  className,
  title,
  children,
}: {
  tone?: StatusTone;
  dot?: boolean;
  className?: string;
  /** the full text when the pill clips it */
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn("inline-flex h-5 shrink-0 items-center gap-[5px] rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap", STATUS_TONE[tone], className)}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** A middle dot between meta parts. */
export function MetaDot() {
  return <span aria-hidden className="text-ink-secondary/60">·</span>;
}

type CardButtonVariant = "black" | "grey" | "white";
const CARD_BUTTON: Record<CardButtonVariant, string> = {
  black: "bg-primary text-primary-ink hover:brightness-110",
  grey: "bg-control text-ink hover:bg-raised-hover",
  white: cn("bg-raised text-ink hover:bg-raised-hover", RING),
};

export function CardButton({
  variant = "black",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: CardButtonVariant }) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        "inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[12.5px] font-semibold whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40",
        CARD_BUTTON[variant],
        className,
      )}
    />
  );
}

/** A white block inside a card: the post, the mail, the command. */
export function CardInset({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-[10px] bg-raised px-3 py-2.5 text-[12.5px] leading-[1.6] text-ink", RING, className)}>{children}</div>;
}

// ── transcript rows ──────────────────────────────────────────────────────

export function TimeSeparator({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="flex justify-center py-0.5 text-[11.5px] font-medium tabular-nums text-ink-secondary/75">
      <span>{label}</span>
    </div>
  );
}

export function SystemLine({
  icon,
  children,
  tone = "quiet",
  onClick,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: "quiet" | "danger";
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      {icon && <span className="flex shrink-0 items-center">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  const classes = cn(
    "mx-auto flex max-w-full items-center justify-center gap-1.5 text-[12px] leading-[1.5]",
    tone === "danger" ? "text-danger" : "text-ink-secondary",
  );
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={cn(classes, "rounded-md px-1.5 hover:text-ink")}>
      {body}
    </button>
  ) : (
    <div className={classes} title={title}>
      {body}
    </div>
  );
}

/** "N replies in thread" under a message somebody answered. */
export function ThreadLink({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("Jump to the replies")}
      className="mt-1 ml-1 inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold text-accent-text hover:underline"
    >
      <IconReply size={13} />
      {tn(count, "{count} reply in thread", "{count} replies in thread")}
    </button>
  );
}

/** The red strip above the composer: what just went wrong, dismissible. */
export function ErrorStrip({
  children,
  action,
  onDismiss,
  tone = "danger",
}: {
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  tone?: "danger" | "warning" | "quiet";
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex min-h-[34px] items-center gap-2 rounded-[10px] px-3 py-1.5 text-[12.5px] leading-[1.45]",
        tone === "danger"
          ? "bg-danger/[0.06] text-danger inset-ring inset-ring-danger/25"
          : tone === "warning"
            ? "bg-warning/[0.08] text-warning inset-ring inset-ring-warning/25"
            : cn("bg-raised text-ink-secondary", RING),
      )}
    >
      {tone !== "quiet" && <IconBolt size={14} className="shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("Dismiss")}
          title={t("Dismiss")}
          className="grid size-6 shrink-0 place-items-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100"
        >
          <IconX size={13} />
        </button>
      )}
    </div>
  );
}

// ── popovers ─────────────────────────────────────────────────────────────

/** Close a popover on an outside press or Escape. */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

export function PopoverPanel({ className, children, label }: { className?: string; children: ReactNode; label?: string }) {
  return (
    <div
      role="menu"
      aria-label={label}
      className={cn(
        "animate-pop-in absolute z-40 flex flex-col rounded-xl bg-raised p-1.5 shadow-xl",
        RING,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  hint,
  className,
  ...props
}: ComponentProps<"button"> & { icon?: ReactNode; hint?: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      {...props}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] text-ink hover:bg-raised-hover disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11.5px] text-ink-secondary">{hint}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold text-ink-secondary">{children}</div>;
}

export function MenuDivider() {
  return <div aria-hidden className="mx-1.5 my-1 h-px bg-hairline/30" />;
}

// ── switch ───────────────────────────────────────────────────────────────

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-select" : "bg-hairline/70",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-[left]",
          checked ? "left-4" : "left-0.5",
        )}
      />
    </button>
  );
}
