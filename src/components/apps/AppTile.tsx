// A neutral monogram tile for a connected app (U13): one character on a soft
// colour. Apps never show a logo here — the design rules forbid drawing them.
import { monogram } from "@/lib/app-catalog";
import { cn } from "@/lib/cn";

export function AppTile({ label, slug, size = 40, className }: { label: string; slug?: string; size?: number; className?: string }) {
  const tile = monogram(label, slug ?? label);
  return (
    <span
      aria-hidden
      className={cn("inline-grid shrink-0 place-items-center font-bold leading-none", className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        fontSize: Math.round(size * 0.42),
        background: tile.bg,
        color: tile.fg,
        boxShadow: `inset 0 0 0 1px ${tile.fg}1F`,
      }}
    >
      {tile.char}
    </span>
  );
}
