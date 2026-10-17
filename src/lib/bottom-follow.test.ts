import { describe, expect, it, vi } from "vitest";

import {
  BOTTOM_FOLLOW_THRESHOLD,
  bottomScrollTop,
  createBottomFollow,
  distanceFromBottom,
  keyFollowIntent,
  shouldResumeBottomFollow,
  touchFollowIntent,
  wheelFollowIntent,
} from "./bottom-follow";

describe("shouldResumeBottomFollow", () => {
  it("does not re-pin a small upward scroll inside the near-bottom zone", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 1_000,
        scrollTop: 992,
        distanceFromBottom: 8,
      }),
    ).toBe(false);
  });

  it("re-pins after scrolling downward to the end", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 992,
        scrollTop: 1_000,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });

  it("stays detached while downward movement remains away from the end", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 500,
        scrollTop: 600,
        distanceFromBottom: BOTTOM_FOLLOW_THRESHOLD,
      }),
    ).toBe(false);
  });

  it("does not re-pin in the old 48px magnet zone", () => {
    expect(
      shouldResumeBottomFollow({
        following: false,
        previousScrollTop: 952,
        scrollTop: 960,
        distanceFromBottom: 40,
      }),
    ).toBe(false);
  });

  it("does nothing when bottom-follow is already active", () => {
    expect(
      shouldResumeBottomFollow({
        following: true,
        previousScrollTop: 992,
        scrollTop: 1_000,
        distanceFromBottom: 0,
      }),
    ).toBe(false);
  });
});

describe("follow intents", () => {
  it("an upward wheel detaches; a downward one re-arms only at the end", () => {
    expect(wheelFollowIntent(-30, true)).toBe("detach");
    expect(wheelFollowIntent(30, true)).toBe("resume");
    expect(wheelFollowIntent(30, false)).toBeNull();
    expect(wheelFollowIntent(0, true)).toBeNull();
  });

  it("a finger dragging the transcript down reads scrollback", () => {
    expect(touchFollowIntent(100, 140, false)).toBe("detach");
    expect(touchFollowIntent(100, 102, false)).toBeNull();
    expect(touchFollowIntent(100, 60, true)).toBe("resume");
  });

  it("PageUp always reads scrollback; Home and ArrowUp only outside a text field", () => {
    expect(keyFollowIntent("PageUp", true)).toBe("detach");
    expect(keyFollowIntent("ArrowUp", false)).toBe("detach");
    expect(keyFollowIntent("Home", false)).toBe("detach");
    expect(keyFollowIntent("ArrowUp", true)).toBeNull();
    expect(keyFollowIntent("Home", true)).toBeNull();
    expect(keyFollowIntent("Enter", false)).toBeNull();
  });
});

/** A scroll container as the browser models it: scrollTop is clamped to
 * [0, scrollHeight - clientHeight], and content can grow or shrink. */
class FakeScroller {
  clientHeight: number;
  content: number;
  writes = 0;
  private top = 0;
  constructor(content: number, clientHeight = 500) {
    this.content = content;
    this.clientHeight = clientHeight;
  }
  get scrollHeight() {
    return Math.max(this.content, this.clientHeight);
  }
  get scrollTop() {
    return Math.min(this.top, this.scrollHeight - this.clientHeight);
  }
  set scrollTop(value: number) {
    this.writes += 1;
    this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }
}

function setup(content = 2_000) {
  const el = new FakeScroller(content);
  const onDockHeight = vi.fn();
  const onFollowChange = vi.fn();
  const follow = createBottomFollow({ scroller: () => el, onDockHeight, onFollowChange });
  follow.reset();
  return { el, follow, onDockHeight, onFollowChange };
}

