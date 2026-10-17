/** Same as Tailwind `gap-3` on the transcript stack. The last bubble sits
 * this far above the composer when the pane is scrolled to the end. */
export const TRANSCRIPT_GAP = "0.75rem";

/** Empty one-line pill (~50px) plus the dock's `pb-3`. The observer replaces
 * this before the first paint once the real composer is measured. */
const FALLBACK_COMPOSER_PX = 64;

/** The docked composer's live height, written onto the chat pane by the
 * bottom-follow observer. A CSS variable instead of React state: the
 * transcript padding and the follow scroll then change in the same frame
 * the composer grows, instead of one or two renders later. */
export const COMPOSER_DOCK_VAR = "--composer-dock-h";

/** The measured dock height as the length the variable carries. Ceiled, so
 * a subpixel composer cannot eat into the gap above it. */
export function composerDockLength(composerHeightPx: number): string {
  const height = Number.isFinite(composerHeightPx) ? Math.max(0, Math.ceil(composerHeightPx)) : FALLBACK_COMPOSER_PX;
  return `${height}px`;
}

/** The composer's height wherever it is needed (the "Jump to latest" pill
 * floats on top of it). */
export const COMPOSER_DOCK_HEIGHT = `var(${COMPOSER_DOCK_VAR}, ${FALLBACK_COMPOSER_PX}px)`;

/** Pad the transcript so rest-at-bottom leaves one inter-bubble gap above
 * the docked composer, whatever it holds right now (a multiline draft, a
 * queued chip, an error strip, an approval takeover). */
export const TRANSCRIPT_END_PAD = `calc(${COMPOSER_DOCK_HEIGHT} + ${TRANSCRIPT_GAP})`;
