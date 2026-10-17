import { describe, expect, it } from "vitest";

import { COMPOSER_DOCK_HEIGHT, COMPOSER_DOCK_VAR, TRANSCRIPT_END_PAD, TRANSCRIPT_GAP, composerDockLength } from "./composer-dock";

describe("composer dock", () => {
  it("pads the transcript by one gap-3 of stage above the measured composer", () => {
    expect(TRANSCRIPT_GAP).toBe("0.75rem");
    expect(COMPOSER_DOCK_VAR).toBe("--composer-dock-h");
    expect(TRANSCRIPT_END_PAD).toBe("calc(var(--composer-dock-h, 64px) + 0.75rem)");
    expect(COMPOSER_DOCK_HEIGHT).toBe("var(--composer-dock-h, 64px)");
  });

  it("carries the measured height in whole pixels", () => {
    expect(composerDockLength(72)).toBe("72px");
  });

  it("ceils fractional heights so a subpixel composer cannot eat the gap", () => {
    expect(composerDockLength(71.2)).toBe("72px");
  });

  it("does not go negative", () => {
    expect(composerDockLength(-4)).toBe("0px");
  });

  it("uses a one-line empty-composer fallback, not the old two-row slot", () => {
    expect(composerDockLength(Number.NaN)).toBe("64px");
  });
});
