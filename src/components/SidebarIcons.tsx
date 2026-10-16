// The navigation icons drawn for the round-8 sidebar and the ⌘K palette
// (light-kit/icons.svg): 24-unit strokes at 1.8, coloured by currentColor.
// Generic glyphs (search, chevrons, hash, users …) come from lucide-react.
import type { ReactNode } from "react";

function Stroke({ size = 18, children, className }: { size?: number; children: ReactNode; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number; className?: string };

/** 简报 — a page with two lines. */
export function BriefIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM14 3.5V8h4M9 12h6M9 15.5h6" />
    </Stroke>
  );
}

/** 工作台 — three linked cards. */
export function WorkbenchIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="3.5" width="7" height="6.5" rx="2" />
      <rect x="14" y="14" width="7" height="6.5" rx="2" />
      <rect x="14" y="3.5" width="7" height="6.5" rx="2" />
      <path d="M10 6.75h4M17.5 10v4" />
    </Stroke>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </Stroke>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Stroke>
  );
}

/** 技能 — a wand with two sparks. */
export function WandIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 20L14.5 9.5" />
      <path d="M14 3.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1z" />
      <path d="M19 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    </Stroke>
  );
}

/** 连接应用 — a plug. */
export function PlugIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </Stroke>
  );
}

/** Collapse / expand the sidebar. */
export function SidebarToggleIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </Stroke>
  );
}

/** New: chat, group chat, bot. */
export function ComposeIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13" />
      <path d="M10 14l.6-3L18 3.6l2.4 2.4L13 13.4z" />
    </Stroke>
  );
}

/** Settings — two sliders. */
export function SlidersIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Stroke>
  );
}

const ROOM_TINTS = ["#F97316", "#14B8A6", "#0EA5E9", "#8B5CF6", "#EC4899", "#65A30D", "#F59E0B"];

/** A group chat's tile colour: teal for a meeting, otherwise one that stays
 * the same for the group. */
export function groupTint(groupId: string, meeting = false): string {
  if (meeting) return "#14B8A6";
  let hash = 0;
  for (let index = 0; index < groupId.length; index += 1) hash = (hash * 31 + groupId.charCodeAt(index)) | 0;
  return ROOM_TINTS[Math.abs(hash) % ROOM_TINTS.length]!;
}

/** A soft square in a tint with an icon in it (group chats, files, routines). */
export function SquareTile({ tint, size = 30, children }: { tint: string; size?: number; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        color: tint,
        background: `color-mix(in oklab, ${tint} 14%, var(--color-raised))`,
      }}
    >
      {children}
    </span>
  );
}

/** The 主 Bot's gold star. */
export function ChiefStar({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={className}>
      <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" fill="#E5A00D" />
    </svg>
  );
}

/** The blue "working" spinner on a row's status line (still under reduced motion). */
export function WorkingSpinner({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={className}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2.2} />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}
