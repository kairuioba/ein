import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The settings toggle: a small cobalt switch (34 × 20) as in the Fog kit. */
export function Switch({
  checked,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-select" : "bg-ink-secondary/35",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(16_24_40/0.2)] transition-all",
          checked ? "left-4" : "left-[2px]",
        )}
      />
    </button>
  );
}

/** A white settings card with the hairline edge. */
export function Card({
  title,
  subtitle,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[14px] bg-raised p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.04)]",
        className,
      )}
    >
      {title && <div className="text-[14.5px] font-semibold text-ink">{title}</div>}
      {subtitle && (
        <div className={title ? "mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary" : "text-[12.5px] leading-relaxed text-ink-secondary"}>
          {subtitle}
        </div>
      )}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy()}
        aria-label={t("Copy command")}
        className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
