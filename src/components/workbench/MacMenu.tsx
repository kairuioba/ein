// A context menu that behaves like a macOS one: opens at the pointer, stays
// on screen, highlights on hover or arrow keys, runs on click or Return, and
// closes on Escape, an outside click, scrolling, or the window losing focus.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

export type MacMenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" }
  | { kind: "header"; label: string };

export function MacMenu({ x, y, items, onClose }: { x: number; y: number; items: MacMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.kind ?? "item") === "item" && !(item as { disabled?: boolean }).disabled);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    menu.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [onClose]);

  const run = (index: number) => {
    const item = items[index];
    if (!item || (item.kind ?? "item") !== "item") return;
    const entry = item as Extract<MacMenuItem, { onSelect: () => void }>;
    if (entry.disabled) return;
    onClose();
    entry.onSelect();
  };

  const move = (delta: number) => {
    if (!selectable.length) return;
    const current = selectable.findIndex(({ index }) => index === active);
    const next = current === -1 ? (delta > 0 ? 0 : selectable.length - 1) : (current + delta + selectable.length) % selectable.length;
    setActive(selectable[next]!.index);
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Enter" && active !== null) {
          event.preventDefault();
          run(active);
        }
      }}
      style={position}
      className="animate-pop-in fixed z-[70] min-w-[220px] max-w-[320px] rounded-[10px] border border-hairline/60 bg-panel/95 p-[5px] text-[13px] text-ink shadow-2xl shadow-black/40 outline-none backdrop-blur-xl"
    >
      {items.map((item, index) => {
        if (item.kind === "separator") return <div key={`sep-${index}`} className="mx-2 my-[5px] h-px bg-hairline/70" />;
        if (item.kind === "header") {
          return (
            <div key={`hdr-${index}`} className="truncate px-2.5 pb-0.5 pt-1 text-[11px] font-semibold text-ink-secondary">
              {item.label}
            </div>
          );
        }
        const highlighted = active === index;
        return (
          <button
            key={`${item.label}-${index}`}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            onPointerEnter={() => setActive(item.disabled ? null : index)}
            onPointerLeave={() => setActive(null)}
            onClick={() => run(index)}
            className={cn(
              "flex h-[26px] w-full items-center gap-2 rounded-[5px] px-2.5 text-left outline-none",
              item.disabled && "opacity-40",
              highlighted && !item.disabled && (item.danger ? "bg-danger text-white" : "bg-accent text-white"),
              !highlighted && item.danger && "text-danger",
            )}
          >
            <span className={cn("flex w-4 shrink-0 justify-center", highlighted ? "text-white" : "text-ink-secondary")}>{item.icon}</span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className={cn("shrink-0 text-[12px] tracking-wide", highlighted ? "text-white/80" : "text-ink-secondary")}>{item.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
