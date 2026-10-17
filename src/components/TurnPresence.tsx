// The typing line at the tail of a conversation (design U8): the bot's tile,
// "<bot> is …" and three dots while it works, with a quiet elapsed time.
// The moment there is an answer the line steps aside and the reply pops in
// on the same left edge — the reply is already in the transcript then, so
// the line leaves in that same frame: the tail changes height once.
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WorkingDots, WorkingTimer } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";

export function TurnPresence({
  avatar,
  visible,
  label = t("Thinking"),
  replaced = false,
  since = null,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  /** The reply that ended the wait is in the transcript now: step aside at
   * once instead of fading, so the line and the reply never both take room. */
  replaced?: boolean;
  /** Turn start (epoch ms) — shows a self-ticking elapsed readout while working. */
  since?: number | null;
}) {
  const [mounted, setMounted] = useState(visible);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    if (replaced) {
      setMounted(false);
      setLeaving(false);
      return;
    }
    // nothing took its place (stopped, failed, waiting on you): fade out
    setLeaving(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, 280);
    return () => clearTimeout(timer);
  }, [visible, replaced, mounted]);

  // decided during render, not after: an effect would leave the line under
  // the new reply for a frame, and the pinned transcript would jump twice
  if (!visible && (replaced || !mounted)) return null;
  return (
    <div className={cn("turn-presence flex flex-col items-start", leaving && !visible && "turn-presence-close")}>
      <div
        className={cn(
          "flex min-h-6 items-center gap-2 text-[12.5px] text-ink-secondary",
          leaving && !visible ? "turn-mascot-out" : "turn-mascot-in",
        )}
      >
        {avatar}
        <span aria-live="polite" className="min-w-0 truncate">
          {label}
        </span>
        <WorkingDots size={4} className="text-ink-secondary/70" />
        {since !== null && <WorkingTimer since={since} className="text-[11.5px] text-ink-secondary/60" />}
      </div>
    </div>
  );
}
