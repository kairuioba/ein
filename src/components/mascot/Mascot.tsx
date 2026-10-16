// Engine mascots as React components:
//   <Mascot kind pose scale />   the full figure (people view, call tiles, onboarding)
//   <BotTile kind size state chief />  the head-and-shoulders avatar in a soft tile
//   <NameTag name driverKind lead />   the name plate with the official-icon slot
// The art is two sprite sheets (see scripts/mascots/generate.py); positions are
// computed from MASCOT_KINDS / MASCOT_POSES, which mirror the sheet layout.
import type { CSSProperties, ReactNode } from "react";
import mascotSheet from "@/assets/mascots/mascots.png";
import bustSheet from "@/assets/mascots/busts.png";
import claudeBust from "@/assets/mascots/claude-bust.jpg";
import { ProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import {
  MASCOT_BRAND,
  MASCOT_KINDS,
  MASCOT_POSES,
  tint,
  type MascotKind,
  type MascotPose,
} from "@/lib/engine-mascots";

const CELL = 72;

/** A full-body figure. `scale` should be a whole number or 1.5 so pixels stay
 * square on 2× screens (72, 108, 144 px …). */
export function Mascot({
  kind,
  pose = "idle",
  scale = 1,
  dim = false,
  shadow = false,
  className,
  title,
}: {
  kind: MascotKind;
  pose?: MascotPose;
  scale?: number;
  dim?: boolean;
  shadow?: boolean;
  className?: string;
  title?: string;
}) {
  const size = CELL * scale;
  const col = MASCOT_POSES.indexOf(pose);
  const row = MASCOT_KINDS.indexOf(kind);
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundImage: `url(${mascotSheet})`,
    backgroundSize: `${size * MASCOT_POSES.length}px ${size * MASCOT_KINDS.length}px`,
    backgroundPosition: `${-col * size}px ${-row * size}px`,
    imageRendering: "pixelated",
  };
  return (
    <span className={cn("relative inline-block shrink-0", className)} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {shadow && (
        <span
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 rounded-[50%]"
          style={{
            bottom: size * 0.02,
            width: size * 0.6,
            height: size * 0.13,
            background: "radial-gradient(closest-side, rgb(16 24 40 / 0.22), rgb(16 24 40 / 0))",
          }}
        />
      )}
      <span className={cn("relative block", dim && "opacity-45 grayscale-[0.7]")} style={style} />
    </span>
  );
}

export type TileState = "working" | "waiting" | null | undefined;

/** The avatar: a bust on the engine's brand tint. Claude shows the team's own
 * artwork on a dark ground. Markers: a crown for the chief, an amber diamond
 * for "waiting on you", blue pixels for "working". */
export function BotTile({
  kind,
  size = 32,
  state,
  chief = false,
  className,
  title,
}: {
  kind: MascotKind;
  size?: number;
  state?: TileState;
  chief?: boolean;
  className?: string;
  title?: string;
}) {
  const brand = MASCOT_BRAND[kind];
  const isClaude = kind === "claude";
  const inset = size * (isClaude ? 0.04 : 0.1);
  const inner = size - inset * 2;
  const k = size / 12;
  const index = MASCOT_KINDS.indexOf(kind);
  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <span
        className="absolute inset-0 overflow-hidden"
        style={{
          borderRadius: size * 0.28,
          background: isClaude ? "#14161C" : tint(brand, 0.86),
          boxShadow: `inset 0 0 0 ${Math.max(1, size * 0.03)}px ${isClaude ? "#2A2E38" : tint(brand, 0.55)}`,
        }}
      >
        {isClaude ? (
          <img src={claudeBust} alt="" draggable={false} className="absolute object-cover" style={{ left: inset, top: inset, width: inner, height: inner, borderRadius: size * 0.22 }} />
        ) : (
          <span
            className="absolute"
            style={{
              left: inset,
              top: inset + size * 0.06,
              width: inner,
              height: inner,
              backgroundImage: `url(${bustSheet})`,
              backgroundSize: `${inner * MASCOT_KINDS.length}px ${inner}px`,
              backgroundPosition: `${-index * inner}px 0`,
            }}
          />
        )}
      </span>
      {chief && (
        <svg
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2"
          style={{ top: -k * 2.6, width: k * 6.4, height: k * 3.6 }}
          viewBox="0 0 26 15"
        >
          <polygon points="1,14 1,5 6,5 6,9 9,9 9,1 17,1 17,9 20,9 20,5 25,5 25,14" fill="#E5A00D" stroke="#FFFFFF" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      )}
      {state === "waiting" && (
        <span
          aria-hidden
          className="absolute rotate-45 rounded-[2px] bg-[#D97706] ring-2 ring-raised"
          style={{ right: -k * 0.6, bottom: -k * 0.6, width: k * 3, height: k * 3 }}
        />
      )}
      {state === "working" &&
        [
          [-1.6, 0.3, 1],
          [0.7, -1.6, 0.8],
          [1.04, 0.62, 0.6],
          [0.22, 1.04, 0.45],
        ].map(([x, y, o], i) => (
          <span
            key={i}
            aria-hidden
            className="absolute bg-select"
            style={{
              left: x < 0 ? x * k : x * size,
              top: y < 0 ? y * k : y * size,
              width: k * 1.1,
              height: k * 1.1,
              opacity: o,
            }}
          />
        ))}
    </span>
  );
}

/** A name plate: the engine's official icon (unaltered) in a small slot, then
 * the bot's name. Leads get the dark plate, everyone else the light one. */
export function NameTag({
  name,
  driverKind,
  lead = false,
  star = false,
  className,
  children,
}: {
  name: string;
  driverKind?: string;
  lead?: boolean;
  star?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] max-w-full items-center gap-[5px] rounded-[7px] pr-2 pl-1 text-[12px] font-semibold whitespace-nowrap",
        lead ? "bg-[#14161C] text-white shadow-[0_3px_8px_-3px_rgb(16_24_40/0.45)]" : "bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)]",
        className,
      )}
    >
      <span className={cn("grid size-[15px] shrink-0 place-items-center overflow-hidden rounded-[4px]", lead ? "bg-white" : "bg-control")}>
        {driverKind ? <ProviderMark driverKind={driverKind} size={11} /> : null}
      </span>
      <span className="truncate">{name}</span>
      {star && (
        <svg aria-hidden width="11" height="11" viewBox="0 0 16 16" className="shrink-0">
          <path d="M8 1.5l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3 4 13.5l1-4.4-3.4-3 4.5-.5z" fill="#F5B301" />
        </svg>
      )}
      {children}
    </span>
  );
}
