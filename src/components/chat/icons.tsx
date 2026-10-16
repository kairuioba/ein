// The chat's line icons, drawn from the design's own icon sheet so the
// strokes match the approved screens. Generic glyphs only — engine and app
// logos always come from ProviderMark, never from here.
import type { SVGProps } from "react";

type IconProps = { size?: number; className?: string; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">;

function Svg({ size = 16, className, strokeWidth = 1.8, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12.5" rx="2.5" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </Svg>
);
export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 15.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5" />
  </Svg>
);
export const IconMore = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg strokeWidth={1.9} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconAt = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M15.8 8.5v4.3a2.4 2.4 0 0 0 4.7.5 8.6 8.6 0 1 0-3.4 5.4" />
  </Svg>
);
export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />
  </Svg>
);
export const IconX = (p: IconProps) => (
  <Svg strokeWidth={1.9} {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);
export const IconBack = (p: IconProps) => (
  <Svg strokeWidth={1.9} {...p}>
    <path d="M14.5 6.5L9 12l5.5 5.5" />
  </Svg>
);
export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="M9.5 4.5v15" />
  </Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const IconReply = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 6 6v4" />
  </Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.8a3.5 3.5 0 0 1 0 7.2M18 14.2A6.5 6.5 0 0 1 21.5 20" />
  </Svg>
);
export const IconSlash = (p: IconProps) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M15 4L9 20" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M6.5 9.5L12 15l5.5-5.5" />
  </Svg>
);

/** The gold star the 主 Bot carries next to its name. */
export const IconStar = ({ size = 13, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={className}>
    <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" fill="#E5A00D" />
  </svg>
);
