// Whether to start the CUA ("control this Mac") daemon at launch.
//
// startCua() -> startEmbedded() calls the CUA SDK's requestMacOSPermissions(),
// which asks macOS for Accessibility and Screen Recording. Doing that on every
// launch turns the permission prompt into a startup popup the user must answer
// before touching anything, and on the ad-hoc-signed build macOS re-asks
// because it cannot match a stored TCC grant to a stable signing identity.
//
// So: read the two TCC statuses without prompting. Only when both are already
// granted do we start the daemon at launch (no prompt). Otherwise the computer
// settings show their "Open System Settings / Retry" card, and the
// user-initiated Retry may prompt through startCua() again.

/** Pure decision used by the Electron main process (and its tests). */
export function cuaStartupDecision({ platform, accessibilityTrusted, screenRecordingStatus }) {
  if (platform === "linux") return { start: true, missing: [] };
  if (platform !== "darwin") {
    return {
      start: false,
      missing: [],
      connection: {
        mode: "unavailable",
        reason: "unsupported-platform",
        reasonCode: "unsupported-platform",
      },
    };
  }
  const accessibility = accessibilityTrusted === true;
  const screenRecording = screenRecordingStatus === "granted";
  const missing = [];
  if (!accessibility) missing.push("accessibility");
  if (!screenRecording) missing.push("screen-recording");
  if (missing.length === 0) return { start: true, missing: [] };
  return {
    start: false,
    missing,
    connection: {
      mode: "unavailable",
      reason: "permissions-required",
      reasonCode: "permissions-required",
      permissionStatus: { accessibility, screenRecording: screenRecordingStatus },
    },
  };
}
