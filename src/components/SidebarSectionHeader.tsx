import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  sidebarAttentionLabel,
  type SidebarSectionAttention,
} from "@/lib/sidebar-attention";

/** A sidebar section's heading: chevron, the department's colour square, its
 * name, a short note ("Delivered", "+2", a new squad), the count, and — on
 * hover — a grip to drag the section. The whole row toggles the section; the
 * note can hold its own button, so the toggle sits underneath as a layer
 * rather than wrapping the content. */
export function SidebarSectionHeader({
  name,
  collapsed,
  attention,
  onToggle,
  reorderable,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMove,
  color,
  note,
  count,
}: {
  name: string;
  collapsed: boolean;
  attention?: SidebarSectionAttention;
  onToggle?: () => void;
  reorderable: boolean;
  dragging: boolean;
  onDragStart?: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onMove?: (direction: -1 | 1) => void;
  /** department colour, "#RRGGBB" */
  color?: string;
  /** inline after the name; may contain a button */
  note?: ReactNode;
  count?: number;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const attentionLabel = attention ? sidebarAttentionLabel(attention) : "";
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!reorderable || !event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove?.(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove?.(1);
    }
  };
  const badges = attention && (
    <>
      {attention.waiting > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none relative min-w-4 rounded-full bg-warning/15 px-1 text-center text-[9.5px] font-semibold leading-4 text-warning"
        >
          {attention.waiting}
        </span>
      )}
      {attention.unread > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none relative min-w-4 rounded-full bg-select/15 px-1 text-center text-[9.5px] font-semibold leading-4 text-accent-text"
        >
          {attention.unread}
        </span>
      )}
      {attention.working > 0 && (
        <span aria-hidden="true" className="pointer-events-none relative flex size-4 items-center justify-center">
          <span className="size-1.5 animate-pulse rounded-full bg-select" />
        </span>
      )}
    </>
  );

  return (
    <div
      className="group/section relative mt-1 flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-2 text-[12px] font-semibold text-ink-secondary"
      data-section={name}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={onHeaderKeyDown}
          aria-expanded={!collapsed}
          aria-label={attentionLabel ? `${name} · ${attentionLabel}` : name}
          aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={
            reorderable
              ? collapsed
                ? t("Expand {name}. Alt+Up/Down reorders it.", { name })
                : t("Collapse {name}. Alt+Up/Down reorders it.", { name })
              : collapsed
                ? t("Expand {name}", { name })
                : t("Collapse {name}", { name })
          }
          className="absolute inset-0 rounded-lg hover:bg-raised-hover/70"
        />
      ) : null}
      {onToggle && <Chevron size={13} aria-hidden="true" className="pointer-events-none relative shrink-0 text-ink-secondary/80" />}
      {color && (
        <span aria-hidden="true" className="pointer-events-none relative size-[7px] shrink-0 rounded-[2px]" style={{ background: color }} />
      )}
      <span className="pointer-events-none relative truncate">{name}</span>
      {note && <span className="relative flex min-w-0 shrink-0 items-center gap-1.5 font-medium">{note}</span>}
      {collapsed && badges}
      {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
      <span
        className={cn(
          "pointer-events-none relative ml-auto shrink-0 font-medium text-ink-secondary/70 tabular-nums transition-opacity",
          reorderable && "group-hover/section:opacity-0",
        )}
      >
        {count ?? ""}
      </span>
      {/* the grip takes the count's place on hover, so it costs no width */}
      {reorderable && (
        <span
          aria-hidden="true"
          draggable
          title={t("Drag to reorder")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className={cn(
            "absolute right-1 top-1/2 flex size-5 -translate-y-1/2 cursor-grab items-center justify-center rounded text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover/section:opacity-100",
            dragging && "opacity-40",
          )}
        >
          <GripVertical size={12} />
        </span>
      )}
    </div>
  );
}
