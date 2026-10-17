import { describe, expect, it } from "vitest";

import { cuaStartupDecision } from "./cua-startup.mjs";

describe("CUA startup permission gate", () => {
  it("starts on Linux without touching macOS permissions", () => {
    expect(cuaStartupDecision({ platform: "linux", accessibilityTrusted: false, screenRecordingStatus: "denied" })).toEqual({
      start: true,
      missing: [],
    });
  });

  it("stays unavailable on platforms without a local CUA driver", () => {
    const decision = cuaStartupDecision({
      platform: "win32",
      accessibilityTrusted: false,
      screenRecordingStatus: "unknown",
    });
    expect(decision.start).toBe(false);
    expect(decision.connection).toMatchObject({ mode: "unavailable", reason: "unsupported-platform" });
  });

  it("starts on macOS only when Accessibility and Screen Recording are already granted", () => {
    expect(
      cuaStartupDecision({ platform: "darwin", accessibilityTrusted: true, screenRecordingStatus: "granted" }),
    ).toEqual({ start: true, missing: [] });
  });

  it("does not prompt (no start) while a macOS permission is missing", () => {
    const decision = cuaStartupDecision({
      platform: "darwin",
      accessibilityTrusted: false,
      screenRecordingStatus: "not-determined",
    });
    expect(decision.start).toBe(false);
    expect(decision.missing).toEqual(["accessibility", "screen-recording"]);
    expect(decision.connection).toMatchObject({
      mode: "unavailable",
      reason: "permissions-required",
      reasonCode: "permissions-required",
      permissionStatus: { accessibility: false, screenRecording: "not-determined" },
    });
  });

  it("names only the permission that is actually missing", () => {
    const decision = cuaStartupDecision({
      platform: "darwin",
      accessibilityTrusted: true,
      screenRecordingStatus: "denied",
    });
    expect(decision.start).toBe(false);
    expect(decision.missing).toEqual(["screen-recording"]);
  });
});
