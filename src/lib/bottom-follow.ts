/** Subpixel slack for "at the rest position" — not a magnet zone. A larger
 * value used to re-pin follow ~48px early and then jump the pane to the end. */
export const BOTTOM_FOLLOW_THRESHOLD = 4;

/**
 * Resume automatic bottom-follow only when the reader is already at the
 * rest position and still moving toward it. Re-pinning must not imply a
 * snap; the scroll effect follows new content, it does not yank the viewport.
 */
export function shouldResumeBottomFollow({
  following,
  previousScrollTop,
  scrollTop,
  distanceFromBottom,
}: {
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): boolean {
  return !following && scrollTop > previousScrollTop && distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD;
}

/** What a follower reads and writes: the transcript's scroll container in
 * the app, a plain object in tests. */
export interface FollowScroller {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function distanceFromBottom(el: FollowScroller): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** The rest position: scrolled all the way down, so the transcript's end
 * padding leaves the last row one gap above the docked composer. */
export function bottomScrollTop(el: FollowScroller): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/** What a reader's gesture means for bottom-follow. Follow breaks ONLY on an
 * upward gesture, never on a position check: while content grows, "at the
 * bottom" reads false between the growth and the pin, and breaking there
 * would end follow for good (upstream-verified failure). */
export type FollowIntent = "detach" | "resume" | null;

export function wheelFollowIntent(deltaY: number, atEnd: boolean): FollowIntent {
  if (deltaY < 0) return "detach";
  return deltaY > 0 && atEnd ? "resume" : null;
}

/** A finger moving down drags the transcript toward older rows. */
export function touchFollowIntent(previousY: number, y: number, atEnd: boolean): FollowIntent {
  if (y > previousY + 4) return "detach";
  return atEnd ? "resume" : null;
}

/** The keyboard is a scroll gesture too: PageUp, Home and ArrowUp read
 * scrollback. ArrowUp and Home only count outside a text field — in the
 * composer they move the caret (or edit the last message). */
export function keyFollowIntent(key: string, typingInField: boolean): FollowIntent {
  if (key === "PageUp") return "detach";
  if ((key === "Home" || key === "ArrowUp") && !typingInField) return "detach";
  return null;
}

/**
 * Stick-to-bottom for a chat transcript, free of React and the DOM so it can
 * be tested with plain objects.
 *
 * The view calls `resized()` from a ResizeObserver watching the transcript,
 * its scroll container and the composer dock. ResizeObserver callbacks run
 * after layout and before paint, so a reply, a card that grows, an image
 * that loads or a composer that gains a line is followed in the same frame
 * it appears in: no frame paints the new end hidden behind the composer, and
 * there is no scroll animation to restart on every change.
 */
export function createBottomFollow(host: {
  scroller: () => FollowScroller | null;
  /** the composer dock's measured height, whenever it changes */
  onDockHeight?: (px: number) => void;
  /** follow switched on or off (drives the "Jump to latest" control) */
  onFollowChange?: (following: boolean) => void;
}) {
  let following = true;
  let previousScrollTop = 0;
  let touchY = 0;

  const setFollowing = (next: boolean) => {
    if (next === following) return;
    following = next;
    host.onFollowChange?.(next);
  };
  const atEnd = () => {
    const el = host.scroller();
    return !el || distanceFromBottom(el) < BOTTOM_FOLLOW_THRESHOLD;
  };
  const pin = () => {
    const el = host.scroller();
    if (!el) return;
    const top = bottomScrollTop(el);
    // a no-op write still costs a scroll event; skip it at rest
    if (Math.abs(el.scrollTop - top) >= 1) el.scrollTop = top;
    previousScrollTop = el.scrollTop;
  };
  const apply = (intent: FollowIntent) => {
    if (intent === "detach") setFollowing(false);
    else if (intent === "resume") setFollowing(true);
  };

  return {
    isFollowing: () => following,
    /** A fresh conversation (or the first mount): follow, at the end. */
    reset() {
      setFollowing(true);
      pin();
    },
    /** Something changed size. `dockHeight` is set when the composer dock
     * was among the resized targets. */
    resized(dockHeight?: number) {
      if (dockHeight !== undefined) host.onDockHeight?.(dockHeight);
      if (following) pin();
    },
    /** Reading scrollback on purpose (a search hit, "show earlier"). */
    detach() {
      setFollowing(false);
    },
    /** Arm follow without moving; the caller scrolls (Jump to latest). */
    resume() {
      setFollowing(true);
    },
    wheel(deltaY: number) {
      apply(wheelFollowIntent(deltaY, atEnd()));
    },
    touchStart(y: number) {
      touchY = y;
    },
    touchMove(y: number) {
      apply(touchFollowIntent(touchY, y, atEnd()));
    },
    key(key: string, typingInField: boolean) {
      apply(keyFollowIntent(key, typingInField));
    },
    /** Grabbing the scrollbar is a scroll gesture. */
    grabbedScrollbar() {
      setFollowing(false);
    },
    /** The container scrolled: scrolling back down to the end re-arms. */
    scrolled() {
      const el = host.scroller();
      if (!el) return;
      const scrollTop = el.scrollTop;
      const resume = shouldResumeBottomFollow({
        following,
        previousScrollTop,
        scrollTop,
        distanceFromBottom: distanceFromBottom(el),
      });
      previousScrollTop = scrollTop;
      if (resume) setFollowing(true);
    },
    /** The view moved scrollTop itself (restoring a position after rows were
     * prepended); keep the resume check from reading it as the reader's. */
    syncScrollTop() {
      const el = host.scroller();
      if (el) previousScrollTop = el.scrollTop;
    },
  };
}

export type BottomFollow = ReturnType<typeof createBottomFollow>;
