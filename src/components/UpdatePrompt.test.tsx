import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  parseUpdateSnooze,
  isUpdatePromptSnoozed,
  updatePromptVisible,
  UpdatePromptView,
} from "./UpdatePrompt";

const downloaded = { status: "downloaded" as const, version: "2.0.1", current: "2.0.0" };

const fakeStorage = (value: string | null): Storage =>
  ({ getItem: () => value, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 }) as Storage;

describe("update prompt", () => {
  it("renders the version and both one-click actions", () => {
    const html = renderToStaticMarkup(<UpdatePromptView version="2.0.1" onInstall={() => {}} onLater={() => {}} />);
    expect(html).toContain("A new version of Ein is ready");
    expect(html).toContain("Update now and restart");
    expect(html).toContain("Later");
    expect(html).toContain("2.0.1");
  });

  it("shows a restarting state that cannot be clicked twice", () => {
    const html = renderToStaticMarkup(<UpdatePromptView version="2.0.1" installing onInstall={() => {}} onLater={() => {}} />);
    expect(html).toContain("disabled");
    expect(html).toContain("Restarting…");
  });

  it("only prompts when a version is fully downloaded", () => {
    const now = 1_000_000;
    expect(updatePromptVisible(downloaded, now, fakeStorage(null))).toBe(true);
    expect(updatePromptVisible({ ...downloaded, status: "downloading" }, now, fakeStorage(null))).toBe(false);
    expect(updatePromptVisible({ ...downloaded, status: "available" }, now, fakeStorage(null))).toBe(false);
    expect(updatePromptVisible(null, now, fakeStorage(null))).toBe(false);
  });

  it("snoozes this exact version for 24h, but a newer version prompts again", () => {
    const now = 1_000_000;
    const raw = JSON.stringify({ version: "2.0.1", until: now + 24 * 60 * 60 * 1000 });
    expect(isUpdatePromptSnoozed(downloaded, now + 1000, raw)).toBe(true);
    expect(isUpdatePromptSnoozed(downloaded, now, raw) && isUpdatePromptSnoozed({ ...downloaded, version: "2.0.2" }, now, raw)).toBe(false);
    expect(parseUpdateSnooze("not-json")).toBeNull();
    expect(parseUpdateSnooze(JSON.stringify({ version: "2.0.1", until: "soon" }))).toBeNull();
  });

  it("treats missing/torn storage as not snoozed", () => {
    expect(updatePromptVisible(downloaded, 1, null)).toBe(true);
    expect(isUpdatePromptSnoozed(downloaded, 1, "{}")).toBe(false);
  });
});