describe("createBottomFollow", () => {
  it("opens a conversation at its end", () => {
    const { el, follow } = setup();
    expect(follow.isFollowing()).toBe(true);
    expect(el.scrollTop).toBe(1_500);
    expect(distanceFromBottom(el)).toBe(0);
    expect(bottomScrollTop(el)).toBe(1_500);
  });

  it("keeps a growing transcript at its end on every resize", () => {
    const { el, follow } = setup();
    el.content += 420; // a reply lands
    follow.resized();
    expect(distanceFromBottom(el)).toBe(0);
    el.content += 36; // a card grows after it mounted
    follow.resized();
    expect(el.scrollTop).toBe(1_956);
  });

  it("passes the composer dock's height on and follows its growth", () => {
    const { el, follow, onDockHeight } = setup();
    el.content += 60; // a five-line draft pads the transcript by the taller dock
    follow.resized(124);
    expect(onDockHeight).toHaveBeenCalledWith(124);
    expect(distanceFromBottom(el)).toBe(0);
  });

  it("does not write scrollTop when nothing moved", () => {
    const { el, follow } = setup();
    const writes = el.writes;
    follow.resized();
    follow.resized();
    expect(el.writes).toBe(writes);
  });

  it("an upward wheel detaches: new content no longer moves the reader", () => {
    const { el, follow, onFollowChange } = setup();
    follow.wheel(-40);
    el.scrollTop = 1_100; // the wheel's own scroll
    follow.scrolled();
    expect(onFollowChange).toHaveBeenLastCalledWith(false);
    el.content += 500;
    follow.resized();
    expect(el.scrollTop).toBe(1_100);
    expect(follow.isFollowing()).toBe(false);
  });

  it("scrolling back down to the end re-arms follow", () => {
    const { el, follow, onFollowChange } = setup();
    follow.wheel(-40);
    el.scrollTop = 1_000;
    follow.scrolled();
    el.scrollTop = 1_500;
    follow.scrolled();
    expect(follow.isFollowing()).toBe(true);
    expect(onFollowChange).toHaveBeenLastCalledWith(true);
    el.content += 100;
    follow.resized();
    expect(distanceFromBottom(el)).toBe(0);
  });

  it("a downward wheel re-arms only once the end is reached", () => {
    const { el, follow } = setup();
    follow.wheel(-40);
    el.scrollTop = 1_000;
    follow.wheel(40);
    expect(follow.isFollowing()).toBe(false);
    el.scrollTop = 1_500;
    follow.wheel(40);
    expect(follow.isFollowing()).toBe(true);
  });

  it("content shrinking at the end keeps the reader at the end", () => {
    const { el, follow } = setup();
    el.content -= 36; // the typing line steps aside
    follow.resized();
    expect(distanceFromBottom(el)).toBe(0);
    expect(follow.isFollowing()).toBe(true);
  });

  it("touch, keys and the scrollbar detach like the wheel", () => {
    const touch = setup();
    touch.follow.touchStart(100);
    touch.follow.touchMove(150);
    expect(touch.follow.isFollowing()).toBe(false);

    const keys = setup();
    keys.follow.key("ArrowUp", true); // moving the caret in the composer
    expect(keys.follow.isFollowing()).toBe(true);
    keys.follow.key("PageUp", false);
    expect(keys.follow.isFollowing()).toBe(false);

    const bar = setup();
    bar.follow.grabbedScrollbar();
    expect(bar.follow.isFollowing()).toBe(false);
  });

  it("a restored position after prepending rows is not read as the reader scrolling down", () => {
    const { el, follow } = setup();
    follow.detach();
    el.scrollTop = 0;
    follow.scrolled();
    el.content += 1_200; // "show earlier" prepends rows
    el.scrollTop = 1_200; // the view keeps the same row under the reader
    follow.syncScrollTop();
    follow.scrolled();
    expect(follow.isFollowing()).toBe(false);
  });

  it("reset re-arms and lands at the end of a different conversation", () => {
    const { el, follow } = setup();
    follow.detach();
    el.scrollTop = 200;
    el.content = 3_000;
    follow.reset();
    expect(follow.isFollowing()).toBe(true);
    expect(distanceFromBottom(el)).toBe(0);
  });
});
