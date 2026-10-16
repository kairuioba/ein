// Small pieces the settings page and the Bot settings panel share: the page
// header, the "saved automatically" status, a stepper, a number field, a
// checkbox and the label/value rows the Fog designs use.
import { useEffect, useState, type ReactNode } from "react";
import { Check, Loader2, Minus, Plus, TriangleAlert } from "lucide-react";
import { ProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

// marks drawn light, for dark grounds; every other one-colour mark paints with --color-ink
const LIGHT_MARKS = new Set(["hermesAgent", "cursorAgent"]);

/** The little square behind an engine's mark on a dark name plate. White with
 * light-skin ink, so one-colour marks show in every skin; the marks drawn
 * light (Hermes, Cursor) sit on a dark square instead. */
export function MarkTile({ driverKind, size, markSize }: { driverKind?: string; size: number; markSize: number }) {
  const dark = driverKind !== undefined && LIGHT_MARKS.has(driverKind);
  return (
    <span
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[4px]",
        dark ? "bg-[#2A2E37]" : "bg-white text-[#14161C] [--color-ink-secondary:#5A606C] [--color-ink:#14161C]",
      )}
    >
      {driverKind ? <ProviderMark driverKind={driverKind} size={markSize} /> : null}
    </span>
  );
}

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** "✓ Changes save automatically", or what the last save did. */
export function SaveStatus({ state, className }: { state: SaveState; className?: string }) {
  if (state.kind === "saving") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-secondary", className)} role="status">
        <Loader2 size={13} className="animate-spin" />
        {t("Saving…")}
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className={cn("inline-flex max-w-[420px] items-center gap-1.5 text-[12px] text-danger", className)} role="alert" title={state.message}>
        <TriangleAlert size={13} className="shrink-0" />
        <span className="truncate">{t("Not saved: {message}", { message: state.message })}</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-secondary", className)}>
      <Check size={13} className="text-success" />
      {t("Changes save automatically")}
    </span>
  );
}

/** Tracks one save at a time for a page: saving → saved (or the error). */
export function useSaveState() {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  useEffect(() => {
    if (state.kind !== "saved") return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);
  const run = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setState({ kind: "saving" });
    try {
      const result = await work();
      setState({ kind: "saved" });
      return result;
    } catch (cause) {
      setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      return undefined;
    }
  };
  return { state, run, setState };
}

/** The page title block: 22px title, one grey line, and a right slot. */
export function SectionHeader({ title, description, right }: { title: string; description?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] leading-[1.3] font-bold tracking-[-0.2px] text-ink">{title}</h1>
        {description && <p className="mt-[3px] text-[13px] leading-relaxed text-ink-secondary">{description}</p>}
      </div>
      {right && <div className="mb-0.5 shrink-0">{right}</div>}
    </div>
  );
}

/** − n + in a white pill, as in the org rules. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      className="mx-0.5 inline-flex h-7 items-center rounded-lg bg-raised align-middle shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-ink-secondary)_32%,transparent)]"
    >
      <button
        type="button"
        aria-label={t("Decrease")}
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        className="grid h-7 w-[26px] place-items-center text-ink-secondary hover:text-ink disabled:opacity-35"
      >
        <Minus size={13} />
      </button>
      <b className="min-w-[22px] border-x border-hairline/40 px-1 text-center text-[13.5px] leading-7 font-bold tabular-nums text-ink" aria-live="polite">
        {value}
      </b>
      <button
        type="button"
        aria-label={t("Increase")}
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        className="grid h-7 w-[26px] place-items-center text-ink-secondary hover:text-ink disabled:opacity-35"
      >
        <Plus size={13} />
      </button>
    </span>
  );
}

/** A short number input that commits on blur or Enter; empty commits null.
 * `decimals` allows that many digits after the point (an exchange rate). */
export function NumberField({
  value,
  onCommit,
  label,
  min = 0,
  max = 100000,
  width = 44,
  placeholder,
  allowEmpty = false,
  disabled,
  decimals = 0,
}: {
  value: number | null | undefined;
  onCommit: (next: number | null) => void;
  label: string;
  min?: number;
  max?: number;
  width?: number;
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
  decimals?: number;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const scale = 10 ** decimals;
  const commit = () => {
    const text = draft.trim();
    if (!text) {
      if (allowEmpty) {
        if (value != null) onCommit(null);
      } else setDraft(value == null ? "" : String(value));
      return;
    }
    const parsed = Math.round(Number(text) * scale) / scale;
    if (!Number.isFinite(parsed)) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      inputMode={decimals ? "decimal" : "numeric"}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(decimals ? event.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1") : event.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          setDraft(value == null ? "" : String(value));
          event.stopPropagation();
        }
      }}
      style={{ width }}
      className="mx-0.5 h-7 rounded-lg bg-raised text-center align-middle text-[13.5px] font-bold tabular-nums text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-ink-secondary)_32%,transparent)] placeholder:font-normal placeholder:text-ink-secondary/60 focus:shadow-[inset_0_0_0_1.5px_var(--color-select),0_0_0_3px_color-mix(in_oklab,var(--color-select)_16%,transparent)] disabled:opacity-50"
    />
  );
}

/** A 16px checkbox with its label, as in the org rules. */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("inline-flex items-center gap-[5px] text-[13.5px] text-ink disabled:opacity-50", className)}
    >
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-[5px] text-white",
          // the outline is a tint of the secondary ink so an empty box shows on the dark skins too
          checked ? "bg-select" : "bg-raised shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-ink-secondary)_40%,transparent)]",
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}

/** A label + optional sub line on the left, a control on the right. */
export function SettingRow({
  label,
  sub,
  children,
  className,
}: {
  label: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-[42px] items-center gap-2.5 border-b border-hairline/30 py-1.5 last:border-b-0", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-px leading-[1.35]">
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        {sub && <span className="truncate text-[11.5px] text-ink-secondary">{sub}</span>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-1.5 text-[13px] whitespace-nowrap">{children}</div>}
    </div>
  );
}

/** A bordered group of SettingRows. */
export function RowGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col rounded-xl px-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]", className)}>
      {children}
    </div>
  );
}

/** A small grey field label above an input. */
export function FieldLabel({ children, hint, right }: { children: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-[5px] flex items-baseline gap-2 text-[12px] font-semibold text-ink-secondary">
      <span>{children}</span>
      {hint && <em className="text-[12px] font-normal not-italic text-ink-secondary/70">{hint}</em>}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

export const inputClass =
  "w-full rounded-[10px] bg-raised px-2.5 py-2 text-[13px] leading-[1.55] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-ink-secondary)_26%,transparent)] placeholder:text-ink-secondary/60 focus:shadow-[inset_0_0_0_1.5px_var(--color-select),0_0_0_3px_color-mix(in_oklab,var(--color-select)_16%,transparent)] disabled:opacity-60";
