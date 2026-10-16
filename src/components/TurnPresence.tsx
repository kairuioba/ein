// The typing line at the tail of a conversation (design U8): the bot's tile,
// "<bot> is …" and three dots while it works, with a quiet elapsed time.
// The moment there is an answer the line steps aside and the full bubble
// pops in on the same left edge.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WorkingDots, WorkingTimer } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";

export function TurnPresence({
  avatar,
  visible,
  label = t("Thinking"),
  answering = false,
  since = null,
  children,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  /** Turn start (epoch ms) — shows a self-ticking elapsed readout while working. */
  since?: number | null;
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  if (!mounted) return null;
  const showAnswer = phase === "answer" && children;
  return (
    <div className="turn-presence flex flex-col items-start">
      {showAnswer ? <div className="turn-answer w-full">{children}</div> : null}
      {!showAnswer && (
        <div
          className={cn(
            "flex min-h-6 items-center gap-2 text-[12.5px] text-ink-secondary",
            phase === "think" && "turn-mascot-in",
            phase === "out" && "turn-mascot-out",
          )}
        >
          {avatar}
          <span aria-live="polite" className="min-w-0 truncate">
            {label}
          </span>
          <WorkingDots size={4} className="text-ink-secondary/70" />
          {since !== null && <WorkingTimer since={since} className="text-[11.5px] text-ink-secondary/60" />}
        </div>
      )}
    </div>
  );
}
