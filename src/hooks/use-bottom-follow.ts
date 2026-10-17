import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { bottomScrollTop, createBottomFollow } from "@/lib/bottom-follow";
import { COMPOSER_DOCK_VAR, composerDockLength } from "@/lib/composer-dock";

function borderBoxHeight(entry: ResizeObserverEntry): number {
  const box = entry.borderBoxSize?.[0];
  return box ? box.blockSize : entry.target.getBoundingClientRect().height;
}

/**
 * Stick-to-bottom for a chat pane whose composer floats over the transcript.
 *
 * One ResizeObserver watches the scroll container, the transcript and the
 * composer dock. Its callback runs after layout and before paint, so while
 * the reader is following, every change in height — a reply, a card, a
 * loaded image, a composer that grows a line — is pinned in the frame it
 * happens in. The dock's height goes onto the pane as a CSS variable (the
 * transcript's end padding reads it), so padding and scroll move together.
 */
export function useBottomFollow({
  scrollRef,
  contentRef,
  dockRef,
  resetKey,
  observeKey,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  dockRef: RefObject<HTMLElement | null>;
  /** A different conversation: follow from its end, pinned before paint. */
  resetKey: string;
  /** Re-attach the observer when the transcript element is swapped. */
  observeKey?: unknown;
}) {
  const [following, setFollowing] = useState(true);
  const follow = useMemo(
    () =>
      createBottomFollow({
        scroller: () => scrollRef.current,
        onDockHeight: (px) => dockRef.current?.parentElement?.style.setProperty(COMPOSER_DOCK_VAR, composerDockLength(px)),
        onFollowChange: setFollowing,
      }),
    [scrollRef, dockRef],
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const dock = dockRef.current;
    if (!scroller) return;
    // measured now, so even the first paint pads for the real composer
    follow.resized(dock ? dock.getBoundingClientRect().height : undefined);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      let dockHeight: number | undefined;
      for (const entry of entries) if (entry.target === dock) dockHeight = borderBoxHeight(entry);
      follow.resized(dockHeight);
    });
    observer.observe(scroller);
    if (content) observer.observe(content);
    if (dock) observer.observe(dock);
    return () => observer.disconnect();
  }, [follow, scrollRef, contentRef, dockRef, observeKey]);

  // a new conversation opens at its end, before the first paint
  useLayoutEffect(() => {
    follow.reset();
  }, [follow, resetKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typingInField =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      follow.key(event.key, typingInField);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [follow]);

  /** One tap back to the end; glides unless the reader asked for less motion. */
  const jumpToLatest = useCallback(() => {
    follow.resume();
    const el = scrollRef.current;
    if (!el) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: bottomScrollTop(el), behavior: reduced ? "auto" : "smooth" });
  }, [follow, scrollRef]);

  /** Spread onto the scroll container: the reader's own gestures. */
  const scrollProps = useMemo(
    () => ({
      onWheel: (event: ReactWheelEvent<HTMLElement>) => follow.wheel(event.deltaY),
      onTouchStart: (event: ReactTouchEvent<HTMLElement>) => follow.touchStart(event.touches[0]?.clientY ?? 0),
      onTouchMove: (event: ReactTouchEvent<HTMLElement>) => follow.touchMove(event.touches[0]?.clientY ?? 0),
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        // the scrollbar lane lies past the content box (clientWidth excludes it)
        const el = event.currentTarget;
        if (event.target === el && event.nativeEvent.offsetX >= el.clientWidth) follow.grabbedScrollbar();
      },
      onScroll: () => follow.scrolled(),
    }),
    [follow],
  );

  return { following, follow, jumpToLatest, scrollProps };
}
