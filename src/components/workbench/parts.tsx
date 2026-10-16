// Small pieces shared by the workbench views (看人 / 看事), the add-people
// sheet and the brief: status glyphs, the L2 badges that sit ON a node
// (never lines), health dots, the "new" tag, and a few hooks.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clock, Hand, Lock, Reply, Sparkles, X, Zap } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Tone } from "@/lib/workbench";
import type { Health } from "../../../shared/org-types";

// ── status glyphs (done ✓, running spinner, waiting ◆, failed ▲, queued ○, blocked ⊘) ──
export type GlyphStatus = "done" | "run" | "wait" | "fail" | "queue" | "blocked";

export function StatusGlyph({ status, size = 13, className }: { status: GlyphStatus; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", className: cn("shrink-0", className), "aria-hidden": true } as const;
  switch (status) {
    case "done":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="8" className="fill-success" />
          <path d="M4.6 8.3l2.3 2.3 4.5-4.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "run":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" fill="none" className="stroke-select/25" strokeWidth="2.2" />
          <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" className="origin-center animate-spin stroke-select [animation-duration:1.4s]" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "wait":
      return (
        <svg {...common}>
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.2" transform="rotate(45 8 8)" fill="#D97706" />
          <rect x="6.9" y="6.9" width="2.2" height="2.2" rx=".6" transform="rotate(45 8 8)" fill="#fff" />
        </svg>
      );
    case "fail":
      return (
        <svg {...common}>
          <path d="M8 1.2L15.2 14H.8z" className="fill-danger stroke-danger" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 5.8v3.8M8 11.6v.1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.8" className="fill-control stroke-ink-secondary/50" strokeWidth="1.5" strokeDasharray="2.4 2" />
          <path d="M6.3 9.7l3.4-3.4" className="stroke-ink-secondary" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.8" className="fill-raised stroke-ink-secondary/45" strokeWidth="1.5" />
        </svg>
      );
  }
}

// ── L2 badges ────────────────────────────────────────────────────────────────
export type BadgeKind = "hand" | "lock" | "bolt" | "clock" | "talk" | "auto" | "new" | "fail" | "ok";

const BADGE: Record<BadgeKind, { className: string; icon?: ReactNode }> = {
  hand: { className: "bg-warning/12 text-warning", icon: <Hand size={11} strokeWidth={2.2} /> },
  lock: { className: "bg-warning/12 text-warning", icon: <Lock size={11} strokeWidth={2.2} /> },
  bolt: { className: "bg-danger/10 text-danger", icon: <Zap size={11} strokeWidth={2.2} /> },
  clock: { className: "bg-control/70 text-ink-secondary", icon: <Clock size={11} strokeWidth={2.2} /> },
  talk: { className: "bg-[#EC4899]/10 text-[#BE185D]", icon: <Reply size={11} strokeWidth={2.2} /> },
  auto: { className: "bg-control/70 text-ink-secondary", icon: <Sparkles size={11} strokeWidth={2.2} /> },
  new: { className: "bg-[#6D3FE0] text-white" },
  fail: { className: "bg-danger/10 text-danger", icon: <X size={11} strokeWidth={2.4} /> },
  ok: { className: "bg-success/12 text-success", icon: <Check size={11} strokeWidth={2.4} /> },
};

export function Badge({ kind, children, className, title }: { kind: BadgeKind; children?: ReactNode; className?: string; title?: string }) {
  const spec = BADGE[kind];
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center gap-[3px] rounded-[6px] px-1.5 text-[11px] leading-none font-bold whitespace-nowrap", spec.className, className)}>
      {spec.icon}
      {children !== undefined && children !== null && <span>{children}</span>}
    </span>
  );
}

/** The violet "新" tag on people and squads that joined since you last looked. */
export function NewTag({ className }: { className?: string }) {
  return <Badge kind="new" className={cn("h-4 px-1 text-[10.5px]", className)}>{t("New here")}</Badge>;
}

// ── health (report lens) ─────────────────────────────────────────────────────
export const HEALTH_COLOR: Record<Health | "none", string> = { green: "#22C55E", yellow: "#F5B000", red: "#E5484D", none: "#B4BAC5" };

export function HealthDot({ health, size = 8, className }: { health: Health | null | undefined; size?: number; className?: string }) {
  const label = health === "green" ? t("Health green") : health === "yellow" ? t("Health yellow") : health === "red" ? t("Health red") : t("No report yet");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size, background: HEALTH_COLOR[health ?? "none"] }}
    />
  );
}

export function healthOfTone(tone: Tone, status?: string): Health | null {
  if (status === "idle") return null;
  if (tone === "red") return "red";
  if (tone === "amber") return "yellow";
  if (status === "blocked" || status === "disagree") return "yellow";
  return tone === "grey" && status !== "done" ? null : "green";
}

/** The amber ◆ for things waiting on the owner. */
export function DiamondMark({ size = 9, className, color = "#D97706" }: { size?: number; className?: string; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={cn("shrink-0", className)}>
      <rect x="3" y="3" width="10" height="10" rx="2" transform="rotate(45 8 8)" fill={color} />
    </svg>
  );
}

/** The black ◆ that marks a decision (决定 #n). */
export function DecisionMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden className={cn("shrink-0", className)}>
      <rect x="4" y="4" width="14" height="14" rx="2.5" transform="rotate(45 11 11)" className="fill-ink" />
    </svg>
  );
}

/** A work-order ticket icon (需求单). */
export function TicketMark({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={cn("shrink-0", className)}>
      <path
        d="M2 4.2A1.2 1.2 0 0 1 3.2 3h9.6A1.2 1.2 0 0 1 14 4.2V6a2 2 0 0 0 0 4v1.8a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V10a2 2 0 0 0 0-4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M10 4.5v1.2M10 7.4v1.2M10 10.3v1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** The chief's crown, drawn over a full-body figure. */
export function Crown({ width = 26, className, style }: { width?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={width} height={(width * 15) / 26} viewBox="0 0 26 15" aria-hidden className={className} style={style}>
      <polygon points="1,14 1,5 6,5 6,9 9,9 9,1 17,1 17,9 20,9 20,5 25,5 25,14" fill="#E5A00D" stroke="#FFFFFF" strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="11.5" y="4" width="3" height="3" fill="#FFF3C4" />
    </svg>
  );
}

// ── hooks ────────────────────────────────────────────────────────────────────
/** A clock that ticks every `ms` (relative times stay fresh without a poll). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** The content-box size of an element, kept current. */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setSize((current) => (current.width === node.clientWidth && current.height === node.clientHeight ? current : { width: node.clientWidth, height: node.clientHeight }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** A small preference remembered in localStorage (per window). */
export function useStoredState<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null;
      return stored && allowed.includes(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // the choice still holds for this visit
      }
    },
    [key],
  );
  return [value, set];
}
